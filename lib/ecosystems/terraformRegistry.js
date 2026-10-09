import {
  cdxgenAgent,
  DEBUG_MODE,
  readEnvironmentVariable,
} from "../core/activity.js";
import { sanitizeBomUrl } from "../core/propertySanitizer.js";
import {
  prefetchEnabled,
  prefetchedResponse,
  prefetchJson,
} from "../inventory/fetchBatch.js";
import { getRepoLicense, prefetchRepoLicenses } from "./ecosystems.js";

/**
 * Opt-in remote enrichment for Terraform / OpenTofu components: licenses,
 * repository URLs and registry flags.
 *
 * Callers gate this on `shouldFetchPackageMetadata()` (the same rule as the
 * Elm collector), so an ordinary scan makes no requests at all. When it does
 * run, only the two public registries are contacted — `registry.terraform.io`
 * and `registry.opentofu.org` — never a private registry host, whose name
 * alone can be confidential.
 *
 * The OpenTofu docs API is queried for both public hosts because it fronts
 * the same namespace with per-version SPDX ids and a confidence score; the
 * Terraform registry only contributes repository URLs, verification flags
 * and tiers. GitHub's license API is the last resort and reports the default
 * branch's license, not necessarily the license at the pinned tag.
 */

const PUBLIC_REGISTRY_HOSTS = new Set([
  "registry.terraform.io",
  "registry.opentofu.org",
]);
const MIN_LICENSE_CONFIDENCE = 0.8;
const GITHUB_TREE_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/.+$/;
const GITHUB_REPO_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+$/;

const property = (pkg, name) =>
  (pkg.properties || []).find((prop) => prop.name === name)?.value;

const setProperty = (pkg, name, value) => {
  (pkg.properties = pkg.properties || []).push({ name, value });
};

/**
 * Registry address of a component, split into its parts.
 *
 * @param {object} pkg Component
 * @returns {undefined|{ host: string, parts: string[] }} Address descriptor
 */
function registryAddress(pkg) {
  const address = property(pkg, "cdx:tf:address");
  if (!address) {
    return undefined;
  }
  const parts = address.split("/");
  if (parts.length < 3 || parts.length > 4) {
    return undefined;
  }
  return { host: parts[0], parts };
}

/**
 * Enrich Terraform components in place. Never throws; a failed lookup leaves
 * the component exactly as the offline pass produced it.
 *
 * @param {object[]} pkgList Components to enrich
 * @returns {Promise<object[]>} The same package list
 */
export async function getTerraformRegistryMetadata(pkgList) {
  const components = pkgList || [];
  // Only public-registry components with an exact version take part in the
  // registry steps; the GitHub fallback below runs for the whole list.
  const targets = components.filter(
    (pkg) =>
      pkg.version &&
      PUBLIC_REGISTRY_HOSTS.has(registryAddress(pkg)?.host || ""),
  );
  const docsBase = (
    readEnvironmentVariable("CDXGEN_TOFU_DOCS_URL") ||
    "https://api.opentofu.org"
  ).replace(/\/+$/u, "");
  const tfBase = (
    readEnvironmentVariable("CDXGEN_TF_REGISTRY_URL") ||
    "https://registry.terraform.io"
  ).replace(/\/+$/u, "");

  const docsUrl = (pkg) => {
    const { parts } = registryAddress(pkg);
    const encoded = parts.map((segment) => encodeURIComponent(segment));
    const version = encodeURIComponent(pkg.version);
    if (property(pkg, "cdx:tf:kind") === "provider") {
      // parts: host, namespace, type
      return `${docsBase}/registry/docs/providers/${encoded[1]}/${encoded[2]}/v${version}/index.json`;
    }
    // parts: host, namespace, name, system
    return `${docsBase}/registry/docs/modules/${encoded[1]}/${encoded[2]}/${encoded[3]}/v${version}/index.json`;
  };
  const registryUrl = (pkg) => {
    const { parts } = registryAddress(pkg);
    const encoded = parts.map((segment) => encodeURIComponent(segment));
    const version = encodeURIComponent(pkg.version);
    if (property(pkg, "cdx:tf:kind") === "provider") {
      return `${tfBase}/v1/providers/${encoded[1]}/${encoded[2]}/${version}`;
    }
    return `${tfBase}/v1/modules/${encoded[1]}/${encoded[2]}/${encoded[3]}/${version}`;
  };

  // The OpenTofu docs API fronts both public registries; the Terraform
  // registry API is asked only about its own components, so scanning an
  // OpenTofu project never sends its module list to registry.terraform.io.
  const onTerraformRegistry = (pkg) =>
    registryAddress(pkg)?.host === "registry.terraform.io";
  const urls = [
    ...new Set(
      targets.flatMap((pkg) =>
        onTerraformRegistry(pkg)
          ? [docsUrl(pkg), registryUrl(pkg)]
          : [docsUrl(pkg)],
      ),
    ),
  ];
  const prefetched = await prefetchJson(
    prefetchEnabled() ? urls.map((url) => ({ url })) : [],
  );

  for (const pkg of targets) {
    // 1. OpenTofu docs API: per-version SPDX ids with confidence.
    const docs = await fetchJson(docsUrl(pkg), prefetched);
    if (docs) {
      const entries = Array.isArray(docs.licenses)
        ? docs.licenses
        : Array.isArray(docs.license)
          ? docs.license
          : [];
      const best = entries
        .filter(
          (entry) =>
            entry &&
            typeof entry.spdx === "string" &&
            entry.spdx &&
            typeof entry.confidence === "number" &&
            entry.confidence >= MIN_LICENSE_CONFIDENCE,
        )
        .sort((a, b) => b.confidence - a.confidence)[0];
      if (best && !pkg.license) {
        pkg.license = best.spdx;
        setProperty(pkg, "cdx:tf:licenseSource", "opentofu-registry");
      }
      const link = typeof docs.link === "string" ? docs.link : "";
      if (registryAddress(pkg).host === "registry.opentofu.org") {
        const tree = link.match(GITHUB_TREE_URL);
        if (tree && !pkg.repository) {
          pkg.repository = {
            url: `https://github.com/${tree[1]}/${tree[2]}`,
          };
        }
      }
    }
    // 2. Terraform registry: repository, verification, tier, deprecation.
    if (!onTerraformRegistry(pkg)) {
      continue;
    }
    const meta = await fetchJson(registryUrl(pkg), prefetched);
    if (meta) {
      applyRegistryMetadata(pkg, meta);
    }
  }

  // 3. GitHub fallback for anything still without a license.
  const githubUrls = [
    ...new Set(
      components
        .filter((pkg) => !pkg.license)
        .map((pkg) => githubRepositoryUrl(pkg))
        .filter(Boolean),
    ),
  ];
  if (githubUrls.length) {
    await prefetchRepoLicenses(githubUrls);
    for (const pkg of components.filter((pkg) => !pkg.license)) {
      const url = githubRepositoryUrl(pkg);
      if (!url) {
        continue;
      }
      try {
        const license = await getRepoLicense(url, undefined);
        if (license?.id) {
          pkg.license = license.id;
          setProperty(pkg, "cdx:tf:licenseSource", "github");
        }
      } catch (err) {
        if (DEBUG_MODE) {
          console.log(
            `Unable to read the GitHub license of ${url}: ${err.message}`,
          );
        }
      }
    }
  }
  return pkgList;
}

/**
 * The GitHub repository URL of a component, if it has one.
 *
 * @param {object} pkg Component
 * @returns {string|undefined}
 */
function githubRepositoryUrl(pkg) {
  const repository =
    typeof pkg.repository?.url === "string" ? pkg.repository.url : undefined;
  if (repository && GITHUB_REPO_URL.test(repository)) {
    return repository;
  }
  // A git module's sanitized VCS URL, kept in its display source.
  const source = property(pkg, "cdx:tf:module:source") || "";
  if (source.startsWith("git::https://github.com/")) {
    const url = source.slice("git::".length).replace(/\.git$/u, "");
    if (GITHUB_REPO_URL.test(url)) {
      return url;
    }
  }
  return undefined;
}

/**
 * Apply one Terraform registry document to a component.
 *
 * @param {object} pkg Component
 * @param {object} meta Registry document
 */
function applyRegistryMetadata(pkg, meta) {
  if (
    typeof meta.source === "string" &&
    (meta.source.startsWith("http://") || meta.source.startsWith("https://")) &&
    !pkg.repository
  ) {
    const sanitized = sanitizeBomUrl(meta.source);
    if (sanitized) {
      pkg.repository = { url: sanitized };
    }
  }
  if (property(pkg, "cdx:tf:kind") === "module") {
    if (typeof meta.verified === "boolean") {
      setProperty(
        pkg,
        "cdx:tf:registry:verified",
        meta.verified ? "true" : "false",
      );
    }
    if (meta.deprecation !== null && meta.deprecation !== undefined) {
      setProperty(pkg, "cdx:tf:deprecated", "true");
    }
    if (typeof meta.description === "string" && !pkg.description) {
      pkg.description = meta.description.slice(0, 1024);
    }
  } else {
    if (
      meta.tier === "official" ||
      meta.tier === "partner" ||
      meta.tier === "community"
    ) {
      setProperty(pkg, "cdx:tf:registry:tier", meta.tier);
    }
  }
}

/**
 * Read one registry document, preferring the batched prefetch.
 *
 * @param {string} url Document URL
 * @param {Map} prefetched Batched results
 * @returns {Promise<object|undefined>} Parsed document
 */
async function fetchJson(url, prefetched) {
  try {
    const res =
      prefetchedResponse(prefetched, url) ||
      (await cdxgenAgent.get(url, { responseType: "json" }));
    return res?.body;
  } catch (err) {
    if (DEBUG_MODE) {
      console.log(`Unable to fetch ${url}: ${err.message}`);
    }
    return undefined;
  }
}

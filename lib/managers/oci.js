import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { cdxgenAgent, readEnvironmentVariable } from "../core/activity.js";
import { getAllFiles, safeExistsSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { isCycloneDxBom } from "../inventory/bomUtils.js";

const ORAS_CREATED_ANNOTATION = "org.opencontainers.image.created";

// artifactType values used for CycloneDX SBOM referrers. Registries such as
// ghcr.io ignore the `?artifactType=` referrers query filter and return *every*
// referrer (build-provenance attestations, cosign signatures, other SBOM
// formats, ...) alongside the CycloneDX SBOM. Tags that accumulate many
// referrers over time (e.g. the rolling `nightly`/`master` tags) therefore
// require us to filter client-side, otherwise the newest referrer selected may
// not be a CycloneDX SBOM at all and its layer will fail to parse as JSON.
const CYCLONEDX_ARTIFACT_TYPES = new Set([
  "application/vnd.cyclonedx+json",
  "sbom/cyclonedx",
]);

function isCycloneDxArtifactType(artifactType) {
  return !!artifactType && CYCLONEDX_ARTIFACT_TYPES.has(artifactType);
}

// mediaType values a referrer manifest layer may use to carry a CycloneDX BOM.
// `attachBomNative` writes `application/vnd.cyclonedx+json`; BuildKit native
// attestations wrap the BOM in an in-toto statement layer. We use the layer
// descriptor's mediaType (the authoritative signal — blob responses are served
// as octet-stream) to pick the correct layer instead of assuming layers[0].
const CYCLONEDX_LAYER_MEDIA_TYPES = new Set([
  "application/vnd.cyclonedx+json",
  "application/vnd.in-toto+json",
]);

function selectBomLayer(layers) {
  if (!Array.isArray(layers) || !layers.length) {
    return undefined;
  }
  return (
    layers.find((layer) => CYCLONEDX_LAYER_MEDIA_TYPES.has(layer?.mediaType)) ||
    // Fall back to the first layer for older attachments / registries that omit
    // the layer mediaType.
    layers[0]
  );
}

// OCI registry probes (manifest/token/referrers/blob lookups) run on the audit
// hot path — including from inside JSONata rules (`$hasSbom`/`$hasSignedSbom`),
// whose evaluation is time-bounded. Use a smaller per-request timeout than the
// global cdxgenAgent default so an unreachable/slow registry fails fast instead
// of tying up the scan. Overridable via CDXGEN_OCI_TIMEOUT_MS.
const DEFAULT_OCI_TIMEOUT_MS = 8000;
const MAX_OCI_TIMEOUT_MS = 300000;

function getOciTimeoutMs() {
  const raw = readEnvironmentVariable("CDXGEN_OCI_TIMEOUT_MS");
  if (raw === undefined || raw === "") {
    return DEFAULT_OCI_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_OCI_TIMEOUT_MS;
  }
  return Math.min(parsed, MAX_OCI_TIMEOUT_MS);
}

function getManifestDescriptors(manifestObj) {
  if (Array.isArray(manifestObj?.manifests)) {
    return manifestObj.manifests;
  }
  if (Array.isArray(manifestObj?.referrers)) {
    return manifestObj.referrers;
  }
  return [];
}

// OCI digest grammar (`algorithm:encoded`). Digests taken from referrer
// descriptors and manifests are pasted into registry URLs, so anything else
// (path separators, query strings) is rejected rather than requested.
const OCI_DIGEST_PATTERN = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/;

function isOciDigest(digest) {
  return typeof digest === "string" && OCI_DIGEST_PATTERN.test(digest);
}

function getManifestCreatedAt(manifest) {
  const createdAt = manifest?.annotations?.[ORAS_CREATED_ANNOTATION];
  if (!createdAt) {
    return undefined;
  }
  const createdAtTimestamp = Date.parse(createdAt);
  if (Number.isNaN(createdAtTimestamp)) {
    return undefined;
  }
  return createdAtTimestamp;
}

// A referrers list can be any length and, on registries without the referrers
// API, is an image index written by whoever can push to the repository. Every
// candidate costs a manifest request, a blob request and a parse of the whole
// blob, so only the newest few distinct ones are tried.
const MAX_REFERRER_CANDIDATES = 20;

/**
 * Return the digests of the candidate SBOM referrers, newest first.
 *
 * Descriptors whose `artifactType` identifies them as a CycloneDX SBOM are
 * preferred. Only when no descriptor advertises a CycloneDX artifactType (e.g.
 * a registry that strips the field, or an older attachment) do we fall back to
 * considering every descriptor, preserving the previous best-effort behaviour.
 *
 * The descriptor list is untrusted: on registries without the referrers API it
 * is the `sha256-<digest>` fallback tag, an image index anyone with push
 * access to the repository can write. A descriptor may therefore only say
 * which manifest of the image's own repository to fetch, never where to fetch
 * it from, so only its digest is used and fields naming another registry or
 * repository (such as the `reference` emitted by the oras CLI) are ignored.
 *
 * @param {Object} manifestObj Referrers response / image index object.
 * @returns {string[]} Distinct candidate digests, newest first, at most
 *   MAX_REFERRER_CANDIDATES of them.
 */
function selectReferrerDigests(manifestObj) {
  const manifestDescriptors = getManifestDescriptors(manifestObj);
  const allCandidates = manifestDescriptors
    .map((manifest, index) => {
      if (!isOciDigest(manifest?.digest)) {
        return undefined;
      }
      return {
        artifactType: manifest?.artifactType,
        createdAt: getManifestCreatedAt(manifest),
        digest: manifest.digest,
        index,
      };
    })
    .filter(Boolean);
  const cdxCandidates = allCandidates.filter((c) =>
    isCycloneDxArtifactType(c.artifactType),
  );
  const candidates = cdxCandidates.length ? cdxCandidates : allCandidates;
  candidates.sort((a, b) => {
    if (a.createdAt !== undefined || b.createdAt !== undefined) {
      if (a.createdAt === undefined) {
        return 1;
      }
      if (b.createdAt === undefined) {
        return -1;
      }
      if (b.createdAt !== a.createdAt) {
        return b.createdAt - a.createdAt;
      }
    }
    return b.index - a.index;
  });
  const digests = [...new Set(candidates.map((c) => c.digest))];
  if (digests.length > MAX_REFERRER_CANDIDATES) {
    thoughtLog(
      `Only the newest ${MAX_REFERRER_CANDIDATES} of ${digests.length} referrers are tried.`,
    );
  }
  return digests.slice(0, MAX_REFERRER_CANDIDATES);
}

function _getBomFiles(tmpDir) {
  let bomFiles = getAllFiles(tmpDir, "**/*.{bom,cdx}.json");
  if (!bomFiles.length) {
    bomFiles = getAllFiles(tmpDir, "**/bom.json");
  }
  if (!bomFiles.length) {
    bomFiles = getAllFiles(tmpDir, "**/*.json");
  }
  return bomFiles;
}

function parseImageRef(image) {
  let registry = "docker.io";
  let repoAndTag = image;
  const firstSlash = image.indexOf("/");
  if (firstSlash !== -1) {
    const hostCandidate = image.slice(0, firstSlash);
    if (
      hostCandidate.includes(".") ||
      hostCandidate.includes(":") ||
      hostCandidate === "localhost"
    ) {
      registry = hostCandidate;
      repoAndTag = image.slice(firstSlash + 1);
    }
  }
  let repository = repoAndTag;
  let reference = "latest";
  const atIndex = repoAndTag.indexOf("@");
  if (atIndex !== -1) {
    repository = repoAndTag.slice(0, atIndex);
    reference = repoAndTag.slice(atIndex + 1);
  } else {
    const colonIndex = repoAndTag.lastIndexOf(":");
    if (colonIndex !== -1) {
      repository = repoAndTag.slice(0, colonIndex);
      reference = repoAndTag.slice(colonIndex + 1);
    }
  }
  if (registry === "docker.io" && !repository.includes("/")) {
    repository = `library/${repository}`;
  }
  return { registry, repository, reference };
}

function getDockerCreds(registry) {
  try {
    const configPath = join(homedir(), ".docker", "config.json");
    if (safeExistsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (config.auths) {
        const auth =
          config.auths[registry] ||
          config.auths[`https://${registry}`] ||
          config.auths[`https://${registry}/v1/`];
        if (auth?.auth) {
          return auth.auth;
        }
      }
    }
  } catch (_e) {
    /* ignore */
  }
  // DOCKER_AUTH names no registry of its own, while callers such as the
  // `$hasSbom` audit probes pass registries taken from scanned content. Only
  // hand it to the registry the operator's login belongs to, which is
  // DOCKER_SERVER_ADDRESS (docker.io by default) as for DOCKER_USER/DOCKER_PASSWORD.
  const authRegistry =
    readEnvironmentVariable("DOCKER_SERVER_ADDRESS") || "docker.io";
  if (
    authRegistry === registry ||
    authRegistry === `https://${registry}` ||
    authRegistry === `https://${registry}/v1/`
  ) {
    return readEnvironmentVariable("DOCKER_AUTH");
  }
  return undefined;
}

/**
 * Check whether a URL named by a registry response belongs to the registry
 * itself.
 *
 * A registry's 401 response names the token realm and its 202 response names
 * the blob upload location, so a hostile registry picks the URL cdxgen will
 * call. Credentials picked up for the registry must therefore only be attached
 * when that URL resolves to the same scheme, host and port; public delegating
 * realms (docker.io to auth.docker.io) are still usable, just anonymously.
 *
 * @param {string} registry Registry host, optionally with a port
 * @param {URL} realmUrl Parsed URL from the WWW-Authenticate or Location header
 * @returns {boolean} true when scheme, host and port match the registry
 */
export function isSameRegistryHost(registry, realmUrl) {
  try {
    const registryUrl = new URL(
      registry.startsWith("localhost")
        ? `http://${registry}`
        : `https://${registry}`,
    );
    return registryUrl.origin === realmUrl.origin;
  } catch (_e) {
    return false;
  }
}

async function getOciToken(registry, repository, scope) {
  const creds = getDockerCreds(registry);
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const authUrl = `${scheme}://${registry}/v2/`;
  try {
    const res = await cdxgenAgent.get(authUrl, {
      throwHttpErrors: false,
      timeout: getOciTimeoutMs(),
    });
    if (res.statusCode === 401) {
      const wwwAuth = res.headers["www-authenticate"];
      if (wwwAuth?.toLowerCase().startsWith("bearer ")) {
        const params = {};
        wwwAuth
          .substring(7)
          .split(",")
          .forEach((part) => {
            const [k, v] = part.split("=");
            if (v) params[k.trim()] = v.trim().replace(/"/g, "");
          });
        if (params.realm) {
          const reqUrl = new URL(params.realm);
          if (params.service)
            reqUrl.searchParams.set("service", params.service);
          reqUrl.searchParams.set("scope", `repository:${repository}:${scope}`);
          // Tokens expire within minutes, so a cached one would be replayed
          // after it stopped working.
          const options = {
            cache: false,
            responseType: "json",
            timeout: getOciTimeoutMs(),
          };
          // The realm comes from the registry's own 401 response, so a
          // hostile registry chooses this URL. Never forward the stored
          // registry credentials to a different origin; an anonymous cross-host
          // token request (how public registries such as docker.io delegate
          // to auth.docker.io) is still allowed.
          if (creds && isSameRegistryHost(registry, reqUrl)) {
            options.headers = { Authorization: `Basic ${creds}` };
          } else if (creds) {
            console.warn(
              `Skipping credential forwarding to the token realm ${reqUrl.origin} for registry ${registry}: the origin differs.`,
            );
          }
          const tokenRes = await cdxgenAgent.get(reqUrl.toString(), options);
          if (
            tokenRes.body &&
            (tokenRes.body.token || tokenRes.body.access_token)
          ) {
            return tokenRes.body.token || tokenRes.body.access_token;
          }
        }
      }
    }
  } catch (_e) {
    /* ignore */
  }
  if (creds) return `Basic ${creds}`;
  return null;
}

/**
 * Fetch a URL and parse the response body as JSON without throwing on a
 * non-JSON payload. Registries that do not implement an endpoint (notably
 * ghcr.io for the OCI referrers API) answer with a 404 *HTML* error page; the
 * shared httpClient parses `responseType: "json"` eagerly and would throw on
 * that HTML before the caller can inspect the status code. Reading as text and
 * parsing defensively lets callers route on `statusCode` and fall back cleanly.
 *
 * @returns {Promise<{statusCode: number, headers: Object, body: Object|undefined}>}
 */
async function fetchJson(url, headers, strict = false) {
  const res = await cdxgenAgent.get(url, {
    headers,
    responseType: "text",
    throwHttpErrors: false,
    timeout: getOciTimeoutMs(),
  });
  if (strict && (res.statusCode >= 500 || res.statusCode === 429)) {
    throw new Error(`The registry answered with HTTP ${res.statusCode}`);
  }
  let body;
  if (typeof res.body === "string" && res.body.length) {
    try {
      body = JSON.parse(res.body);
    } catch {
      body = undefined;
    }
  }
  return { statusCode: res.statusCode, headers: res.headers, body };
}

async function fetchManifest(
  registry,
  repository,
  reference,
  token,
  strict = false,
) {
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const url = `${scheme}://${registry}/v2/${repository}/manifests/${reference}`;
  const headers = {
    Accept:
      "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json",
  };
  if (token) {
    headers.Authorization = token.startsWith("Basic")
      ? token
      : `Bearer ${token}`;
  }
  const res = await fetchJson(url, headers, strict);
  if (res.statusCode === 200) {
    return {
      manifest: res.body,
      digest: res.headers["docker-content-digest"],
      mediaType: res.headers["content-type"],
    };
  }
  return null;
}

async function discoverReferrers(
  registry,
  repository,
  digest,
  token,
  strict = false,
) {
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const url = `${scheme}://${registry}/v2/${repository}/referrers/${digest}?artifactType=application/vnd.cyclonedx+json`;
  const headers = {};
  if (token) {
    headers.Authorization = token.startsWith("Basic")
      ? token
      : `Bearer ${token}`;
  }
  try {
    const res = await fetchJson(url, headers, strict);
    if (res.statusCode === 200) {
      return res.body;
    }
  } catch (e) {
    if (strict) {
      throw e;
    }
  }
  return undefined;
}

async function pullBlob(registry, repository, digest, token) {
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const url = `${scheme}://${registry}/v2/${repository}/blobs/${digest}`;
  const headers = {};
  if (token) {
    headers.Authorization = token.startsWith("Basic")
      ? token
      : `Bearer ${token}`;
  }
  const res = await cdxgenAgent.get(url, {
    headers,
    responseType: "buffer",
    timeout: getOciTimeoutMs(),
  });
  return res.body;
}

/**
 * Retrieves a CycloneDX BOM attached to an OCI image purely in JavaScript
 * without relying on the `oras` CLI tool.
 *
 * @param {string} image OCI image reference (e.g. `"registry.example.com/org/app:tag"`)
 * @param {string} [platform] OCI platform string (e.g. `"linux/amd64"`); no-op for JS implementation
 * @param {Object} [options]
 * @param {boolean} [options.reportErrors] Throw on a transport error, a timeout, an HTTP 5xx or a 429 instead of answering `undefined`, so a caller can tell a registry that did not answer from one that holds no SBOM
 * @param {function(Buffer): void} [options.checkBytes] Called with the raw bytes of the BOM layer that is about to be returned. An error it throws is rethrown, and no other referrer is tried.
 * @returns {Promise<Object|undefined>} Parsed CycloneDX BOM JSON object, or `undefined` if not found
 */
export async function getBomWithOras(
  image,
  _platform = undefined,
  options = {},
) {
  const { registry, repository, reference } = parseImageRef(image);
  const token = await getOciToken(registry, repository, "pull");
  let rejection;
  const strict = options.reportErrors === true;

  try {
    const targetManifest = await fetchManifest(
      registry,
      repository,
      reference,
      token,
      strict,
    );
    if (!targetManifest?.digest) {
      return undefined;
    }
    const digest = targetManifest.digest;

    let referrersObj = await discoverReferrers(
      registry,
      repository,
      digest,
      token,
      strict,
    );

    // If not found with artifactType filter, try fetching all referrers
    if (!referrersObj?.manifests || referrersObj.manifests.length === 0) {
      const scheme = registry.startsWith("localhost") ? "http" : "https";
      let url = `${scheme}://${registry}/v2/${repository}/referrers/${digest}`;
      const headers = token
        ? {
            Authorization: token.startsWith("Basic")
              ? token
              : `Bearer ${token}`,
          }
        : {};
      let res = await fetchJson(url, headers, strict);
      if (res.statusCode === 200 && res.body?.manifests) {
        referrersObj = res.body;
      } else {
        // Registries such as ghcr.io do not implement the referrers API and
        // answer with a 404 HTML page. Fall back to the OCI referrers tag
        // schema, where the SBOM index is stored under a `sha256-<digest>` tag.
        const fallbackTag = digest.replace(":", "-");
        url = `${scheme}://${registry}/v2/${repository}/manifests/${fallbackTag}`;
        headers.Accept = "application/vnd.oci.image.index.v1+json";
        res = await fetchJson(url, headers, strict);
        if (res.statusCode === 200) {
          referrersObj = res.body;
        }
      }
    }

    // Prefer CycloneDX-typed referrers, newest first. Registries that ignore
    // the artifactType query filter return every referrer, so we may still see
    // non-SBOM referrers here (e.g. on the rolling nightly tag). Try each
    // candidate until one yields a valid CycloneDX BOM instead of failing on
    // the first non-JSON layer. Referrers live in the image's own repository,
    // so every request below stays on the registry the token was obtained for.
    const referrerDigests = selectReferrerDigests(referrersObj);

    for (const referrerDigest of referrerDigests) {
      const manifestNode = await fetchManifest(
        registry,
        repository,
        referrerDigest,
        token,
        strict,
      );
      const bomLayer = selectBomLayer(manifestNode?.manifest?.layers);
      if (!isOciDigest(bomLayer?.digest)) {
        continue;
      }
      const blob = await pullBlob(registry, repository, bomLayer.digest, token);
      const text = blob.toString("utf8");
      let bomJson;
      try {
        bomJson = JSON.parse(text);
      } catch {
        // Defensive: the mediaType claimed JSON but the layer did not parse
        // (truncated/corrupt blob). Skip it and try the next candidate.
        continue;
      }

      // Extract from in-toto envelope (BuildKit native attestations)
      if (
        bomJson &&
        (bomJson._type === "https://in-toto.io/Statement/v0.1" ||
          bomJson._type === "https://in-toto.io/Statement/v1") &&
        bomJson.predicateType === "https://cyclonedx.org/bom" &&
        bomJson.predicate
      ) {
        bomJson = bomJson.predicate;
      }

      if (isCycloneDxBom(bomJson)) {
        if (options.checkBytes) {
          try {
            options.checkBytes(blob);
          } catch (err) {
            rejection = err;
            break;
          }
        }
        return bomJson;
      }
    }
  } catch (e) {
    if (strict) {
      throw e;
    }
    console.log(
      `Unable to pull the SBOM attachment for ${image} natively! ${e.message}`,
    );
  }
  if (rejection) {
    throw rejection;
  }
  return undefined;
}

function getDigest(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

async function pushBlob(registry, repository, buffer, token) {
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const digest = getDigest(buffer);
  const headers = {};
  if (token) {
    headers.Authorization = token.startsWith("Basic")
      ? token
      : `Bearer ${token}`;
  }

  // 1. Initiate upload
  const initUrl = `${scheme}://${registry}/v2/${repository}/blobs/uploads/`;
  const initRes = await cdxgenAgent.post(initUrl, {
    headers,
    throwHttpErrors: false,
  });
  if (initRes.statusCode === 201 || initRes.statusCode === 202) {
    let location = initRes.headers.location;
    if (!location.startsWith("http")) {
      location = `${scheme}://${registry}${location.startsWith("/") ? "" : "/"}${location}`;
    }
    const uploadUrl = new URL(location);
    uploadUrl.searchParams.set("digest", digest);

    // 2. Upload blob
    const putHeaders = {
      ...headers,
      "Content-Length": buffer.length.toString(),
      "Content-Type": "application/octet-stream",
    };
    // The location comes with a 2xx response, so the http client does not
    // treat it as a redirect and would keep the Authorization header. Never
    // forward the registry credentials to a different origin; upload sessions
    // delegated to another host carry their own signed query string.
    if (token && !isSameRegistryHost(registry, uploadUrl)) {
      delete putHeaders.Authorization;
      console.warn(
        `Skipping credential forwarding to the upload location ${uploadUrl.host} for registry ${registry}: the origin differs.`,
      );
    }
    const putRes = await cdxgenAgent.put(uploadUrl.toString(), {
      headers: putHeaders,
      body: buffer,
      throwHttpErrors: false,
    });
    if (putRes.statusCode === 201 || putRes.statusCode === 202) {
      return { digest, size: buffer.length };
    }
    throw new Error(
      `Failed to upload blob: ${putRes.statusCode} ${putRes.body}`,
    );
  }
  if (initRes.statusCode === 401) {
    throw new Error(
      `Unauthorized to initiate blob upload: ${initRes.statusCode}`,
    );
  }
  throw new Error(
    `Failed to initiate blob upload: ${initRes.statusCode} ${initRes.body}`,
  );
}

async function pushManifest(registry, repository, manifestObj, token) {
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const buffer = Buffer.from(JSON.stringify(manifestObj));
  const digest = getDigest(buffer);
  const url = `${scheme}://${registry}/v2/${repository}/manifests/${digest}`;
  const headers = {
    "Content-Type":
      manifestObj.mediaType || "application/vnd.oci.image.manifest.v1+json",
  };
  if (token) {
    headers.Authorization = token.startsWith("Basic")
      ? token
      : `Bearer ${token}`;
  }
  const res = await cdxgenAgent.put(url, {
    headers,
    body: buffer,
    throwHttpErrors: false,
  });
  if (res.statusCode === 201 || res.statusCode === 202) {
    return digest;
  }
  throw new Error(`Failed to push manifest: ${res.statusCode} ${res.body}`);
}

/**
 * Attach a CycloneDX BOM to an OCI image using the OCI 1.1 artifact manifest
 * API, pushing the BOM as a blob and linking it via the referrers API (with a
 * fallback tag when the registry does not support referrers).
 *
 * @param {string} image The target OCI image reference to attach the BOM to.
 * @param {Object} bomJson The CycloneDX BOM document to attach.
 * @returns {Promise<string|undefined>} The digest of the pushed manifest, or
 *   undefined when the manifest could not be pushed.
 */
export async function attachBomNative(image, bomJson) {
  const { registry, repository, reference } = parseImageRef(image);
  const token = await getOciToken(registry, repository, "pull,push");

  // 1. Fetch target manifest
  const targetManifest = await fetchManifest(
    registry,
    repository,
    reference,
    token,
  );
  if (!targetManifest?.digest) {
    throw new Error(`Target image ${image} not found or no access.`);
  }

  // 2. Push SBOM blob
  const bomBuffer = Buffer.from(JSON.stringify(bomJson));
  const blobInfo = await pushBlob(registry, repository, bomBuffer, token);

  // Push the empty config blob ({}) required by the OCI 1.1 artifact manifest
  const emptyConfigBuffer = Buffer.from("{}");
  await pushBlob(registry, repository, emptyConfigBuffer, token);

  // 3. Push OCI 1.1 Manifest
  const manifestObj = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: "application/vnd.cyclonedx+json",
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest:
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      size: 2,
    },
    layers: [
      {
        mediaType: "application/vnd.cyclonedx+json",
        digest: blobInfo.digest,
        size: blobInfo.size,
      },
    ],
    subject: {
      mediaType:
        targetManifest.mediaType ||
        "application/vnd.oci.image.manifest.v1+json",
      digest: targetManifest.digest,
      size: targetManifest.manifest
        ? Buffer.from(JSON.stringify(targetManifest.manifest)).length
        : 0,
    },
    annotations: {
      "org.opencontainers.image.created": new Date().toISOString(),
    },
  };

  let manifestDigest = await pushManifest(
    registry,
    repository,
    manifestObj,
    token,
  );

  // Probe if referrers API is supported by the registry
  const probeUrl = `${registry.startsWith("localhost") ? "http" : "https"}://${registry}/v2/${repository}/referrers/${targetManifest.digest}`;
  const probeHeaders = token
    ? { Authorization: token.startsWith("Basic") ? token : `Bearer ${token}` }
    : {};
  const probeRes = await cdxgenAgent.get(probeUrl, {
    headers: probeHeaders,
    throwHttpErrors: false,
    timeout: getOciTimeoutMs(),
  });

  if (probeRes.statusCode === 404 || probeRes.statusCode === 400) {
    // Registry does not support referrers API natively. Create the fallback tag.
    const fallbackTag = targetManifest.digest.replace(":", "-");

    // Check if the fallback tag already exists (an Image Index)
    const fallbackUrl = `${registry.startsWith("localhost") ? "http" : "https"}://${registry}/v2/${repository}/manifests/${fallbackTag}`;
    const getRes = await cdxgenAgent.get(fallbackUrl, {
      headers: {
        ...probeHeaders,
        Accept: "application/vnd.oci.image.index.v1+json",
      },
      responseType: "json",
      throwHttpErrors: false,
      timeout: getOciTimeoutMs(),
    });

    let indexObj;
    if (getRes.statusCode === 200 && getRes.body && getRes.body.manifests) {
      indexObj = getRes.body;
      indexObj.manifests.push({
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: manifestDigest,
        size: Buffer.from(JSON.stringify(manifestObj)).length,
        artifactType: "application/vnd.cyclonedx+json",
      });
    } else {
      indexObj = {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: manifestDigest,
            size: Buffer.from(JSON.stringify(manifestObj)).length,
            artifactType: "application/vnd.cyclonedx+json",
          },
        ],
      };
    }

    const indexBuffer = Buffer.from(JSON.stringify(indexObj));
    const putHeaders = {
      ...probeHeaders,
      "Content-Type": "application/vnd.oci.image.index.v1+json",
    };
    await cdxgenAgent.put(fallbackUrl, {
      headers: putHeaders,
      body: indexBuffer,
      throwHttpErrors: false,
    });
    manifestDigest = getDigest(indexBuffer);
  }

  console.log(`Attached SBOM natively to ${image} via ${manifestDigest}`);
  return manifestDigest;
}

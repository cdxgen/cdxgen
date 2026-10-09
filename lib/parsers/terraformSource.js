/**
 * Pure parser for Terraform / OpenTofu module and provider source addresses.
 *
 * A module `source` argument can be a local path, a registry shorthand, a git
 * URL (forced with `git::` or detected from a github.com/gitlab.com/bitbucket.org
 * host or an scp-style `git@host:path` string), a mercurial URL, or an archive
 * URL over http/s3/gcs. The grammar is go-getter's: an optional `<getter>::`
 * prefix, a base address, an optional `//subdirectory` suffix that starts after
 * the `://` of a URL when one is present, and go-getter query parameters such
 * as `ref`, `rev`, `checksum` and `archive`.
 *
 * Source strings are untrusted and can carry credentials (URL passwords, the
 * git `sshkey` parameter, S3 keys), so this module never returns the raw input.
 * The `url` field is rebuilt from parsed, sanitized pieces — userinfo, query
 * and fragment removed — and `displaySource` is assembled from those pieces
 * only. `credentialInSource` flags that a secret-shaped parameter was present
 * without repeating it.
 *
 * Layer 1: no filesystem, no network, no purl construction. Callers turn the
 * returned plain data into components and purls.
 */

export const TERRAFORM_REGISTRY_HOST = "registry.terraform.io";
export const OPENTOFU_REGISTRY_HOST = "registry.opentofu.org";

/** Getters that may be forced with a `name::` prefix. */
const FORCED_GETTERS = new Set([
  "git",
  "hg",
  "s3",
  "gcs",
  "http",
  "https",
  "file",
]);

/** go-getter query parameters that carry credentials (checked case-blind). */
const CREDENTIAL_QUERY_KEYS = new Set([
  "sshkey",
  "aws_access_key_id",
  "aws_access_key_secret",
  "aws_access_token",
  "token",
  "access_token",
  "private_token",
  "password",
  "secret",
  "sig",
  "signature",
  "x-amz-signature",
  "x-goog-signature",
]);

/** Registry namespace and name: alphanumeric edges, `-`/`_` inside, 1–64 chars. */
const REGISTRY_PART = /^[0-9A-Za-z](?:[0-9A-Za-z_-]{0,62}[0-9A-Za-z])?$/;
/** Registry target system: lower-case only. */
const REGISTRY_SYSTEM = /^[0-9a-z]{1,64}$/;
/** Archive filename suffixes go-getter unpacks without `?archive=`. */
const ARCHIVE_EXTENSIONS = [
  ".zip",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".tar.bz2",
  ".tbz2",
  ".tar.xz",
  ".txz",
];
/** `?checksum=` algorithms and the hex length each digest must have. */
const CHECKSUM_ALGORITHMS = {
  md5: { alg: "MD5", length: 32 },
  sha1: { alg: "SHA-1", length: 40 },
  sha256: { alg: "SHA-256", length: 64 },
  sha512: { alg: "SHA-512", length: 128 },
};
const HEX_DIGEST = /^[0-9a-f]+$/i;
/** A bare or `=`-prefixed single semver-ish clause. */
const EXACT_VERSION =
  /^v?[0-9]+(?:\.[0-9]+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** A version-shaped git ref; the suffix must start with `-` or `+`. */
const VCS_TAG = /^v?[0-9]+(?:\.[0-9]+)*(?:[-+][0-9A-Za-z.-]+)?$/;
/** Windows drive roots such as `C:\` or `C:/`. */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const GIT_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

/**
 * Parse a module `source` argument into a classified descriptor.
 *
 * @param {string} source Module source string as written in the configuration
 * @param {Object} [options]
 * @param {string} [options.defaultRegistryHost] Host for 3-segment registry
 *   shorthand (`registry.terraform.io` unless the caller knows better)
 * @returns {null|Object} `null` for non-strings, otherwise a descriptor whose
 *   `kind` is `local`, `registry`, `git`, `hg`, `http`, `s3`, `gcs`, `file` or
 *   `unknown`
 */
export function parseModuleSource(source, { defaultRegistryHost } = {}) {
  const defaultHost = defaultRegistryHost || TERRAFORM_REGISTRY_HOST;
  if (typeof source !== "string") {
    return null;
  }
  const text = source.trim();
  if (!text) {
    return { kind: "unknown", credentialInSource: false };
  }

  // Local sources stay inside the calling package and are never components.
  if (
    text === "." ||
    text === ".." ||
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.startsWith(".\\") ||
    text.startsWith("..\\")
  ) {
    return {
      kind: "local",
      path: text,
      credentialInSource: false,
      displaySource: text,
    };
  }

  // Absolute paths (and drive roots) are file sources; callers never emit them.
  if (text.startsWith("/") || text.startsWith("\\") || DRIVE_ROOT.test(text)) {
    return { kind: "file", credentialInSource: false };
  }

  // Forced getter prefix.
  let getter;
  let rest = text;
  const dd = text.indexOf("::");
  if (dd >= 0) {
    const prefix = text.slice(0, dd).toLowerCase();
    if (!FORCED_GETTERS.has(prefix)) {
      return { kind: "unknown", credentialInSource: false };
    }
    getter = prefix;
    rest = text.slice(dd + 2);
  }

  // Split the `//subdirectory` marker and the query string off the base.
  // The marker search starts after `://` so a URL's scheme slashes do not
  // count; a query found on the subdirectory belongs to the base URL.
  const schemeAt = rest.indexOf("://");
  const searchFrom = schemeAt >= 0 ? schemeAt + 3 : 0;
  const marker = rest.indexOf("//", searchFrom);
  let base = rest;
  let rawSubdir;
  if (marker >= 0) {
    const tail = rest.slice(marker + 2);
    const queryAt = tail.indexOf("?");
    if (queryAt >= 0) {
      rawSubdir = tail.slice(0, queryAt);
      base = rest.slice(0, marker) + tail.slice(queryAt);
    } else {
      rawSubdir = tail;
      base = rest.slice(0, marker);
    }
  }
  const queryAt = base.indexOf("?");
  const address = queryAt >= 0 ? base.slice(0, queryAt) : base;
  const queryString = queryAt >= 0 ? base.slice(queryAt + 1) : "";

  // Query parameters: keep the identity-relevant ones, flag the secret-shaped
  // ones without ever copying their values.
  const params = new URLSearchParams(queryString);
  const refParam = params.get("ref");
  const revParam = params.get("rev");
  const checksumParam = params.get("checksum");
  const archiveParam = params.has("archive");
  let credentialInSource = false;
  for (const key of params.keys()) {
    if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
      credentialInSource = true;
      break;
    }
  }

  // Normalize the subdirectory: forward slashes, no outer slashes. A `..`
  // segment escapes the package, so the source is unusable.
  let subdir;
  if (rawSubdir !== undefined) {
    const segments = rawSubdir.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments.includes("..")) {
      return { kind: "unknown", credentialInSource };
    }
    if (segments.length) {
      subdir = segments.join("/");
    }
  }

  const result = {
    kind: "unknown",
    credentialInSource,
    ...(subdir ? { subdir } : {}),
  };

  if (getter) {
    fillForcedGetter(result, getter, address);
  } else {
    fillDetectedSource(result, address, defaultHost);
  }
  if (result.kind === "unknown") {
    return result;
  }
  if (result.kind === "hg") {
    result.ref = revParam ?? refParam ?? result.ref;
  } else if (result.kind === "git") {
    result.ref = refParam ?? result.ref;
  }
  if (checksumParam && !result.checksum) {
    const checksum = parseChecksumParam(checksumParam);
    if (checksum) {
      result.checksum = checksum;
    }
  }
  if (archiveParam && !result.archive) {
    result.archive = true;
  }
  if (!result.archive && result.url) {
    const lower = result.url.toLowerCase();
    if (ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      result.archive = true;
    }
  }
  result.displaySource = buildDisplaySource(result);
  return result;
}

/**
 * Classify an address that had no `<getter>::` prefix.
 *
 * @param {Object} result Descriptor under construction, mutated
 * @param {string} address Base address without subdirectory or query
 * @param {string} defaultHost Registry host for 3-segment shorthand
 */
function fillDetectedSource(result, address, defaultHost) {
  const segments = address.split("/");
  const host = (segments[0] || "").toLowerCase();
  if (GIT_HOSTS.has(host) && segments.length >= 3 && segments[1]) {
    // go-getter turns `github.com/o/r/x/y` into the repo plus `//x/y`.
    const repo = segments[2].replace(/\.git$/i, "");
    result.kind = "git";
    result.url = sanitizeUrl(
      `https://${segments[0]}/${segments[1]}/${repo}.git`,
    );
    const extra = segments.slice(3).filter(Boolean).join("/");
    if (extra) {
      result.subdir = result.subdir ? `${result.subdir}/${extra}` : extra;
    }
    return;
  }
  if (address.startsWith("git@")) {
    const scp = parseScpSource(address);
    if (scp) {
      result.kind = "git";
      result.url = scp.url;
      result.credentialInSource = result.credentialInSource || scp.hasPassword;
      return;
    }
  }
  if (address.startsWith("http://") || address.startsWith("https://")) {
    const parsed = parseWebUrl(address);
    if (parsed) {
      result.kind = parsed.kind;
      result.url = parsed.url;
      result.credentialInSource =
        result.credentialInSource || parsed.hasPassword;
      return;
    }
    return;
  }
  const registry = matchRegistryAddress(address, defaultHost);
  if (registry) {
    result.kind = "registry";
    Object.assign(result, registry);
  }
}

/**
 * Interpret the base address of a `<getter>::` source.
 *
 * @param {Object} result Descriptor under construction, mutated
 * @param {string} getter Forced getter name
 * @param {string} address Base address without subdirectory or query
 */
function fillForcedGetter(result, getter, address) {
  if (getter === "file") {
    result.kind = "file";
    return;
  }
  if (getter === "git") {
    if (address.startsWith("file://")) {
      result.kind = "file";
      return;
    }
    if (isWebOrGitScheme(address)) {
      result.kind = "git";
      result.url = sanitizeUrl(address);
      return;
    }
    const scp = parseScpSource(address);
    if (scp) {
      result.kind = "git";
      result.url = scp.url;
      result.credentialInSource = result.credentialInSource || scp.hasPassword;
    }
    return;
  }
  if (getter === "hg") {
    if (isWebOrGitScheme(address)) {
      result.kind = "hg";
      result.url = sanitizeUrl(address);
    }
    return;
  }
  if (getter === "s3" || getter === "gcs" || getter === "http") {
    if (address.startsWith("http://") || address.startsWith("https://")) {
      result.kind = getter === "s3" || getter === "gcs" ? getter : "http";
      result.url = sanitizeUrl(address);
      result.credentialInSource =
        result.credentialInSource || urlHasPassword(address);
    }
  }
}

/**
 * Parse an `http(s)` address, mapping S3 and GCS hosts to their kinds.
 *
 * @param {string} address Base address
 * @returns {null|{kind: string, url: string|undefined, hasPassword: boolean}}
 */
function parseWebUrl(address) {
  let parsed;
  try {
    parsed = new URL(address);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  let kind = "http";
  if (host.endsWith(".amazonaws.com")) {
    kind = "s3";
  } else if (
    host === "www.googleapis.com" &&
    parsed.pathname.startsWith("/storage/")
  ) {
    kind = "gcs";
  }
  return {
    kind,
    url: sanitizeUrl(address),
    hasPassword: parsed.password !== "",
  };
}

/**
 * Whether a URL carries a password in its userinfo.
 *
 * @param {string} address Absolute URL
 * @returns {boolean}
 */
function urlHasPassword(address) {
  try {
    return new URL(address).password !== "";
  } catch {
    return false;
  }
}

/**
 * Whether the address is an http, https, ssh or git URL.
 *
 * @param {string} address Base address
 * @returns {boolean}
 */
function isWebOrGitScheme(address) {
  return (
    address.startsWith("https://") ||
    address.startsWith("http://") ||
    address.startsWith("ssh://") ||
    address.startsWith("git://")
  );
}

/**
 * Convert an scp-style `user[:password]@host:path` string to an ssh URL.
 *
 * @param {string} address Base address
 * @returns {null|{url: string, hasPassword: boolean}}
 */
function parseScpSource(address) {
  const at = address.lastIndexOf("@");
  if (at < 0) {
    return null;
  }
  const userInfo = address.slice(0, at);
  const hostPart = address.slice(at + 1);
  const colon = hostPart.indexOf(":");
  if (colon < 0) {
    return null;
  }
  const host = hostPart.slice(0, colon);
  const path = hostPart.slice(colon + 1);
  if (!host || !path || host.includes("/")) {
    return null;
  }
  return {
    url: sanitizeUrl(`ssh://${host}/${path}`),
    hasPassword: userInfo.includes(":"),
  };
}

/**
 * Strip userinfo, query and fragment from a URL.
 *
 * The conversion of scp forms to `ssh://` happens before this runs, because a
 * generic URL sanitizer keeps userinfo when it cannot parse an authority.
 *
 * @param {string} address Absolute URL
 * @returns {string|undefined} Sanitized URL
 */
function sanitizeUrl(address) {
  try {
    const parsed = new URL(address);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Match a registry module address: `[host/]namespace/name/system`.
 *
 * @param {string} address Base address
 * @param {string} defaultHost Host for the 3-segment form
 * @returns {null|{host: string, namespace: string, name: string, system: string, address: string}}
 */
function matchRegistryAddress(address, defaultHost) {
  const segments = address.split("/");
  if (segments.length !== 3 && segments.length !== 4) {
    return null;
  }
  let host = null;
  const hasHost = segments.length === 4;
  if (hasHost) {
    let rawHost = segments[0];
    const colon = rawHost.indexOf(":");
    if (colon >= 0) {
      const port = rawHost.slice(colon + 1);
      if (!/^[0-9]+$/.test(port)) {
        return null;
      }
      rawHost = rawHost.slice(0, colon);
    }
    host = rawHost.toLowerCase();
    if (!host.includes(".") && host !== "localhost") {
      return null;
    }
  } else if (segments.some((segment) => segment.includes(":"))) {
    return null;
  }
  const ns = segments[hasHost ? 1 : 0];
  const name = segments[hasHost ? 2 : 1];
  const system = segments[hasHost ? 3 : 2];
  if (
    !REGISTRY_PART.test(ns) ||
    !REGISTRY_PART.test(name) ||
    !REGISTRY_SYSTEM.test(system)
  ) {
    return null;
  }
  const fullHost = (host || defaultHost).toLowerCase();
  const lowerNs = ns.toLowerCase();
  const lowerName = name.toLowerCase();
  const lowerSystem = system.toLowerCase();
  return {
    host: fullHost,
    namespace: lowerNs,
    name: lowerName,
    system: lowerSystem,
    address: `${fullHost}/${lowerNs}/${lowerName}/${lowerSystem}`,
  };
}

/**
 * Parse a `?checksum=<alg>:<hex>` parameter.
 *
 * @param {string} value Raw parameter value
 * @returns {null|{alg: string, content: string}} Digest descriptor
 */
function parseChecksumParam(value) {
  const colon = value.indexOf(":");
  if (colon < 0) {
    return null;
  }
  const spec = CHECKSUM_ALGORITHMS[value.slice(0, colon).toLowerCase()];
  const hex = value.slice(colon + 1);
  if (!spec || hex.length !== spec.length || !HEX_DIGEST.test(hex)) {
    return null;
  }
  return { alg: spec.alg, content: hex.toLowerCase() };
}

/**
 * Build the sanitized display form Terraform itself uses in `modules.json`.
 *
 * @param {Object} result Classified descriptor
 * @returns {string|undefined} Display source
 */
function buildDisplaySource(result) {
  let base;
  if (result.kind === "registry") {
    base = result.address;
  } else if (["git", "hg", "s3", "gcs"].includes(result.kind) && result.url) {
    base = `${result.kind}::${result.url}`;
  } else if (result.kind === "http" && result.url) {
    base = result.url;
  } else {
    return undefined;
  }
  return result.subdir ? `${base}//${result.subdir}` : base;
}

/**
 * Parse a `required_providers` source string into a provider address.
 *
 * @param {string} source Provider source such as `hashicorp/aws` or
 *   `registry.terraform.io/hashicorp/aws`
 * @param {Object} [options]
 * @param {string} [options.defaultRegistryHost] Host for 2-segment shorthand
 * @returns {null|Object} `{ host, namespace, type, address }` lower-cased,
 *   `{ builtin: true }` for `terraform.io/builtin/*`, or `null`
 */
export function parseProviderSource(source, { defaultRegistryHost } = {}) {
  const defaultHost = defaultRegistryHost || TERRAFORM_REGISTRY_HOST;
  if (typeof source !== "string") {
    return null;
  }
  const text = source.trim();
  if (!text || text.includes("::")) {
    return null;
  }
  if (text.toLowerCase().startsWith("terraform.io/builtin/")) {
    return { builtin: true };
  }
  const segments = text.split("/");
  let host;
  let namespace;
  let type;
  if (segments.length === 2) {
    host = defaultHost;
    namespace = segments[0];
    type = segments[1];
  } else if (segments.length === 3) {
    host = segments[0].toLowerCase();
    if (!host.includes(".") && host !== "localhost") {
      return null;
    }
    namespace = segments[1];
    type = segments[2];
  } else {
    return null;
  }
  if (!REGISTRY_PART.test(namespace) || !REGISTRY_PART.test(type)) {
    return null;
  }
  const fullHost = host.toLowerCase();
  const lowerNs = namespace.toLowerCase();
  const lowerType = type.toLowerCase();
  return {
    host: fullHost,
    namespace: lowerNs,
    type: lowerType,
    address: `${fullHost}/${lowerNs}/${lowerType}`,
  };
}

/**
 * Classify a module `version` constraint by how tightly it pins.
 *
 * @param {string} constraint Constraint string from the configuration
 * @returns {Object} `{ pinning: "exact", version }`, `{ pinning: "range" }` or
 *   `{ pinning: "none" }`
 */
export function classifyVersionConstraint(constraint) {
  if (typeof constraint !== "string" || !constraint.trim()) {
    return { pinning: "none" };
  }
  const clauses = constraint.split(",").map((clause) => clause.trim());
  if (clauses.length !== 1) {
    return { pinning: "range" };
  }
  let clause = clauses[0];
  if (clause.startsWith("=")) {
    clause = clause.slice(1).trim();
  }
  if (clause && EXACT_VERSION.test(clause)) {
    return { pinning: "exact", version: clause };
  }
  return { pinning: "range" };
}

/**
 * Classify a git/hg ref by how immutably it identifies a commit.
 *
 * @param {string} ref Ref value from `?ref=` or `?rev=`
 * @returns {"sha"|"tag"|"branch"|"none"}
 */
export function classifyVcsRef(ref) {
  if (typeof ref !== "string" || !ref) {
    return "none";
  }
  if (ref.length > 255) {
    return "branch";
  }
  if (/^[0-9a-f]{40}$/i.test(ref) || /^[0-9a-f]{64}$/i.test(ref)) {
    return "sha";
  }
  if (VCS_TAG.test(ref)) {
    return "tag";
  }
  return "branch";
}

/**
 * Pure parser for `.gitmodules` (git config INI) and a URL→purl coordinate helper.
 *
 * The file format is git-config INI:
 *
 * ```
 * [submodule "name"]
 *     path = third_party/foo
 *     url = https://github.com/org/foo.git
 *     branch = main
 * ```
 *
 * Submodule URLs are frequently *relative* (`../dep`, `../../org/dep`). Such a
 * URL is meaningless until resolved against the origin remote. The
 * {@link resolveSubmoduleUrl} helper takes the origin URL as an argument
 * (rather than discovering it) so this module stays layer 1 — no git, no fs.
 *
 * Purl coordinates are produced here as plain data; the purl *string* is built
 * by the layer-3 resolver via `tryBuildPurl`, because cdx-purl lives in layer 2
 * and a layer-1 parser may not reach it.
 */

const SUBMODULE_HEADER = /^\s*\[submodule\s+"(.*)"\s*\]\s*$/;

/**
 * Parse `.gitmodules` text into an ordered list of submodule descriptors.
 *
 * @param {string} text Raw `.gitmodules` contents
 * @returns {{ name: string, path?: string, url?: string, branch?: string }[]} Submodules in file order
 */
export function parseGitmodules(text) {
  const submodules = [];
  if (!text || typeof text !== "string") {
    return submodules;
  }
  let current = null;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const header = line.match(SUBMODULE_HEADER);
    if (header) {
      current = { name: header[1] };
      submodules.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (!key) {
      continue;
    }
    if (key === "path") {
      current.path = value;
    } else if (key === "url") {
      current.url = value;
    } else if (key === "branch") {
      current.branch = value;
    }
  }
  return submodules;
}

/**
 * Parse a git remote URL into an origin descriptor.
 *
 * Supports https, the `git@host:owner/repo` SSH shorthand, and
 * `ssh://git@host/owner/repo` URLs.
 *
 * @param {string} url Origin remote URL
 * @returns {{ scheme: string, host?: string, owner?: string, name?: string, baseUrl?: string } | null}
 */
export function parseGitRemoteUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const parsed = safeWebUrl(url);
    if (!parsed) {
      return null;
    }
    return parsed;
  }
  if (url.startsWith("git@")) {
    const colon = url.indexOf(":");
    if (colon === -1) {
      return null;
    }
    const host = url.slice(0, colon).split("@")[1];
    const pathPart = url.slice(colon + 1).replace(/\.git$/, "");
    const segments = pathPart.split("/").filter(Boolean);
    const name = segments.pop();
    const owner = segments.join("/");
    if (!host || !name) {
      return null;
    }
    return {
      scheme: "ssh",
      host,
      owner,
      name,
      baseUrl: `https://${host}/${owner}`,
    };
  }
  if (url.startsWith("ssh://")) {
    const noScheme = url.slice("ssh://".length);
    const at = noScheme.indexOf("@");
    const hostStart = at === -1 ? 0 : at + 1;
    const rest = noScheme.slice(hostStart);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      return null;
    }
    const host = rest.slice(0, slash);
    const pathPart = rest.slice(slash + 1).replace(/\.git$/, "");
    const segments = pathPart.split("/").filter(Boolean);
    const name = segments.pop();
    const owner = segments.join("/");
    if (!host || !name) {
      return null;
    }
    return {
      scheme: "ssh",
      host,
      owner,
      name,
      baseUrl: `https://${host}/${owner}`,
    };
  }
  return null;
}

function safeWebUrl(url) {
  try {
    const parsed = new URL(url);
    const pathnameParts = parsed.pathname.split("/").filter(Boolean);
    if (pathnameParts[pathnameParts.length - 1] === "") {
      pathnameParts.pop();
    }
    const name = pathnameParts.pop()?.replace(/\.git$/, "");
    const owner = pathnameParts.join("/");
    if (!name) {
      return null;
    }
    return {
      scheme: parsed.protocol.slice(0, -1),
      host: parsed.hostname,
      owner,
      name,
      baseUrl: `https://${parsed.hostname}/${owner}`,
    };
  } catch {
    return null;
  }
}

/**
 * Longest origin remote URL a relative submodule URL is resolved against.
 *
 * The origin comes from the scanned checkout and is repeated in the resolved
 * URL, and from there in the purl and bom-ref, of every relative submodule.
 * Left unbounded, the output grows with origin length times submodule count.
 * Real origins, including those that embed a CI job token, are far shorter.
 */
const MAX_ORIGIN_URL_LENGTH = 2048;

/**
 * Resolve a submodule URL that may be relative against the origin remote.
 *
 * Git treats the superproject URL as a *directory* rather than a file, so
 * `../bar` against `https://example.com/repositories/foo` resolves to
 * `https://example.com/repositories/bar`, and `./inner` resolves to
 * `https://example.com/repositories/foo/inner`. RFC 3986 would strip the last
 * segment first and land a level higher, so the base carries an explicit
 * trailing slash before resolution. SSH shorthand origins (`git@host:o/root`)
 * are normalised to `https://host/o/root` first.
 *
 * @param {string} submoduleUrl URL from `.gitmodules` (absolute or relative)
 * @param {string} originUrl Origin remote URL of the containing repo
 * @returns {string|null} Absolute URL, or null when it cannot be resolved
 */
export function resolveSubmoduleUrl(submoduleUrl, originUrl) {
  if (!submoduleUrl) {
    return null;
  }
  if (!submoduleUrl.startsWith(".")) {
    return submoduleUrl;
  }
  if (originUrl?.length > MAX_ORIGIN_URL_LENGTH) {
    return null;
  }
  const origin = parseGitRemoteUrl(originUrl);
  if (!origin?.host) {
    return null;
  }
  const originPath = [origin.owner, origin.name].filter(Boolean).join("/");
  const base = `https://${origin.host}/${originPath}/`;
  try {
    const resolved = new URL(submoduleUrl, base);
    resolved.hash = "";
    resolved.password = "";
    resolved.username = "";
    return resolved.href;
  } catch {
    return null;
  }
}

/**
 * Build purl coordinates from a resolved submodule URL.
 *
 * GitHub remotes become `pkg:github/<owner>/<name>@<version>`; every other
 * host becomes `pkg:generic` coordinates with a `vcs_url` qualifier, because
 * only GitHub has a registered purl type that cdx-purl recognises.
 *
 * The caller (layer 3) turns these into a purl string via `tryBuildPurl`.
 *
 * @param {string} resolvedUrl Absolute git URL
 * @param {string} [version] Resolved version (tag or commit SHA)
 * @returns {{ type: string, namespace: string|null, name: string, version: string|null, qualifiers?: { vcs_url: string } } | null}
 */
export function submodulePurlCoordinates(resolvedUrl, version) {
  const remote = parseGitRemoteUrl(resolvedUrl);
  if (!remote?.name) {
    return null;
  }
  if (remote.host === "github.com") {
    // The github purl type namespaces on the owner alone. The host belongs in
    // the type, not the namespace, so `pkg:github/google/benchmark` is the form
    // other tools produce for the same repository.
    return {
      type: "github",
      namespace: remote.owner || null,
      name: remote.name,
      version: version || null,
    };
  }
  return {
    type: "generic",
    namespace: remote.owner ? `${remote.host}/${remote.owner}` : remote.host,
    name: remote.name,
    version: version || null,
    qualifiers: { vcs_url: resolvedUrl },
  };
}

import { URL } from "node:url";

import { build, Purl, TypedPurls } from "@cdxgen/cdx-purl";

import { DEBUG_MODE } from "../core/activity.js";

/**
 * The set of purl types that carry validation rules in cdx-purl.
 *
 * cdx-purl's `build()` is permissive: it accepts *any* type string (even an
 * unregistered one like `pkg:nix/...`) without throwing, because the "type"
 * segment of a Package URL is not restricted by the spec. What distinguishes a
 * *registered* type is that cdx-purl ships a rule table for it
 * (`TYPE_RULES_SOURCE`, exposed as `TypedPurls`) — namespace requirements,
 * permitted qualifiers, and so on. A purl built with an unregistered type
 * round-trips but gets no type-specific normalization, and more importantly it
 * identifies a package in a namespace no vulnerability database or advisory
 * feed recognises.
 *
 * Ecosystems cdxgen supports that have no registered type (nix, zig, mojo, and
 * gleam when it is not published via hex) must therefore emit `pkg:generic/...`
 * with a `cdx:purl:proposedType` property instead of squatting a type. This set
 * is the single source of truth for that decision, sourced directly from
 * cdx-purl so it updates automatically when a type is registered upstream.
 */
export const REGISTERED_PURL_TYPES = new Set(Object.keys(TypedPurls));

/**
 * Report whether a purl type is registered in cdx-purl's rule table.
 *
 * @param {string} type Purl type (the segment after `pkg:`)
 * @returns {boolean} `true` when the type carries validation rules upstream
 */
export function purlTypeIsRegistered(type) {
  return REGISTERED_PURL_TYPES.has(type);
}

/**
 * Longest run of "/" a purl may contain before cdx-purl is asked to parse it.
 * cdx-purl trims trailing slashes of the path and subpath with a pattern that
 * takes time quadratic in such a run, and the purl is often supplied by a
 * scanned project, a BOM or a server client. A valid purl has no repeated
 * slash at all, so the limit is generous.
 */
export const MAX_PURL_SLASH_RUN = 64;

/**
 * Report whether a string has a run of "/" longer than
 * {@link MAX_PURL_SLASH_RUN}.
 *
 * @param {string} purlString Purl string to inspect
 * @returns {boolean} `true` when the run is too long to hand to cdx-purl
 */
export function hasExcessiveSlashRun(purlString) {
  if (typeof purlString !== "string") {
    return false;
  }
  let run = 0;
  for (let i = 0; i < purlString.length; i++) {
    if (purlString.charCodeAt(i) === 47) {
      run += 1;
      if (run > MAX_PURL_SLASH_RUN) {
        return true;
      }
    } else {
      run = 0;
    }
  }
  return false;
}

/**
 * Report whether a purl string uses a type that cdx-purl has registered rules
 * for. Purls that fail to parse are treated as unregistered rather than
 * throwing, because the caller is vetting untrusted output.
 *
 * @param {string} purlString Purl string to vet
 * @returns {boolean} `true` when the purl's type is registered upstream
 */
export function purlTypeIsRegisteredString(purlString) {
  if (hasExcessiveSlashRun(purlString)) {
    return false;
  }
  try {
    const parsed = Purl.parse(purlString);
    return purlTypeIsRegistered(parsed.type);
  } catch {
    return false;
  }
}

/**
 * Encode a string for inclusion in a hand-written PackageURL string,
 * percent-encoding every character the purl grammar does not allow literally,
 * while preserving already-encoded `%40` sequences and keeping `:` and `/`
 * unencoded.
 *
 * `encodeURIComponent` alone leaves `!`, `'`, `(`, `)` and `*` literal, and the
 * purl grammar requires them escaped, so they are escaped here as well.
 *
 * Only for comparing against or assembling purl text. Never pass the result to
 * `build()`, `new Purl()` or one of the helpers in this module: they escape
 * their inputs themselves, and escaping twice turns `+` into `%252B`.
 *
 * @param {string} s String to encode
 * @returns {string} Encoded string suitable for use in a PackageURL component
 */
export function encodeForPurl(s) {
  return s && !s.includes("%40")
    ? encodeURIComponent(s)
        .replace(
          /[!'()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        )
        .replace(/%3A/g, ":")
        .replace(/%2F/g, "/")
    : s;
}

/**
 * Build a purl string, returning `null` instead of throwing when the parts do
 * not form a valid purl.
 *
 * cdx-purl is strict: it rejects a maven purl without a groupId, a swift or
 * golang purl without a namespace, a vscode-extension without a publisher, and
 * so on. Those rejections are correct and must not be papered over — but they
 * also must not crash a scan of an otherwise fine project. This helper is the
 * one sanctioned place to turn a `PurlError` into an absent purl.
 *
 * Only `PurlError` is swallowed. Anything else (a `TypeError` from a bad call,
 * for instance) is a defect in the caller and is rethrown.
 *
 * @param {object} parts Purl parts accepted by cdx-purl's `build()`
 * @returns {string|null} Canonical purl string, or `null` if it is not valid
 */
export function tryBuildPurl(parts) {
  try {
    return build(parts);
  } catch (err) {
    if (err?.code?.startsWith("E_")) {
      if (DEBUG_MODE) {
        console.log(`Unable to construct a purl from ${JSON.stringify(parts)}`);
      }
      return null;
    }
    throw err;
  }
}

/**
 * Build a canonical npm purl from a package name and version.
 *
 * Prefer this over hand-assembling `pkg:npm/...` strings. Manual assembly has
 * to re-implement percent-encoding and gets it wrong in ways cdx-purl then
 * rejects: an unencoded `+` in a semver build-metadata version
 * (`1.0.0+build.1`) throws `E_INVALID_CHARACTER`, and the scope separator has
 * to survive encoding. `build()` handles both, so callers pass raw values.
 *
 * @param {string} pkgName Package name, optionally scoped (`@scope/name`)
 * @param {string} [version] Package version, raw and unencoded
 * @returns {string} Canonical npm purl string
 */
export function npmPurl(pkgName, version) {
  let namespace = null;
  let name = pkgName;
  if (pkgName?.startsWith("@")) {
    const slash = pkgName.indexOf("/");
    if (slash > -1) {
      namespace = pkgName.slice(0, slash);
      name = pkgName.slice(slash + 1);
    }
  }
  return build({
    type: "npm",
    namespace,
    name,
    version: version || null,
  });
}

/**
 * Longest text read as a NuGet version or version range: the limit CycloneDX
 * sets for a component version. One resolved version or MSBuild property can
 * serve every reference that leaves its own version open, and each of them
 * builds a purl and a bom-ref from it, so the text has to be bounded.
 */
export const MAX_NUGET_VERSION_LENGTH = 1024;

/**
 * Detect whether a version string is a concrete version or an MSBuild
 * expression / NuGet range that names no single version.
 *
 * NuGet project files express versions in a small language of their own:
 * `$(TargetFSharpCoreVersion)` is an MSBuild property that only a build
 * evaluates, `1.0-*` is a floating range, and `[1.0,2.0)` is an interval.
 * None of them is a version, so none can be encoded into a purl — the result
 * would parse but identify no package. Neither is a text longer than
 * {@link MAX_NUGET_VERSION_LENGTH} characters.
 *
 * Callers resolve such a version from a manifest that pins one (paket.lock,
 * packages.lock.json, project.assets.json, Directory.Packages.props). This
 * function is the last-resort guard for when no manifest pins it: the purl is
 * then emitted without a version rather than with a meaningless one.
 *
 * It encodes NuGet's syntax specifically, so it belongs to the NuGet helpers
 * and not to purl construction in general — an ecosystem that allows brackets
 * or commas in a legitimate version must not have it applied.
 *
 * @param {string} version Candidate version
 * @returns {string|null} The version when concrete, or null to omit it
 */
export function concreteVersion(version) {
  if (!version || typeof version !== "string") {
    return null;
  }
  // Checked before the text is read, so a long one costs no more to turn down
  if (version.length > MAX_NUGET_VERSION_LENGTH) {
    return null;
  }
  const v = version.trim();
  if (!v) {
    return null;
  }
  // MSBuild property reference: $(VariableName)
  if (v.includes("$(")) {
    return null;
  }
  // Floating version range or wildcard: 1.0-*, *, 1.*
  if (/[*]/.test(v)) {
    return null;
  }
  // Bracketed range: [1.0,2.0), (1.0,)
  if (/[[\](),]/.test(v)) {
    return null;
  }
  return v;
}

/**
 * Build a canonical NuGet purl from a package name and version.
 *
 * The version is expected to have been resolved from a manifest that pins one.
 * An MSBuild expression or NuGet range that reaches here unresolved is dropped
 * by {@link concreteVersion}, leaving a versionless purl that identifies the
 * package rather than a version-shaped purl that identifies nothing.
 *
 * @param {string} name Package name
 * @param {string} [version] Package version (may be non-concrete)
 * @returns {string|null} Canonical purl, or null when the name is empty
 */
export function nugetPurl(name, version) {
  return tryBuildPurl({
    type: "nuget",
    name,
    version: concreteVersion(version),
  });
}

/**
 * Build a canonical PyPI purl from a package name and version.
 *
 * PyPI normalises underscores to hyphens in the name component.
 *
 * @param {string} name Package name (underscores will be normalised)
 * @param {string} [version] Package version
 * @returns {string|null} Canonical purl, or null when invalid
 */
export function pypiPurl(name, version) {
  return tryBuildPurl({
    type: "pypi",
    name: (name || "").replaceAll("_", "-"),
    version,
  });
}

/**
 * Identifier a dependency graph uses to reference a PyPI component.
 *
 * PyPI names are case-insensitive and treat `_` and `-` as equivalent, so
 * cdx-purl folds both when it builds the purl. A reference assembled by hand
 * from the raw name does not, and then names out of the same distribution
 * disagree: a `zope_interface` requirement points at nothing while the
 * component is `pkg:pypi/zope-interface`. Deriving the reference from the purl
 * keeps the graph attached to the components.
 *
 * @param {string} name Package name
 * @param {string} [version] Package version
 * @returns {string} bom-ref for the component
 */
export function pypiBomRef(name, version) {
  const purl = pypiPurl(name, version);
  if (purl) {
    return decodeURIComponent(purl);
  }
  return `library:${name}:${version || ""}`;
}

/**
 * Build a canonical Maven purl from group, name, and version.
 *
 * @param {string} group Group ID (required for Maven)
 * @param {string} name Artifact ID
 * @param {string} [version] Version
 * @param {object} [qualifiers] Optional qualifiers (e.g. `{type: "jar"}`)
 * @returns {string|null} Canonical purl, or null when invalid
 */
export function mavenPurl(group, name, version, qualifiers) {
  return tryBuildPurl({
    type: "maven",
    namespace: group,
    name,
    version,
    qualifiers: qualifiers || undefined,
  });
}

/**
 * Build a purl for a Nix flake input using the registered `generic` type.
 *
 * `nix` is not a registered purl type in cdx-purl, so emitting `pkg:nix/...`
 * would squat a namespace no vulnerability database recognises. Nix inputs are
 * therefore identified as generic packages, disambiguated by a `vcs_url`
 * qualifier built from the flake lock, and tagged with a
 * `cdx:purl:proposedType=nix` property on the component so the intended type is
 * recoverable. If `nix` is ever registered upstream, callers can switch over
 * without touching the property scheme.
 *
 * Callers pass the already-encoded qualifier values they derived from the lock
 * node; this helper only owns purl construction.
 *
 * @param {string} name Package name
 * @param {string} [version] Package version (typically the short revision)
 * @param {object} [qualifiers] Optional qualifiers such as `{ vcs_url }`
 * @returns {string|null} Canonical purl, or null when invalid
 */
export function nixGenericPurl(name, version, qualifiers) {
  return tryBuildPurl({
    type: "generic",
    name,
    version,
    qualifiers: qualifiers || undefined,
  });
}

/**
 * Identifier for a Nix flake project, whose version is not pinned by the flake
 * itself.
 *
 * A flake project is named after its directory. The bom-ref deliberately uses
 * the `application:name:version` shape (matching `fallbackBomRef`) rather than a
 * `pkg:` string, because `nix` is not a registered purl type and a bom-ref that
 * looks like a purl but is not valid would mislead downstream tooling.
 *
 * @param {string} name Project name
 * @returns {string} bom-ref for the component
 */
export function nixBomRef(name) {
  return `application:${name}:latest`;
}

/**
 * Build a canonical generic purl from a name.
 *
 * @param {string} name Package name
 * @returns {string|null} Canonical purl, or null when invalid
 */
export function genericPurl(name) {
  return tryBuildPurl({
    type: "generic",
    name,
  });
}

/**
 * Report whether a string is a valid purl according to cdx-purl.
 *
 * Use this before writing anything into a CycloneDX `purl` field that did not
 * come from `build()` — notably when recovering a purl from a `bom-ref`, which
 * is an opaque identifier and frequently is not a purl at all.
 *
 * @param {string} candidate String to test
 * @returns {boolean} true when cdx-purl parses it
 */
export function isValidPurl(candidate) {
  if (
    !candidate ||
    typeof candidate !== "string" ||
    hasExcessiveSlashRun(candidate)
  ) {
    return false;
  }
  try {
    Purl.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Split a purl into its components without requiring it to be well-formed.
 *
 * `Purl.parse` rejects a purl whose parts are not already escaped, which is the
 * case this exists to handle: a `bom-ref` (cdxgen writes the decoded form of the
 * purl there), a `go mod graph` token such as `github.com/Azure/go-autorest@v14.2.0+incompatible`,
 * or a purl from a third-party document that left a `+` or a `://` unescaped.
 * The separators (`:`, `/`, `@`, `?`, `#`, `&`, `=`) are structural and are read
 * positionally; everything between them is decoded and handed back raw, ready
 * for `build` to escape correctly.
 *
 * The version is taken after the last `@` of the path, so a scoped npm name
 * (`@scope/name@1.0.0`) and a composer branch version (`dev-feature/x`) both
 * split correctly.
 *
 * @param {string} purl Purl to split
 * @returns {{type: string, namespace: (string|null), name: string, version: (string|null), qualifiers: (Object|null), subpath: (string|null)}|null} Parts, or null when the purl has no type and name
 */
export function splitPurlLoose(purl) {
  if (typeof purl !== "string" || !purl.startsWith("pkg:")) {
    return null;
  }
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  let rest = purl.slice("pkg:".length).replace(/^\/+/, "");
  let subpath = null;
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    subpath = decode(rest.slice(hash + 1)) || null;
    rest = rest.slice(0, hash);
  }
  let qualifiers = null;
  const query = rest.indexOf("?");
  if (query !== -1) {
    qualifiers = {};
    for (const pair of rest.slice(query + 1).split("&")) {
      const equals = pair.indexOf("=");
      if (equals <= 0) {
        continue;
      }
      qualifiers[pair.slice(0, equals)] = decode(pair.slice(equals + 1));
    }
    if (!Object.keys(qualifiers).length) {
      qualifiers = null;
    }
    rest = rest.slice(0, query);
  }
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const type = rest.slice(0, slash);
  let path = rest.slice(slash + 1);
  let version = null;
  const at = path.lastIndexOf("@");
  if (at > 0 && path[at - 1] !== "/") {
    version = decode(path.slice(at + 1)) || null;
    path = path.slice(0, at);
  }
  const segments = path.split("/").filter(Boolean).map(decode);
  const name = segments.pop();
  if (!name) {
    return null;
  }
  return {
    type,
    namespace: segments.length ? segments.join("/") : null,
    name,
    version,
    qualifiers,
    subpath,
  };
}

/**
 * Parse a purl string that may carry unescaped reserved characters.
 *
 * A well-formed purl is parsed strictly, so its components come back exactly as
 * cdx-purl reads them. Anything else is split structurally by
 * {@link splitPurlLoose}. Use this where the input is known to be a decoded or
 * hand-written purl (a `bom-ref`, a workspace reference, a package manager's
 * `name@version` token), never to accept an invalid purl into a `purl` field:
 * pass the parts to `build()` instead, which escapes them.
 *
 * @param {string} purlString Purl or decoded purl
 * @returns {{type: string, namespace: (string|null), name: string, version: (string|null), qualifiers: (Object|null), subpath: (string|null)}|null} Raw components, or null when nothing purl-shaped remains
 */
export function parsePurlLoose(purlString) {
  if (
    typeof purlString !== "string" ||
    !purlString.startsWith("pkg:") ||
    hasExcessiveSlashRun(purlString)
  ) {
    return null;
  }
  try {
    const parsed = Purl.parse(purlString);
    return {
      type: parsed.type,
      namespace: parsed.namespace || null,
      name: parsed.name,
      version: parsed.version || null,
      qualifiers: parsed.qualifiers || null,
      subpath: parsed.subpath || null,
    };
  } catch (err) {
    if (!err?.code?.startsWith("E_")) {
      throw err;
    }
  }
  return splitPurlLoose(purlString);
}

/**
 * Turn a decoded or hand-written purl into a canonical, correctly escaped one.
 *
 * `bom-ref` values are the decoded form of a purl
 * (`pkg:npm/foo@1.0.0+build`), which cdx-purl rightly rejects as a purl. This
 * recovers the purl the ref was made from by splitting it structurally and
 * rebuilding it with `build()`, so every reserved character is escaped exactly
 * once.
 *
 * @param {string} purlString Purl or decoded purl
 * @returns {string|null} Canonical purl string, or `null` when no valid purl can be built
 */
export function canonicalPurlFromLooseString(purlString) {
  const parts = parsePurlLoose(purlString);
  if (!parts) {
    return null;
  }
  return tryBuildPurl(parts);
}

/**
 * Parse a purl string, returning `null` instead of throwing when it is invalid.
 *
 * The parse-side counterpart of {@link tryBuildPurl}, for callers that have
 * already assembled a purl string. Only `PurlError` is swallowed.
 *
 * @param {string} purlString Candidate purl
 * @returns {string|null} Canonical purl string, or `null` if it is not valid
 */
export function tryParsePurl(purlString) {
  try {
    return Purl.parse(purlString).toString();
  } catch (err) {
    if (err?.code?.startsWith("E_")) {
      return null;
    }
    throw err;
  }
}

/**
 * Build a `bom-ref` for a component that has no valid purl.
 *
 * `bom-ref` must be **unique within the document** — CycloneDX uses it as the
 * key for the dependency graph, so two components sharing one silently merge
 * their edges. The bare component name is therefore not usable: the syft go
 * module graph contains eight versions of `go.opencensus.io`, none of which can
 * carry a golang purl (cdx-purl requires a namespace), and naming them all
 * `go.opencensus.io` collapsed eight distinct modules into one ref.
 *
 * The `type:group/name:version` shape matches the convention already used for
 * root components (`application:swift-smoke:latest`) and for the dedupe key in
 * `lib/stages/postgen/ruleEngine.js`.
 *
 * @param {object} component Component with `type`, `group`, `name`, `version`
 * @returns {string} A document-unique, deterministic bom-ref
 */
export function fallbackBomRef(component) {
  const type = component?.type || "library";
  const group = component?.group ? `${component.group}/` : "";
  const name = component?.name || "unnamed";
  const version = component?.version || "";
  return `${type}:${group}${name}:${version}`;
}

/**
 * Attach a purl and `bom-ref` to a component, never emitting an invalid purl.
 *
 * CycloneDX requires `component.purl` to be a valid Package URL when present,
 * so a component we cannot build a purl for must omit the field entirely — it
 * must *not* fall back to the bare name, which is what produced
 * `"purl": "swift-smoke"` in the swift golden.
 *
 * `bom-ref` has no syntax constraint but does have a uniqueness constraint, so
 * the fallback goes through {@link fallbackBomRef} rather than using the name.
 *
 * Any pre-existing `purl` is deleted when the new one is invalid, so a
 * component cannot retain a stale purl from an earlier enrichment pass.
 *
 * @param {object} component Component to mutate
 * @param {string|null} purlString Canonical purl string, or `null`/`undefined`
 * @param {string} [fallbackRef] Explicit `bom-ref` override for when there is no purl
 * @returns {object} The same component, for chaining
 */
export function applyPurl(component, purlString, fallbackRef) {
  if (purlString) {
    component.purl = purlString;
    component["bom-ref"] = decodeURIComponent(purlString);
  } else {
    delete component.purl;
    component["bom-ref"] = fallbackRef ?? fallbackBomRef(component);
  }
  return component;
}

/**
 * Sanitize a purl that cdxgen did not author.
 *
 * cdxgen ingests components from places it does not control — caxa binary
 * metadata, existing SBOMs supplied as input, converter output. Those purls can
 * be invalid (`@cdxgen/caxa` emitted `pkg:generic/...?arch=…&platform=…`, and
 * `arch`/`platform` are not qualifiers the `generic` type allows), and cdxgen
 * must neither emit an invalid purl it merely read nor hard-fail on third-party
 * data.
 *
 * Order of preference:
 *   1. Keep the purl when it is already valid.
 *   2. Rebuild a canonical purl from the component's own type/group/name/version.
 *   3. Drop the purl and assign a unique fallback `bom-ref`.
 *
 * The original string is preserved in a property whenever it is discarded, so the
 * provenance of the change is visible in the output rather than silent.
 *
 * @param {object} component Component to sanitize in place
 * @param {string} [purlType] purl type to use when rebuilding (default `generic`)
 * @returns {object} The same component, for chaining
 */
export function sanitizeIngestedPurl(component, purlType) {
  if (!component || typeof component !== "object") {
    return component;
  }
  const original = component.purl;
  if (!original || typeof original !== "string") {
    return component;
  }
  if (isValidPurl(original)) {
    return component;
  }
  let rebuilt = null;
  try {
    const parsedType = original.startsWith("pkg:")
      ? original.slice(4).split("/")[0].split("@")[0]
      : null;
    rebuilt = tryBuildPurl({
      type: purlType || parsedType || "generic",
      namespace: component.group || null,
      name: component.name,
      version: component.version || null,
    });
  } catch {
    rebuilt = null;
  }
  component.properties = component.properties || [];
  component.properties.push({
    name: "cdx:purl:sanitized_from",
    value: original,
  });
  return applyPurl(component, rebuilt);
}

/**
 * Build an `oci` purl from a Docker/OCI repository digest.
 *
 * The `oci` type **prohibits** a namespace, so the registry-qualified repository
 * cannot go in the purl path: `pkg:oci/docker.io/library/alpine@sha256:…` is
 * invalid. Per the purl spec the name is the repository's last segment, the
 * version is the digest, and the full repository travels in `repository_url`.
 *
 * @param {string} repoDigest e.g. `docker.io/library/alpine@sha256:abc…`
 * @param {string} [tag] Optional image tag, emitted as the `tag` qualifier
 * @returns {string|null} Canonical purl, or `null` when one cannot be built
 */
export function ociPurl(repoDigest, tag) {
  if (!repoDigest || typeof repoDigest !== "string") {
    return null;
  }
  const atIndex = repoDigest.lastIndexOf("@");
  const repository = atIndex > -1 ? repoDigest.slice(0, atIndex) : repoDigest;
  const digest = atIndex > -1 ? repoDigest.slice(atIndex + 1) : null;
  const segments = repository.split("/").filter(Boolean);
  const name = segments[segments.length - 1];
  if (!name) {
    return null;
  }
  const qualifiers = {};
  // Only worth recording when it carries more than the bare name.
  if (segments.length > 1) {
    qualifiers.repository_url = repository;
  }
  if (tag) {
    qualifiers.tag = tag;
  }
  return tryBuildPurl({
    type: "oci",
    name: name.toLowerCase(),
    version: digest,
    qualifiers: Object.keys(qualifiers).length ? qualifiers : null,
  });
}

/**
 * Create a PackageURL object from a repository URL string, package type, and version.
 *
 * Supports HTTPS URLs, SSH `git@` URLs, Bitbucket SSH URLs, and local paths.
 * Extracts the namespace (host + path prefix) and repository name from the URL.
 *
 * @param {string} type PackageURL type (e.g. `"swift"`, `"generic"`)
 * @param {string} repoUrl Repository URL string
 * @param {string} version Package version
 * @returns {PackageURL|undefined} PackageURL object, or undefined for unsupported URL formats
 */
export function purlFromUrlString(type, repoUrl, version) {
  let namespace = "";
  let name;
  if (repoUrl?.startsWith("http")) {
    const url = new URL(repoUrl);
    const pathnameParts = url.pathname.split("/");
    // Bug #4136 fix. Strip trailing slash
    if (pathnameParts[pathnameParts.length - 1] === "") {
      pathnameParts.pop();
    }
    const pathnameLastElement = pathnameParts.pop(); // pop() returns last element and removes it from pathnameParts
    name = pathnameLastElement.replace(".git", "");
    const urlpath = pathnameParts.join("/");
    namespace = url.hostname + urlpath;
  } else if (repoUrl?.startsWith("git@")) {
    const parts = repoUrl.split(":");
    const hostname = parts[0].split("@")[1];
    const pathnameParts = parts[1].split("/");
    const pathnameLastElement = pathnameParts.pop();
    name = pathnameLastElement.replace(".git", "");
    const urlpath = pathnameParts.join("/");
    namespace = `${hostname}/${urlpath}`;
  } else if (repoUrl?.startsWith("ssh://git@bitbucket")) {
    repoUrl = repoUrl.replace("ssh://git@", "");
    const parts = repoUrl.split(":");
    const hostname = parts[0];
    const pathnameParts = parts[1].split("/").slice(1);
    const pathnameLastElement = pathnameParts.pop();
    name = pathnameLastElement.replace(".git", "");
    const urlpath = pathnameParts.join("/");
    namespace = `${hostname}/${urlpath}`;
  } else if (repoUrl?.startsWith("/")) {
    const parts = repoUrl.split("/");
    name = parts[parts.length - 1] || "unknown";
    if (type === "swift") {
      // cdx-purl requires a swift namespace with host/owner segments.
      // Local paths have none, so return undefined and let the caller
      // construct the component without a purl.
      return undefined;
    }
  } else {
    if (DEBUG_MODE) {
      console.warn("unsupported repo url for swift type");
    }
    return undefined;
  }

  return new Purl({
    type: type,
    namespace: namespace || null,
    name: name,
    version: version || null,
  });
}

/**
 * NOT IMPLEMENTED YET.
 * A future method to locate a generic package given some name and properties
 *
 * @param {object} apkg Package to locate
 * @returns Located project with precise purl or the original unmodified input.
 */
export function locateGenericPackage(apkg) {
  return apkg;
}

function createConanPurlString(name, version, user, channel, rrev, prev) {
  // https://github.com/package-url/purl-spec/blob/master/PURL-TYPES.rst#conan

  const qualifiers = {};

  if (user) qualifiers["user"] = user;
  if (channel) qualifiers["channel"] = channel;
  if (rrev) qualifiers["rrev"] = rrev;
  if (prev) qualifiers["prev"] = prev;

  return build({
    type: "conan",
    namespace: "" || null,
    name: name,
    version: version || null,
    qualifiers: Object.keys(qualifiers).length ? qualifiers : null || null,
  });
}

function untilFirst(separator, inputStr) {
  // untilFirst("/", "a/b") -> ["/", "a", "b"]
  // untilFirst("/", "abc") -> ["/", "abc", null]

  if (!inputStr || inputStr.length === 0) {
    return [null, null, null];
  }

  const separatorIndex = inputStr.search(separator);
  if (separatorIndex === -1) {
    return ["", inputStr, null];
  }
  return [
    inputStr[separatorIndex],
    inputStr.substring(0, separatorIndex),
    inputStr.substring(separatorIndex + 1),
  ];
}

/**
 * Parse a Conan package reference into purl coordinates.
 *
 * Accepts references such as `name/version@user/channel#recipe_revision` and
 * returns a `[purl, name, version]` tuple, or `[null, null, null]` when the
 * reference cannot be parsed.
 *
 * @param {string} conanPkgRef Conan package reference
 * @returns {(string|null)[]} Tuple of purl string, package name, and version
 */
export function mapConanPkgRefToPurlStringAndNameAndVersion(conanPkgRef) {
  // A full Conan package reference may be composed of the following segments:
  // conanPkgRef = "name/version@user/channel#recipe_revision:package_id#package_revision"
  // See also https://docs.conan.io/1/cheatsheet.html#package-terminology

  // The components 'package_id' and 'package_revision' do not appear in any files processed by cdxgen.
  // The components 'user' and 'channel' are not mandatory.
  // 'name/version' is a valid Conan package reference, so is 'name/version@user/channel' or 'name/version@user/channel#recipe_revision'.
  // pURL for Conan does not recognize 'package_id'.

  const UNABLE_TO_PARSE_CONAN_PKG_REF = [null, null, null];

  if (!conanPkgRef) {
    if (DEBUG_MODE)
      console.warn(
        `Could not parse Conan package reference '${conanPkgRef}', input does not seem valid.`,
      );

    return UNABLE_TO_PARSE_CONAN_PKG_REF;
  }

  const separatorRegex = /[@#:\/]/;

  const info = {
    name: null,
    version: null,
    user: null,
    channel: null,
    recipe_revision: null,
    package_id: null,
    package_revision: null,
    phase_history: [],
  };

  const transitions = {
    ["name"]: {
      "/": "version",
      "#": "recipe_revision",
      "": "end",
    },
    ["version"]: {
      "@": "user",
      "#": "recipe_revision",
      "": "end",
    },
    ["user"]: {
      "/": "channel",
    },
    ["channel"]: {
      "#": "recipe_revision",
      "": "end",
    },
    ["recipe_revision"]: {
      ":": "package_id",
      "": "end",
    },
    ["package_id"]: {
      "#": "package_revision",
    },
    ["package_revision"]: {
      "": "end",
    },
  };

  let phase = "name";
  let remainder = conanPkgRef;
  let separator;
  let item;

  while (remainder) {
    [separator, item, remainder] = untilFirst(separatorRegex, remainder);

    if (!item) {
      if (DEBUG_MODE)
        console.warn(
          `Could not parse Conan package reference '${conanPkgRef}', empty item in phase '${phase}', separator=${separator}, remainder=${remainder}, info=${JSON.stringify(info)}`,
        );
      return UNABLE_TO_PARSE_CONAN_PKG_REF;
    }

    info[phase] = item;
    info.phase_history.push(phase);

    if (!(phase in transitions)) {
      if (DEBUG_MODE)
        console.warn(
          `Could not parse Conan package reference '${conanPkgRef}', no transition from '${phase}', separator=${separator}, item=${item}, remainder=${remainder}, info=${JSON.stringify(info)}`,
        );
      return UNABLE_TO_PARSE_CONAN_PKG_REF;
    }

    const possibleTransitions = transitions[phase];
    if (!(separator in possibleTransitions)) {
      if (DEBUG_MODE)
        console.warn(
          `Could not parse Conan package reference '${conanPkgRef}', transition '${separator}' not allowed from '${phase}', item=${item}, remainder=${remainder}, info=${JSON.stringify(info)}`,
        );
      return UNABLE_TO_PARSE_CONAN_PKG_REF;
    }

    phase = possibleTransitions[separator];
  }

  if (phase !== "end") {
    if (DEBUG_MODE)
      console.warn(
        `Could not parse Conan package reference '${conanPkgRef}', end of input string reached unexpectedly in phase '${phase}', info=${JSON.stringify(info)}.`,
      );
    return UNABLE_TO_PARSE_CONAN_PKG_REF;
  }

  if (!info.version) info.version = "latest";

  const purl = createConanPurlString(
    info.name,
    info.version,
    info.user,
    info.channel,
    info.recipe_revision,
    info.package_revision,
  );

  return [purl, info.name, info.version];
}

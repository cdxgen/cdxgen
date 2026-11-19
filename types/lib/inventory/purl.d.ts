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
export declare const REGISTERED_PURL_TYPES: Set<string>;
/**
 * Report whether a purl type is registered in cdx-purl's rule table.
 *
 * @param {string} type Purl type (the segment after `pkg:`)
 * @returns {boolean} `true` when the type carries validation rules upstream
 */
export declare function purlTypeIsRegistered(type: string): boolean;
/**
 * Longest run of "/" a purl may contain before cdx-purl is asked to parse it.
 * cdx-purl trims trailing slashes of the path and subpath with a pattern that
 * takes time quadratic in such a run, and the purl is often supplied by a
 * scanned project, a BOM or a server client. A valid purl has no repeated
 * slash at all, so the limit is generous.
 */
export declare const MAX_PURL_SLASH_RUN = 64;
/**
 * Report whether a string has a run of "/" longer than
 * {@link MAX_PURL_SLASH_RUN}.
 *
 * @param {string} purlString Purl string to inspect
 * @returns {boolean} `true` when the run is too long to hand to cdx-purl
 */
export declare function hasExcessiveSlashRun(purlString: string): boolean;
/**
 * Report whether a purl string uses a type that cdx-purl has registered rules
 * for. Purls that fail to parse are treated as unregistered rather than
 * throwing, because the caller is vetting untrusted output.
 *
 * @param {string} purlString Purl string to vet
 * @returns {boolean} `true` when the purl's type is registered upstream
 */
export declare function purlTypeIsRegisteredString(purlString: string): boolean;
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
export declare function encodeForPurl(s: string): string;
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
export declare function tryBuildPurl(parts: object): string | null;
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
export declare function npmPurl(pkgName: string, version?: string): string;
/**
 * Longest text read as a NuGet version or version range: the limit CycloneDX
 * sets for a component version. One resolved version or MSBuild property can
 * serve every reference that leaves its own version open, and each of them
 * builds a purl and a bom-ref from it, so the text has to be bounded.
 */
export declare const MAX_NUGET_VERSION_LENGTH = 1024;
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
export declare function concreteVersion(version: string): string | null;
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
export declare function nugetPurl(name: string, version?: string): string | null;
/**
 * Build a canonical PyPI purl from a package name and version.
 *
 * PyPI normalises underscores to hyphens in the name component.
 *
 * @param {string} name Package name (underscores will be normalised)
 * @param {string} [version] Package version
 * @returns {string|null} Canonical purl, or null when invalid
 */
export declare function pypiPurl(name: string, version?: string): string | null;
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
export declare function pypiBomRef(name: string, version?: string): string;
/**
 * Build a canonical Maven purl from group, name, and version.
 *
 * @param {string} group Group ID (required for Maven)
 * @param {string} name Artifact ID
 * @param {string} [version] Version
 * @param {object} [qualifiers] Optional qualifiers (e.g. `{type: "jar"}`)
 * @returns {string|null} Canonical purl, or null when invalid
 */
export declare function mavenPurl(group: string, name: string, version?: string, qualifiers?: object): string | null;
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
export declare function nixGenericPurl(name: string, version?: string, qualifiers?: object): string | null;
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
export declare function nixBomRef(name: string): string;
/**
 * Build a canonical generic purl from a name.
 *
 * @param {string} name Package name
 * @returns {string|null} Canonical purl, or null when invalid
 */
export declare function genericPurl(name: string): string | null;
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
export declare function isValidPurl(candidate: string): boolean;
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
export declare function splitPurlLoose(purl: string): {
    type: string;
    namespace: (string | null);
    name: string;
    version: (string | null);
    qualifiers: (Object | null);
    subpath: (string | null);
} | null;
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
export declare function parsePurlLoose(purlString: string): {
    type: string;
    namespace: (string | null);
    name: string;
    version: (string | null);
    qualifiers: (Object | null);
    subpath: (string | null);
} | null;
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
export declare function canonicalPurlFromLooseString(purlString: string): string | null;
/**
 * Parse a purl string, returning `null` instead of throwing when it is invalid.
 *
 * The parse-side counterpart of {@link tryBuildPurl}, for callers that have
 * already assembled a purl string. Only `PurlError` is swallowed.
 *
 * @param {string} purlString Candidate purl
 * @returns {string|null} Canonical purl string, or `null` if it is not valid
 */
export declare function tryParsePurl(purlString: string): string | null;
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
export declare function fallbackBomRef(component: object): string;
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
export declare function applyPurl(component: object, purlString: string | null, fallbackRef?: string): object;
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
export declare function sanitizeIngestedPurl(component: object, purlType?: string): object;
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
export declare function ociPurl(repoDigest: string, tag?: string): string | null;
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
export declare function purlFromUrlString(type: string, repoUrl: string, version: string): PackageURL | undefined;
/**
 * NOT IMPLEMENTED YET.
 * A future method to locate a generic package given some name and properties
 *
 * @param {object} apkg Package to locate
 * @returns Located project with precise purl or the original unmodified input.
 */
export declare function locateGenericPackage(apkg: object): object;
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
export declare function mapConanPkgRefToPurlStringAndNameAndVersion(conanPkgRef: string): (string | null)[];
//# sourceMappingURL=purl.d.ts.map
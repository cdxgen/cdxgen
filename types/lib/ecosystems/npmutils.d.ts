/**
 * Marks an npm component as development-only.
 *
 * @param {object} pkg Component object to annotate
 * @returns {void}
 */
export declare function setNpmDevelopmentProperty(pkg: object): void;
/**
 * Marks an npm component as optional.
 *
 * @param {object} pkg Component object to annotate
 * @returns {void}
 */
export declare function setNpmOptionalProperty(pkg: object): void;
/**
 * Marks an npm component as a peer dependency.
 *
 * @param {object} pkg Component object to annotate
 * @returns {void}
 */
export declare function setNpmPeerProperty(pkg: object): void;
/**
 * Marks an npm component as imported only for its TypeScript types.
 *
 * @param {object} pkg Component object to annotate
 * @returns {void}
 */
export declare function setNpmTypeOnlyProperty(pkg: object): void;
/**
 * Clean an npm version the way `npm publish` does before it records a release.
 *
 * Publishing a directory runs the manifest through `npm pkg fix`
 * (`fixVersionField` in `@npmcli/package-json`, which calls `semver.clean` in
 * loose mode) and then through libnpmpublish, which calls `semver.clean` again
 * in strict mode and records the result as the packument version, the
 * dist-tag, the `_id` and the tarball file name. Semver build metadata
 * (`1.0.0+build.5`), a leading `v` or `=`, surrounding whitespace and leading
 * zeros are dropped; a prerelease is kept.
 *
 * The `package.json` inside the published tarball keeps the original string,
 * and so do the lockfiles npm, pnpm, yarn and bun write for a project, a
 * workspace member or a git, file or link dependency. The cleaned form is the
 * version the npm registry knows the package by.
 *
 * @param {string} version Version as a manifest or lockfile records it
 * @returns {string|null} The cleaned version, or null when npm would reject `version` as invalid semver
 */
export declare function cleanNpmVersion(version: string): string | null;
/**
 * Record the version npm would publish when it differs from the recorded one.
 *
 * Sets `cdx:npm:cleanedVersion` on an npm component whose version is valid
 * semver but not in the form {@link cleanNpmVersion} produces, for example
 * `1.0.0+build.5` (published as `1.0.0`). The component's `version` and `purl`
 * keep the recorded string: that is what the manifest and lockfile say. A
 * component whose version is already clean, or not semver at all (a git
 * commit, a `file:` path), is left without the property, and a stale value from
 * an earlier pass is replaced.
 *
 * @param {object} component Component or package object with `version` and `purl`
 * @returns {object} The same component, for chaining
 */
export declare function setNpmCleanedVersionProperty(component: object): object;
/**
 * Helper function to create a properly encoded workspace PURL
 *
 * @param {string} packageName - Package name (e.g., "@babel/core")
 * @param {string} version - Package version
 * @returns {string} Encoded PURL string
 */
export declare function createNpmWorkspacePurl(packageName: string, version: string): string;
/**
 * Finds a matching npm workspace PURL for the supplied package name.
 *
 * @param {string[] | undefined} workspacePackages Array of workspace package PURLs
 * @param {string} packageName Package name to match against
 * @returns {string | undefined} Matching workspace package PURL, if any
 */
export declare function findMatchingNpmWorkspace(workspacePackages: string[] | undefined, packageName: string): string | undefined;
/**
 * Classifies an npm dependency specifier by source type.
 *
 * @param {string | undefined | null} spec npm dependency specifier
 * @returns {{ type: string, value: string } | undefined} Classified manifest source, if supported
 */
export declare function classifyNpmManifestSource(spec: string | undefined | null): {
    type: string;
    value: string;
} | undefined;
/**
 * Collects unique manifest-declared npm dependency sources from incoming edges.
 *
 * @param {object} node Arborist node
 * @returns {{ type: string, value: string }[]} Unique manifest source entries
 */
export declare function collectNpmManifestSources(node: object): {
    type: string;
    value: string;
}[];
/**
 * Resolve the license of an npm-style manifest, honouring the legacy plural
 * `licenses` field that packages published before the SPDX convention still
 * carry (issue 4466). A modern `license` value is returned unchanged. The
 * legacy field may hold one entry or an array of them, each a string or a
 * `{ type, url }` object; one entry is returned as it is. npm documents an
 * array of several entries as a choice between them, so when every entry is an
 * SPDX identifier the array becomes the equivalent `MIT OR Apache-2.0`
 * expression, and otherwise stays a list for `getLicenses` to convert entry by
 * entry.
 *
 * @param {object} pkgData Parsed package.json (or bower.json) manifest
 * @returns {string|object|Array|undefined} The effective license value
 */
export declare function resolveNpmLicense(pkgData: object): string | object | any[] | undefined;
/**
 * Hydrates sparse npm package metadata from the installed package.json in deep mode.
 * Existing metadata on the Arborist node wins over on-disk values.
 *
 * @param {object} node Arborist node
 * @param {object} [options={}] CLI options
 * @returns {{ nodePackage: object, diskPkg: object | undefined, packageJsonPath: string | undefined }} Hydrated package metadata and the source package.json context
 */
export declare function hydrateNpmNodePackage(node: object, options?: object): {
    nodePackage: object;
    diskPkg: object | undefined;
    packageJsonPath: string | undefined;
};
/**
 * Helper to check if a package is imported only for TypeScript types.
 */
export declare function isPkgTypeOnlyImport(allImports: any, group: any, name: any): boolean;
/**
 * Normalize a pnpm lockfile package key by stripping the leading "/@"
 * separator and any parenthetical peer-dependency suffix.
 *
 * @param {string} lockKey Raw package key from a pnpm lockfile.
 * @returns {string} The normalized key.
 */
export declare function normalizePnpmLockKey(lockKey: string): string;
/**
 * Normalize an npm registry URL by trimming surrounding whitespace and any
 * trailing slash. Returns undefined for empty or templated (`${...}`) URLs.
 *
 * @param {string} registryUrl Raw registry URL.
 * @returns {string|undefined} The normalized registry URL, or undefined when
 *   the URL is empty or templated.
 */
export declare function normalizeNpmRegistryUrl(registryUrl: string): string | undefined;
/**
 * Load and merge npm/pnpm configuration from the project root with env-derived values.
 *
 * Reads `.npmrc` and `.pnpmrc` (when present) under `projectRoot`, layering them
 * on top of the environment-derived config returned by `parseNpmrcFromEnv`.
 *
 * @param {string} projectRoot Project root directory to search for rc files.
 * @returns {Object<string, string>} Merged npmrc configuration object.
 */
export declare function loadNpmrcConfig(projectRoot: string): Record<string, string>;
/**
 * Strip a leading "@" from an npm scope group name.
 *
 * @param {string} group Raw scope group (e.g. "@scope").
 * @returns {string} The scope without the leading "@", or an empty string.
 */
export declare function normalizeNpmScopeGroup(group: string): string;
/**
 * Resolve the npm registry URL for a git-installed package.
 *
 * Prefers the scope-specific registry (`@scope:registry`) from the npmrc config,
 * falling back to the global `registry` value.
 *
 * @param {string} group npm scope group (with or without leading "@").
 * @param {Object<string, string>} [npmrcConfig={}] Merged npmrc configuration.
 * @returns {string|undefined} The resolved registry URL, or undefined.
 */
export declare function resolveNpmRegistryUrlForGitPackage(group: string, npmrcConfig?: Record<string, string>): string | undefined;
/**
 * Build purl qualifiers (vcs_url, repository_url) for a git-sourced npm package.
 *
 * @param {string} vcsUrl Version-control URL (e.g. "repo#commit").
 * @param {string} group npm scope group.
 * @param {Object<string, string>} npmrcConfig Merged npmrc configuration.
 * @returns {Object<string, string>|null} Qualifier map, or null when none apply.
 */
export declare function buildNpmGitPurlQualifiers(vcsUrl: string, group: string, npmrcConfig: Record<string, string>): Record<string, string> | null;
/**
 * Construct the registry tarball download URL for an npm package.
 *
 * @param {string} registryUrl Normalized registry base URL.
 * @param {string} group npm scope group.
 * @param {string} name Package name.
 * @param {string} version Package version.
 * @returns {string|undefined} The tarball URL, or undefined when required inputs are missing.
 */
export declare function buildNpmRegistryTarballUrl(registryUrl: string, group: string, name: string, version: string): string | undefined;
/**
 * Build distribution-intake external references for a git npm package's tarball.
 *
 * Resolves the registry URL for the package scope and constructs the tarball
 * download URL, returning a single-element external-reference list.
 *
 * @param {string} group npm scope group.
 * @param {string} name Package name.
 * @param {string} version Package version.
 * @param {Object<string, string>} npmrcConfig Merged npmrc configuration.
 * @returns {Array<{type: string, url: string}>|undefined} Distribution-intake
 *   references, or undefined when the registry URL cannot be resolved.
 */
export declare function buildNpmGitDistributionIntakeRefs(group: string, name: string, version: string, npmrcConfig: Record<string, string>): Array<{
    type: string;
    url: string;
}> | undefined;
/**
 * Parse a pnpm lockfile key into group/name/git-spec for git-resolved packages.
 *
 * @param {string} lockKey Raw package key from a pnpm lockfile.
 * @returns {{group: string, name: string, gitSpec: string, fullName: string, packageName: string}|null}
 *   Parsed coordinates, or null when the key is not a git reference.
 */
export declare function parsePnpmGitLockKey(lockKey: string): {
    group: string;
    name: string;
    gitSpec: string;
    fullName: string;
    packageName: string;
} | null;
/**
 * Build external-reference/intake objects for git-resolved pnpm packages.
 *
 * Scans the lockfile `packages` and `snapshots` maps for git resolutions,
 * deriving purl, vcs_url, and distribution-intake references for each. Entries
 * are indexed under every alias of their lock key for fast lookup.
 *
 * @param {Object<string, object>} packages Lockfile `packages` map.
 * @param {Object<string, object>} snapshots Lockfile `snapshots` map.
 * @param {Object<string, string>} [npmrcConfig={}] Merged npmrc configuration.
 * @returns {Object<string, object>} Map of lookup key to git package reference.
 */
export declare function buildPnpmGitPkgRefs(packages: Record<string, object>, snapshots: Record<string, object>, npmrcConfig?: Record<string, string>): Record<string, object>;
//# sourceMappingURL=npmutils.d.ts.map
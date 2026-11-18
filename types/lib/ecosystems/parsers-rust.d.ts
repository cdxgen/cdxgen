/**
 * Method to parse cargo.toml data
 *
 * The component described by a [package] section will be put at the front of
 * the list, regardless of if [package] appears before or after
 * [dependencies]. Found dependencies will be placed at the back of the
 * list.
 *
 * The Cargo documentation specifies that the [package] section should appear
 * first as a convention, but it is not enforced.
 * https://doc.rust-lang.org/stable/style-guide/cargo.html#formatting-conventions
 *
 * @param {String} cargoTomlFile cargo.toml file
 * @param {boolean} simple Return a simpler representation of the component by skipping extended attributes and license fetch.
 * @param {Object} pkgFilesMap Object with package name and list of files
 *
 * @returns {Array} Package list
 */
export declare function parseCargoTomlData(cargoTomlFile: string, simple?: boolean, pkgFilesMap?: Object, context?: {}): any[];
/**
 * The package names a Cargo.lock file records, in file order. Dep-info
 * collection filters the build directory against this set, so artefacts an
 * earlier build of a different lock file left behind cannot attach files to
 * packages the current one no longer has.
 *
 * @param {String} cargoLockFile A path to a Cargo.lock file
 *
 * @returns {Array<string>} Package names, empty when the file cannot be read
 */
export declare function cargoLockPackageNames(cargoLockFile: string): Array<string>;
/**
 * Parse a Cargo.lock file to find components within the Rust project.
 *
 * @param {String} cargoLockFile A path to a Cargo.lock file. The Cargo.lock-file path may be used as information for extended attributes, such as manifest based evidence.
 * @param {boolean} simple Return a simpler representation of the component by skipping extended attributes and license fetch.
 * @param {Object} pkgFilesMap Object with package name and list of files
 *
 * @returns {Array} A list of the project's components as described by the Cargo.lock-file.
 */
export declare function parseCargoData(cargoLockFile: string, simple?: boolean, pkgFilesMap?: Object): any[];
/**
 * Build a Cargo dependency graph from manifest relationships so workspace roots
 * and member-to-member links can complement lockfile-derived dependency data.
 *
 * @param {string} cargoTomlFile Cargo.toml path
 * @param {object} [context] manifest graph context
 * @returns {object[]} Cargo dependency relationships
 */
export declare function parseCargoManifestDependencyData(cargoTomlFile: string, context?: object): object[];
/**
 * Parses a Cargo.lock file's TOML data and returns a flat dependency graph as an
 * array of objects mapping each package purl to the purls it directly depends on.
 *
 * @param {string} cargoLockData Raw TOML string contents of a Cargo.lock file
 * @returns {Object[]} Array of dependency relationship objects with ref and dependsOn fields
 */
export declare function parseCargoDependencyData(cargoLockData: string): Object[];
/**
 * Normalize a cargo dependency kind to the vocabulary used by the cargo
 * manifest parsers.
 *
 * `cargo metadata` encodes a normal dependency as `null` rather than a string,
 * so a truthiness test would silently leave runtime dependencies unlabelled.
 *
 * @param {string|null|undefined} kind Dependency kind as reported by cargo
 * @returns {string} One of `runtime`, `build` or `dev`
 */
export declare function normalizeCargoDepKind(kind: string | null | undefined): string;
/**
 * Parse a cargo package id into its name and version.
 *
 * cargo 1.77 and later emit the package id spec form
 * (`registry+https://...#name@1.0.0`, or `path+file:///p/foo#1.0.0` where the
 * name is carried by the path); earlier releases emit `name 1.0.0 (source)`.
 *
 * @param {string} packageId cargo package id
 * @returns {{name: string, version: string}|undefined} Parsed identity
 */
export declare function parseCargoPackageId(packageId: string): {
    name: string;
    version: string;
} | undefined;
/**
 * Build the `name@version` key used to correlate cargo components across the
 * lock file, the manifests and `cargo metadata`.
 *
 * @param {{name: string, version: string}} pkg Package identity
 * @returns {string} Correlation key
 */
export declare function cargoComponentKey(pkg: {
    name: string;
    version: string;
}): string;
/**
 * Convert a cargo purl or bom-ref into a `name@version` correlation key.
 *
 * @param {string} purl cargo purl
 * @returns {string} Correlation key
 */
export declare function cargoPurlToComponentKey(purl: string): string;
/**
 * Collect the dependency kinds and platform gates declared by a single
 * `Cargo.toml`, keyed by the crate name that cargo resolves the entry to.
 *
 * Manifests declare version requirements rather than resolved versions, so the
 * returned map is keyed by name alone and is meant to label the edges leaving a
 * workspace member in the lock file graph.
 *
 * @param {string} cargoTomlFile Cargo.toml path
 * @param {object} [context] Workspace resolution context
 * @returns {Map<string, {kinds: Set<string>, targets: Set<string>, optional: boolean}>} Declared edges
 */
export declare function parseCargoManifestDependencyKinds(cargoTomlFile: string, context?: object): Map<string, {
    kinds: Set<string>;
    targets: Set<string>;
    optional: boolean;
}>;
/**
 * Roll per-edge cargo dependency kinds up to an effective kind per component.
 *
 * A crate is only dev-only when *every* path reaching it from a workspace root
 * traverses a dev edge, so a crate shared between a dev dependency and a normal
 * one keeps its runtime kind. Cargo never builds the dev dependencies of a
 * dependency, so dev edges are followed from the workspace roots alone.
 *
 * @param {object} graph Dependency graph
 * @param {string[]} graph.rootKeys Workspace member component keys
 * @param {Map<string, Array<{to: string, kind: string, target?: string}>>} graph.edges Adjacency map
 * @returns {Map<string, {kind: string, kinds: Set<string>, targets: Set<string>, targetGated: boolean}>} Effective kinds
 */
export declare function rollupCargoDependencyKinds({ rootKeys, edges }: {
    rootKeys: string[];
    edges: Map<string, Array<{
        to: string;
        kind: string;
        target?: string;
    }>>;
}): Map<string, {
    kind: string;
    kinds: Set<string>;
    targets: Set<string>;
    targetGated: boolean;
}>;
/**
 * Build a cargo dependency graph from the `resolve` section of
 * `cargo metadata --format-version 1`.
 *
 * @param {object} metadata Parsed `cargo metadata` output
 * @returns {{rootKeys: string[], edges: Map<string, Array<object>>, packageInfo: Map<string, object>, resolvedKeys: Set<string>}} Graph
 */
export declare function parseCargoMetadataResolve(metadata: object): {
    rootKeys: string[];
    edges: Map<string, Array<object>>;
    packageInfo: Map<string, object>;
    resolvedKeys: Set<string>;
};
/**
 * Build a cargo dependency graph from the lock file relationships, labelling
 * the edges that leave a workspace member with the kinds declared by its
 * manifest.
 *
 * The lock file is the union of every dependency kind and every target triple,
 * so only the manifests can distinguish them. The resulting labels are exact at
 * depth one and inherited below it, which is enough to identify dev-only and
 * build-only subtrees without invoking cargo.
 *
 * @param {object[]} lockDependencies Relationships from {@link parseCargoDependencyData}
 * @param {Map<string, Map<string, object>>} declaredEdgesByRoot Declared edges keyed by root component key
 * @returns {{rootKeys: string[], edges: Map<string, Array<object>>}} Graph
 */
export declare function buildCargoLockDependencyGraph(lockDependencies: object[], declaredEdgesByRoot: Map<string, Map<string, object>>): {
    rootKeys: string[];
    edges: Map<string, Array<object>>;
};
/**
 * Annotate cargo components with their effective dependency kind, platform
 * gates and scope.
 *
 * Components reachable only through dev edges are scoped `excluded` so
 * `--required-only` drops them. Build dependencies stay required because a
 * build script is part of producing the artifact; the kind is recorded as a
 * property so a consumer can filter on it.
 *
 * @param {object[]} pkgList Components to annotate
 * @param {Map<string, object>} rollup Effective kinds from {@link rollupCargoDependencyKinds}
 * @param {Map<string, object>} [packageInfo] Extra per-package facts
 * @param {object} [options] Annotation options
 * @param {boolean} [options.resolveIsComplete] The rollup covers every workspace in the scan, so a
 *        component missing from it is an optional dependency no feature activates
 * @returns {object[]} The annotated components
 */
export declare function applyCargoDependencyKindMetadata(pkgList: object[], rollup: Map<string, object>, packageInfo?: Map<string, object>, options?: {
    resolveIsComplete?: boolean;
}): object[];
/**
 * Recover the upstream version of a native library from the version of the
 * crate that ships it.
 *
 * The `-sys` and `-src` crates carry the upstream version as semver build
 * metadata, because the crate's own version tracks the binding's releases
 * rather than the library's: `openssl-src@300.6.1+3.6.3` ships OpenSSL 3.6.3
 * and `curl-sys@0.4.74+curl-8.9.0` ships curl 8.9.0.
 *
 * @param {string} crateVersion Version of the providing crate
 * @returns {string} Upstream version, or an empty string when it is not encoded
 */
export declare function cargoUpstreamVersionFromCrateVersion(crateVersion: string): string;
/**
 * Recover the version of a vendored native library from the C source the crate
 * ships.
 *
 * A `-sys` crate that bundles its library carries the upstream version in a
 * header define - `ZLIB_VERSION`, `SQLITE_VERSION`, `OPENSSL_VERSION_TEXT` -
 * which is the only statement of the version for the crates that do not encode
 * it in their own version. A crate often ships more than one variant, so a
 * candidate sitting in a directory named after a feature this build did not
 * enable is dropped: `libz-sys` ships both `src/zlib` and `src/zlib-ng`, and
 * only one of them is compiled.
 *
 * @param {object} args Resolution inputs
 * @param {string} args.crateDir Directory holding the crate's unpacked source
 * @param {string} args.links The crate's `links` value
 * @param {string} args.libraryName Normalized library name
 * @param {string[]} [args.declaredFeatures] Features the crate declares
 * @param {Set<string>} [args.resolvedFeatures] Features the resolver enabled
 * @returns {{version: string, evidence: string, candidates: string[]}} Version and where it came from
 */
export declare function resolveCargoVendoredLibraryVersion({ crateDir, links, libraryName, declaredFeatures, resolvedFeatures, }: {
    crateDir: string;
    links: string;
    libraryName: string;
    declaredFeatures?: string[];
    resolvedFeatures?: Set<string>;
}): {
    version: string;
    evidence: string;
    candidates: string[];
};
/**
 * Build components for the native libraries that `-sys` crates link.
 *
 * A crate declaring `links = "openssl"` puts a C library into the artifact that
 * the cargo dependency graph cannot describe: its advisories and its license
 * obligations belong to OpenSSL, not to the Rust binding. When the resolver
 * enabled a vendoring feature, that library is compiled into the binary, which
 * makes it a component of the delivered assembly.
 *
 * @param {Map<string, object>} packageInfo Per-package facts from {@link parseCargoMetadataResolve}
 * @param {Map<string, Array<object>>} edges Dependency edges keyed by component key
 * @param {Map<string, object>} rollup Effective kinds, used to skip crates no build reaches
 * @returns {{components: object[], dependencies: object[]}} Native library components and their edges
 */
export declare function buildCargoNativeLibraryComponents(packageInfo: Map<string, object>, edges: Map<string, Array<object>>, rollup: Map<string, object>): {
    components: object[];
    dependencies: object[];
};
/**
 * Parses tab-separated cargo-auditable binary metadata output and returns a list
 * of Rust package components. Optionally fetches crates.io metadata when
 * FETCH_LICENSE is enabled.
 *
 * @param {string} cargoData Tab-separated string output from cargo-auditable or similar tool
 * @returns {Promise<Object[]>} List of Rust package component objects with group, name, and version
 */
export declare function parseCargoAuditableData(cargoData: string): Promise<Object[]>;
//# sourceMappingURL=parsers-rust.d.ts.map
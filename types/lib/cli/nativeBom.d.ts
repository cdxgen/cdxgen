/**
 * Resolves the local Cargo registry cache directory from the `CARGO_CACHE_DIR`
 * or `CARGO_HOME` environment variables, falling back to `~/.cargo/registry/cache`.
 *
 * @returns {string|undefined} Absolute path to the Cargo cache directory
 */
export declare function getCargoCacheDir(): string | undefined;
/**
 * Function to create bom string for Go projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object | undefined>} Promise resolving to a BOM object or `undefined`
 */
export declare function createGoBom(path: string, options: Object): Promise<Object | undefined>;
export declare function createRustBom(path: any, options: any): Promise<Object | undefined>;
/**
 * Parses a `.crate` file name into a CycloneDX component (name, version, purl,
 * bom-ref, and source/cache properties). Returns undefined when the file name
 * does not match the `name-version` convention.
 *
 * @param {string} crateFile Absolute path to a `.crate` archive
 * @returns {object|undefined} Component object or undefined
 */
export declare function buildCargoCacheComponent(crateFile: string): object | undefined;
/**
 * Enriches a cargo cache component with a SHA-256 hash and filename-based
 * identity evidence (confidence 0.5), and with what the archive's own manifest
 * says: its licence, description and repository, read from the archive without
 * extracting it anywhere. Hash computation failures are ignored.
 *
 * @param {string} crateFile Absolute path to the `.crate` archive
 * @param {object} [component] Component produced by `buildCargoCacheComponent`
 * @returns {Promise<object|undefined>} The enriched component or undefined
 */
export declare function enrichCargoCacheComponent(crateFile: string, component?: object): Promise<object | undefined>;
/**
 * Builds a BOM from `.crate` files found in the Cargo registry cache (or from a
 * single `.crate` path). Optionally fetches crates.io license metadata when
 * license fetching is enabled.
 *
 * @param {string} path Directory or `.crate` file path
 * @param {object} options CLI options
 * @returns {Promise<object>} Promise resolving to a BOM namespace data object
 */
export declare function createCargoCacheBom(path: string, options: object): Promise<object>;
/**
 * Function to create bom string for Dart projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createDartBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for cpp projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export declare function createCppBom(path: string, options: Object): Object;
/**
 * Function to create bom string for clojure projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export declare function createClojureBom(path: string, options: Object): Object;
/**
 * Locate the Stack lock files under a path.
 *
 * Stack names the lock after the configuration file it completes, so the
 * default `stack.yaml` produces `stack.yaml.lock` and a project with several
 * configurations produces one lock per configuration. `stack.lock` is also
 * accepted because tooling and documentation examples have used that name.
 *
 * @param {string} path Project path
 * @param {Object} options Parse options from the cli
 * @returns {string[]} Lock file paths, deduplicated
 */
export declare function findStackLockFiles(path: string, options: Object): string[];
/**
 * Function to create bom string for Haskell projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export declare function createHaskellBom(path: string, options: Object): Object;
/**
 * Function to create bom string for Elixir projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export declare function createElixirBom(path: string, options: Object): Object;
/**
 * Function to create bom string for swift projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createSwiftBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for cocoa projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object | undefined>} Promise resolving to a BOM object, or `undefined` when no Podfiles are found
 */
export declare function createCocoaBom(path: string, options: Object): Promise<Object | undefined>;
/**
 * Function to create bom string for Nix flakes
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createNixBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Zig projects.
 *
 * Zig moved package management into the build system, so the dependency list
 * lives in `build.zig.zon` (ZON, not JSON). The resolver walks the full
 * dependency graph by locating each dependency's manifest through the in-tree
 * `zig-pkg/` directory or the global cache, producing both a flat component
 * list and a CycloneDX `dependencies[]` edge list.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createZigBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Gleam projects.
 *
 * Gleam resolves through Hex, so packages carry `pkg:hex/...` purls and no new
 * purl type is introduced. The `manifest.toml` lock is the source of truth for
 * resolved versions and the direct/transitive distinction; `gleam.toml` is the
 * manifest.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createGleamBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Julia projects.
 *
 * The resolved `Manifest.toml` is preferred over the declared `Project.toml`
 * so the BOM carries pinned versions and the package graph.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export declare function createJuliaBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Erlang projects using rebar3.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export declare function createErlangBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for OCaml projects using opam.
 *
 * Resolved `.opam.locked` files are preferred; a plain `.opam` file is used
 * as a declared fallback with unpinned versions.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export declare function createOCamlBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Elm projects.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export declare function createElmBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Crystal projects using shards.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export declare function createCrystalBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Nim projects using nimble.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export declare function createNimBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Lua projects using LuaRocks.
 *
 * When a `luarocks.lock` is present next to a rockspec it supplies the
 * resolved versions; otherwise the rockspec's declared dependencies are
 * inventoried without versions.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export declare function createLuaBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Spack environments.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export declare function createSpackBom(path: string, options: Object): Promise<Object>;
//# sourceMappingURL=nativeBom.d.ts.map
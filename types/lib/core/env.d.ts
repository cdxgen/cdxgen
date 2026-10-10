/** True when running under Node.js. */
export declare const isNode: boolean;
/** True when running under Bun. */
export declare const isBun: boolean;
/** True when running under Deno. */
export declare const isDeno: boolean;
/** Value of the CDXGEN_SPDX_CREATED_BY environment variable, or undefined when unset. */
export declare const CDXGEN_SPDX_CREATED_BY: string | undefined;
/**
 * Resolved table border style for console output ("ascii", "unicode", or
 * "auto"), driven by the CDXGEN_TABLE_BORDER environment variable.
 */
export declare const TABLE_BORDER_STYLE: string;
/** True when test scope dependencies should be included for Maven projects (default true unless CDX_MAVEN_INCLUDE_TEST_SCOPE is explicitly false). */
export declare const includeMavenTestScope: boolean;
/** True when the native Maven dependency tree command should be preferred (default true unless PREFER_MAVEN_DEPS_TREE is false/0). */
export declare const PREFER_MAVEN_DEPS_TREE: boolean;
/**
 * Split a Maven arguments string into an argv array, honoring shell quoting
 * (single and double quotes) and backslash escaping of whitespace and quotes.
 *
 * @param {string} argsString Raw Maven arguments string.
 * @returns {string[]} Parsed argument array, or an empty array when input is falsy.
 */
export declare function parseMavenArgs(argsString: string): string[];
/**
 * Determines whether license information should be fetched from remote sources,
 * based on the FETCH_LICENSE environment variable.
 *
 * @returns {boolean} True if the FETCH_LICENSE env var is set to "true" or "1"
 */
export declare function shouldFetchLicense(): boolean;
/**
 * Determines whether registry provenance, such as publish times, publishers
 * and trusted-publishing signals, is wanted. `--bom-audit` turns it on through
 * CDXGEN_FETCH_PKG_METADATA. Local data cannot answer these questions, so a
 * package whose licence and description are known locally is still looked up.
 *
 * @returns {boolean} True if CDXGEN_FETCH_PKG_METADATA is "true" or "1"
 */
export declare function shouldFetchRegistryProvenance(): boolean;
/**
 * Determines whether remote package metadata should be fetched for enrichment.
 *
 * @returns {boolean} True when registry metadata enrichment is enabled.
 */
export declare function shouldFetchPackageMetadata(): boolean;
/**
 * Determines whether VCS (version control system) information should be fetched
 * for Go packages, based on the GO_FETCH_VCS environment variable.
 *
 * @returns {boolean} True if the GO_FETCH_VCS env var is set to "true" or "1"
 */
export declare function shouldFetchVCS(): boolean;
/** True when license information should be fetched from remote sources (FETCH_LICENSE env var). */
export declare const FETCH_LICENSE: boolean;
/** True when search.maven.org should be used to identify jars without Maven metadata (default true unless SEARCH_MAVEN_ORG is explicitly false). */
export declare const SEARCH_MAVEN_ORG: boolean;
/** Resolved Java executable command (JAVA_CMD env var > JAVA_HOME/bin/java > "java"). */
export declare const JAVA_CMD: string;
/**
 * Returns the Java executable command to use, resolved in priority order:
 * JAVA_CMD env var > JAVA_HOME/bin/java > "java".
 *
 * @returns {string} Path or name of the Java executable
 */
export declare function getJavaCommand(): string;
/** Resolved Python executable command (PYTHON_CMD env var > CONDA_PYTHON_EXE > "python"). */
export declare const PYTHON_CMD: string;
/**
 * Returns the Python executable command to use, resolved in priority order:
 * PYTHON_CMD env var > CONDA_PYTHON_EXE env var > "python" > "python3".
 *
 * Distributions that ship only a versioned interpreter leave a bare "python"
 * unresolvable, which would fail every virtualenv this tool creates, so the
 * versioned name is used when it is the only one PATH offers.
 *
 * @returns {string} Path or name of the Python executable
 */
export declare function getPythonCommand(): string;
/** Resolved .NET CLI command (DOTNET_CMD env var, or "dotnet"). */
export declare let DOTNET_CMD: string;
/** Resolved Node.js executable command (NODE_CMD env var, or "node"). */
export declare let NODE_CMD: string;
/** Resolved npm executable command (NPM_CMD env var, or "npm"). */
export declare let NPM_CMD: string;
/** Resolved Yarn executable command (YARN_CMD env var, or "yarn"). */
export declare let YARN_CMD: string;
/** Resolved GCC executable command (GCC_CMD env var, or "gcc"). */
export declare let GCC_CMD: string;
/** Resolved rustc executable command (RUSTC_CMD env var, or "rustc"). */
export declare let RUSTC_CMD: string;
/** Resolved Go executable command (GO_CMD env var, or "go"). */
export declare let GO_CMD: string;
/** Resolved Cargo executable command (CARGO_CMD env var, or "cargo"). */
export declare let CARGO_CMD: string;
/**
 * Target triple the cargo resolve graph is filtered to, so that a
 * cross-compiled project can be described for the triple it ships on rather
 * than for the union of every triple its lock file covers.
 *
 * `CDXGEN_CARGO_TARGET` is cdxgen's own name for it; `CARGO_BUILD_TARGET` is
 * cargo's standard variable, which a cross-compiling build already sets.
 */
export declare const CARGO_TARGET: string | undefined;
/** Resolved Clojure CLI executable command (CLJ_CMD env var, or "clj"). */
export declare let CLJ_CMD: string;
/** Resolved Leiningen executable command (LEIN_CMD env var, or "lein"). */
export declare let LEIN_CMD: string;
/** Resolved temp directory used by cdxgen (CDXGEN_TEMP_DIR env var, or "temp"). */
export declare let CDXGEN_TEMP_DIR: string;
/** Resolved Swift executable command (SWIFT_CMD env var, or "swift"). */
export declare const SWIFT_CMD: string;
/** Resolved Ruby executable command (RUBY_CMD env var, or "ruby"). */
export declare const RUBY_CMD: string;
/** Python package components that can be excluded from the generated BOM. */
export declare const PYTHON_EXCLUDED_COMPONENTS: string[];
/** Map of base cdxgen project type to the array of accepted alias strings. */
export declare const PROJECT_TYPE_ALIASES: {
    java: string[];
    android: string[];
    jar: string[];
    "gradle-index": string[];
    "sbt-index": string[];
    "maven-index": string[];
    "cargo-cache": string[];
    js: string[];
    mcp: string[];
    "ai-skill": string[];
    agentic: string[];
    py: string[];
    go: string[];
    rust: string[];
    php: string[];
    ruby: string[];
    csharp: string[];
    dart: string[];
    haskell: string[];
    elixir: string[];
    erlang: string[];
    julia: string[];
    r: string[];
    ocaml: string[];
    elm: string[];
    crystal: string[];
    nim: string[];
    lua: string[];
    perl: string[];
    spack: string[];
    terraform: string[];
    c: string[];
    clojure: string[];
    github: string[];
    hbom: string[];
    os: string[];
    jenkins: string[];
    helm: string[];
    "helm-index": string[];
    universal: string[];
    cloudbuild: string[];
    swift: string[];
    binary: string[];
    oci: string[];
    cocoa: string[];
    scala: string[];
    nix: string[];
    zig: string[];
    gleam: string[];
    caxa: string[];
    asar: string[];
    "vscode-extension": string[];
    "chrome-extension": string[];
    dynamic: string[];
    "ai-provenance": string[];
};
/** Map of base package manager to the array of accepted alias strings. */
export declare const PACKAGE_MANAGER_ALIASES: {
    scala: string[];
};
/**
 * Project-type prefixes that accept a version suffix pinning a JVM build
 * tool, e.g. `maven3.9.9`, `mvn3.9.9`, `gradle8.14`, `sbt1.10`, or
 * `scala3.6.4`. Kept alongside the alias map because both describe how CLI
 * project types map to base types.
 *
 * @type {string[]}
 */
export declare const JVM_BUILD_TOOL_TYPE_PREFIXES: string[];
/**
 * Check whether a project type pins a JVM build tool version, i.e. it starts
 * with one of the JVM build tool prefixes followed by a digit.
 *
 * @param {string} projectType Project type from the CLI
 * @returns {boolean} True for versioned JVM build tool types.
 */
export declare function isVersionedJvmToolProjectType(projectType: string): boolean;
/**
 * Method to check if a given feature flag is enabled.
 *
 * @param {Object} cliOptions CLI options
 * @param {String} feature Feature flag
 *
 * @returns {Boolean} True if the feature is enabled
 */
export declare function isFeatureEnabled(cliOptions: Object, feature: string): boolean;
/**
 * Method to check if the given project types are allowed by checking against include and exclude types passed from the CLI arguments.
 *
 * @param {Array} projectTypes project types to check
 * @param {Object} options CLI options
 * @param {Boolean} defaultStatus Default return value if there are no types provided
 */
export declare function hasAnyProjectType(projectTypes: any[], options: Object, defaultStatus?: boolean): any;
/**
 * Determine whether the predictive dependency audit should run for the current
 * CLI invocation.
 *
 * OBOM-focused runs (`obom` or explicit `-t os` / OS aliases only) should keep
 * the direct BOM audit findings but skip the predictive dependency audit.
 *
 * @param {object} options CLI options
 * @param {string} [commandPath] Invoked command path or name
 * @returns {boolean} True when predictive dependency audit should run
 */
export declare function shouldRunPredictiveBomAudit(options: object, commandPath?: string): boolean;
/**
 * Convenient method to check if the given package manager is allowed.
 *
 * @param {String} name Package manager name
 * @param {Array} conflictingManagers List of package managers
 * @param {Object} options CLI options
 *
 * @returns {Boolean} True if the package manager is allowed
 */
export declare function isPackageManagerAllowed(name: string, conflictingManagers: any[], options: Object): boolean;
/**
 * Function to parse a list of environment variables to identify the paths containing executable binaries
 *
 * @param envValues {Array[String]} Environment variables list
 * @returns {Array[String]} Binary Paths identified from the environment variables
 */
export declare function extractPathEnv(envValues: any): any;
//# sourceMappingURL=env.d.ts.map
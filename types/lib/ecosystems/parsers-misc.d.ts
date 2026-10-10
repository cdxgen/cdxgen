/**
 * Method to parse pubspec.lock files.
 *
 * @param pubLockData Contents of lock data
 * @param lockFile Filename for setting evidence
 *
 * @returns {Object}
 */
export declare function parsePubLockData(pubLockData: any, lockFile: any): Object;
/**
 * Parses a Dart pub package's pubspec.yaml content and returns a list containing
 * a single component object with name, description, version, homepage, and purl.
 *
 * @param {string} pubYamlData Raw YAML string contents of a pubspec.yaml file
 * @returns {Object[]} List containing a single Dart package component object
 */
export declare function parsePubYamlData(pubYamlData: string): Object[];
/**
 * Parses Helm chart YAML data (Chart.yaml or repository index.yaml) and returns
 * a list of Helm chart component objects including the chart itself and any
 * declared dependencies or index entries.
 *
 * @param {string} helmData Raw YAML string contents of a Helm Chart.yaml or index.yaml file
 * @returns {Object[]} List of Helm chart component objects with name, version, and optional homepage/repository
 */
export declare function parseHelmYamlData(helmData: string): Object[];
/**
 * Recursively walks a parsed YAML/JSON object structure to find container image
 * references stored under common keys (image, repository, dockerImage, etc.) and
 * appends discovered image and service entries to pkgList while tracking seen
 * images in imgList to avoid duplicates.
 *
 * @param {Object|Array|string} keyValueObj The object, array, or string node to inspect
 * @param {Object[]} pkgList Accumulator array that receives {image} and {service} entries
 * @param {string[]} imgList Accumulator array of image name strings already seen
 * @returns {string[]} The updated imgList
 */
export declare function recurseImageNameLookup(keyValueObj: Object | any[] | string, pkgList: Object[], imgList: string[]): string[];
/**
 * Parses the contents of a Dockerfile or Containerfile and returns a list of
 * base image objects referenced by FROM instructions, substituting ARG default
 * values where possible and skipping multi-stage build alias references.
 *
 * @param {string} fileContents Raw string contents of the Dockerfile/Containerfile
 * @returns {Object[]} Array of objects with an image property for each unique base image
 */
export declare function parseContainerFile(fileContents: string): Object[];
/**
 * Parses a Bitbucket Pipelines YAML file and extracts all Docker image references
 * used as build environments and pipe references (docker:// pipes are normalized).
 *
 * @param {string} fileContents Raw string contents of the bitbucket-pipelines.yml file
 * @returns {Object[]} Array of objects with an image property for each referenced image or pipe
 */
export declare function parseBitbucketPipelinesFile(fileContents: string): Object[];
/**
 * Parses container specification data such as Docker Compose files, Kubernetes
 * manifests, Tekton tasks, Skaffold configs, or Kustomize overlays (YAML, possibly
 * multi-document) and returns a list of image, service, and OCI spec entries.
 *
 * @param {string} dcData Raw YAML string contents of the container spec file
 * @returns {Object[]} Array of objects with image, service, or ociSpec properties
 */
export declare function parseContainerSpecData(dcData: string): Object[];
/**
 * Identifies the data flow direction of a Privado processing object based on its
 * sinkId value: "write" sinks map to "inbound", "read" sinks to "outbound", and
 * HTTP/gRPC sinks to "bi-directional".
 *
 * @param {Object} processingObj Privado processing object, expected to have a sinkId property
 * @returns {string} Flow direction string: "inbound", "outbound", "bi-directional", or "unknown"
 */
export declare function identifyFlow(processingObj: Object): string;
/**
 * Parses a Privado data flow JSON file and returns a list of service objects
 * enriched with data classifications, endpoints, trust-boundary flag, violations,
 * and git metadata properties extracted from the scan result.
 *
 * @param {string} f Path to the Privado scan result JSON file
 * @returns {Object[]} List of service component objects suitable for a SaaSBOM
 */
export declare function parsePrivadoFile(f: string): Object[];
/**
 * Parses an OpenAPI specification (JSON or YAML string) and returns a list
 * containing a single service object with name, version, endpoints, and
 * authentication flag derived from the spec's info, servers, paths, and
 * securitySchemes sections.
 *
 * @param {string} oaData Raw JSON or YAML string contents of an OpenAPI specification
 * @returns {Object[]} List containing a single service component object
 */
export declare function parseOpenapiSpecData(oaData: string): Object[];
/**
 * Parses Haskell Cabal freeze file content and extracts package name and version
 * pairs from constraint lines (lines containing " ==").
 *
 * @param {string} cabalData Raw string contents of a Cabal freeze file
 * @returns {Object[]} List of package objects with name and version fields
 */
export declare function parseCabalData(cabalData: string): Object[];
/**
 * Parses an Elixir mix.lock file and extracts Hex package name and version pairs
 * from lines containing ":hex".
 *
 * @param {string} mixData Raw string contents of a mix.lock file
 * @returns {Object[]} List of package objects with name and version fields
 */
export declare function parseMixLockData(mixData: string): Object[];
/**
 * Parses a GitHub Actions workflow YAML file and returns a list of action
 * components for each step that uses an external action (steps with a "uses"
 * field). Each component captures the action name, group, version/commit SHA,
 * version pinning type, job context (runner, permissions, environment), and
 * workflow-level metadata (triggers, concurrency, write permissions).
 *
 * @param {string} f Path to the GitHub Actions workflow YAML file
 * @returns {Object[]} List of action component objects with purl, properties, and evidence
 */
export declare function parseGitHubWorkflowData(f: string): Object[];
/**
 * Parse Google Cloud Build YAML data and extract container image steps as packages.
 *
 * @param {string} cbwData Raw YAML string of a Cloud Build configuration file
 * @returns {Object[]} Array of package objects parsed from the build steps
 */
export declare function parseCloudBuildData(cbwData: string): Object[];
/**
 * Parse Conan lock file data (conan.lock) and return the package list, dependency map,
 * and parent component dependencies.
 *
 * Supports both the legacy `graph_lock.nodes` format (Conan 1.x) and the newer
 * `requires` format (Conan 2.x).
 *
 * @param {string} conanLockData Raw JSON string of the Conan lock file
 * @returns {{ pkgList: Object[], dependencies: Object, parentComponentDependencies: string[] }}
 */
export declare function parseConanLockData(conanLockData: string): {
    pkgList: Object[];
    dependencies: Object;
    parentComponentDependencies: string[];
};
/**
 * Parse a Conan conanfile.txt and extract required and optional packages.
 *
 * @param {string} conanData Raw text contents of a conanfile.txt
 * @returns {Object[]} Array of package objects with purl, name, version, and scope
 */
export declare function parseConanData(conanData: string): Object[];
/**
 * Parse Collider lock file data (collider.lock) and return the package list and
 * parent component dependencies.
 *
 * @param {string} colliderLockData Raw JSON string of the Collider lock file
 * @param {string} lockFile Source lock file path
 * @returns {{ pkgList: Object[], dependencies: Object, parentComponentDependencies: string[] }}
 */
export declare function parseColliderLockData(colliderLockData: string, lockFile: string): {
    pkgList: Object[];
    dependencies: Object;
    parentComponentDependencies: string[];
};
/**
 * Method to parse flake.nix files
 *
 * @param {String} flakeNixFile flake.nix file to parse
 * @returns {Object} Object containing package information
 */
export declare function parseFlakeNix(flakeNixFile: string): Object;
/**
 * Method to parse flake.lock files
 *
 * @param {String} flakeLockFile flake.lock file to parse
 * @returns {Object} Object containing locked dependency information
 */
export declare function parseFlakeLock(flakeLockFile: string): Object;
/**
 * Parse composer.json file
 *
 * @param {string} composerJsonFile composer.json file
 *
 * @returns {Object} Object with rootRequires and parent component
 */
export declare function parseComposerJson(composerJsonFile: string): Object;
/**
 * Parse composer lock file
 *
 * @param {string} pkgLockFile composer.lock file
 * @param {array} rootRequires require section from composer.json
 */
export declare function parseComposerLock(pkgLockFile: string, rootRequires: array): never[] | {
    pkgList: {
        group: any;
        name: any;
        purl: any;
        "bom-ref": string;
        version: any;
        repository: any;
        license: any;
        description: any;
        scope: string;
        properties: {
            name: string;
            value: string;
        }[];
        evidence: {
            identity: {
                field: string;
                confidence: number;
                methods: {
                    technique: string;
                    confidence: number;
                    value: string;
                }[];
            };
        };
    }[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
    rootList: {
        group: any;
        name: any;
        purl: any;
        "bom-ref": string;
        version: any;
        repository: any;
        license: any;
        description: any;
        scope: string;
        properties: {
            name: string;
            value: string;
        }[];
        evidence: {
            identity: {
                field: string;
                confidence: number;
                methods: {
                    technique: string;
                    confidence: number;
                    value: string;
                }[];
            };
        };
    }[];
};
/**
 * Method to execute dpkg --listfiles to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export declare function executeDpkgList(pkgName: string): any;
/**
 * Method to execute dnf repoquery to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export declare function executeRpmList(pkgName: string): any;
/**
 * Method to execute apk -L info to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export declare function executeApkList(pkgName: string): any;
/**
 * Method to execute alpm -Ql to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export declare function executeAlpmList(pkgName: string): any;
/**
 * Method to execute equery files to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export declare function executeEqueryList(pkgName: string): any;
/**
 * Parse swift dependency tree output json object
 *
 * @param {Array} pkgList Package list
 * @param {Array} dependenciesList Dependencies
 * @param {string} jsonObject Swift dependencies json object
 * @param {string} pkgFile Package.swift file
 */
export declare function parseSwiftJsonTreeObject(pkgList: any[], dependenciesList: any[], jsonObject: string, pkgFile: string): any;
/**
 * Parse swift dependency tree output
 * @param {string} rawOutput Swift dependencies json output
 * @param {string} pkgFile Package.swift file
 */
export declare function parseSwiftJsonTree(rawOutput: string, pkgFile: string): {
    rootList?: undefined;
    pkgList?: undefined;
    dependenciesList?: undefined;
} | {
    rootList: any[];
    pkgList: any[];
    dependenciesList: any[];
};
/**
 * Parse swift package resolved file
 * @param {string} resolvedFile Package.resolved file
 */
export declare function parseSwiftResolved(resolvedFile: string): {
    name: any;
    group: any;
    version: any;
    properties: {
        name: string;
        value: string;
    }[];
    evidence: {
        identity: {
            field: string;
            confidence: number;
            methods: {
                technique: string;
                confidence: number;
                value: string;
            }[];
        };
    };
}[];
/**
 * Identify the targets of a Swift package that are part of what it ships.
 *
 * Production targets are the non-test targets that are part of a product,
 * executables, macros, plugins, targets nothing else depends on, and every
 * target they depend on. The remaining non-test targets only serve tests,
 * such as snapshot or fixture helper libraries.
 *
 * @param {Object} dumpJson `swift package dump-package` document
 * @returns {Set<string>} Lowercase names of the production targets
 */
export declare function collectSwiftProductionTargets(dumpJson: Object): Set<string>;
/**
 * Classify the dependencies of a Swift package into the packages its shipped
 * code needs and the packages only its tests need.
 *
 * Production targets are the non-test targets that are part of a product,
 * executables, macros, plugins, targets nothing else depends on, and every
 * target they depend on. The remaining non-test targets only serve tests
 * (test-support libraries). A package is test-only when only test and
 * test-support targets reference its products or use its plugins. With the dependency graph from
 * `swift package show-dependencies`, the packages reachable only through
 * test-only packages are test-only as well; a package reachable from a
 * production dependency, or from a declared dependency no target references,
 * stays required.
 *
 * Target dependencies reference products either as
 * `{"product": [name, package]}` or `{"byName": [name]}`; SwiftPM resolves a
 * `byName` product through the package of the same name. When a production
 * `byName` reference names neither a local target nor a package, the
 * classification is abandoned rather than risking a required package being
 * scoped optional.
 *
 * @param {Object|String} dumpJson `swift package dump-package` document, parsed or as text
 * @param {Object|String} [treeJson] `swift package show-dependencies --format json` document, parsed or as text
 * @returns {Object} `{ optionalRefs, requiredRefs, optionalNames, requiredNames }`:
 *   bom-refs from the dependency graph, and lowercase package identities,
 *   names, and repository names (the only result without a graph)
 */
export declare function classifySwiftDependencyScopes(dumpJson: Object | string, treeJson?: Object | string): Object;
/**
 * Decide whether a dump-package target is a test target. The `type` field is
 * usually the string `"test"`, but manifest APIs have also been observed
 * representing it as an object.
 *
 * @param {Object} atarget dump-package target
 * @returns {boolean} `true` for test targets
 */
export declare function isSwiftTestTarget(atarget: Object): boolean;
/**
 * Parse a CMake-generated dot/graphviz file and extract components and their dependency
 * relationships.
 *
 * The first `digraph` entry becomes the parent component. Subsequent `node` entries
 * with a `label` attribute are treated as direct dependencies, while commented
 * `node -> node` relationships are used to construct the dependency graph.
 *
 * @param {string} dotFile Path to the CMake-generated dot file
 * @param {string} pkgType PackageURL type to assign to extracted packages (e.g. `"generic"`)
 * @param {Object} options CLI options; may contain `projectGroup`, `projectName`, and `projectVersion`
 * @returns {{ parentComponent: Object, pkgList: Object[], dependenciesList: Object[] }}
 */
export declare function parseCmakeDotFile(dotFile: string, pkgType: string, options?: Object): {
    parentComponent: Object;
    pkgList: Object[];
    dependenciesList: Object[];
};
/**
 * The component for a dependency a CMake file downloads at configure time
 * (`FetchContent_Declare`, `ExternalProject_Add`, `CPMAddPackage`).
 *
 * A git repository becomes a `github` purl, or a `generic` one with a
 * `vcs_url`, at its tag or commit. A GitHub archive URL becomes a `github` purl
 * at the ref it names. Any other URL becomes a `generic` purl with a
 * `download_url`, and a `URL_HASH` becomes a hash. A version that still holds an
 * unresolved `${VAR}` is left out rather than published.
 *
 * @param {Object} dep Dependency facts from `cmakeFetchDependencies`
 * @param {string} srcFile The CMake file the dependency was read from
 * @returns {Object} The component
 */
export declare function cmakeFetchDependencyComponent(dep: Object, srcFile: string): Object;
/**
 * Parse a CMake-like build file (CMakeLists.txt, meson.build, etc.) and extract the
 * parent component and list of dependency packages.
 *
 * Handles `set`, `project`, `find_package`, `find_library`, `find_dependency`,
 * `find_file` and `dependency()` directives (CMake command names in any case),
 * and, for CMake files, the dependencies downloaded at configure time by
 * `FetchContent_Declare`, `ExternalProject_Add` and `CPMAddPackage`.
 * Uses the MesonWrapDB to improve name resolution confidence.
 *
 * @param {string} cmakeListFile Path to the CMake-like build file
 * @param {string} pkgType PackageURL type to assign to extracted packages (e.g. `"generic"`)
 * @param {Object} options CLI options; may contain `projectGroup`, `projectName`, and `projectVersion`
 * @returns {{ parentComponent: Object, pkgList: Object[] }}
 */
export declare function parseCmakeLikeFile(cmakeListFile: string, pkgType: string, options?: Object): {
    parentComponent: Object;
    pkgList: Object[];
};
/**
 * Parse an atom C/C++ usage-slice report into per-file package usage data.
 *
 * Walks the `objectSlices` of an atom report, collecting resolved method names
 * and full names per source file while skipping include globals and compiler
 * internals.
 *
 * @param {object} sliceData Parsed atom usage-slice report.
 * @returns {Object<string, Set<string>>|undefined} Map of file name to the set
 *   of used symbols, or undefined when sliceData is empty.
 */
export declare function parseCUsageSlice(sliceData: object): Record<string, Set<string>> | undefined;
/**
 * Function to parse the .d make files
 *
 * @param {String} dfile .d file path
 *
 * @returns {Object} pkgFilesMap Object with package name and list of files
 */
export declare function parseMakeDFile(dfile: string): Object;
/**
 * Parse the contents of a 'Podfile.lock'
 *
 * @param {Object} podfileLock The content of the podfile.lock as an Object
 * @param {String} projectPath The path to the project root
 * @param {String} [scanRoot] Directory the scan was asked for. Local `:path`
 *   and `:podspec` sources outside it are not read. Defaults to projectPath.
 * @returns {Map} Map of all dependencies with their direct dependencies
 */
export declare function parsePodfileLock(podfileLock: Object, projectPath: string, scanRoot?: string): Map<any, any>;
/**
 * Parse all targets and their direct dependencies from the 'Podfile'
 *
 * @param {Object} target A JSON-object representing a target
 * @param {Map} allDependencies The map containing all parsed direct dependencies for a target
 * @param {String} [prefix=undefined] Prefix to add to the targets name
 */
export declare function parsePodfileTargets(target: Object, allDependencies: Map<any, any>, prefix?: string): void;
/**
 * Parse a single line representing a dependency
 *
 * @param {String} dependencyLine The line that should be parsed as a dependency
 * @param {boolean} [parseVersion=true] Include parsing the version of the dependency
 * @returns {Object} Object representing a dependency
 */
export declare function parseCocoaDependency(dependencyLine: string, parseVersion?: boolean): Object;
/**
 * Execute the 'pod'-command with parameters
 *
 * @param {String[]} parameters The parameters for the command
 * @param {String} path The path where the command should be executed
 * @param {Object} options CLI options
 * @returns {Object} The result of running the command
 */
export declare function executePodCommand(parameters: string[], path: string, options: Object): Object;
/**
 * Method that handles object creation for cocoa pods.
 *
 * @param {Object} dependency The dependency that is to be transformed into an SBOM object
 * @param {Object} options CLI options
 * @param {String} [type="library"] The type of Object to create
 * @returns {Object} An object representing the pod in SBOM-format
 */
export declare function buildObjectForCocoaPod(dependency: Object, options: Object, type?: string): Object;
/**
 * Discard prefetched podspecs. Tests only.
 */
export declare function resetCocoaPodspecPrefetch(): void;
/**
 * Prefetch the remote podspecs a full CocoaPods scan is about to read.
 *
 * The probe is speculative — up to four URLs per pod — so batching all of them
 * at once would issue requests the serial path never makes: a pod whose podspec
 * sits on `main` is one request there and would be four here. Instead each
 * candidate position is its own round, and a round carries only the pods that
 * every earlier round missed. That is the same set of requests the serial path
 * makes, in the same order of preference, with the pods within a round
 * overlapped rather than queued. Rounds are bounded at four however many pods
 * there are.
 *
 * @param {Array<Object>} dependencies Pod metadata objects, each optionally
 *   carrying a `cdx:pods:podspecLocation` property.
 * @returns {Promise<void>}
 */
export declare function prefetchCocoaPodspecs(dependencies: Array<Object>): Promise<void>;
/**
 * Parse an xmake `xmake-requires.lock` file.
 *
 * The lock is a Lua table, written when the `package.requires_lock` policy is
 * enabled. Its top level holds a `__meta__` entry plus one section per build
 * configuration, keyed `platform|arch`; each section maps a requirement key
 * (`"zlib#31fecfc4"`, or `"sol2 v3.2.1#72267bd5"` when the requirement
 * carries a version) to a table with the resolved `version` and the
 * `repo` revision the package definition came from.
 *
 * The same package appears once per configuration, so entries are collapsed
 * by name and version, and the configurations a package was resolved for are
 * kept as a property. A requirement key without a `version` field names a
 * system package xmake did not resolve; it is inventoried without a version.
 *
 * No `xmake` purl type is registered, so packages are identified as generic
 * carrying a `cdx:purl:proposedType=xmake` property, following the
 * convention used for nix and zig.
 *
 * @param {string} lockFile Path to `xmake-requires.lock`
 * @returns {Object[]} Package records for the pinned requirements
 */
export declare function parseXmakeRequiresLock(lockFile: string): Object[];
//# sourceMappingURL=parsers-misc.d.ts.map
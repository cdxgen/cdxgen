/**
 * For all modules in the specified package, creates a list of
 * component objects from each one.
 *
 * @param {Object} options CLI options
 * @param {Object} allImports All imports
 * @param {Object} pkg Package object
 * @param {string} ptype Package type
 * @returns {Object[]} Array of component objects
 */
export function listComponents(options: Object, allImports: Object, pkg: Object, ptype?: string): Object[];
/**
 * Function to create bom string for Java jars
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 *
 * @returns {Object} BOM with namespace mapping
 */
export function createJarBom(path: string, options: Object): Object;
/**
 * Function to create bom string for Android apps using blint
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object|undefined} BOM object
 */
export function createAndroidBom(path: string, options: Object): Object | undefined;
/**
 * Function to create bom string for binaries using blint
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object|undefined} BOM object
 */
export function createBinaryBom(path: string, options: Object): Object | undefined;
/**
 * Function to create bom string for Java projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createJavaBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Node.js projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createNodejsBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Projects that use Pixi package manager.
 * createPixiBom is based on createPythonBom.
 * Pixi package manager utilizes many languages like python, rust, C/C++, ruby, etc.
 * It produces a Lockfile which help produce reproducible envs across operating systems.
 * This code will look at the operating system of our machine and create a BOM specific to that machine.
 *
 *
 * @param {String} path
 * @param {Object} options
 * @returns {Object} BOM object
 */
export function createPixiBom(path: string, options: Object): Object;
/**
 * Function to create bom string for Python projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createPythonBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Go projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createGoBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Rust projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createRustBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Dart projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createDartBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for cpp projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createCppBom(path: string, options: Object): Object;
/**
 * Function to create bom string for clojure projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createClojureBom(path: string, options: Object): Object;
/**
 * Function to create bom string for Haskell projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createHaskellBom(path: string, options: Object): Object;
/**
 * Function to create bom string for Elixir projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createElixirBom(path: string, options: Object): Object;
/**
 * Function to create bom string for GitHub action workflows
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createGitHubBom(path: string, options: Object): Object;
/**
 * Function to create bom string for cloudbuild yaml
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createCloudBuildBom(path: string, options: Object): Object;
/**
 * Function to create obom string for the current OS using osquery
 *
 * @param {string} _path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createOSBom(_path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Jenkins plugins
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createJenkinsBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Helm charts
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createHelmBom(path: string, options: Object): Object;
/**
 * Function to create bom string for swift projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createSwiftBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for cocoa projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createCocoaBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Nix flakes
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createNixBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for caxa SEA binaries
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createCaxaBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for docker compose
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createContainerSpecLikeBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for php projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createPHPBom(path: string, options: Object): Object;
/**
 * Function to create bom string for ruby projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createRubyBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for csharp projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object|undefined>} Promise resolving to BOM object
 */
export function createCsharpBom(path: string, options: Object): Promise<Object | undefined>;
/**
 * Function to create bom object for cryptographic certificate files
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createCryptoCertsBom(path: string, options: Object): Promise<Object>;
/**
 * Merges two CycloneDX dependency arrays into a single deduplicated list.
 * For each unique ref, the dependsOn and provides sets from both arrays are
 * combined. Self-referential entries pointing to the parent component are
 * removed from all dependsOn and provides lists.
 *
 * @param {Object[]} dependencies First array of dependency objects
 * @param {Object[]} newDependencies Second array of dependency objects to merge
 * @param {Object} parentComponent Parent component whose bom-ref is used to filter self-references
 * @returns {Object[]} Merged and deduplicated array of dependency objects
 */
export function mergeDependencies(dependencies: Object[], newDependencies: Object[], parentComponent?: Object): Object[];
/**
 * Trim duplicate components by retaining all the properties
 *
 * @param {Array} components Components
 *
 * @returns {Array} Filtered components
 */
export function trimComponents(components: any[]): any[];
/**
 * Dedupe components
 *
 * @param {Object} options Options
 * @param {Array} components Components
 * @param {Object} parentComponent Parent component
 * @param {Array} dependencies Dependencies
 *
 * @returns {Object} Object including BOM Json
 */
export function dedupeBom(options: Object, components: any[], parentComponent: Object, dependencies: any[]): Object;
/**
 * Function to create bom string for all languages
 *
 * @param {string[]} pathList list of to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createMultiXBom(pathList: string[], options: Object): Promise<Object>;
/**
 * Function to create bom string for various languages
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object|undefined>} Promise resolving to BOM object, or undefined if path is not readable
 */
export function createXBom(path: string, options: Object): Promise<Object | undefined>;
/**
 * Function to create bom string for various languages
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createBom(path: string, options: Object): Promise<Object>;
/**
 * Method to submit the generated bom to dependency-track or cyclonedx server
 *
 * @param {Object} args CLI args
 * @param {Object} bomContents BOM Json
 * @return {Promise<{ token: string } | undefined>} a promise with a token (if request was successful) or undefined (in case of invalid arguments)
 * @throws {Error} if the request fails
 */
export function submitBom(args: Object, bomContents: Object): Promise<{
    token: string;
} | undefined>;
//# sourceMappingURL=index.d.ts.map
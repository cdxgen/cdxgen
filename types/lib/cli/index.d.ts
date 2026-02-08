/**
 * For all modules in the specified package, creates a list of
 * component objects from each one.
 *
 * @param {Object} options CLI options
 * @param {Object} allImports All imports
 * @param {Object} pkg Package object
 * @param {string} ptype Package type
 */
export function listComponents(options: any, allImports: any, pkg: any, ptype?: string): any[];
/**
 * Function to create bom string for Java jars
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 *
 * @returns {Object} BOM with namespace mapping
 */
export function createJarBom(path: string, options: any): any;
/**
 * Function to create bom string for Android apps using blint
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createAndroidBom(path: string, options: any): {
    bomJson: any;
    dependencies: any;
    parentComponent: any;
};
/**
 * Function to create bom string for binaries using blint
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createBinaryBom(path: string, options: any): {
    bomJson: any;
    dependencies: any;
    parentComponent: any;
};
/**
 * Function to create bom string for Java projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createJavaBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for Node.js projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createNodejsBom(path: string, options: any): Promise<any>;
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
 */
export function createPixiBom(path: string, options: any): any;
/**
 * Function to create bom string for Python projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createPythonBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for Go projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createGoBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for Rust projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createRustBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for Dart projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createDartBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for cpp projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createCppBom(path: string, options: any): any;
/**
 * Function to create bom string for clojure projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createClojureBom(path: string, options: any): any;
/**
 * Function to create bom string for Haskell projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createHaskellBom(path: string, options: any): any;
/**
 * Function to create bom string for Elixir projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createElixirBom(path: string, options: any): any;
/**
 * Function to create bom string for GitHub action workflows
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createGitHubBom(path: string, options: any): any;
/**
 * Function to create bom string for cloudbuild yaml
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createCloudBuildBom(path: string, options: any): any;
/**
 * Function to create obom string for the current OS using osquery
 *
 * @param {string} _path to the project
 * @param {Object} options Parse options from the cli
 */
export function createOSBom(_path: string, options: any): Promise<any>;
/**
 * Function to create bom string for Jenkins plugins
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createJenkinsBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for Helm charts
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createHelmBom(path: string, options: any): any;
/**
 * Function to create bom string for swift projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createSwiftBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for cocoa projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createCocoaBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for Nix flakes
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createNixBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for caxa SEA binaries
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createCaxaBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for docker compose
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createContainerSpecLikeBom(path: string, options: any): any;
/**
 * Function to create bom string for php projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createPHPBom(path: string, options: any): any;
/**
 * Function to create bom string for ruby projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createRubyBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for csharp projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createCsharpBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom object for cryptographic certificate files
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createCryptoCertsBom(path: string, options: any): Promise<{
    bomJson: {
        components: {
            name: any;
            type: string;
            version: string;
            "bom-ref": string;
            cryptoProperties: {
                assetType: string;
                algorithmProperties: {
                    executionEnvironment: string;
                    implementationPlatform: string;
                };
            };
            properties: {
                name: string;
                value: any;
            }[];
        }[];
    };
}>;
export function mergeDependencies(dependencies: any, newDependencies: any, parentComponent?: {}): ({
    ref: string;
    dependsOn: any;
    provides: any;
} | {
    ref: string;
    dependsOn: any;
    provides?: undefined;
})[];
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
export function dedupeBom(options: any, components: any[], parentComponent: any, dependencies: any[]): any;
/**
 * Function to create bom string for all languages
 *
 * @param {string[]} pathList list of to the project
 * @param {Object} options Parse options from the cli
 */
export function createMultiXBom(pathList: string[], options: any): Promise<any>;
/**
 * Function to create bom string for various languages
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createXBom(path: string, options: any): Promise<any>;
/**
 * Function to create bom string for various languages
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createBom(path: string, options: any): any;
/**
 * Method to submit the generated bom to dependency-track or cyclonedx server
 *
 * @param {Object} args CLI args
 * @param {Object} bomContents BOM Json
 * @return {Promise<{ token: string } | undefined>} a promise with a token (if request was successful) or undefined (in case of invalid arguments)
 * @throws {Error} if the request fails
 */
export function submitBom(args: any, bomContents: any): Promise<{
    token: string;
} | undefined>;
//# sourceMappingURL=index.d.ts.map
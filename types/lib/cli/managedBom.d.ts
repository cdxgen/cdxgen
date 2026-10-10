/**
 * Checks whether a directory contains .NET project or solution files
 * (`*.csproj`, `*.fsproj`, `*.vbproj`, `*.sln`).
 *
 * @param {string} src Directory to inspect
 * @param {object} [options={}] CLI options
 * @returns {boolean} True when at least one .NET project/solution file exists
 */
export declare const hasDotnetProjectIndicators: (src: string, options?: object) => boolean;
/**
 * Decides whether dosai crypto collection should run for a .NET source. Returns
 * true when an explicit dosai .NET project type is selected, or when no project
 * type (or `universal`) is selected and .NET project indicators are present.
 *
 * @param {string} src Directory to inspect
 * @param {object} [options={}] CLI options
 * @returns {boolean} True when dosai crypto collection should run
 */
export declare const shouldCollectDosaiCrypto: (src: string, options?: object) => boolean;
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
 * @returns {Object | null} BOM object, or `null` when `pixi.lock` is absent and `options.installDeps` is false
 */
export declare function createPixiBom(path: string, options: Object): Object | null;
/**
 * Function to create bom string for Python projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createPythonBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for GitHub action workflows
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export declare function createGitHubBom(path: string, options: Object): Object;
/**
 * Function to create bom string for cloudbuild yaml
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export declare function createCloudBuildBom(path: string, options: Object): Object;
/**
 * Function to create bom string for Jenkins plugins
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createJenkinsBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for Helm charts
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export declare function createHelmBom(path: string, options: Object): Object;
/**
 * Function to create bom string for php projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export declare function createPHPBom(path: string, options: Object): Object;
/**
 * Function to create bom string for ruby projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createRubyBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for csharp projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object|undefined>} Promise resolving to BOM object
 */
export declare function createCsharpBom(path: string, options: Object): Promise<Object | undefined>;
/**
 * Function to create bom object for cryptographic certificate files
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createCryptoCertsBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for R projects using renv.
 *
 * The `renv.lock` file carries the resolved package set for the project
 * library, including the R version it was produced under.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export declare function createRBom(path: string, options: Object): Object;
/**
 * Function to create bom string for Perl projects using Carton.
 *
 * The `cpanfile.snapshot` carries the resolved install set; the declared
 * `cpanfile` is consulted to distinguish direct dependencies.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export declare function createPerlBom(path: string, options: Object): Object;
/**
 * Function to create bom string for Terraform and OpenTofu projects.
 *
 * The workspace assembly turns the provider lock file, the module manifest
 * `init` writes and the configuration files into module and provider
 * components with a dependency graph and offline licenses. When metadata
 * fetching is enabled, the public registries add licenses, repository URLs
 * and registry flags to components the offline pass could not resolve.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export declare function createTerraformBom(path: string, options: Object): Promise<Object>;
//# sourceMappingURL=managedBom.d.ts.map
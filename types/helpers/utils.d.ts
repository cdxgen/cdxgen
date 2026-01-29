/**
 * Safely check if a file path exists without crashing due to a lack of permissions
 *
 * @param {String} filePath File path
 * @Boolean True if the path exists. False otherwise
 */
export function safeExistsSync(filePath: string): any;
/**
 * Safely create a directory without crashing due to a lack of permissions
 *
 * @param {String} filePath File path
 * @param options {Options} mkdir options
 * @Boolean True if the path exists. False otherwise
 */
export function safeMkdirSync(filePath: string, options: Options): any;
export function safeSpawnSync(command: any, args: any, options: any): any;
export function shouldFetchLicense(): any;
export function shouldFetchVCS(): any;
export function getJavaCommand(): string;
export function getPythonCommand(): string;
/**
 * Method to check if a given feature flag is enabled.
 *
 * @param {Object} cliOptions CLI options
 * @param {String} feature Feature flag
 *
 * @returns {Boolean} True if the feature is enabled
 */
export function isFeatureEnabled(cliOptions: any, feature: string): boolean;
/**
 * Method to check if the given project types are allowed by checking against include and exclude types passed from the CLI arguments.
 *
 * @param {Array} projectTypes project types to check
 * @param {Object} options CLI options
 * @param {Boolean} defaultStatus Default return value if there are no types provided
 */
export function hasAnyProjectType(projectTypes: any[], options: any, defaultStatus?: boolean): any;
/**
 * Convenient method to check if the given package manager is allowed.
 *
 * @param {String} name Package manager name
 * @param {Array} conflictingManagers List of package managers
 * @param {Object} options CLI options
 *
 * @returns {Boolean} True if the package manager is allowed
 */
export function isPackageManagerAllowed(name: string, conflictingManagers: any[], options: any): boolean;
/**
 * Method to get files matching a pattern
 *
 * @param {string} dirPath Root directory for search
 * @param {string} pattern Glob pattern (eg: *.gradle)
 * @param {Object} options CLI options
 *
 * @returns {Array[string]} List of matched files
 */
export function getAllFiles(dirPath: string, pattern: string, options?: any): any;
/**
 * Method to get files matching a pattern
 *
 * @param {string} dirPath Root directory for search
 * @param {string} pattern Glob pattern (eg: *.gradle)
 * @param {Boolean} includeDot whether hidden files can be included.
 * @param {Array} ignoreList Directory patterns to ignore
 *
 * @returns {Array[string]} List of matched files
 */
export function getAllFilesWithIgnore(dirPath: string, pattern: string, includeDot: boolean, ignoreList: any[]): any;
/**
 * Return the current timestamp in YYYY-MM-DDTHH:MM:SSZ format.
 *
 * @returns {string} ISO formatted timestamp, without milliseconds.
 */
export function getTimestamp(): string;
export function getTmpDir(): any;
/**
 * Method to determine if a license is a valid SPDX license expression
 *
 * @param {string} license License string
 * @returns {boolean} true if the license is a valid SPDX license expression
 * @see https://spdx.dev/learn/handling-license-info/
 **/
export function isSpdxLicenseExpression(license: string): boolean;
/**
 * Convert the array of licenses to a CycloneDX 1.5 compliant license array.
 * This should return an array containing:
 * - one or more SPDX license if no expression is present
 * - the license of the expression if one expression is present
 * - a unified conditional 'OR' license expression if more than one expression is present
 *
 * @param {Array} licenses Array of licenses
 * @returns {Array} CycloneDX 1.5 compliant license array
 */
export function adjustLicenseInformation(licenses: any[]): any[];
/**
 * Performs a lookup + validation of the license specified in the
 * package. If the license is a valid SPDX license ID, set the 'id'
 * and url of the license object, otherwise, set the 'name' of the license
 * object.
 */
export function getLicenses(pkg: any): any[];
/**
 * Method to retrieve known license by known-licenses.json
 *
 * @param {String} licenseUrl Repository url
 * @param {String} pkg Bom ref
 * @return {Object} Objetct with SPDX license id or license name
 */
export function getKnownLicense(licenseUrl: string, pkg: string): any;
/**
 * Tries to find a file containing the license text based on commonly
 * used naming and content types. If a candidate file is found, add
 * the text to the license text object and stop.
 */
export function addLicenseText(pkg: any, l: any, licenseContent: any): void;
/**
 * Read the file from the given path to the license text object and includes
 * content-type attribute, if not default. Returns the license text object.
 */
export function readLicenseText(licenseFilepath: any, licenseContentType: any): {
    content: any;
};
export function getSwiftPackageMetadata(pkgList: any): Promise<any[]>;
/**
 * Method to retrieve metadata for npm packages by querying npmjs
 *
 * @param {Array} pkgList Package list
 */
export function getNpmMetadata(pkgList: any[]): Promise<any[]>;
/**
 * Parse nodejs package json file
 *
 * @param {string} pkgJsonFile package.json file
 * @param {boolean} simple Return a simpler representation of the component by skipping extended attributes and license fetch.
 */
export function parsePkgJson(pkgJsonFile: string, simple?: boolean): Promise<any[]>;
/**
 * Parse nodejs package lock file
 *
 * @param {string} pkgLockFile package-lock.json file
 * @param {object} options Command line options
 */
export function parsePkgLock(pkgLockFile: string, options?: object): Promise<{
    pkgList: any;
    dependenciesList: any;
}>;
/**
 * Given a lock file this method would return an Object with the identity as the key and parsed name and value
 * eg: "@actions/core@^1.2.6", "@actions/core@^1.6.0":
 *        version "1.6.0"
 * would result in two entries
 *
 * @param {string} lockData Yarn Lockfile data
 */
export function yarnLockToIdentMap(lockData: string): {};
/**
 * Parse nodejs yarn lock file
 *
 * @param {string} yarnLockFile yarn.lock file
 * @param {Object} parentComponent parent component
 * @param {Array[String]} workspacePackages Workspace packages
 * @param {Object} workspaceSrcFiles Workspace package.json files
 * @param {Object} _workspaceDirectDeps Direct dependencies of each workspace
 * @param {Object} depsWorkspaceRefs Workspace references for each dependency
 */
export function parseYarnLock(yarnLockFile: string, parentComponent?: any, workspacePackages?: any, workspaceSrcFiles?: any, _workspaceDirectDeps?: any, depsWorkspaceRefs?: any): Promise<{
    pkgList: any[];
    dependenciesList: any[];
}>;
/**
 * Parse nodejs shrinkwrap deps file
 *
 * @param {string} swFile shrinkwrap-deps.json file
 */
export function parseNodeShrinkwrap(swFile: string): Promise<any[]>;
/**
 * Parse pnpm workspace file
 *
 * @param {string} workspaceFile pnpm-workspace.yaml
 * @returns {object} Object containing packages and catalogs
 */
export function parsePnpmWorkspace(workspaceFile: string): object;
/**
 * Helper function to create a properly encoded workspace PURL
 *
 * @param {string} packageName - Package name (e.g., "@babel/core")
 * @param {string} version - Package version
 * @returns {string} Encoded PURL string
 */
export function createNpmWorkspacePurl(packageName: string, version: string): string;
export function parseYarnWorkspace(packageJsonFile: any): {
    packages?: undefined;
} | {
    packages: any;
};
/**
 * Helper function to find a package path in pnpm node_modules structure
 *
 * @param {string} baseDir Base directory containing node_modules
 * @param {string} packageName Package name (with or without scope)
 * @param {string} version Package version
 * @returns {string|null} Path to the package directory or null if not found
 */
export function findPnpmPackagePath(baseDir: string, packageName: string, version: string): string | null;
/**
 * pnpm packages with metadata from local node_modules
 *
 * @param {Array} pkgList Package list to enhance
 * @param {string} lockFilePath Path to the pnpm-lock.yaml file
 * @returns {Array} Enhanced package list
 */
export function pnpmMetadata(pkgList: any[], lockFilePath: string): any[];
/**
 * Parse nodejs pnpm lock file
 *
 * @param {string} pnpmLock pnpm-lock.yaml file
 * @param {Object} parentComponent parent component
 * @param {Array[String]} workspacePackages Workspace packages
 * @param {Object} workspaceSrcFiles Workspace package.json files
 * @param {Object} workspaceCatalogs Workspace catalogs
 * @param {Object} workspaceDirectDeps Direct dependencies of each workspace
 * @param {Object} depsWorkspaceRefs Workspace references for each dependency
 */
export function parsePnpmLock(pnpmLock: string, parentComponent?: any, workspacePackages?: any, workspaceSrcFiles?: any, _workspaceCatalogs?: {}, _workspaceDirectDeps?: {}, depsWorkspaceRefs?: any): Promise<{
    pkgList?: undefined;
    dependenciesList?: undefined;
    parentSubComponents?: undefined;
} | {
    pkgList: any[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
    parentSubComponents: {
        group: any;
        name: any;
        version: any;
        type: string;
        purl: string;
        "bom-ref": string;
    }[];
}>;
/**
 * Parse bower json file
 *
 * @param {string} bowerJsonFile bower.json file
 */
export function parseBowerJson(bowerJsonFile: string): Promise<any[]>;
/**
 * Parse minified js file
 *
 * @param {string} minJsFile min.js file
 */
export function parseMinJs(minJsFile: string): Promise<any[]>;
/**
 * Parse pom file
 *
 * @param {string} pomFile pom file to parse
 * @returns {Object} Object containing pom properties, modules, and array of dependencies
 */
export function parsePom(pomFile: string): any;
/**
 * Parse maven tree output
 * @param {string} rawOutput Raw string output
 * @param {string} pomFile .pom file for evidence
 *
 * @returns {Object} Object containing packages and dependencies
 */
export function parseMavenTree(rawOutput: string, pomFile: string): any;
/**
 * Parse mill dependencies from file
 *
 * @param {string} module name of the module
 * @param {map} dependencies the parsed dependencies
 * @param {map} relations a map containing all relations
 * @param {string} millRootPath root of the project
 *
 * @returns the bom-ref of the module
 */
export function parseMillDependency(module: string, dependencies: map, relations: map, millRootPath: string): any;
/**
 * Parse gradle dependencies output
 * @param {string} rawOutput Raw string output
 * @param {string} rootProjectName Root project name
 * @param {map} gradleModules Cache with all gradle modules that have already been read
 * @param {string} gradleRootPath Root path where Gradle is to be run when getting module information
 */
export function parseGradleDep(rawOutput: string, rootProjectName?: string, gradleModules?: map, gradleRootPath?: string): Promise<{
    pkgList: any[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
} | {
    pkgList?: undefined;
    dependenciesList?: undefined;
}>;
/**
 * Parse clojure cli dependencies output
 * @param {string} rawOutput Raw string output
 */
export function parseCljDep(rawOutput: string): any[];
/**
 * Parse lein dependency tree output
 * @param {string} rawOutput Raw string output
 */
export function parseLeinDep(rawOutput: string): any;
export function parseLeinMap(node: any, keys_cache: any, deps: any): any;
/**
 * Parse gradle projects output
 *
 * @param {string} rawOutput Raw string output
 */
export function parseGradleProjects(rawOutput: string): {
    rootProject: string;
    projects: any;
};
/**
 * Parse gradle properties output
 *
 * @param {string} rawOutput Raw string output
 * @param {string} gradleModuleName The name (or 'path') of the module as seen from the root of the project
 */
export function parseGradleProperties(rawOutput: string, gradleModuleName?: string): {
    rootProject: string;
    projects: any;
    metadata: {
        group: string;
        version: string;
        properties: any[];
    };
};
/**
 * Execute gradle properties command using multi-threading and return parsed output
 *
 * @param {string} dir Directory to execute the command
 * @param {array} allProjectsStr List of all sub-projects (including the preceding `:`)
 * @param {array} extraArgs List of extra arguments to use when calling gradle
 *
 * @returns {string} The combined output for all subprojects of the Gradle properties task
 */
export function executeParallelGradleProperties(dir: string, allProjectsStr: any[], extraArgs?: any[]): string;
/**
 * Parse bazel action graph output
 * @param {string} rawOutput Raw string output
 */
export function parseBazelActionGraph(rawOutput: string): any[];
/**
 * Parse bazel skyframe state output
 * @param {string} rawOutput Raw string output
 */
export function parseBazelSkyframe(rawOutput: string): any[];
/**
 * Parse bazel BUILD file
 * @param {string} rawOutput Raw string output
 */
export function parseBazelBuild(rawOutput: string): any[];
/**
 * Parse dependencies in Key:Value format
 */
export function parseKVDep(rawOutput: any): any[];
/**
 * Method to find the spdx license id from name
 *
 * @param {string} name License full name
 */
export function findLicenseId(name: string): any;
/**
 * Method to guess the spdx license id from license contents
 *
 * @param {string} content License file contents
 */
export function guessLicenseId(content: string): any;
/**
 * Method to retrieve metadata for maven packages by querying maven central
 *
 * @param {Array} pkgList Package list
 * @param {Object} jarNSMapping Jar Namespace mapping object
 * @param {Boolean} force Force fetching of license
 *
 * @returns {Array} Updated package list
 */
export function getMvnMetadata(pkgList: any[], jarNSMapping?: any, force?: boolean): any[];
/**
 * Method to compose URL of pom.xml
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {String} fullUrl
 */
export function composePomXmlUrl({ urlPrefix, group, name, version }: string): string;
/**
 * Method to fetch pom.xml data and parse it to JSON
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Object|undefined}
 */
export function fetchPomXmlAsJson({ urlPrefix, group, name, version }: string): any | undefined;
/**
 * Method to fetch pom.xml data
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Promise<String>}
 */
export function fetchPomXml({ urlPrefix, group, name, version }: string): Promise<string>;
/**
 * Method extract single or multiple license entries that might appear in pom.xml
 *
 * @param {Object|Array} license
 */
export function parseLicenseEntryOrArrayFromPomXml(license: any | any[]): any[];
/**
 * Method to parse pom.xml in search of a comment containing license text
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Promise<String>} License ID
 */
export function extractLicenseCommentFromPomXml({ urlPrefix, group, name, version, }: string): Promise<string>;
/**
 * Method to parse python requires_dist attribute found in pypi setup.py
 *
 * @param {String} dist_string string
 */
export function parsePyRequiresDist(dist_string: string): {
    name: string;
    version: string;
};
/**
 * Method to mimic pip version solver using node-semver
 *
 * @param {Array} versionsList List of version numbers available
 * @param {*} versionSpecifiers pip version specifier
 */
export function guessPypiMatchingVersion(versionsList: any[], versionSpecifiers: any): any;
/**
 * Method to retrieve metadata for python packages by querying pypi
 *
 * @param {Array} pkgList Package list
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 */
export function getPyMetadata(pkgList: any[], fetchDepsInfo: boolean): Promise<any[]>;
/**
 * Method to parse bdist_wheel metadata
 *
 * @param {Object} mData bdist_wheel metadata
 */
export function parseBdistMetadata(mData: any): {}[];
/**
 * Method to parse pipfile.lock data
 *
 * @param {Object} lockData JSON data from Pipfile.lock
 */
export function parsePiplockData(lockData: any): Promise<any[]>;
/**
 * Method to parse python pyproject.toml file
 *
 * @param {string} tomlFile pyproject.toml file
 * @returns {Object} Object with parent component, root dependencies, and metadata.
 */
export function parsePyProjectTomlFile(tomlFile: string): any;
/**
 * Method to parse python lock files such as poetry.lock, pdm.lock, uv.lock.
 *
 * @param {Object} lockData JSON data from poetry.lock, pdm.lock, or uv.lock file
 * @param {string} lockFile Lock file name for evidence
 * @param {string} pyProjectFile pyproject.toml file
 */
export function parsePyLockData(lockData: any, lockFile: string, pyProjectFile: string): Promise<{
    pkgList: any[];
    dependenciesList: any[];
    parentComponent?: undefined;
    rootList?: undefined;
    workspaceWarningShown?: undefined;
} | {
    parentComponent: any;
    pkgList: any[];
    rootList: {
        name: any;
        version: any;
        description: any;
        properties: any[];
    }[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
    workspaceWarningShown: boolean;
}>;
/**
 * Method to parse requirements.txt file. This must be replaced with atom parsedeps.
 *
 * @param {String} reqFile Requirements.txt file
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 *
 * @returns {Promise[Array<Object>]} List of direct dependencies from the requirements file
 */
export function parseReqFile(reqFile: string, fetchDepsInfo?: boolean): any;
/**
 * Parse environment markers into structured format
 *
 * @param {String} markersStr Raw markers string
 * @returns {Array<Object>} Structured markers array
 */
export function parseReqEnvMarkers(markersStr: string): Array<any>;
/**
 * Method to find python modules by parsing the imports and then checking with PyPI to obtain the latest version
 *
 * @param {string} src directory
 * @param {Array} epkgList Existing package list
 * @param {Object} options CLI options
 * @returns List of packages
 */
export function getPyModules(src: string, epkgList: any[], options: any): Promise<{
    allImports: {};
    pkgList: any;
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
    modList: any;
}>;
/**
 * Method to parse setup.py data
 *
 * @param {Object} setupPyData Contents of setup.py
 */
export function parseSetupPyFile(setupPyData: any): Promise<any[]>;
/**
 * Method to parse pixi.lock data
 *
 * @param {String} pixiLockFileName  pixi.lock file name
 * @param {String} path File path
 */
export function parsePixiLockFile(pixiLockFileName: string, path: string): {
    pkgList: any;
    formulationList: any[];
    rootList: any[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
    frozen: boolean;
};
/**
 * Method to parse pixi.toml file
 *
 * @param {String} pixiToml
 */
export function parsePixiTomlFile(pixiToml: string): {
    description: any;
    name: any;
    version: any;
    homepage: any;
    repository: any;
};
/**
 * Method to construct a GitHub API url for the given repo metadata
 * @param {Object} repoMetadata Repo metadata with group and name
 * @return {String|undefined} github api url (or undefined - if not enough data)
 */
export function repoMetadataToGitHubApiUrl(repoMetadata: any): string | undefined;
/**
 * Method to run cli command `pixi install`
 *
 *
 */
export function generatePixiLockFile(_path: any): void;
/**
 * Method to split GitHub url into its parts
 * @param {String} repoUrl Repository url
 * @return {[String]} parts from url
 */
export function getGithubUrlParts(repoUrl: string): [string];
/**
 * Method to construct GitHub api url from repo metadata or one of multiple formats of repo URLs
 * @param {String} repoUrl Repository url
 * @param {Object} repoMetadata Object containing group and package name strings
 * @return {String|undefined} github api url (or undefined - if not a GitHub repo)
 */
export function toGitHubApiUrl(repoUrl: string, repoMetadata: any): string | undefined;
/**
 * Method to retrieve repo license by querying github api
 *
 * @param {String} repoUrl Repository url
 * @param {Object} repoMetadata Object containing group and package name strings
 * @return {Promise<String>} SPDX license id
 */
export function getRepoLicense(repoUrl: string, repoMetadata: any): Promise<string>;
/**
 * Method to get go pkg license from go.dev site.
 *
 * @param {Object} repoMetadata Repo metadata
 */
export function getGoPkgLicense(repoMetadata: any): Promise<any>;
export function getGoPkgComponent(group: any, name: any, version: any, hash: any): Promise<{
    group: any;
    name: any;
    version: any;
    _integrity: any;
    license: any;
    purl: string;
    "bom-ref": string;
}>;
/**
 * Method to parse go.mod files
 *
 * @param {String} goModData Contents of go.mod file
 * @param {Object} gosumMap Data from go.sum files
 *
 * @returns {Object} Object containing parent component, rootList and packages list
 */
export function parseGoModData(goModData: string, gosumMap: any): any;
export function parseGoModulesTxt(txtFile: any, gosumMap: any): Promise<any[]>;
/**
 * Parse go list output
 *
 * @param {string} rawOutput Output from go list invocation
 * @param {Object} gosumMap go.sum data
 * @returns Object with parent component and List of packages
 */
export function parseGoListDep(rawOutput: string, gosumMap: any): Promise<{
    parentComponent: {};
    pkgList: {
        group: any;
        name: any;
        version: any;
        _integrity: any;
        license: any;
        purl: string;
        "bom-ref": string;
    }[];
}>;
/**
 * Parse go mod graph
 *
 * @param {string} rawOutput Output from go mod graph invocation
 * @param {string} goModFile go.mod file
 * @param {Object} gosumMap Hashes from gosum for lookups
 * @param {Array} epkgList Existing package list
 * @param {Object} parentComponent Current parent component
 *
 * @returns Object containing List of packages and dependencies
 */
export function parseGoModGraph(rawOutput: string, goModFile: string, gosumMap: any, epkgList?: any[], parentComponent?: any): Promise<{
    pkgList: any[];
    dependenciesList: {
        ref: string;
        dependsOn: any;
    }[];
    parentComponent: any;
    rootList: any;
}>;
/**
 * Parse go mod why output.
 *
 * @param {string} rawOutput Output from go mod why
 * @returns {string|undefined} package name or none
 */
export function parseGoModWhy(rawOutput: string): string | undefined;
/**
 * Parse go sum data
 * @param {string} gosumData Content of go.sum
 * @returns package list
 */
export function parseGosumData(gosumData: string): Promise<any[]>;
export function parseGopkgData(gopkgData: any): Promise<any[]>;
export function parseGoVersionData(buildInfoData: any): Promise<any[]>;
/**
 * Method to query rubygems api for gems details
 *
 * @param {Array} pkgList List of packages with metadata
 */
export function getRubyGemsMetadata(pkgList: any[]): Promise<any[]>;
/**
 * Utility method to convert a gem package name to a CamelCased module name. Low accuracy.
 *
 * @param name Package name
 */
export function toGemModuleNames(name: any): string[];
/**
 * Collect all namespaces for a given gem present at the given gemHome
 *
 * @param {String} rubyCommand Ruby command to use if bundle is not available
 * @param {String} bundleCommand Bundle command to use
 * @param {String} gemHome Value to use as GEM_HOME env variable
 * @param {String} gemName Name of the gem
 * @param {String} filePath File path to the directory containing the Gemfile or .bundle directory
 *
 * @returns {Array<string>} List of module names
 */
export function collectGemModuleNames(rubyCommand: string, bundleCommand: string, gemHome: string, gemName: string, filePath: string): Array<string>;
/**
 * Method to parse Gemspec file contents
 *
 * @param {string} gemspecData Gemspec data
 * @param {string} gemspecFile File name for evidence.
 */
export function parseGemspecData(gemspecData: string, gemspecFile: string): Promise<any[]>;
/**
 * Method to parse Gemfile.lock
 *
 * @param {object} gemLockData Gemfile.lock data
 * @param {string} lockFile Lock file
 */
export function parseGemfileLockData(gemLockData: object, lockFile: string): Promise<any[] | {
    pkgList: any[];
    dependenciesList: {
        ref: string;
        dependsOn: any;
    }[];
    rootList: any[];
}>;
/**
 * Method to retrieve metadata for rust packages by querying crates
 *
 * @param {Array} pkgList Package list
 */
export function getCratesMetadata(pkgList: any[]): Promise<any[]>;
/**
 * Method to retrieve metadata for dart packages by querying pub.dev
 *
 * @param {Array} pkgList Package list
 */
export function getDartMetadata(pkgList: any[]): Promise<any[]>;
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
export function parseCargoTomlData(cargoTomlFile: string, simple?: boolean, pkgFilesMap?: any): any[];
/**
 * Parse a Cargo.lock file to find components within the Rust project.
 *
 * @param {String} cargoLockFile A path to a Cargo.lock file. The Cargo.lock-file path may be used as information for extended attributes, such as manifest based evidence.
 * @param {boolean} simple Return a simpler representation of the component by skipping extended attributes and license fetch.
 * @param {Object} pkgFilesMap Object with package name and list of files
 *
 * @returns {Array} A list of the project's components as described by the Cargo.lock-file.
 */
export function parseCargoData(cargoLockFile: string, simple?: boolean, pkgFilesMap?: any): any[];
export function parseCargoDependencyData(cargoLockData: any): any[];
export function parseCargoAuditableData(cargoData: any): Promise<any[]>;
/**
 * Method to parse pubspec.lock files.
 *
 * @param pubLockData Contents of lock data
 * @param lockFile Filename for setting evidence
 *
 * @returns {Object}
 */
export function parsePubLockData(pubLockData: any, lockFile: any): any;
export function parsePubYamlData(pubYamlData: any): any[];
export function parseHelmYamlData(helmData: any): any[];
export function recurseImageNameLookup(keyValueObj: any, pkgList: any, imgList: any): any;
export function parseContainerFile(fileContents: any): any;
export function parseBitbucketPipelinesFile(fileContents: any): {
    image: any;
}[];
export function parseContainerSpecData(dcData: any): any[];
export function identifyFlow(processingObj: any): string;
export function parsePrivadoFile(f: any): any[];
export function parseOpenapiSpecData(oaData: any): any[];
export function parseCabalData(cabalData: any): any[];
export function parseMixLockData(mixData: any): any[];
export function parseGitHubWorkflowData(f: any): any[];
export function parseCloudBuildData(cbwData: any): any[];
export function mapConanPkgRefToPurlStringAndNameAndVersion(conanPkgRef: any): any[];
export function parseConanLockData(conanLockData: any): {
    pkgList: any[];
    dependencies: {};
    parentComponentDependencies: any[];
};
export function parseConanData(conanData: any): any[];
export function parseLeiningenData(leinData: any): any[];
export function parseEdnData(rawEdnData: any): any[];
/**
 * Method to parse .nupkg files
 *
 * @param {String} nupkgFile .nupkg file
 * @returns {Object} Object containing package list and dependencies
 */
export function parseNupkg(nupkgFile: string): any;
/**
 * Method to parse flake.nix files
 *
 * @param {String} flakeNixFile flake.nix file to parse
 * @returns {Object} Object containing package information
 */
export function parseFlakeNix(flakeNixFile: string): any;
/**
 * Method to parse flake.lock files
 *
 * @param {String} flakeLockFile flake.lock file to parse
 * @returns {Object} Object containing locked dependency information
 */
export function parseFlakeLock(flakeLockFile: string): any;
/**
 * Method to parse .nuspec files
 *
 * @param {String} nupkgFile .nupkg file
 * @param {String} nuspecData Raw nuspec data
 * @returns {Object} Object containing package list and dependencies
 */
export function parseNuspecData(nupkgFile: string, nuspecData: string): any;
export function parseCsPkgData(pkgData: any, pkgFile: any): any[];
/**
 * Method to find all text nodes in PropertyGroup elements in .props files.
 *
 * @param {String} propsFiles .props files in this project
 *
 * @returns {Object} Containing text nodes from PropertyGroup elements and their values
 */
export function getPropertyGroupTextNodes(propsFiles: string): any;
/**
 * Method to parse .csproj like xml files
 *
 * @param {String} csProjData Raw data
 * @param {String} projFile File name
 * @param {Object} pkgNameVersions Package name - version map object
 *
 * @returns {Object} Containing parent component, package, and dependencies
 */
export function parseCsProjData(csProjData: string, projFile: string, pkgNameVersions?: any, msbuildInstalled?: boolean, pkgVersionLabelCandidates?: {}): any;
export function parseCsProjAssetsData(csProjData: any, assetsJsonFile: any): {
    pkgList: any[];
    dependenciesList: any[];
};
export function parseCsPkgLockData(csLockData: any, pkgLockFile: any): {
    pkgList: any[];
    dependenciesList: any[];
    rootList: any[];
};
export function parsePaketLockData(paketLockData: any, pkgLockFile: any): {
    pkgList: any[];
    dependenciesList: any[];
};
/**
 * Parse composer.json file
 *
 * @param {string} composerJsonFile composer.json file
 *
 * @returns {Object} Object with rootRequires and parent component
 */
export function parseComposerJson(composerJsonFile: string): any;
/**
 * Parse composer lock file
 *
 * @param {string} pkgLockFile composer.lock file
 * @param {array} rootRequires require section from composer.json
 */
export function parseComposerLock(pkgLockFile: string, rootRequires: any[]): any[] | {
    pkgList: {
        group: any;
        name: any;
        purl: string;
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
        dependsOn: any;
    }[];
    rootList: {
        group: any;
        name: any;
        purl: string;
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
export function parseSbtTree(sbtTreeFile: any): {
    pkgList: any[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
};
/**
 * Parse sbt lock file
 *
 * @param {string} pkgLockFile build.sbt.lock file
 */
export function parseSbtLock(pkgLockFile: string): {
    group: any;
    name: any;
    version: any;
    _integrity: string;
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
/**
 * Method to execute dpkg --listfiles to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeDpkgList(pkgName: string): any;
/**
 * Method to execute dnf repoquery to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeRpmList(pkgName: string): any;
/**
 * Method to execute apk -L info to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeApkList(pkgName: string): any;
/**
 * Method to execute alpm -Ql to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeAlpmList(pkgName: string): any;
/**
 * Method to execute equery files to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeEqueryList(pkgName: string): any;
/**
 * Convert OS query results
 *
 * @param {string} queryCategory Query category
 * @param {Object} queryObj Query Object from the queries.json configuration
 * @param {Array} results Query Results
 * @param {Boolean} enhance Optionally enhance results by invoking additional package manager commands
 */
export function convertOSQueryResults(queryCategory: string, queryObj: any, results: any[], enhance?: boolean): {
    name: any;
    group: string;
    version: any;
    description: any;
    publisher: any;
    "bom-ref": string;
    purl: string;
    scope: any;
    type: any;
}[];
export function purlFromUrlString(type: any, repoUrl: any, version: any): PackageURL;
/**
 * Parse swift dependency tree output json object
 *
 * @param {Array} pkgList Package list
 * @param {Array} dependenciesList Dependencies
 * @param {string} jsonObject Swift dependencies json object
 * @param {string} pkgFile Package.swift file
 */
export function parseSwiftJsonTreeObject(pkgList: any[], dependenciesList: any[], jsonObject: string, pkgFile: string): string;
/**
 * Parse swift dependency tree output
 * @param {string} rawOutput Swift dependencies json output
 * @param {string} pkgFile Package.swift file
 */
export function parseSwiftJsonTree(rawOutput: string, pkgFile: string): {
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
export function parseSwiftResolved(resolvedFile: string): {
    name: string;
    group: string;
    version: string;
    purl: string;
    "bom-ref": string;
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
 * Collect maven dependencies
 *
 * @param {string} mavenCmd Maven command to use
 * @param {string} basePath Path to the maven project
 * @param {boolean} cleanup Remove temporary directories
 * @param {boolean} includeCacheDir Include maven and gradle cache directories
 */
export function collectMvnDependencies(mavenCmd: string, basePath: string, cleanup?: boolean, includeCacheDir?: boolean): Promise<{}>;
export function collectGradleDependencies(_gradleCmd: any, _basePath: any, _cleanup?: boolean, _includeCacheDir?: boolean): Promise<{}>;
/**
 * Method to collect class names from all jars in a directory
 *
 * @param {string} jarPath Path containing jars
 * @param {object} pomPathMap Map containing jar to pom names. Required to successfully parse gradle cache.
 *
 * @return object containing jar name and class list
 */
export function collectJarNS(jarPath: string, pomPathMap?: object): Promise<{}>;
export function convertJarNSToPackages(jarNSMapping: any): Promise<{
    name: any;
    group: any;
    version: any;
    description: any;
    purl: string;
    "bom-ref": string;
    hashes: any;
    evidence: {
        identity: {
            field: string;
            confidence: number;
            methods: {
                technique: string;
                confidence: number;
                value: any;
            }[];
        };
    };
    properties: {
        name: string;
        value: any;
    }[];
}[]>;
/**
 * Deprecated function to parse pom.xml. Use parsePom instead.
 *
 * @deprecated
 * @param pomXmlData XML contents
 * @returns {Object} Parent component data
 */
export function parsePomXml(pomXmlData: any): any;
export function parseJarManifest(jarMetadata: any): {};
export function parsePomProperties(pomProperties: any): {};
export function encodeForPurl(s: any): any;
/**
 * Method to get pom properties from maven directory
 *
 * @param {string} mavenDir Path to maven directory
 *
 * @return array with pom properties
 */
export function getPomPropertiesFromMavenDir(mavenDir: string): {};
/**
 * Computes the checksum for a file path using the given hash algorithm
 *
 * @param {string} hashName name of hash algorithm
 * @param {string} path path to file
 * @returns {Promise<String>} hex value of hash
 */
export function checksumFile(hashName: string, path: string): Promise<string>;
/**
 * Computes multiple checksum for a file path using the given hash algorithms
 *
 * @param {Array[String]} algorithms Array of algorithms
 * @param {string} path path to file
 * @returns {Promise<Object>} hashes object
 */
export function multiChecksumFile(algorithms: any, path: string): Promise<any>;
/**
 * Method to extract a war or ear file
 *
 * @param {string} jarFile Path to jar file
 * @param {string} tempDir Temporary directory to use for extraction
 * @param {object} jarNSMapping Jar class names mapping object
 *
 * @return pkgList Package list
 */
export function extractJarArchive(jarFile: string, tempDir: string, jarNSMapping?: object): Promise<any[]>;
/**
 * Determine the version of SBT used in compilation of this project.
 * By default it looks into a standard SBT location i.e.
 * <path-project>/project/build.properties
 * Returns `null` if the version cannot be determined.
 *
 * @param {string} projectPath Path to the SBT project
 */
export function determineSbtVersion(projectPath: string): any;
/**
 * Adds a new plugin to the SBT project by amending its plugins list.
 * Only recommended for SBT < 1.2.0 or otherwise use `addPluginSbtFile`
 * parameter.
 * The change manipulates the existing plugins' file by creating a copy of it
 * and returning a path where it is moved to.
 * Once the SBT task is complete one must always call `cleanupPlugin` to remove
 * the modifications made in place.
 *
 * @param {string} projectPath Path to the SBT project
 * @param {string} plugin Name of the plugin to add
 */
export function addPlugin(projectPath: string, plugin: string): string;
/**
 * Cleans up modifications to the project's plugins' file made by the
 * `addPlugin` function.
 *
 * @param {string} projectPath Path to the SBT project
 * @param {string} originalPluginsFile Location of the original plugins file, if any
 */
export function cleanupPlugin(projectPath: string, originalPluginsFile: string): boolean;
/**
 * Returns a default location of the plugins file.
 *
 * @param {string} projectPath Path to the SBT project
 */
export function sbtPluginsPath(projectPath: string): any;
/**
 * Method to read a single file entry from a zip file
 *
 * @param {string} zipFile Zip file to read
 * @param {string} filePattern File pattern
 * @param {string} contentEncoding Encoding. Defaults to utf-8
 *
 * @returns File contents
 */
export function readZipEntry(zipFile: string, filePattern: string, contentEncoding?: string): Promise<any>;
/**
 * Method to get the classes and relevant sources in a jar file
 *
 * @param {string} jarFile Jar file to read
 *
 * @returns List of classes and sources matching certain known patterns
 */
export function getJarClasses(jarFile: string): Promise<any>;
/**
 * Method to return the gradle command to use.
 *
 * @param {string} srcPath Path to look for gradlew wrapper
 * @param {string|null} rootPath Root directory to look for gradlew wrapper
 */
export function getGradleCommand(srcPath: string, rootPath: string | null): string;
/**
 * Method to return the mill command to use.
 *
 * @param {string} srcPath Path to look for mill wrapper
 */
export function getMillCommand(srcPath: string): string;
/**
 * Method to combine the general gradle arguments, the sub-commands and the sub-commands' arguments in the correct way
 *
 * @param {string[]} gradleArguments The general gradle arguments, which must only be added once
 * @param {string[]} gradleSubCommands The sub-commands that are to be executed by gradle
 * @param {string[]} gradleSubCommandArguments The arguments specific to the sub-command(s), which much be added PER sub-command
 * @param {int} gradleCommandLength The length of the full gradle-command
 *
 * @returns {string[]} Array of arrays of arguments to be added to the gradle command
 */
export function buildGradleCommandArguments(gradleArguments: string[], gradleSubCommands: string[], gradleSubCommandArguments: string[], gradleCommandLength: int): string[];
/**
 * Method to split the output produced by Gradle using parallel processing by project
 *
 * @param {string} rawOutput Full output produced by Gradle using parallel processing
 * @param {string[]} relevantTasks The list of gradle tasks whose output need to be considered.
 * @returns {map} Map with subProject names as keys and corresponding dependency task outputs as values.
 */
export function splitOutputByGradleProjects(rawOutput: string, relevantTasks: string[]): map;
/**
 * Parse the contents of a 'Podfile.lock'
 *
 * @param {Object} podfileLock The content of the podfile.lock as an Object
 * @param {String} projectPath The path to the project root
 * @returns {Map} Map of all dependencies with their direct dependencies
 */
export function parsePodfileLock(podfileLock: any, projectPath: string): Map;
/**
 * Parse all targets and their direct dependencies from the 'Podfile'
 *
 * @param {Object} target A JSON-object representing a target
 * @param {Map} allDependencies The map containing all parsed direct dependencies for a target
 * @param {String} [prefix=undefined] Prefix to add to the targets name
 */
export function parsePodfileTargets(target: any, allDependencies: Map, prefix?: string): void;
/**
 * Parse a single line representing a dependency
 *
 * @param {String} dependencyLine The line that should be parsed as a dependency
 * @param {boolean} [parseVersion=true] Include parsing the version of the dependency
 * @returns {Object} Object representing a dependency
 */
export function parseCocoaDependency(dependencyLine: string, parseVersion?: boolean): any;
/**
 * Execute the 'pod'-command with parameters
 *
 * @param {String[]} parameters The parameters for the command
 * @param {String} path The path where the command should be executed
 * @param {Object} options CLI options
 * @returns {Object} The result of running the command
 */
export function executePodCommand(parameters: string[], path: string, options: any): any;
/**
 * Method that handles object creation for cocoa pods.
 *
 * @param {Object} dependency The dependency that is to be transformed into an SBOM object
 * @param {Object} options CLI options
 * @param {String} [type="library"] The type of Object to create
 * @returns {Object} An object representing the pod in SBOM-format
 */
export function buildObjectForCocoaPod(dependency: any, options: any, type?: string): any;
/**
 * Method that handles object creation for gradle modules.
 *
 * @param {string} name The simple name of the module
 * @param {object} metadata Object with all other parsed data for the gradle module
 * @returns {object} An object representing the gradle module in SBOM-format
 */
export function buildObjectForGradleModule(name: string, metadata: object): object;
/**
 * Method to return the maven command to use.
 *
 * @param {string} srcPath Path to look for maven wrapper
 * @param {string} rootPath Root directory to look for maven wrapper
 */
export function getMavenCommand(srcPath: string, rootPath: string): string;
/**
 * Retrieves the atom command by referring to various environment variables
 */
export function getAtomCommand(): any;
export function executeAtom(src: any, args: any, extra_env?: {}): boolean;
/**
 * Find the imported modules in the application with atom parsedeps command
 *
 * @param {string} src
 * @param {string} language
 * @param {string} methodology
 * @param {string} slicesFile
 * @returns List of imported modules
 */
export function findAppModules(src: string, language: string, methodology?: string, slicesFile?: string): any;
/**
 * Create uv.lock file with uv sync command.
 *
 * @param {string} basePath Path
 * @param {Object} options CLI options
 */
export function createUVLock(basePath: string, options: any): void;
/**
 * Execute pip freeze by creating a virtual env in a temp directory and construct the dependency tree
 *
 * @param {string} basePath Base path
 * @param {string} reqOrSetupFile Requirements or setup.py file
 * @param {string} tempVenvDir Temp venv dir
 * @param {Object} parentComponent Parent component
 *
 * @returns {Object} List of packages from the virtual env
 */
export function getPipFrozenTree(basePath: string, reqOrSetupFile: string, tempVenvDir: string, parentComponent: any): any;
/**
 * The problem: pip installation can fail for a number of reasons such as missing OS dependencies and devel packages.
 * When it fails, we don't get any dependency tree. As a workaroud, this method would attempt to install one package at a time to the same virtual environment and then attempts to obtain a dependency tree.
 * Such a tree could be incorrect or quite approximate, but some users might still find it useful to know the names of the indirect dependencies.
 *
 * @param {string} basePath Base path
 * @param {Array} pkgList Existing package list
 * @param {string} tempVenvDir Temp venv dir
 * @param {Object} parentComponent Parent component
 *
 * @returns List of packages from the virtual env
 */
export function getPipTreeForPackages(basePath: string, pkgList: any[], tempVenvDir: string, parentComponent: any): {
    failedPkgList?: undefined;
    rootList?: undefined;
    dependenciesList?: undefined;
} | {
    failedPkgList: any[];
    rootList: {
        name: any;
        version: any;
        purl: string;
        "bom-ref": string;
    }[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
};
export function parsePackageJsonName(name: any): {
    scope: any;
    fullName: string;
    projectName: string;
    moduleName: string;
};
/**
 * Method to add occurrence evidence for components based on import statements. Currently useful for js
 *
 * @param {array} pkgList List of package
 * @param {object} allImports Import statements object with package name as key and an object with file and location details
 * @param {object} allExports Exported modules if available from node_modules
 * @param {Boolean} deep Deep mode
 */
export function addEvidenceForImports(pkgList: any[], allImports: object, allExports: object, deep: boolean): Promise<any[]>;
export function componentSorter(a: any, b: any): any;
export function parseCmakeDotFile(dotFile: any, pkgType: any, options?: {}): {
    parentComponent: {};
    pkgList: any[];
    dependenciesList: {
        ref: string;
        dependsOn: any;
    }[];
};
export function parseCmakeLikeFile(cmakeListFile: any, pkgType: any, options?: {}): {
    parentComponent: {};
    pkgList: any[];
};
export function getOSPackageForFile(afile: any, osPkgsList: any): any;
/**
 * Method to find c/c++ modules by collecting usages with atom
 *
 * @param {string} src directory
 * @param {object} options Command line options
 * @param {array} osPkgsList Array of OS pacakges represented as components
 * @param {array} epkgList Existing packages list
 */
export function getCppModules(src: string, options: object, osPkgsList: any[], epkgList: any[]): {
    parentComponent: {};
    pkgList: any[];
    dependenciesList: {
        ref: any;
        dependsOn: any[];
    }[];
};
/**
 * NOT IMPLEMENTED YET.
 * A future method to locate a generic package given some name and properties
 *
 * @param {object} apkg Package to locate
 * @returns Located project with precise purl or the original unmodified input.
 */
export function locateGenericPackage(apkg: object): any;
export function parseCUsageSlice(sliceData: any): {};
/**
 * Method to retrieve metadata for nuget packages
 *
 * @param {Array} pkgList Package list
 * @param {Array} dependencies Dependencies
 */
export function getNugetMetadata(pkgList: any[], dependencies?: any[]): Promise<{
    pkgList: any[];
    dependencies: any[];
}>;
export function addEvidenceForDotnet(pkgList: any, slicesFile: any): any;
/**
 * Function to parse the .d make files
 *
 * @param {String} dfile .d file path
 *
 * @returns {Object} pkgFilesMap Object with package name and list of files
 */
export function parseMakeDFile(dfile: string): any;
/**
 * Function to validate an externalReference URL for conforming to the JSON schema or bomLink
 * https://github.com/CycloneDX/cyclonedx-core-java/blob/75575318b268dda9e2a290761d7db11b4f414255/src/main/resources/bom-1.5.schema.json#L1140
 * https://datatracker.ietf.org/doc/html/rfc3987#section-2.2
 * https://cyclonedx.org/capabilities/bomlink/
 *
 * @param {String} iri IRI to validate
 *
 * @returns {Boolean} Flag indicating whether the supplied URL is valid or not
 *
 */
export function isValidIriReference(iri: string): boolean;
/**
 * Method to check if a given dependency tree is partial or not.
 *
 * @param {Array} dependencies List of dependencies
 * @param {Number} componentsCount Number of components
 * @returns {Boolean} True if the dependency tree lacks any non-root parents without children. False otherwise.
 */
export function isPartialTree(dependencies: any[], componentsCount?: number): boolean;
/**
 * Re-compute and set the scope based on the dependency tree
 *
 * @param {Array} pkgList List of components
 * @param {Array} dependencies List of dependencies
 *
 * @returns {Array} Updated list
 */
export function recomputeScope(pkgList: any[], dependencies: any[]): any[];
/**
 * Function to parse a list of environment variables to identify the paths containing executable binaries
 *
 * @param envValues {Array[String]} Environment variables list
 * @returns {Array[String]} Binary Paths identified from the environment variables
 */
export function extractPathEnv(envValues: any): any;
/**
 * Collect all executable files from the given list of binary paths
 *
 * @param basePath Base directory
 * @param binPaths {Array[String]} Paths containing potential binaries
 * @return {Array[String]} List of executables
 */
export function collectExecutables(basePath: any, binPaths: any): any;
/**
 * Collect all shared library files from the given list of paths
 *
 * @param basePath Base directory
 * @param libPaths {Array[String]} Paths containing potential libraries
 * @param ldConf {String} Config file used by ldconfig to locate additional paths
 * @param ldConfDirPattern {String} Config directory that can contain more .conf files for ldconfig
 *
 * @return {Array[String]} List of executables
 */
export function collectSharedLibs(basePath: any, libPaths: any, ldConf: string, ldConfDirPattern: string): any;
/**
 * Get information about the runtime.
 *
 * @returns {Object} Object containing the name and version of the runtime
 */
export function getRuntimeInformation(): any;
/**
 * Checks for dangerous Unicode characters that could enable homograph attacks
 *
 * @param {string} str String to check
 * @returns {boolean} true if dangerous Unicode is found
 */
export function hasDangerousUnicode(str: string): boolean;
/**
 * Validates that a root is a legitimate Windows drive letter format
 *
 * @param {string} root Root to validate
 * @returns {boolean} true if valid drive format
 */
export function isValidDriveRoot(root: string): boolean;
/**
 * Get version and runtime information
 */
export function retrieveCdxgenVersion(): string;
export function retrieveCdxgenPluginVersion(): any;
export const dirNameStr: any;
export const isSecureMode: any;
export const isWin: boolean;
export const isMac: boolean;
export let ATOM_DB: any;
export const commandsExecuted: any;
export const frameworksList: any;
export const CDXGEN_VERSION: any;
export const DEBUG_MODE: any;
export const TIMEOUT_MS: any;
export const MAX_BUFFER: any;
export let metadata_cache: {};
export const includeMavenTestScope: any;
export const PREFER_MAVEN_DEPS_TREE: boolean;
export const FETCH_LICENSE: any;
export const SEARCH_MAVEN_ORG: any;
export const JAVA_CMD: string;
export const PYTHON_CMD: string;
export let DOTNET_CMD: string;
export let NODE_CMD: string;
export let NPM_CMD: string;
export let YARN_CMD: string;
export let GCC_CMD: string;
export let RUSTC_CMD: string;
export let GO_CMD: string;
export let CARGO_CMD: string;
export let CLJ_CMD: string;
export let LEIN_CMD: string;
export let CDXGEN_TEMP_DIR: string;
export const SWIFT_CMD: "xcrun swift" | "swift";
export const RUBY_CMD: any;
export const PYTHON_EXCLUDED_COMPONENTS: string[];
export const PROJECT_TYPE_ALIASES: {
    java: string[];
    android: string[];
    jar: string[];
    "gradle-index": string[];
    "sbt-index": string[];
    "maven-index": string[];
    js: string[];
    py: string[];
    go: string[];
    rust: string[];
    php: string[];
    ruby: string[];
    csharp: string[];
    dart: string[];
    haskell: string[];
    elixir: string[];
    c: string[];
    clojure: string[];
    github: string[];
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
};
export namespace PACKAGE_MANAGER_ALIASES {
    let scala: string[];
}
export const remoteHostsAccessed: any;
export const cdxgenAgent: any;
export const RUBY_PLATFORM_PREFIXES: string[];
import { PackageURL } from "packageurl-js";
//# sourceMappingURL=utils.d.ts.map
/**
 * Method to prepare the build environment for BOM generation purposes.
 *
 * @param {String} filePath Path
 * @param {Object} options CLI options
 */
export function prepareEnv(filePath: string, options: Object): void;
/**
 * Method to prepare sdkman build environment for BOM generation purposes.
 *
 * @param {String} projectType Project type
 */
export function prepareSdkmanBuild(projectType: string): boolean | undefined;
/**
 * Method to check and prepare the environment for python
 *
 * @param {String} _filePath Path
 * @param {Object} options CLI Options
 */
export function preparePythonEnv(_filePath: string, options: Object): void;
/**
 * Method to check and prepare the environment for node
 *
 * @param {String} filePath Path
 * @param {Object} options CLI Options
 */
export function prepareNodeEnv(filePath: string, options: Object): void;
/**
 * If NVM_DIR is in path, however nvm command is not loaded.
 * it is possible that required nodeVersion is not installed.
 * This function loads nvm and install the nodeVersion
 *
 * @param {String} nodeVersion required version number
 *
 * @returns {Boolean} true if successful, otherwise false
 */
export function tryLoadNvmAndInstallTool(nodeVersion: string): boolean;
/**
 * This method installs and create package-lock.json
 *
 * @param {String} filePath Path
 * @param {String} nvmNodePath Path to node version in nvm
 */
export function doNpmInstall(filePath: string, nvmNodePath: string): void;
/**
 * Method to check and build the swift project
 *
 * @param {String} filePath Path
 * @param {Object} options CLI Options
 */
export function prepareSwiftEnv(filePath: string, options: Object): void;
/**
 * Method to check and prepare the environment for Ruby projects
 *
 * @param {String} filePath Path
 * @param {Object} options CLI Options
 */
export function prepareRubyEnv(filePath: string, options: Object): void;
//# sourceMappingURL=pregen.d.ts.map
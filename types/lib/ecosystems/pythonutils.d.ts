/**
 * Universal virtual environment metadata detector
 * @param {Object} env - Environment variables (defaults to process.env)
 * @param {string} [explicitPath] - Optional explicit venv path to inspect
 * @returns {Object} Structured environment metadata
 */
export declare function getVenvMetadata(env?: Object, explicitPath?: string): Object;
/**
 * Determines the appropriate Python executable path from a virtual environment.
 * Inspects the virtual environment metadata to detect the Python type (system,
 * conda, pyenv, etc.) and returns the most specific executable found, falling
 * back to the global `PYTHON_CMD` constant when no executable is detected.
 *
 * @param {string} env Path to the Python virtual environment directory
 * @returns {string} Path to the Python executable or the fallback command name
 */
export declare function get_python_command_from_env(env: string): string;
/**
 * The top-level packages and modules a project provides, wherever they sit
 * in its tree: each outermost package directory (one with an `__init__.py`
 * whose parent has none), and the module files beside such packages, since
 * their directory is a source root. Directories of installed packages
 * (virtual environments, `site-packages`) are not the project's.
 *
 * @param {string} src Path to the project being analysed
 * @returns {Set<string>} Module names
 */
export declare function projectModuleNames(src: string): Set<string>;
/**
 * Is this import satisfied by a module that lives in the project itself?
 *
 * `atom parsedeps` reports every non-stdlib import it sees, including imports of the
 * project's own packages. Attributing those to a distribution invents dependencies:
 * `data/pypi-pkg-aliases.json` maps the module `app` to `zope2`, `test` to `pytabix`,
 * `models` to `asposestorage` and `src` to `auto-mix-prep`, so any project with a
 * local package of that name acquires an obscure component it never depended on -
 * along with every namespace and tag that component carries downstream. Filtering by
 * name would need a denylist of every plausible first-party name; asking the
 * filesystem whether the module is ours answers it exactly.
 *
 * Checks the project root and a `src/` layout for a module file, a package directory,
 * and a PEP 420 namespace package directory, then the top-level packages found
 * anywhere in the project and the modules beside them (tool-heavy repositories
 * keep their Python libraries in places such as `dev_tools/pylibs/`).
 *
 * @param {string} src Path to the project being analysed
 * @param {string} name Imported top-level module name
 * @returns {boolean} `true` if the project supplies this module itself
 */
export declare function isFirstPartyModule(src: string, name: string): boolean;
/**
 * Whether a directory holds Python sources for atom to parse.
 *
 * The search skips the directories the manifest searches skip, such as
 * node_modules and dot directories, and honours the exclude patterns, so a
 * Python file shipped inside an npm package does not count.
 *
 * @param {string} src directory
 * @param {Object} options CLI options
 * @returns {boolean} true when the directory holds at least one Python file
 */
export declare function hasPythonSources(src: string, options?: Object): boolean;
/**
 * Method to find python modules by parsing the imports and then checking with PyPI to obtain the latest version
 *
 * @param {string} src directory
 * @param {Array} epkgList Existing package list
 * @param {Object} options CLI options
 * @returns List of packages
 */
export declare function getPyModules(src: string, epkgList: any[], options: Object): Promise<{
    allImports: {};
    pkgList: any;
    dependenciesList: {
        ref: string;
        dependsOn: never[];
    }[];
    modList: any;
}>;
/**
 * Create uv.lock file with uv sync command.
 *
 * @param {string} basePath Path
 * @param {Object} options CLI options
 */
export declare function createUVLock(basePath: string, options: Object): void;
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
export declare function getPipFrozenTree(basePath: string, reqOrSetupFile: string, tempVenvDir: string, parentComponent: Object, projectRoot: any, getTreeWithPluginFn: any): Object;
export declare function getPipTreeForPackages(basePath: any, pkgList: any, tempVenvDir: any, parentComponent: any, getTreeWithPluginFn: any): {
    dependenciesList?: undefined;
    failedPkgList?: undefined;
    rootList?: undefined;
} | {
    failedPkgList: any[];
    rootList: {
        name: any;
        version: any;
        purl: any;
        "bom-ref": string;
    }[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
};
//# sourceMappingURL=pythonutils.d.ts.map
/**
 * Git executable name used for all git invocations, overridable via GIT_CMD.
 *
 * @type {string}
 */
export declare const GIT_COMMAND: string;
/**
 * sdkman tool aliases mapping java version identifiers to candidate ids.
 *
 * Each alias can be overridden via the matching `JAVA*_TOOL` environment
 * variable and otherwise defaults to a Temurin candidate version.
 *
 * @type {Object<string, string>}
 */
export declare const SDKMAN_JAVA_TOOL_ALIASES: Record<string, string>;
/**
 * Retrieves a git config item
 * @param {string} configKey Git config key
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export declare function getGitConfig(configKey: string, dir: string): string | undefined;
/**
 * Retrieves the git origin url
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export declare function getOriginUrl(dir: string): string | undefined;
/**
 * Retrieves the git branch name
 * @param {string} configKey Git config key
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export declare function getBranch(_configKey: any, dir: string): string | undefined;
/**
 * Retrieves the tree and parent hash for a git repo
 * @param {string} dir repo directory
 *
 * @returns Output from git cat-file or undefined
 */
export declare function gitTreeHashes(dir: string): {};
/**
 * Retrieves the files list from git
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export declare function listFiles(dir: string): any[];
/**
 * Execute a git command
 *
 * @param {string} dir Repo directory
 * @param {Array} args arguments to git command
 *
 * @returns Output from the git command
 */
export declare function execGitCommand(dir: string, args: any[]): string | undefined;
/**
 * Retrieves the author names and emails from the git commit log
 *
 * @param {string} dir Repo directory
 * @param {number} maxCount Maximum number of commits to retrieve
 *
 * @returns {Array<{name: string, email: string}>} Array of authors
 */
export declare function gitLogAuthors(dir: string, maxCount?: number): Array<{
    name: string;
    email: string;
}>;
/**
 * Retrieves the commit logs for a git repo, returning hashes and messages
 *
 * @param {string} dir Repo directory
 * @param {number} maxCount Maximum number of commits to retrieve
 *
 * @returns {Array<{hash: string, message: string}>} Array of commit objects
 */
export declare function gitLogTrailers(dir: string, maxCount?: number): Array<{
    hash: string;
    message: string;
}>;
/**
 * Collect Java version and installed modules
 *
 * @param {string} dir Working directory
 * @returns Object containing the java details
 */
export declare function collectJavaInfo(dir: string): {
    type: string;
    name: string;
    version: string;
    description: string;
    properties: {
        name: string;
        value: string;
    }[];
} | undefined;
/**
 * Collect dotnet version
 *
 * @param {string} dir Working directory
 * @returns Object containing dotnet details
 */
export declare function collectDotnetInfo(dir: string): {
    type: string;
    name: string;
    version: string;
    description: string;
} | undefined;
/**
 * Collect python version
 *
 * @param {string} dir Working directory
 * @returns Object containing python details
 */
export declare function collectPythonInfo(dir: string): {
    type: string;
    name: string;
    version: string;
    description: string;
} | undefined;
/**
 * Collect node runtime version
 *
 * @param {string} dir Working directory
 * @returns {Object} Object containing node details
 */
export declare function collectNodeInfo(dir: string): Object;
/**
 * Collect gcc version
 *
 * @param {string} dir Working directory
 * @returns Object containing gcc details
 */
export declare function collectGccInfo(dir: string): {
    type: string;
    name: string;
    version: string;
    description: string;
} | undefined;
/**
 * Collect rust version
 *
 * @param {string} dir Working directory
 * @returns Object containing rust details
 */
export declare function collectRustInfo(dir: string): {
    type: string;
    name: string;
    version: string;
    description: string;
} | undefined;
/**
 * Collect go version
 *
 * @param {string} dir Working directory
 * @returns Object containing go details
 */
export declare function collectGoInfo(dir: string): {
    type: string;
    name: string;
    version: string;
} | undefined;
/**
 * Collect swift version
 *
 * @param {string} dir Working directory
 * @returns Object containing swift details
 */
export declare function collectSwiftInfo(dir: string): {
    type: string;
    name: string;
    version: string;
} | undefined;
/**
 * Collect Ruby version
 *
 * @param {string} dir Working directory
 * @returns Object containing Ruby details
 */
export declare function collectRubyInfo(dir: string): {
    type: string;
    name: string;
    version: string;
} | undefined;
/**
 * Collect the PHP version of the PHP found on the PATH.
 *
 * `-n` stops PHP loading any php.ini, so a PHPRC or an auto_prepend_file cannot
 * run code, and `-v` is used rather than `-r 'echo PHP_VERSION;'` because the
 * shell on Windows does not quote arguments. The first line is
 * `PHP 8.5.11 (cli) (built: Sep 22 2026 13:32:06) (NTS)`.
 *
 * The identity is `pkg:generic/php`: a probe of the PATH cannot tell which
 * package manager, if any, installed this PHP. A banner with a distro revision,
 * such as Ubuntu 22.04's `PHP 8.1.2-1ubuntu2.14`, is recorded as reported but
 * without a CPE: the distro backports fixes under the old upstream number.
 *
 * @param {string} dir Working directory
 * @returns Object containing the PHP details
 */
export declare function collectPhpInfo(dir: string): Object | undefined;
/**
 * Collect the Composer version.
 *
 * `--no-plugins` and `--no-scripts` keep the plugins and scripts of the
 * project in the working directory from running, which `composer --version`
 * would otherwise let a plugin do. It needs no network. The banner is
 * `Composer version 2.10.3 2026-08-27 13:34:23`, but an older Composer on a
 * newer PHP prints deprecation notices above it, so the first line that starts
 * with it is read; the line after it names the PHP Composer runs on, with its
 * path, and is never read. The banner must start its line: an indented echo of
 * the project's composer.json in an error block does not count. Only a stable
 * release is recorded: a pre-release or a snapshot has no version a CPE can
 * name.
 *
 * @param {string} dir Working directory
 * @returns Object containing the Composer details
 */
export declare function collectComposerInfo(dir: string): Object | undefined;
/**
 * Method to run a swift command
 *
 * @param {String} dir Working directory
 * @param {Array} args Command arguments
 * @returns Object containing swift details
 */
export declare function runSwiftCommand(dir: string, args: any[]): string | undefined;
/**
 * Collect toolchain information components for the current environment.
 *
 * Probes the working directory for java, dotnet, python, node, gcc, rust, go,
 * ruby, php and composer toolchains and returns one component per detected
 * tool.
 *
 * @param {string} dir Working directory to inspect
 * @param {Object} [options] CLI options, which decide whether the project's
 *   own toolchain files may choose the tools that run
 * @returns {Object[]} Array of toolchain component objects; empty when nothing is detected
 */
export declare function collectEnvInfo(dir: string, options?: Object): Object[];
/**
 * Method to check if sdkman is available.
 */
export declare function isSdkmanAvailable(): boolean;
/**
 * Method to check if nvm is available.
 */
export declare function isNvmAvailable(): boolean;
/**
 * Method to check if a given sdkman tool is installed and available.
 *
 * @param {String} toolType Tool type such as java, gradle, maven etc.
 * @param {String} toolName Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {Boolean} true if the tool is available. false otherwise.
 */
export declare function isSdkmanToolAvailable(toolType: string, toolName: string): boolean;
/**
 * Method to install and use a given sdkman tool.
 *
 * @param {String} toolType Tool type such as java, gradle, maven etc.
 * @param {String} toolName Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {Boolean} true if the tool is available. false otherwise.
 */
export declare function installSdkmanTool(toolType: string, toolName: string): boolean;
/**
 * Method to check if a given nvm tool is installed and available.
 *
 * @param {String} toolName Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {String} path of nvm if present, otherwise false
 */
export declare function getNvmToolDirectory(toolName: string): string;
/**
 * Method to return nvm tool path
 *
 * @param {String} toolVersion Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {String} path of the tool if not found installs and then returns paths. false if encounters an error.
 */
export declare function getOrInstallNvmTool(toolVersion: string): string;
/**
 * Method to check if rbenv is available.
 *
 * @returns {Boolean} true if rbenv is available. false otherwise.
 */
export declare function isRbenvAvailable(): boolean;
/**
 * Returns the rbenv binary directory for the given Ruby version.
 * Respects the `RBENV_ROOT` environment variable when set; otherwise falls back
 * to `~/.rbenv/versions/<rubyVersion>/bin`.
 *
 * @param {string} rubyVersion Ruby version string (e.g. `"3.2.2"`)
 * @returns {string} Absolute path to the rbenv bin directory for that version
 */
export declare function rubyVersionDir(rubyVersion: string): string;
/**
 * Perform bundle install using Ruby container images. Not working cleanly yet.
 *
 * @param rubyVersion Ruby version
 * @param cdxgenGemHome Gem Home
 * @param filePath Path
 */
export declare function bundleInstallWithDocker(rubyVersion: any, cdxgenGemHome: any, filePath: any): boolean;
/**
 * Install a particular ruby version using rbenv.
 *
 * @param rubyVersion Ruby version to install
 * @param filePath File path
 */
export declare function installRubyVersion(rubyVersion: any, filePath: any): {
    fullToolBinDir: undefined;
    status: boolean;
} | {
    fullToolBinDir: string;
    status: boolean;
};
/**
 * Method to install bundler using gem.
 *
 * @param rubyVersion Ruby version
 * @param bundlerVersion Bundler version
 */
export declare function installRubyBundler(rubyVersion: any, bundlerVersion: any): boolean;
/**
 * Method to perform bundle install
 *
 * @param cdxgenGemHome cdxgen Gem home
 * @param rubyVersion Ruby version
 * @param bundleCommand Bundle command to use
 * @param basePath working directory
 *
 * @returns {boolean} true if the install was successful. false otherwise.
 */
export declare function performBundleInstall(cdxgenGemHome: any, rubyVersion: any, bundleCommand: any, basePath: any): boolean;
/**
 * Retrieves the commit logs for a git repo with detailed author, committer, parents, signatures, and body.
 *
 * @param {string} dir Repo directory
 * @param {number} maxCount Maximum number of commits to retrieve
 * @returns {Array<Object>} Array of detailed commit objects
 */
export declare function gitLogCommitsDetailed(dir: string, maxCount?: number): Array<Object>;
/**
 * Runs a git show on a commit hash and analyzes the diff for test-file
 * deletions and quality-gate-weakening changes (e.g. `|| true`,
 * `continue-on-error: true`, `--no-verify`). Detection is intentionally
 * conservative to avoid false positives from ordinary refactors.
 *
 * @param {string} dir Repo directory
 * @param {string} commitHash Commit hash to analyze
 * @returns {Object} Commit diff analysis results
 */
export declare function gitCommitDiffAnalysis(dir: string, commitHash: string): Object;
/**
 * Retrieves the git-ai notes metadata for recent commits.
 *
 * @param {string} dir Repo directory
 * @param {Object} [options] Options for note retrieval
 * @param {string} [options.ref] Notes reference path (defaults to refs/notes/ai)
 * @param {number} [options.maxCount] Maximum commits to scan (defaults to 20)
 * @returns {Array<Object>} Array of note objects { hash, note }
 */
export declare function gitAiNotes(dir: string, options?: {
    ref?: string;
    maxCount?: number;
}): Array<Object>;
/**
 * Retrieves recent commits whose subject indicates a revert, hotfix, or
 * rollback. Bounded to the same recency window as the other collectors — unlike
 * `git log --grep`, which traverses the entire history looking for matches.
 *
 * @param {string} dir Repo directory
 * @param {number} maxCount Maximum number of recent commits to scan
 * @returns {Array<Object>} Array of { hash, message } revert/hotfix commits
 */
export declare function gitRevertsAndHotfixes(dir: string, maxCount?: number): Array<Object>;
/**
 * Whether the running Node.js links a bundled dependency as a shared library,
 * from the `node_shared_<name>` configure variables it reports.
 *
 * @param {string} name key of process.versions
 * @param {Object} [variables] configure variables, process.config.variables
 *   by default
 * @returns {string|undefined} `shared`, `bundled`, or undefined when the build
 *   does not say
 */
export declare function nodeComponentLinkage(name: string, variables?: Object): string | undefined;
/**
 * Get information about the runtime.
 *
 * @returns {Object} Object containing the name and version of the runtime
 */
export declare function getRuntimeInformation(): Object;
/**
 * Checks for dangerous Unicode characters that could enable homograph attacks
  if (zeroWidthChars.test(str)) {
    return true;
  }

  // Check for control characters (except common ones like \n, \r, \t)
  const controlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
  return controlChars.test(str);
}
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: validation

/**
 * Get version and runtime information
 */
export declare function retrieveCdxgenVersion(): string;
/**
 * Retrieve the version of the cdxgen plugins binary package from package.json.
 *
 * Reads the local package.json and searches the `optionalDependencies` for a package
 * whose name starts with `@cdxgen/cdxgen-plugins-bin`, returning its declared version.
 *
 * @returns {string|undefined} Version string of the plugins binary package, or undefined if not found
 */
export declare function retrieveCdxgenPluginVersion(): string | undefined;
//# sourceMappingURL=envcontext.d.ts.map
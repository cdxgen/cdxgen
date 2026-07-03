/**
 * Retrieves a git config item
 * @param {string} configKey Git config key
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export function getGitConfig(configKey: string, dir: string): string | undefined;
/**
 * Retrieves the git origin url
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export function getOriginUrl(dir: string): string | undefined;
/**
 * Retrieves the git branch name
 * @param {string} configKey Git config key
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export function getBranch(_configKey: any, dir: string): string | undefined;
/**
 * Retrieves the tree and parent hash for a git repo
 * @param {string} dir repo directory
 *
 * @returns Output from git cat-file or undefined
 */
export function gitTreeHashes(dir: string): {};
/**
 * Retrieves the files list from git
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export function listFiles(dir: string): any[];
/**
 * Execute a git command
 *
 * @param {string} dir Repo directory
 * @param {Array} args arguments to git command
 *
 * @returns Output from the git command
 */
export function execGitCommand(dir: string, args: any[]): string | undefined;
/**
 * Retrieves the author names and emails from the git commit log
 *
 * @param {string} dir Repo directory
 * @param {number} maxCount Maximum number of commits to retrieve
 *
 * @returns {Array<{name: string, email: string}>} Array of authors
 */
export function gitLogAuthors(dir: string, maxCount?: number): Array<{
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
export function gitLogTrailers(dir: string, maxCount?: number): Array<{
    hash: string;
    message: string;
}>;
/**
 * Collect Java version and installed modules
 *
 * @param {string} dir Working directory
 * @returns Object containing the java details
 */
export function collectJavaInfo(dir: string): {
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
export function collectDotnetInfo(dir: string): {
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
export function collectPythonInfo(dir: string): {
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
export function collectNodeInfo(dir: string): Object;
/**
 * Collect gcc version
 *
 * @param {string} dir Working directory
 * @returns Object containing gcc details
 */
export function collectGccInfo(dir: string): {
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
export function collectRustInfo(dir: string): {
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
export function collectGoInfo(dir: string): {
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
export function collectSwiftInfo(dir: string): {
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
export function collectRubyInfo(dir: string): {
    type: string;
    name: string;
    version: string;
} | undefined;
/**
 * Method to run a swift command
 *
 * @param {String} dir Working directory
 * @param {Array} args Command arguments
 * @returns Object containing swift details
 */
export function runSwiftCommand(dir: string, args: any[]): string | undefined;
export function collectEnvInfo(dir: any): {
    type: string;
    name: string;
    version: string;
    description: string;
    properties: {
        name: string;
        value: string;
    }[];
}[];
/**
 * Method to check if sdkman is available.
 */
export function isSdkmanAvailable(): boolean;
/**
 * Method to check if nvm is available.
 */
export function isNvmAvailable(): boolean;
/**
 * Method to check if a given sdkman tool is installed and available.
 *
 * @param {String} toolType Tool type such as java, gradle, maven etc.
 * @param {String} toolName Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {Boolean} true if the tool is available. false otherwise.
 */
export function isSdkmanToolAvailable(toolType: string, toolName: string): boolean;
/**
 * Method to install and use a given sdkman tool.
 *
 * @param {String} toolType Tool type such as java, gradle, maven etc.
 * @param {String} toolName Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {Boolean} true if the tool is available. false otherwise.
 */
export function installSdkmanTool(toolType: string, toolName: string): boolean;
/**
 * Method to check if a given nvm tool is installed and available.
 *
 * @param {String} toolName Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {String} path of nvm if present, otherwise false
 */
export function getNvmToolDirectory(toolName: string): string;
/**
 * Method to return nvm tool path
 *
 * @param {String} toolVersion Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {String} path of the tool if not found installs and then returns paths. false if encounters an error.
 */
export function getOrInstallNvmTool(toolVersion: string): string;
/**
 * Method to check if rbenv is available.
 *
 * @returns {Boolean} true if rbenv is available. false otherwise.
 */
export function isRbenvAvailable(): boolean;
/**
 * Returns the rbenv binary directory for the given Ruby version.
 * Respects the `RBENV_ROOT` environment variable when set; otherwise falls back
 * to `~/.rbenv/versions/<rubyVersion>/bin`.
 *
 * @param {string} rubyVersion Ruby version string (e.g. `"3.2.2"`)
 * @returns {string} Absolute path to the rbenv bin directory for that version
 */
export function rubyVersionDir(rubyVersion: string): string;
/**
 * Perform bundle install using Ruby container images. Not working cleanly yet.
 *
 * @param rubyVersion Ruby version
 * @param cdxgenGemHome Gem Home
 * @param filePath Path
 */
export function bundleInstallWithDocker(rubyVersion: any, cdxgenGemHome: any, filePath: any): boolean;
/**
 * Install a particular ruby version using rbenv.
 *
 * @param rubyVersion Ruby version to install
 * @param filePath File path
 */
export function installRubyVersion(rubyVersion: any, filePath: any): {
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
export function installRubyBundler(rubyVersion: any, bundlerVersion: any): boolean;
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
export function performBundleInstall(cdxgenGemHome: any, rubyVersion: any, bundleCommand: any, basePath: any): boolean;
/**
 * Retrieves the commit logs for a git repo with detailed author, committer, parents, signatures, and body.
 *
 * @param {string} dir Repo directory
 * @param {number} maxCount Maximum number of commits to retrieve
 * @returns {Array<Object>} Array of detailed commit objects
 */
export function gitLogCommitsDetailed(dir: string, maxCount?: number): Array<Object>;
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
export function gitCommitDiffAnalysis(dir: string, commitHash: string): Object;
/**
 * Retrieves the git-ai notes metadata for recent commits.
 *
 * @param {string} dir Repo directory
 * @param {Object} [options] Options for note retrieval
 * @param {string} [options.ref] Notes reference path (defaults to refs/notes/ai)
 * @param {number} [options.maxCount] Maximum commits to scan (defaults to 20)
 * @returns {Array<Object>} Array of note objects { hash, note }
 */
export function gitAiNotes(dir: string, options?: {
    ref?: string | undefined;
    maxCount?: number | undefined;
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
export function gitRevertsAndHotfixes(dir: string, maxCount?: number): Array<Object>;
export const GIT_COMMAND: any;
export namespace SDKMAN_JAVA_TOOL_ALIASES {
    let java8: any;
    let java11: any;
    let java17: any;
    let java21: any;
    let java22: any;
    let java23: any;
    let java24: any;
    let java25: any;
    let java26: any;
}
//# sourceMappingURL=envcontext.d.ts.map
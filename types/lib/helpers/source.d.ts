/**
 * Execute git with hardened defaults.
 *
 * @param {string[]} args git arguments
 * @param {Object} options command options
 * @param {string|undefined} options.cwd working directory
 * @returns {Object} spawn result
 */
export function hardenedGitCommand(args: string[], options?: {
    cwd: string | undefined;
}): Object;
/**
 * Build CycloneDX release notes from git tags and commits.
 *
 * @param {string|undefined} repoPath local repository path
 * @param {Object} options options carrying release notes hints
 * @returns {Object|undefined} releaseNotes object
 */
export function buildReleaseNotesFromGit(repoPath: string | undefined, options?: Object): Object | undefined;
/**
 * Return git allow protocol string from the environment variables.
 *
 * @returns {string} git allow protocol string
 */
export function getGitAllowProtocol(): string;
/**
 * Checks the given hostname against the allowed list.
 *
 * @param {string} hostname Host name to check
 * @returns {boolean} true if the hostname in its entirety is allowed. false otherwise.
 */
export function isAllowedHost(hostname: string): boolean;
/**
 * Checks the given path string to belong to a drive in Windows.
 *
 * @param {string} p Path string to check
 * @returns {boolean} true if the windows path belongs to a drive. false otherwise (device names)
 */
export function isAllowedWinPath(p: string): boolean;
/**
 * Checks the given path against the allowed list.
 *
 * @param {string} p Path string to check
 * @returns {boolean} true if the path is present in the allowed paths. false otherwise.
 */
export function isAllowedPath(p: string): boolean;
/**
 * Determine if the path could be a package URL.
 *
 * @param {string} filePath Path or URL
 * @returns {boolean} true if the file path looks like a purl
 */
export function maybePurlSource(filePath: string): boolean;
/**
 * Determine if the file path could be a remote URL.
 *
 * @param {string} filePath The Git URL or local path
 * @returns {boolean} true if the file path is a remote URL. false otherwise.
 */
export function maybeRemotePath(filePath: string): boolean;
/**
 * Validates a given Git URL/Path against dangerous protocols and allowed hosts.
 *
 * @param {string} filePath The Git URL or local path
 * @returns {Object|null} Error object if invalid, or null if valid
 */
export function validateAndRejectGitSource(filePath: string): Object | null;
/**
 * Clone a git repository into a temporary directory.
 *
 * @param {string} repoUrl Repository URL
 * @param {string|string[]|null} branch Branch name
 * @returns {string} cloned directory path
 */
export function gitClone(repoUrl: string, branch?: string | string[] | null): string;
/**
 * Sanitize remote URL for logging.
 *
 * @param {string|undefined} remoteUrl Repository URL
 * @returns {string|undefined} sanitized URL
 */
export function sanitizeRemoteUrlForLogs(remoteUrl: string | undefined): string | undefined;
/**
 * Find a matching git ref for a package version.
 *
 * @param {string} repoUrl Repository URL
 * @param {Object|undefined} purlResolution purl resolution metadata
 * @returns {string|undefined} matching tag or branch reference
 */
export function findGitRefForPurlVersion(repoUrl: string, purlResolution: Object | undefined): string | undefined;
/**
 * Find the best source directory for purl-based npm monorepo scans.
 *
 * @param {string} srcDir cloned source directory
 * @param {Object|undefined} purlResolution purl resolution metadata
 * @returns {string|undefined} preferred source directory
 */
export function resolvePurlSourceDirectory(srcDir: string, purlResolution: Object | undefined): string | undefined;
/**
 * Validate package URL source input and return an error object when invalid.
 *
 * @param {string} purlString package URL string
 * @returns {{status:number,error:string,details:string}|null} validation error or null
 */
export function validatePurlSource(purlString: string): {
    status: number;
    error: string;
    details: string;
} | null;
/**
 * Resolve a git repository URL from a package URL by querying package registries.
 *
 * Supported purl types:
 * - npm    -> registry.npmjs.org
 * - pypi   -> pypi.org
 * - gem    -> rubygems.org
 * - cargo  -> crates.io
 * - pub    -> pub.dev
 * - github -> github.com/{namespace}/{name}
 * - bitbucket -> bitbucket.org/{namespace}/{name}
 * - maven  -> repo1.maven.org POM scm metadata
 * - composer -> repo.packagist.org p2 metadata
 * - generic -> qualifiers: vcs_url, download_url
 *
 * @param {string} purlString package URL string
 * @returns {Promise<{repoUrl:string|undefined, registry:string|undefined, type:string}|undefined>} resolution result
 */
export function resolveGitUrlFromPurl(purlString: string): Promise<{
    repoUrl: string | undefined;
    registry: string | undefined;
    type: string;
} | undefined>;
/**
 * Clean up cloned source directories.
 *
 * @param {string} srcDir directory path to remove
 */
export function cleanupSourceDir(srcDir: string): void;
export const PURL_REGISTRY_LOOKUP_WARNING: "Resolved repository URL from package registry metadata. This source can be inaccurate or malicious; review before trusting results.";
export const SUPPORTED_PURL_SOURCE_TYPES: string[];
//# sourceMappingURL=source.d.ts.map
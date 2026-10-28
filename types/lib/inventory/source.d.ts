/** Warning emitted for repository URLs resolved from untrusted package registry metadata. */
export declare const PURL_REGISTRY_LOOKUP_WARNING = "Resolved repository URL from package registry metadata. This source can be inaccurate or malicious; review before trusting results.";
/** Purl types supported for source repository resolution. */
export declare const SUPPORTED_PURL_SOURCE_TYPES: string[];
/**
 * Validate git ref names used as branch/tag values.
 *
 * @param {string|undefined} refName branch or tag name
 * @returns {boolean} true if safe
 */
export declare function isSafeGitRefName(refName: string | undefined): boolean;
/**
 * Execute git with hardened defaults.
 *
 * @param {string[]} args git arguments
 * @param {Object} options command options
 * @param {string|undefined} options.cwd working directory
 * @param {boolean|undefined} options.noRepository run outside any repository,
 *   so the config of a repository in the working directory, such as url.*.insteadOf
 *   or core.sshCommand, cannot change where a remote command connects
 * @returns {Object} spawn result
 */
export declare function hardenedGitCommand(args: string[], options?: {
    cwd: string | undefined;
    noRepository: boolean | undefined;
}): Object;
/**
 * Build CycloneDX release notes from git tags and commits.
 *
 * @param {string|undefined} repoPath local repository path
 * @param {Object} options options carrying release notes hints
 * @returns {Object|undefined} releaseNotes object
 */
export declare function buildReleaseNotesFromGit(repoPath: string | undefined, options?: Object): Object | undefined;
/**
 * Return git allow protocol string from the environment variables.
 *
 * @returns {string} git allow protocol string
 */
export declare function getGitAllowProtocol(): string;
/**
 * Checks the given hostname against the allowed list.
 *
 * @param {string} hostname Host name to check
 * @returns {boolean} true if the hostname in its entirety is allowed. false otherwise.
 */
export declare function isAllowedHost(hostname: string): boolean;
/**
 * Checks the given path string to belong to a drive in Windows.
 *
 * @param {string} p Path string to check
 * @returns {boolean} true if the windows path belongs to a drive. false otherwise (device names)
 */
export declare function isAllowedWinPath(p: string): boolean;
/**
 * Checks the given path against the allowed list.
 *
 * @param {string} p Path string to check
 * @returns {boolean} true if the path is present in the allowed paths. false otherwise.
 */
export declare function isAllowedPath(p: string): boolean;
/**
 * Checks where the given path really points, after following symlinks, against
 * where the allowed paths really point. Both sides are resolved, so an allowed
 * directory that is itself reached through a link (such as /tmp on macOS) still
 * matches, while a link inside an allowed directory that leads outside it does
 * not.
 *
 * @param {string} p Path string to check
 * @returns {boolean} true if the real path is inside a real allowed path
 */
export declare function isAllowedRealPath(p: string): boolean;
/**
 * Determine if the path could be a package URL.
 *
 * @param {string} filePath Path or URL
 * @returns {boolean} true if the file path looks like a purl
 */
export declare function maybePurlSource(filePath: string): boolean;
/**
 * Determine if the file path could be a remote URL.
 *
 * @param {string} filePath The Git URL or local path
 * @returns {boolean} true if the file path is a remote URL. false otherwise.
 */
export declare function maybeRemotePath(filePath: string): boolean;
/**
 * Validates a given Git URL/Path against dangerous protocols and allowed hosts.
 *
 * @param {string} filePath The Git URL or local path
 * @returns {Object|null} Error object if invalid, or null if valid
 */
export declare function validateAndRejectGitSource(filePath: string): Object | null;
/**
 * Return the host a git client connects to for a remote, read the way git,
 * libcurl and OpenSSH read it rather than the way new URL() does. git ends the
 * authority of ssh:// and git:// URLs only at the first slash, percent-decodes
 * it before splitting off the host, and reads a leading "[...]" as the host.
 * OpenSSH takes the host after the last "@". So a "?" or "#" before the first
 * slash, a second "@", brackets in the user name, or a percent sign in an
 * ssh:// or git:// authority make the host ambiguous.
 *
 * @param {string} remote Git URL or SCP-like address
 * @returns {string|undefined} lower-cased host, or undefined when it is ambiguous
 */
export declare function getGitRemoteHost(remote: string): string | undefined;
/**
 * Remove credentials from git output before it is logged. Every URL in the
 * text loses its user name and password, which git copies into its error
 * messages from the remote it was given.
 *
 * @param {string|undefined} text Output of a git command
 * @param {string|undefined} repoUrl Remote the command was given
 * @returns {string|undefined} Output with credentials replaced by ***
 */
export declare function redactGitOutput(text: string | undefined, repoUrl: string | undefined): string | undefined;
/**
 * Clone a git repository into a temporary directory.
 *
 * @param {string} repoUrl Repository URL
 * @param {string|string[]|null} branch Branch name
 * @returns {string} cloned directory path
 */
export declare function gitClone(repoUrl: string, branch?: string | string[] | null): string;
/**
 * Sanitize remote URL for logging.
 *
 * @param {string|undefined} remoteUrl Repository URL
 * @returns {string|undefined} sanitized URL
 */
export declare function sanitizeRemoteUrlForLogs(remoteUrl: string | undefined): string | undefined;
/**
 * Find a matching git ref for a package version.
 *
 * @param {string} repoUrl Repository URL
 * @param {Object|undefined} purlResolution purl resolution metadata
 * @returns {string|undefined} matching tag or branch reference
 */
export declare function findGitRefForPurlVersion(repoUrl: string, purlResolution: Object | undefined): string | undefined;
/**
 * Find the best source directory for purl-based npm monorepo scans.
 *
 * @param {string} srcDir cloned source directory
 * @param {Object|undefined} purlResolution purl resolution metadata
 * @returns {string|undefined} preferred source directory
 */
export declare function resolvePurlSourceDirectory(srcDir: string, purlResolution: Object | undefined): string | undefined;
/**
 * Validate package URL source input and return an error object when invalid.
 *
 * @param {string} purlString package URL string
 * @returns {{status:number,error:string,details:string}|null} validation error or null
 */
export declare function validatePurlSource(purlString: string): {
    status: number;
    error: string;
    details: string;
} | null;
/**
 * Discard prefetched registry documents. Tests only.
 */
export declare function resetGitUrlSourcePrefetch(): void;
/**
 * Prefetch the registry documents a list of purls will be resolved from.
 *
 * `resolveGitUrlFromPurl` takes a single purl, so on its own it can only ever
 * make one request at a time. Callers that know the whole list up front — the
 * predictive audit knows every target before it starts — can hand it over here
 * and have the documents fetched in one round instead.
 *
 * @param {Array<string>} purlStrings Purls about to be resolved. Duplicates,
 *   empties and unparseable entries are fine.
 * @returns {Promise<void>}
 */
export declare function prefetchGitUrlSources(purlStrings: Array<string>): Promise<void>;
/**
 * Resolve source repository details for a package from its purl.
 *
 * Queries the package registry (or constructs the URL directly for VCS-hosted
 * purl types) and normalizes the repository or homepage URL found in registry
 * metadata. Network and lookup failures are logged and yield `undefined`.
 *
 * @param {string} purlString Package URL string
 * @param {Object} [helpers={}] Injected registry helpers (e.g. `fetchPomXmlAsJson` required for maven)
 * @returns {Promise<{type: string, registry: string, repoUrl: string, version: string, namespace: string, name: string}|undefined>} Resolved source details, or `undefined` when no remote repository URL could be resolved
 */
export declare function resolveGitUrlFromPurl(purlString: string, helpers?: Object): Promise<{
    type: string;
    registry: string;
    repoUrl: string;
    version: string;
    namespace: string;
    name: string;
} | undefined>;
/**
 * Clean up cloned source directories.
 *
 * @param {string} srcDir directory path to remove
 */
export declare function cleanupSourceDir(srcDir: string): void;
//# sourceMappingURL=source.d.ts.map
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
 * Determine whether git must refuse HTTP redirects. A git host allowlist is
 * checked against the URL cdxgen is given, and git would otherwise follow
 * the server's redirect on its first request to a host the allowlist never
 * saw. Secure mode refuses redirects in the HTTP client too.
 *
 * @returns {boolean} true when a git host allowlist or secure mode applies
 */
export declare function gitRedirectsRefused(): boolean;
/**
 * Execute git with hardened defaults.
 *
 * Every call runs with command-scope settings that keep the repository from
 * running fsmonitor hooks, being opened as a bare repository or having its
 * commit signatures verified by a program it names. While a git
 * host allowlist or secure mode applies, git also refuses HTTP redirects, so
 * an allowed host cannot send a clone or ls-remote to a host the allowlist
 * does not name. A remote that carries its own password is used without the
 * account's credential helpers: git hands a URL password that worked to the
 * helpers, which would save it and offer it to every later command for that
 * host, such as the clone for another client of the server.
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
 * Execute git with the hardened defaults of hardenedGitCommand without
 * blocking the event loop. A long-running process such as the server uses this
 * for the operations that wait on a remote, which would otherwise stop it from
 * answering anyone until the remote is done.
 *
 * @param {string[]} args git arguments
 * @param {Object} options command options, as for hardenedGitCommand
 * @param {string|undefined} options.cwd working directory
 * @param {boolean|undefined} options.noRepository run outside any repository
 * @returns {Promise<Object>} spawn result
 */
export declare function hardenedGitCommandAsync(args: string[], options?: {
    cwd: string | undefined;
    noRepository: boolean | undefined;
}): Promise<Object>;
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
 * ssh:// or git:// authority make the host ambiguous. git also searches the
 * whole remote, path included, for "@[" and then takes the bracketed text as
 * the host, so "@[" after the authority makes it ambiguous too.
 *
 * @param {string} remote Git URL or SCP-like address
 * @returns {string|undefined} lower-cased host, or undefined when it is ambiguous
 */
export declare function getGitRemoteHost(remote: string): string | undefined;
/**
 * Remove credentials from git output before it is logged or reported. Every
 * URL in the text loses its user name and password, which git copies into its
 * error messages from the remote it was given, and its query string and
 * fragment, which can hold access tokens and signatures.
 *
 * @param {string|undefined} text Output of a git command
 * @param {string|undefined} repoUrl Remote the command was given
 * @returns {string|undefined} Output with credentials replaced by ***
 */
export declare function redactGitOutput(text: string | undefined, repoUrl: string | undefined): string | undefined;
export { redactPackageManagerOutput } from "../core/outputRedaction.js";
/**
 * Check out the files of a repository that was cloned with --no-checkout,
 * unless the checkout is larger than cdxgen accepts.
 *
 * git stores a blob or a tree once however often a tree names it, so the
 * size of the pack a remote sends says nothing about the size of the
 * checkout: a pack of 2 kB can stand for terabytes of files. The tree is
 * therefore measured before any of it is written. The listing has one line
 * for every file and every directory the tree names, so a tree that is
 * costly to walk is also long to list, and one whose listing outgrows the
 * spawn buffer is refused as well, which bounds the measuring. The files are
 * then written as the blobs hold them, because keyword expansion, re-encoding
 * and end-of-line conversion asked for by the repository's .gitattributes
 * would make them many times larger than what was measured.
 *
 * @param {string} cloneDir directory of a clone made with --no-checkout
 * @param {Object} [options]
 * @param {boolean} [options.forServer] apply the default ceilings, as for a request to the server
 * @returns {Object} spawn-like result; status is 0 when the files are checked
 *   out or the repository has no commit, otherwise stderr says why not
 */
export declare function checkoutClonedRepository(cloneDir: string, options?: {
    forServer?: boolean;
}): Object;
/**
 * Clone a git repository into a temporary directory.
 *
 * @param {string} repoUrl Repository URL
 * @param {string|string[]|null} branch Branch name
 * @returns {string} cloned directory path
 */
export declare function gitClone(repoUrl: string, branch?: string | string[] | null): string;
/**
 * Clone a git repository into a temporary directory without blocking the
 * event loop while the remote is answering.
 *
 * @param {string} repoUrl Repository URL
 * @param {string|string[]|null} branch Branch name
 * @returns {Promise<string>} cloned directory path
 */
export declare function gitCloneAsync(repoUrl: string, branch?: string | string[] | null): Promise<string>;
/**
 * Sanitize remote URL for logs, audit reports and BOM annotations. The user
 * name and password are masked, and the query string and fragment, which can
 * hold access tokens and signatures, are dropped.
 *
 * @param {string|undefined} remoteUrl Repository URL
 * @returns {string|undefined} sanitized URL
 */
export declare function sanitizeRemoteUrlForLogs(remoteUrl: string | undefined): string | undefined;
/**
 * Split a comma-separated list of local scan paths into its entries. A string
 * that names an existing path is one path, whatever characters it holds.
 *
 * @param {string} sourcePath Path or comma-separated paths
 * @returns {string[]} The entries, never empty
 */
export declare function splitSourcePaths(sourcePath: string): string[];
/**
 * Name a source for logs, activity records and default names. A git URL or
 * purl can hold a credential in its user info, query string or fragment (in a
 * purl, the qualifiers such as a percent-encoded `vcs_url`, and the subpath),
 * so those parts are left out. A local path is returned unchanged.
 *
 * @param {string} source Local path, git URL or purl
 * @returns {string} The source without user info, query string and fragment
 */
export declare function getSourceLabel(source: string): string;
/**
 * Name a source after its last path segment, for the default project name and
 * for files named after the source. The name is written to the BOM and sent to
 * Dependency-Track, so it comes from the source without credentials.
 *
 * @param {string} source Local path, git URL or purl
 * @returns {string} Last path segment of the source
 */
export declare function getSourceBaseName(source: string): string;
/**
 * Find a matching git ref for a package version.
 *
 * @param {string} repoUrl Repository URL
 * @param {Object|undefined} purlResolution purl resolution metadata
 * @returns {string|undefined} matching tag or branch reference
 */
export declare function findGitRefForPurlVersion(repoUrl: string, purlResolution: Object | undefined): string | undefined;
/**
 * Find a matching git ref for a package version without blocking the event
 * loop while the remote is answering.
 *
 * @param {string} repoUrl Repository URL
 * @param {Object|undefined} purlResolution purl resolution metadata
 * @returns {Promise<string|undefined>} matching tag or branch reference
 */
export declare function findGitRefForPurlVersionAsync(repoUrl: string, purlResolution: Object | undefined): Promise<string | undefined>;
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
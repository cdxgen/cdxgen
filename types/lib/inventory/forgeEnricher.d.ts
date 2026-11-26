/**
 * Parse a GitHub repository URL into its owner and repository name.
 *
 * Only accepts URLs where github.com is the actual host (rejecting spoofed
 * hosts such as `https://evil.com/github.com/o/r` and
 * `https://evil.com//github.com/o/r`) and only git-safe path segments, so an
 * untrusted remote URL cannot steer authenticated API requests.
 *
 * @param {string} url The git origin url
 * @returns {{owner: string, repo: string}|null} Object containing owner and repo, or null
 */
export declare function parseGitHubUrl(url: string): {
    owner: string;
    repo: string;
} | null;
/**
 * Parses GitLab repository origin URL to extract project path/ID.
 *
 * Only accepts URLs where gitlab.com is the actual host, as parseGitHubUrl does.
 *
 * @param {string} url The git origin url
 * @returns {string|null} The project path (owner/repo) or null
 */
export declare function parseGitLabUrl(url: string): string | null;
/**
 * Enriches AI commits with details from GitHub or GitLab API if tokens are present.
 *
 * @param {string} dir Root directory of the repository
 * @param {Array<Object>} aiCommits List of AI commit objects
 * With `options.offline`, nothing is requested and the result is empty, as
 * it is without a token.
 *
 * @param {Object} options Options containing forgeToken or env context
 * @returns {Promise<Object>} Object containing reviews list and authoritative flags
 */
export declare function enrichFromForge(dir: string, aiCommits: Array<Object>, options?: Object): Promise<Object>;
//# sourceMappingURL=forgeEnricher.d.ts.map
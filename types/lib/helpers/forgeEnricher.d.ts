export function parseGitHubUrl(url: any): {
    owner: any;
    repo: any;
} | null;
/**
 * Parses GitLab repository origin URL to extract project path/ID.
 *
 * @param {string} url The git origin url
 * @returns {string|null} The project path (owner/repo) or null
 */
export function parseGitLabUrl(url: string): string | null;
/**
 * Enriches AI commits with details from GitHub or GitLab API if tokens are present.
 *
 * @param {string} dir Root directory of the repository
 * @param {Array<Object>} aiCommits List of AI commit objects
 * @param {Object} options Options containing forgeToken or env context
 * @returns {Promise<Object>} Object containing reviews list and authoritative flags
 */
export function enrichFromForge(dir: string, aiCommits: Array<Object>, options?: Object): Promise<Object>;
//# sourceMappingURL=forgeEnricher.d.ts.map
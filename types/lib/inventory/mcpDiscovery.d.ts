/**
 * Normalize a string into a safe MCP reference token.
 *
 * Reads the first 256 characters, NFKC-normalizes, lowercases, collapses
 * separator runs, strips leading and trailing punctuation, and truncates to
 * 128 characters, falling back to `unknown` for empty or dot-only results.
 *
 * @param {string} value Raw token value
 * @returns {string} Sanitized reference token
 */
export declare function sanitizeMcpRefToken(value: string): string;
/**
 * Determine whether a hostname is local: `localhost`, loopback, link-local, or a private address range.
 *
 * @param {string} hostname Hostname or IP address
 * @returns {boolean} `true` when the host resolves to a local or private address
 */
export declare function isLocalHost(hostname: string): boolean;
/**
 * Return the AI provider names whose detection patterns match the given text.
 *
 * @param {string} text Text to scan
 * @returns {string[]} Matching provider names (e.g. `anthropic`, `openai`)
 */
export declare function providerNamesForText(text: string): string[];
/**
 * Return the credential-indicator names whose patterns match the given text.
 *
 * @param {string} text Text to scan
 * @returns {string[]} Matching indicator names (e.g. `github-token`, `bearer-token`)
 */
export declare function credentialIndicatorsForText(text: string): string[];
//# sourceMappingURL=mcpDiscovery.d.ts.map
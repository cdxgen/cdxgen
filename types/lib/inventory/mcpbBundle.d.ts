/**
 * Cut text to at most limit characters at the last boundary before the
 * limit, so no URL or token is split. Text within the limit is returned as
 * it is, and text with no boundary before the limit gives an empty string.
 *
 * @param {string} text Text to cut
 * @param {number} limit Largest length kept
 * @returns {string} The cut text
 */
export declare function truncateAtWordBoundary(text: string, limit: number): string;
/**
 * Parser for MCPB / DXT desktop-extension bundles.
 *
 * A bundle is a zip archive carrying a local MCP server, its dependencies, and
 * a `manifest.json`. This parser reads only the manifest to describe the
 * bundled server, the tools/prompts it exposes, the number of precompiled
 * platform binaries, and whether it injects secret-typed configuration values
 * as environment variables. Only regular files inside `context.rootDir`, the
 * scanned root, are opened.
 *
 * @type {{id: string, patterns: string[], parse(files: string[], options?: Object, context?: {rootDir?: string}): {components: Object[]}}}
 */
export declare const mcpbBundleParser: {
    id: string;
    patterns: string[];
    parse(files: string[], options?: Object, context?: {
        rootDir?: string;
    }): {
        components: Object[];
    };
};
//# sourceMappingURL=mcpbBundle.d.ts.map
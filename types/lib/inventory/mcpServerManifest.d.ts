/**
 * Parser for MCP Registry server manifests (`server.json`).
 *
 * Converts each declared distributable package into a CycloneDX component
 * (with a purl when the registry type maps to a supported ecosystem) and each
 * remotely hosted endpoint into a service, alongside a file component that
 * summarizes the manifest. Only regular files inside `context.rootDir`, the
 * scanned root, are read; a symbolic link is never followed.
 *
 * @type {{id: string, patterns: string[], parse(files: string[], options?: Object, context?: {rootDir?: string}): {components: Object[], services: Object[]}}}
 */
export declare const mcpServerManifestParser: {
    id: string;
    patterns: string[];
    parse(files: string[], options?: Object, context?: {
        rootDir?: string;
    }): {
        components: Object[];
        services: Object[];
    };
};
//# sourceMappingURL=mcpServerManifest.d.ts.map
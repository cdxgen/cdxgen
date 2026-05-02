/**
 * Classify a package/component/import reference as MCP-related.
 *
 * @param {Object|string} ref Package/component reference or import source
 * @returns {{
 *   isMcp: boolean,
 *   isOfficial: boolean,
 *   isKnownIntegration: boolean,
 *   role: string | undefined,
 *   catalogSource: string | undefined,
 *   packageName: string
 * }}
 */
export function classifyMcpReference(ref: Object | string): {
    isMcp: boolean;
    isOfficial: boolean;
    isKnownIntegration: boolean;
    role: string | undefined;
    catalogSource: string | undefined;
    packageName: string;
};
/**
 * Add MCP catalog metadata to a CycloneDX component.
 *
 * @param {Object} component CycloneDX component
 * @returns {Object} Same component reference
 */
export function enrichComponentWithMcpMetadata(component: Object): Object;
//# sourceMappingURL=mcp.d.ts.map
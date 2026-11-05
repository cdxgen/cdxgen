/**
 * Summarize Kiro CLI V3 permission documents into policy-safe posture facts.
 *
 * Kiro V3 describes what an agent may do with `capability`/`effect` rules that
 * live in an agent definition's `permissions` object, in the user-scope
 * `~/.kiro/settings/permissions.yaml`, and in the per-workspace
 * `~/.kiro/workspace-roots/<hash>/permissions.yaml`. The rules carry `match`
 * pattern lists, free-text reasons, and paths, none of which belong in a BOM.
 * This module reduces a document to counts, allowlisted effect counts,
 * validated capability names, and booleans, and never returns the patterns or
 * any other free text.
 */
/**
 * Summarize a Kiro V3 permission document.
 *
 * Accepts the parsed `permissions` object of an agent definition or a parsed
 * `permissions.yaml` document. A bare rules array is accepted as well. The
 * result carries only counts, booleans, and validated token lists; `match`
 * patterns, `exclude` lists, reasons, and paths are never returned.
 *
 * @param {Object|Array|undefined} rulesOrDoc Parsed permissions object, YAML
 *   document, or rules array
 * @returns {{
 *   ruleCount: number,
 *   allowRuleCount: number,
 *   denyRuleCount: number,
 *   askRuleCount: number,
 *   evaluateRuleCount: number,
 *   capabilities: string[],
 *   allowsAllCapabilities: boolean,
 *   unrestrictedAllowCapabilities: string[],
 *   workspaceTrusted: boolean|undefined,
 *   policyPresets: string[],
 *   unknownPolicyPresetCount: number,
 * }} Permission posture summary
 */
export declare function summarizeKiroPermissions(rulesOrDoc: Object | any[] | undefined): {
    ruleCount: number;
    allowRuleCount: number;
    denyRuleCount: number;
    askRuleCount: number;
    evaluateRuleCount: number;
    capabilities: string[];
    allowsAllCapabilities: boolean;
    unrestrictedAllowCapabilities: string[];
    workspaceTrusted: boolean | undefined;
    policyPresets: string[];
    unknownPolicyPresetCount: number;
};
/**
 * Flatten a permission summary into property suffix/value pairs.
 *
 * Both scans that consume Kiro permission documents emit the same suffixes;
 * the host scan prefixes them with `cdx:agentic:` and the project scan with
 * `cdx:agent:`. Values are numbers, booleans, or comma-separated validated
 * tokens, so no free text reaches a BOM through this mapping.
 *
 * @param {ReturnType<summarizeKiroPermissions>} summary Permission posture summary
 * @returns {Record<string, number|boolean|string>} Property suffix mapped to its value
 */
export declare function kiroPermissionSummaryEntries(summary: ReturnType<summarizeKiroPermissions>): Record<string, number | boolean | string>;
//# sourceMappingURL=kiroPermissions.d.ts.map
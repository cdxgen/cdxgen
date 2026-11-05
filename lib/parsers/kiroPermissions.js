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

// Effects documented at kiro.dev/docs/permissions. An unknown effect is
// counted by `ruleCount` alone and by no per-effect counter.
const KIRO_EFFECTS = new Set(["allow", "deny", "ask", "evaluate"]);

// Policy presets that may be listed under the top-level `policies` key.
// kiro.dev documents `approve-for-me`; other preset names are dropped rather
// than copied, because the full set is not documented.
const KIRO_POLICY_PRESET_ALLOWLIST = new Set(["approve-for-me"]);

// A capability is a short lowercase token such as `fs_read`, `shell`, or the
// meta-capability `all`. Anything outside this shape is dropped instead of
// being copied into the BOM.
const KIRO_CAPABILITY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

const isPlainEntry = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sortedUnique = (values) => [...new Set(values)].sort();

/**
 * Decide whether a rule's `match` list holds at least one non-empty pattern.
 *
 * @param {unknown} match The rule's match value
 * @returns {boolean} True when a non-empty string pattern is present
 */
const hasNonEmptyMatch = (match) =>
  Array.isArray(match) &&
  match.some((entry) => typeof entry === "string" && entry.trim() !== "");

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
 * }} Permission posture summary
 */
export function summarizeKiroPermissions(rulesOrDoc) {
  const doc = Array.isArray(rulesOrDoc) ? { rules: rulesOrDoc } : rulesOrDoc;
  const rules = Array.isArray(doc?.rules) ? doc.rules : [];
  let ruleCount = 0;
  const effectCounts = { allow: 0, deny: 0, ask: 0, evaluate: 0 };
  const capabilities = [];
  const unrestrictedAllowCapabilities = [];
  let allowsAllCapabilities = false;
  for (const rule of rules) {
    if (!isPlainEntry(rule)) {
      continue;
    }
    ruleCount += 1;
    if (typeof rule.effect === "string" && KIRO_EFFECTS.has(rule.effect)) {
      effectCounts[rule.effect] += 1;
    }
    if (typeof rule.capability === "string") {
      const capability = rule.capability;
      if (KIRO_CAPABILITY_PATTERN.test(capability)) {
        capabilities.push(capability);
        if (rule.effect === "allow" && !hasNonEmptyMatch(rule.match)) {
          unrestrictedAllowCapabilities.push(capability);
          if (capability === "all") {
            allowsAllCapabilities = true;
          }
        }
      }
    }
  }
  const policyPresets = Array.isArray(doc?.policies)
    ? doc.policies.filter(
        (entry) =>
          typeof entry === "string" && KIRO_POLICY_PRESET_ALLOWLIST.has(entry),
      )
    : [];
  return {
    allowRuleCount: effectCounts.allow,
    allowsAllCapabilities,
    askRuleCount: effectCounts.ask,
    capabilities: sortedUnique(capabilities),
    denyRuleCount: effectCounts.deny,
    evaluateRuleCount: effectCounts.evaluate,
    policyPresets: sortedUnique(policyPresets),
    ruleCount,
    unrestrictedAllowCapabilities: sortedUnique(unrestrictedAllowCapabilities),
    ...(typeof doc?.workspaceTrusted === "boolean"
      ? { workspaceTrusted: doc.workspaceTrusted }
      : {}),
  };
}

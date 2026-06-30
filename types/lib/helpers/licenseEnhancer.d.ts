/**
 * Parses a compliance policy file.
 *
 * @param {string} policyPath Path to policy file
 * @returns {object|null} Parsed policy object
 */
export function loadPolicy(policyPath: string): object | null;
/**
 * Resolves a raw license ID or expression to a CycloneDX license object shape.
 *
 * @param {string} raw Raw license string
 * @param {object} opts Options
 * @returns {object|null} Resolved license object: { id } or { expression } or { name }
 */
export function resolveLicenseId(raw: string, opts?: object): object | null;
/**
 * Upgrades deprecated SPDX license identifiers or expressions.
 *
 * @param {string} idOrExpr License ID or expression
 * @returns {string} Upgraded identifier or expression
 */
export function upgradeDeprecated(idOrExpr: string): string;
/**
 * Normalizes a single CycloneDX license object or string.
 *
 * @param {object|string} license License object or string
 * @param {object} opts Options
 * @returns {object} Normalized license object
 */
export function normalizeLicense(license: object | string, opts?: object): object;
/**
 * Normalizes and deduplicates a component's licenses array.
 *
 * @param {object} component CycloneDX Component
 * @param {object} opts Options
 * @returns {object} Modified component
 */
export function enhanceComponentLicenses(component: object, opts?: object): object;
/**
 * Opt-in: enriches a license object with metadata properties and compliance policy.
 *
 * @param {object} licenseWrapper License wrapper object
 * @param {object} policy Compliance policy
 * @param {object} opts Options
 * @returns {object} Enriched license wrapper
 */
export function enrichLicenseMetadata(licenseWrapper: object, policy: object, _opts?: {}): object;
/**
 * Walks a whole BOM and enhances all metadata and component licenses.
 *
 * @param {object} bom CycloneDX BOM JSON Object
 * @param {object} opts Options
 * @returns {object} Enhanced BOM
 */
export function enhanceBom(bom: object, opts?: object): object;
/**
 * Walks every component license in a BOM and returns the entries that violate
 * the supplied compliance policy (alert `error`, or `warning` when
 * `includeWarnings` is set). Recurses into nested components and the metadata
 * component.
 *
 * @param {object} bom CycloneDX BOM
 * @param {object} policy Parsed policy object (see loadPolicy)
 * @param {object} [opts] { includeWarnings?: boolean }
 * @returns {object[]} Violations: { ref, name, version, license, category, alert }
 */
export function collectPolicyViolations(bom: object, policy: object, opts?: object): object[];
export { parseSpdxExpression };
import { parseSpdxExpression } from "./spdxExpression.js";
//# sourceMappingURL=licenseEnhancer.d.ts.map
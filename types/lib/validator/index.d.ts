/**
 * cdx-validate orchestrator.
 *
 * Combines cdxgen's existing structural validation
 * ({@link ./bomValidator.js}) with the compliance rule packs in
 * {@link ./complianceEngine.js} and (optionally) signature verification from
 * {@link ../helpers/bomSigner.js}.
 *
 * This module exposes a single high-level function, `validateBomAdvanced`,
 * and helpers to classify the result. It does *not* perform any I/O: the CLI
 * wrapper (`bin/validate.js`) is responsible for reading the input BOM.
 */
/**
 * Map of severity names to numeric ordering used for severity threshold
 * comparisons.
 *
 * @type {Object<string, number>}
 */
declare const SEVERITY_ORDER: Record<string, number>;
/**
 * Validate a BOM.
 *
 * Validation is done in JavaScript. `cdxrs validate` is deliberately not used:
 * it rejects BOMs the JS validator accepts and reports its findings on stdout
 * rather than through the bridge, which turns a disagreement between the two
 * implementations into an unexplained non-zero exit.
 *
 * **No failure mode may abort SBOM generation.**
 *
 * @param {object} bomJson Parsed CycloneDX BOM.
 * @returns {Promise<{ valid: boolean, source: "js", findings: null }>}
 */
export declare function validateGeneratedBom(bomJson: object): Promise<{
    valid: boolean;
    source: "js";
    findings: null;
}>;
/**
 * Run structural + compliance validation against a parsed BOM.
 *
 * The JSON schema check and signature verification read the document as
 * given. The deep checks and compliance rules read the 1.x-shaped model, so
 * the same project gives the same rule results at 1.x and at 2.0; for a 2.0
 * document `readLosses` lists what that model could not hold.
 *
 * @param {object} bomJson Parsed CycloneDX JSON BOM.
 * @param {object} [options]
 * @param {boolean} [options.schema]            Run JSON-Schema validation (default true).
 * @param {boolean} [options.deep]              Run purl/ref/metadata deep checks (default true).
 * @param {Array<string>} [options.benchmarks]  Aliases to include in the scorecards (default: all).
 * @param {Array<string>} [options.categories]  Restrict compliance rules to these categories.
 * @param {string} [options.minSeverity]        Minimum severity for returned findings.
 * @param {boolean} [options.includeManual]     Include manual-review findings (default true).
 * @param {boolean} [options.includePass]       Include passing findings (default false).
 * @param {string} [options.publicKey]          If set, verify the BOM signature with this public key.
 * @param {string|Buffer} [options.secretKey]   If set, verify an HMAC (HS*) BOM signature with this shared secret.
 * @param {boolean} [options.nestedSignatures]  Also verify component, service, and annotation signatures (default true), as cdx-verify does.
 *   Parse untrusted BOM text with `parseStrictJson()` from `lib/parsers/strictJson.js` when verifying signatures.
 * @returns {{
 *   schemaValid: boolean,
 *   deepValid: boolean,
 *   validationErrors: Array<{ stage: string, message: string }>,
 *   readLosses: Array<{ pointer: string, reason: string }>,
 *   signatureVerified: boolean | null,
 *   signatureDetails: object | null,
 *   signatureEntries: Array<{ index: number, algorithm: any, keyId: any, verified: boolean }> | null,
 *   findings: Array<object>,
 *   allFindings: Array<object>,
 *   benchmarks: Array<object>,
 *   summary: object
 * }}
 */
export declare function validateBomAdvanced(bomJson: object, options?: {
    schema?: boolean;
    deep?: boolean;
    benchmarks?: Array<string>;
    categories?: Array<string>;
    minSeverity?: string;
    includeManual?: boolean;
    includePass?: boolean;
    publicKey?: string;
    secretKey?: string | Buffer;
    nestedSignatures?: boolean;
}): {
    schemaValid: boolean;
    deepValid: boolean;
    validationErrors: Array<{
        stage: string;
        message: string;
    }>;
    readLosses: Array<{
        pointer: string;
        reason: string;
    }>;
    signatureVerified: boolean | null;
    signatureDetails: object | null;
    signatureEntries: Array<{
        index: number;
        algorithm: any;
        keyId: any;
        verified: boolean;
    }> | null;
    findings: Array<object>;
    allFindings: Array<object>;
    benchmarks: Array<object>;
    summary: object;
};
/**
 * Decide whether a report should trigger a non-zero CLI exit.
 *
 * @param {object} report
 * @param {object} opts
 * @param {string} [opts.failSeverity] Severity level at or above which failing findings are considered a failure (default "high").
 * @param {boolean} [opts.strict]      When true, failing on any `fail` status regardless of severity, and a failing schema/deep validation also counts.
 * @param {boolean} [opts.requireSignature] Require a valid signature when verification was requested.
 * @returns {{ shouldFail: boolean, reason: string | null }}
 */
export declare function shouldFail(report: object, opts?: {
    failSeverity?: string;
    strict?: boolean;
    requireSignature?: boolean;
}): {
    shouldFail: boolean;
    reason: string | null;
};
export { buildBenchmarkReports, evaluateAll } from "./complianceEngine.js";
export { SEVERITY_ORDER };
//# sourceMappingURL=index.d.ts.map
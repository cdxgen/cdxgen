/**
 * Reader converters for CycloneDX 2.0 component evidence
 * (#/$defs/cyclonedx-component-2.0/$defs/componentEvidence and
 * #/$defs/cyclonedx-evidence-2.0) and cryptoProperties
 * (#/$defs/cyclonedx-cryptography-2.0/$defs/cryptoProperties) back to the 1.x
 * shapes. Each frozen spec is the allowlist of the members 1.x carries.
 */
/**
 * Register the identity shadows. An identity shadow is looked up by its 1.x
 * projection alone, whichever component carries it, so a key is registered
 * only when every identity entry read under it needs the same original; a
 * key shared with an entry that renders back by itself, or with a different
 * original, is left to the component shadows.
 *
 * @param {object} ctx Reader context
 */
export declare function flushIdentityShadows(ctx: object): void;
/**
 * componentEvidence → 1.x evidence.
 *
 * @param {object} ctx Reader context
 * @param {object} value 2.0 componentEvidence
 * @param {string} pointer JSON pointer of `value`
 * @returns {object|undefined} 1.x evidence
 */
export declare function reverseEvidence(ctx: object, value: object, pointer: string): object | undefined;
/**
 * cryptoProperties → 1.x cryptoProperties: list-valued
 * `implementationPlatform` and `securedBy.algorithmRef` become one value,
 * enum values 1.7 does not list are dropped, and 2.0-only members
 * (`secProperties`, `renewal`, `rotation`, `keyUsage`, non-hash
 * fingerprints) are losses.
 *
 * @param {object} ctx Reader context
 * @param {object} value 2.0 cryptoProperties
 * @param {string} pointer JSON pointer of `value`
 * @returns {object|undefined} 1.x cryptoProperties
 */
export declare function reverseCryptoProperties(ctx: object, value: object, pointer: string): object | undefined;
//# sourceMappingURL=cyclonedx20ReadEvidence.d.ts.map
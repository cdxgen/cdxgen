/**
 * Render-side conversion of 1.x component evidence and cryptoProperties to
 * the CycloneDX 2.0 shapes (#/$defs/cyclonedx-component-2.0/$defs/componentEvidence,
 * #/$defs/cyclonedx-cryptography-2.0/$defs/cryptoProperties).
 */
/**
 * The refId prefix of the party derived for a tool other than cdxgen. Any
 * refId that starts with it is a valid refIdType
 * (#/$defs/cyclonedx-common-2.0/$defs/refIdType: non-empty and not starting
 * with the BOM-Link intro `urn:cdx:`), whatever the tool's own refId is, so
 * the tool refId is appended unchanged and the party refId stays readable and
 * deterministic.
 */
export declare const TOOL_PARTY_REF_ID_PREFIX = "party-tool-";
/**
 * What the claims cdxgen writes at 2.0 are attributed with (#4591). cdxgen
 * claims only analysis it did:
 *
 * - `toolRefId` is the refId of the cdxgen tool component, present only when
 *   the BOM's `metadata.tools` lists cdxgen with a `bom-ref`.
 *   findCdxgenToolBomRef (lib/inventory/citations.js) returns the first tool
 *   bom-ref containing "cdxgen", which is a cdxgen-plugins-bin helper such as
 *   `trustinspector-cdxgen` whenever one is listed first, so the tool is
 *   matched by name among the same refs. Identity evidence carries cdxgen's
 *   assertion, its tool and method results only when this is set.
 * - `assertingTool` is set only without `toolRefId`: the first other tool
 *   component with a `bom-ref` (`{refId, toolRefId, label?}`), whose party
 *   asserts the component identifiers (`identifiers[].party` is required).
 *   With neither, cdxgen, as the converting tool, asserts the identifiers it
 *   wrote.
 * - `timestamp` is the BOM timestamp when it has one.
 *
 * Nothing is invented: absent members stay absent.
 *
 * @param {object} bom BOM in the 1.x shape (only `metadata` is read)
 * @returns {{toolRefId?: string, assertingTool?: {refId: string, toolRefId: string, label?: string}, timestamp?: string}} Claim context
 */
export declare function identityClaimContext(bom: object): {
    toolRefId?: string;
    assertingTool?: {
        refId: string;
        toolRefId: string;
        label?: string;
    };
    timestamp?: string;
};
/**
 * The refId of the party asserting the component identifiers: the cdxgen
 * party when cdxgen is the listed tool or no tool is listed, else the party
 * of the first other listed tool (see identityClaimContext).
 *
 * @param {object} claims Claim context from identityClaimContext
 * @returns {string} Party refId
 */
export declare function identifierPartyRefId(claims: object): string;
/**
 * The parties the renderer derives from the claim context, in the order it
 * appends them: the cdxgen party, then the asserting tool's party when there
 * is one. Each is a party (#/$defs/cyclonedx-party-2.0/$defs/party) with the
 * `asserter` role and a system identity
 * (#/$defs/cyclonedx-party-2.0/$defs/system, kind `automation`) whose `ref`
 * names the tool component only when that refId is declared. The renderer
 * declares one only when the document references it; the reader drops one
 * that matches exactly, since the render derives it again.
 *
 * @param {object} claims Claim context from identityClaimContext
 * @param {Set<string>} declared refIds declared in the document
 * @returns {object[]} Party declarations
 */
export declare function derivedPartyDeclarations(claims: object, declared: Set<string>): object[];
/**
 * Convert one 1.x identity entry to componentIdentityEvidence
 * (#/$defs/cyclonedx-component-2.0/$defs/componentIdentityEvidence). When
 * cdxgen is the listed tool (#4591), the entry is cdxgen's attributed claim:
 * `tools` names the helper recorded on the entry or, failing that, the cdxgen
 * tool; `assertion` credits the cdxgen party as asserter
 * (#/$defs/cyclonedx-evidence-2.0/$defs/assertion); and a method with a
 * matched value has the result `detected`. For another tool's BOM cdxgen did
 * not do that analysis, so none of these is added; the entry's own `tools`
 * are kept. `timestamp` is the BOM's own when it has one.
 *
 * @param {object} entry 1.x identity evidence entry
 * @param {object} stats Render counters from createRenderStats
 * @returns {object|undefined} The 2.0 entry, or undefined without a field
 */
export declare function convertIdentityEntry(entry: object, stats: object): object | undefined;
/**
 * Convert component evidence
 * (#/$defs/cyclonedx-component-2.0/$defs/componentEvidence). The 1.x
 * `callstack` object becomes the `callStacks` array; identity `field` becomes
 * `scheme`. Every nested object is cloned, so nothing is shared with the
 * input.
 */
export declare function convertComponentEvidence(evidence: any, stats: any): {
    identity: any[];
    occurrences: any[];
    callStacks: {
        frames: any[];
    }[];
    licenses: any[];
    copyright: any[];
} | undefined;
/**
 * Convert cryptoProperties
 * (#/$defs/cyclonedx-cryptography-2.0/$defs/cryptoProperties, required
 * `[assetType]`): drop the deprecated free-text `curve` (2.0 keeps only
 * `ellipticCurve`), algorithm families and protocol types the pinned 2.0 enums
 * do not list, and move `algorithmRef` under `securedBy`.
 */
export declare function convertCryptoProperties(cryptoProperties: any, stats: any): any;
//# sourceMappingURL=cyclonedx20RenderEvidence.d.ts.map
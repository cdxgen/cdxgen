/**
 * The 2.0 sections the renderer derives from the 1.x-shaped internal model
 * rather than converts: post-quantum migration risks (pqcMigration.js,
 * #4592), and the coding-agent parties and behavioral blueprint
 * (agentBlueprint.js, #4593).
 *
 * A model read from 2.0 carries its 2.0-only sections (risks, blueprints,
 * parties) for 2.0 output. Derived entries in them are recognised by refId
 * (`risk-pqc-*`, `blueprint-declared-agents`, agent parties `party-agent-*`
 * of system kind `agent`). The renderer drops carried derived entries and
 * derives them again from the model, so they follow edits to the model and
 * are never declared twice. Every other carried entry is kept, first, and a
 * derived entry never replaces a carried entry with the same refId.
 *
 * Only cdxgen's own analysis is derived: the sections are derived only when
 * the model's `metadata.tools` lists cdxgen with a bom-ref, the rule
 * identityClaimContext applies to cdxgen's identity claims. Another tool's
 * BOM converted with `cdx-convert --to 2.0` gets no derived section.
 */
/** A risk entry renderCycloneDx20 derives (see collectPqcRisks). */
export declare const isDerivedRisk: (risk: any) => boolean;
/** The blueprint renderCycloneDx20 derives (see collectAgentBehaviour). */
export declare const isDerivedBlueprint: (blueprint: any) => boolean;
/** An agent party renderCycloneDx20 derives (see collectAgentBehaviour). */
export declare const isDerivedAgentParty: (party: any) => boolean;
/**
 * Does the model's `metadata.tools` list cdxgen with a bom-ref? The same
 * test decides whether cdxgen's identity claims are written.
 *
 * @param {object} internalBom The 1.x-shaped internal model
 * @returns {boolean} True when cdxgen is a listed tool
 */
export declare function isCdxgenListedTool(internalBom: object): boolean;
/**
 * Derive the 2.0 sections of an internal model; all empty unless cdxgen is a
 * listed tool (isCdxgenListedTool).
 *
 * @param {object} internalBom The 1.x-shaped internal model
 * @returns {{risks: object[], agentParties: object[], blueprints: object[]}}
 */
export declare function deriveCycloneDx20Sections(internalBom: object): {
    risks: object[];
    agentParties: object[];
    blueprints: object[];
};
/**
 * Add the derived risks and blueprint to a rendered document whose carried
 * 2.0 sections are already in place, and return the parties to declare: the
 * carried parties without derived agent parties, then the derived ones.
 *
 * @param {object} out The document being rendered
 * @param {object[]} carriedParties Parties carried from a 2.0 read
 * @param {object} internalBom The internal model the document renders
 * @returns {object[]} The parties to declare before the cdxgen party
 */
export declare function appendDerivedSections(out: object, carriedParties: object[], internalBom: object): object[];
/**
 * Split the derived entries out of a list read from 2.0. An entry that is
 * what the renderer derives again from the read model is dropped without a
 * loss; a derived-looking entry that differs is dropped too (the renderer
 * would replace it), and its index is returned so the reader reports the
 * loss.
 *
 * @param {object[]} entries The 2.0 list (risks, blueprints, parties)
 * @param {object[]} derived What the renderer derives from the read model
 * @param {Function} isDerived Recogniser for derived entries
 * @returns {{kept: object[], differing: number[]}} The entries to carry, and
 *   the indexes of dropped entries that differ from the derivation
 */
export declare function splitDerivedEntries(entries: object[], derived: object[], isDerived: Function): {
    kept: object[];
    differing: number[];
};
//# sourceMappingURL=cyclonedx20Derived.d.ts.map
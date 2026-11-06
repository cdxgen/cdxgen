/**
 * Reader converters for the CycloneDX 2.0 common objects
 * (#/$defs/cyclonedx-common-2.0, #/$defs/cyclonedx-license-2.0,
 * #/$defs/cyclonedx-release-notes-2.0) back to their 1.x shapes. Each frozen
 * spec is the allowlist of the members 1.x carries; anything else is a loss.
 */
/** hash (#/$defs/cyclonedx-common-2.0/$defs/hash) → 1.x hash. */
export declare function reverseHash(ctx: any, value: any, pointer: any): object | undefined;
/** A list of hashes. */
export declare const HASHES_RULE: Readonly<{
    to: any;
    convert: (ctx: any, value: any, pointer: any) => any[] | undefined;
}>;
/** property (#/$defs/cyclonedx-common-2.0/$defs/property) → 1.x property. */
export declare function reverseProperty(ctx: any, value: any, pointer: any): object | undefined;
/** A list of properties. */
export declare const PROPERTIES_RULE: Readonly<{
    to: any;
    convert: (ctx: any, value: any, pointer: any) => any[] | undefined;
}>;
/** externalReference → 1.x externalReference. */
export declare function reverseExternalReference(ctx: any, value: any, pointer: any): object | undefined;
/** A list of external references. */
export declare const EXTERNAL_REFERENCES_RULE: Readonly<{
    to: any;
    convert: (ctx: any, value: any, pointer: any) => any[] | undefined;
}>;
/** attachment: `mediaType` is the 1.x `contentType`. */
export declare function reverseAttachment(ctx: any, value: any, pointer: any): object | undefined;
/** An attachment-valued member. */
export declare const ATTACHMENT_RULE: Readonly<{
    convert: typeof reverseAttachment;
}>;
/** postalAddress (common or party) → 1.x postalAddress. */
export declare function reverseAddress(ctx: any, value: any, pointer: any): object | undefined;
/** organizationalContact → 1.x organizationalContact. */
export declare function reverseContact(ctx: any, value: any, pointer: any): object | undefined;
/** organizationalEntity (common) → 1.x organizationalEntity. */
export declare function reverseEntity(ctx: any, value: any, pointer: any): object | undefined;
/**
 * One licenseChoice entry. A licenseReference (`{ref}`) resolves against
 * definitions.licenses; 1.x has no license references, so the declaration
 * is inlined and the reference itself reported.
 */
export declare function reverseLicenseChoice(ctx: any, value: any, pointer: any): object | undefined;
/** A licenses member. */
export declare const LICENSES_RULE: Readonly<{
    to: any;
    convert: (ctx: any, value: any, pointer: any) => any[] | undefined;
}>;
/**
 * Issues a patch or release resolves. 1.x lists issues only; a reference to a
 * weakness, vulnerability or requirement has no 1.x form.
 */
export declare const RESOLVES_RULE: Readonly<{
    to: any;
    convert: (ctx: any, value: any, pointer: any) => any[] | undefined;
}>;
/**
 * releaseNotes, inline or a releaseNotesReference resolved against
 * definitions.releaseNotes (1.x has no reference form).
 */
export declare function reverseReleaseNotes(ctx: any, value: any, pointer: any): object | undefined;
/** A patentAssertions member; 1.x requires `asserter` and `assertionType`. */
export declare const PATENT_ASSERTIONS_RULE: Readonly<{
    to: any;
    convert: (ctx: any, value: any, pointer: any) => any[] | undefined;
}>;
//# sourceMappingURL=cyclonedx20ReadCommon.d.ts.map
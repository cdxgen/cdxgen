/**
 * Render-side conversion of 1.x components, services and tools to CycloneDX
 * 2.0 components (#/$defs/cyclonedx-component-2.0/$defs/component).
 */
/**
 * Convert license choices: 1.x license objects and expressions may carry
 * `bom-ref`, which the 2.0 licenseDeclaration renames to `refId`
 * (#/$defs/cyclonedx-license-2.0/$defs/licenseDeclaration), and a license
 * `text` is an attachment.
 *
 * @param {object[]} licenses 1.x license choices
 * @param {object} stats Render counters
 * @returns {object[]|undefined} 2.0 license choices
 */
export declare function convertLicenses(licenses: object[], stats: object): object[] | undefined;
/**
 * Convert a 1.x attachment ({contentType, encoding, content}) to the 2.0
 * attachment (#/$defs/cyclonedx-common-2.0/$defs/attachment, `mediaType`
 * instead of `contentType`, `content` required). A content type that is not
 * a media type the 2.0 pattern accepts is counted and left out.
 *
 * @param {object} attachment 1.x attachment
 * @param {object} stats Render counters
 * @param {string} label Counter label of the attachment's position
 * @returns {object|undefined} 2.0 attachment, or undefined without content
 */
export declare function convertAttachment(attachment: object, stats: object, label: string): object | undefined;
/**
 * Convert release notes
 * (#/$defs/cyclonedx-release-notes-2.0/$defs/releaseNotes): the members are
 * the same, but each note's `text` is an attachment and a note requires it.
 *
 * @param {object} releaseNotes 1.x release notes
 * @param {object} stats Render counters
 * @returns {object|undefined} 2.0 release notes
 */
export declare function convertReleaseNotes(releaseNotes: object, stats: object): object | undefined;
/** Map a 1.x free-text data classification onto the 2.0 enum or `{name}`. */
export declare function toDataClassification(classification: any): any;
/**
 * Convert 1.x dataGovernance ({custodians, stewards, owners} of
 * organization-or-contact entries) into the 2.0 array of parties
 * (#/$defs/cyclonedx-data-2.0/$defs/dataGovernance) with the matching roles.
 */
export declare function convertGovernance(governance: any, stats: any): any[] | undefined;
/** Convert 1.x data contents ({attachment, url, properties}). */
export declare function convertDataContents(contents: any, stats: any): {
    attachment: object;
} | undefined;
/**
 * Convert one 1.x component to the 2.0 component shape
 * (#/$defs/cyclonedx-component-2.0/$defs/component). Fields with no 2.0
 * home (`signature`, the deprecated `modified`, …) are counted.
 */
export declare function convertComponent(component: any, stats: any): any;
/**
 * Convert one 1.x service into a 2.0 component of type `service`
 * (#/$defs/cyclonedx-component-2.0/$defs/component/properties/type). The
 * provider becomes a party with the `provider` role. `authenticated`,
 * `x-trust-boundary` and `trustZone` have no 2.0 field; they ride as the
 * cdx:service:* properties of CARRIED_SERVICE_PROPERTIES, after the service's
 * own properties, and the reader turns them back into the 1.x fields.
 */
export declare function convertService(service: any, stats: any): any;
/**
 * Convert metadata.tools: the 1.x {components, services} object, or the
 * legacy 1.5 array. 2.0 tools hold only `components`
 * (#/$defs/cyclonedx-metadata-2.0/$defs/metadata/properties/tools).
 */
export declare function convertTools(tools: any, stats: any): {
    components: any[];
} | undefined;
//# sourceMappingURL=cyclonedx20RenderComponents.d.ts.map
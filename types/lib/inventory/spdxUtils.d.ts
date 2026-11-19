/**
 * Convert an SPDX 3.x JSON-LD document into a CycloneDX-like BOM object.
 *
 * Maps `software_Package` and `software_File` graph elements to components and
 * `dependsOn` relationships to a dependency list. Input that is not SPDX
 * JSON-LD is returned unchanged.
 *
 * A relationship names its elements by `spdxId`, and each one is written out
 * as the bom-ref of the component, which is its purl. The dependency list can
 * therefore be many times the size of the document: the purl a package states
 * once is repeated for every relationship that names the package.
 * `maxResolvedRefLength` bounds the characters written this way for a caller
 * that converts a document it does not trust.
 *
 * @param {Object} bomJson SPDX JSON-LD or CycloneDX-like document
 * @param {Object} [options] Conversion options
 * @param {number} [options.maxResolvedRefLength] Most characters of bom-refs the relationships may resolve to. Unbounded by default
 * @returns {Object} BOM object carrying `components` and `dependencies`
 * @throws {RangeError} When the relationships resolve to more than `maxResolvedRefLength` characters
 */
export declare const toCycloneDxLikeBom: (bomJson: Object, { maxResolvedRefLength }?: {
    maxResolvedRefLength?: number;
}) => Object;
//# sourceMappingURL=spdxUtils.d.ts.map
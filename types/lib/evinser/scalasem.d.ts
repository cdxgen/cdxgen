/**
 * Map Scala semantic-slice used types back to purls and their source locations.
 *
 * Builds a type-to-purl cache from the component `internal:Namespaces`
 * properties, then for each `.scala` entry in the semantic slice records the
 * source file locations where each used type's purl appears.
 *
 * The location of an entry is its key, as the path below the project
 * directory: that is what `analyzeScalaProject` checked to be a file of the
 * project. The entry's own `sourceFile` is free text and is not read. The
 * total size of the recorded locations is bounded; entries that would exceed
 * the bound are skipped and a warning says so.
 *
 * @param {Object[]} components CycloneDX components carrying namespace properties
 * @param {Object} semanticsSlice Parsed Scala semantic slice object keyed by source file
 * @param {string} [projectDir] Project directory the slice keys are relative to; the working directory when omitted
 * @returns {{ purlLocationMap: Object<string, string[]> }} Map of purl to sorted source location arrays
 */
export declare function findPurlLocations(components: Object[], semanticsSlice: Object, projectDir?: string): {
    purlLocationMap: Record<string, string[]>;
};
//# sourceMappingURL=scalasem.d.ts.map
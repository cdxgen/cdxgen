/**
 * Synchronously checks if a file is a valid Electron ASAR archive by sniffing its header.
 *
 * @param {string} archivePath - Path to the file to check
 * @returns {boolean} True if the file has a valid ASAR header, false otherwise
 */
export declare function isAsarArchiveSync(archivePath: string): boolean;
/**
 * Synchronously reads and parses the header of an Electron ASAR archive.
 *
 * @param {string} archivePath - Path to the ASAR archive
 * @returns {Object} Object containing archiveDataOffset, header files node, headerSize, and headerString
 * @throws {Error} If the archive is invalid or header cannot be parsed
 */
export declare function readAsarArchiveHeaderSync(archivePath: string): Object;
/**
 * Synchronously lists all entries (files, directories, symlinks) in an Electron ASAR archive.
 *
 * @param {string} archivePath - Path to the ASAR archive
 * @returns {Object} Object containing the archive header info and list of entries
 * @throws {Error} If the archive is invalid or header parsing fails
 */
export declare function listAsarEntries(archivePath: string): Object;
/**
 * Recursively rewrites paths within component properties and evidence of an extracted archive
 * to use virtual archive paths instead of local temporary extraction paths.
 *
 * @param {Object|Array} subject - The component, array of components, or component graph to rewrite
 * @param {string} extractedDir - The temporary path where the archive was extracted
 * @param {string} archivePath - The original path of the archive
 * @returns {Object|Array} The updated subject with paths rewritten
 */
export declare function rewriteExtractedArchivePaths(subject: Object | any[], extractedDir: string, archivePath: string): Object | any[];
/**
 * Parse an Electron ASAR archive and emit inventory, metadata, and optional
 * signing information.
 *
 * @param {string} archivePath Absolute or relative path to an ASAR archive
 * @param {Object} [options={}] Parse options
 * @param {string} [options.asarVirtualPath] Virtual archive identity to use in
 * BOM references and evidence for nested ASAR recursion
 * @param {number} [options.specVersion] CycloneDX spec version used to choose
 * compatible component types
 * @param {Map<string, Object|null>} [options.asarPlistCache] Per-scan cache of
 * the ElectronAsarIntegrity table of each Electron Info.plist, keyed by path, shared across the archives
 * of one bundle
 * @returns {Promise<Object>} Parsed archive analysis result
 */
export declare function parseAsarArchive(archivePath: string, options?: {
    asarVirtualPath?: string;
    specVersion?: number;
    asarPlistCache?: Map<string, Object | null>;
}): Promise<Object>;
/**
 * Synchronously extracts an Electron ASAR archive to a temporary directory.
 *
 * @param {string} archivePath - Path to the ASAR archive to extract
 * @returns {Promise<string|undefined>} Resolves to the path of the temporary directory, or undefined if extraction fails
 */
export declare function extractAsarToTempDir(archivePath: string): Promise<string | undefined>;
/**
 * Cleans up a temporary directory that was used for ASAR extraction.
 *
 * @param {string} tempDir - Path to the temporary directory to remove
 */
export declare function cleanupAsarTempDir(tempDir: string): void;
/**
 * Builds BOM properties summarizing the extraction status and manifest counts of an ASAR archive.
 *
 * @param {Object} archiveAnalysis - The parsed archive analysis result
 * @param {boolean} extractionPerformed - Whether the extraction was actually executed
 * @returns {Array<Object>} List of CycloneDX component properties
 */
export declare function buildAsarExtractionSummary(archiveAnalysis: Object, extractionPerformed: boolean): Array<Object>;
//# sourceMappingURL=asarutils.d.ts.map
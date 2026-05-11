export function readAsarArchiveHeaderSync(archivePath: any): {
    archiveDataOffset: bigint;
    header: any;
    headerSize: any;
    headerString: any;
};
export function listAsarEntries(archivePath: any): {
    entries: any[];
    archiveDataOffset: bigint;
    header: any;
    headerSize: any;
    headerString: any;
};
export function rewriteExtractedArchivePaths(subject: any, extractedDir: any, archivePath: any): any;
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
 * @returns {Promise<Object>} Parsed archive analysis result
 */
export function parseAsarArchive(archivePath: string, options?: {
    asarVirtualPath?: string | undefined;
    specVersion?: number | undefined;
}): Promise<Object>;
export function extractAsarToTempDir(archivePath: any): Promise<any>;
export function cleanupAsarTempDir(tempDir: any): void;
export function buildAsarExtractionSummary(archiveAnalysis: any, extractionPerformed: any): any[];
//# sourceMappingURL=asarutils.d.ts.map
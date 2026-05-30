/**
 * Convert a GGUF `general.file_type` enumeration value to a stable encoding label.
 *
 * The mapping follows the current `llama_ftype` enumeration used by GGUF writers.
 * Unknown values intentionally return `undefined` so callers can fall back to
 * filename-derived or executor-specific hints.
 *
 * @param {number|string|undefined} fileType numeric GGUF file type value
 * @returns {string|undefined} encoding label such as `Q5_K_M` or `BF16`
 */
export function ggufFileTypeName(fileType: number | string | undefined): string | undefined;
/**
 * Parse a GGUF filename using the upstream naming convention documented by the
 * GGUF specification.
 *
 * The convention is intentionally strict and will return `undefined` for files
 * that do not follow the recommended layout. Callers that need to support older
 * or community-specific names can use this as a first pass and then fall back to
 * project-specific heuristics.
 *
 * @param {string} filePathOrName absolute path or bare filename
 * @returns {Object|undefined} parsed filename details when recognized
 */
export function parseGgufFilename(filePathOrName: string): Object | undefined;
/**
 * Parse GGUF metadata from an in-memory header buffer.
 *
 * @param {Uint8Array|Buffer} buffer GGUF header buffer
 * @returns {Object} parsed metadata map
 */
export function parseGgufMetadataBuffer(buffer: Uint8Array | Buffer): Object;
/**
 * Read selected GGUF metadata keys from a model artifact without loading the whole file.
 *
 * @param {string} filePath GGUF file path
 * @returns {Object|undefined} parsed GGUF metadata
 */
export function readGgufMetadata(filePath: string): Object | undefined;
//# sourceMappingURL=gguf.d.ts.map
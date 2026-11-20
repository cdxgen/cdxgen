/**
 * Read the JSON header of a safetensors file and check it against the format
 * rules: the tensors must tile the byte buffer without holes or overlaps, each
 * tensor's byte range must match its dtype and shape, and the file size must
 * equal the header length plus the buffer length.
 *
 * @param {string} filePath Path to a `.safetensors` file
 * @returns {{ok: true, header: Object}|{ok: false, reason: string}} Parsed
 *   header summary, or the reason the file was rejected
 */
export declare function inspectSafetensors(filePath: string): {
    ok: true;
    header: Object;
} | {
    ok: false;
    reason: string;
};
/**
 * Read and validate the JSON header of a safetensors model file.
 *
 * @param {string} filePath Path to a `.safetensors` file
 * @returns {{
 *   metadata: Object,
 *   metadataKeyCount: number,
 *   format: string|undefined,
 *   tensorCount: number,
 *   dtypes: string[],
 *   totalParameters: number,
 *   dataBytes: number,
 *   unknownDtypeTensors: number,
 * } | undefined} Header summary, or undefined when the file is not a valid
 *   safetensors file
 */
export declare function readSafetensorsHeader(filePath: string): {
    metadata: Object;
    metadataKeyCount: number;
    format: string | undefined;
    tensorCount: number;
    dtypes: string[];
    totalParameters: number;
    dataBytes: number;
    unknownDtypeTensors: number;
} | undefined;
//# sourceMappingURL=safetensors.d.ts.map
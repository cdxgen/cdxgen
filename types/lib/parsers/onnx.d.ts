/**
 * Read the identifying header fields of an ONNX model file and check that they
 * form a plausible ModelProto.
 *
 * Only `ir_version`, `producer_name`, `producer_version`, `domain`,
 * `model_version`, `opset_import` and `metadata_props` are extracted. The graph
 * and every other payload are skipped by offset without being read, so no
 * tensor data is ever loaded and no model code is executed.
 *
 * A file is accepted when every known field uses the wire type the schema
 * gives it, `ir_version` is present and between 1 and 64, every opset version
 * is a non-negative safe integer, and the file names at least one
 * `opset_import` or carries a `graph`.
 *
 * @param {string} filePath Path to the `.onnx` file
 * @returns {{
 *   irVersion: number,
 *   producerName: string,
 *   producerVersion: string,
 *   domain: string,
 *   modelVersion: number,
 *   opsets: Array<{domain: string, version: number}>,
 *   metadataPropsCount: number,
 *   metadataKeys: string[],
 *   hasGraph: boolean,
 * } | undefined} Header summary, or undefined when the file is not an ONNX
 *   model
 */
export declare function readOnnxHeader(filePath: string): {
    irVersion: number;
    producerName: string;
    producerVersion: string;
    domain: string;
    modelVersion: number;
    opsets: Array<{
        domain: string;
        version: number;
    }>;
    metadataPropsCount: number;
    metadataKeys: string[];
    hasGraph: boolean;
} | undefined;
//# sourceMappingURL=onnx.d.ts.map
/**
 * The largest file that `JSON.parse(readFileSync(file, "utf-8"))` can always
 * decode. V8 caps a string at this many UTF-16 code units, and UTF-8 never
 * decodes to more code units than it has bytes.
 */
export declare const MAX_JSON_TEXT_BYTES: any;
/**
 * Locate the value of each member of the top-level object in a JSON file,
 * without decoding any of them.
 *
 * @param {string} filePath JSON file whose top-level value is an object
 * @param {Object} [options] Chunk size override, for tests
 * @returns {Map<string, {start: number, end: number}>} Byte range of each member's value, in file order. A repeated key keeps its last value, as JSON.parse does.
 * @throws {SyntaxError} When the top-level value is not a well-formed object
 */
export declare function indexJsonObject(filePath: string, options?: Object): Map<string, {
    start: number;
    end: number;
}>;
/**
 * Decode one member of the top-level object in a JSON file, reading the file
 * only up to the end of that member. A member near the start of a large file
 * costs a few bounded reads, however large the rest of the file is; the rest
 * is not checked for well-formedness.
 *
 * @param {string} filePath JSON file whose top-level value is an object
 * @param {string} name Member to decode
 * @param {Object} [options] Batch and chunk size overrides, for tests
 * @returns {*} The decoded value, or undefined when the object has no such member
 * @throws {SyntaxError} When the object is malformed before the member ends
 */
export declare function readJsonMember(filePath: string, name: string, options?: Object): any;
/**
 * Decode the JSON value stored in a byte range of a file, without ever holding
 * more than a bounded run of it in one string.
 *
 * `spec` narrows what is kept. `{ members: { name: spec } }` keeps only the
 * named members of an object, each narrowed by its own spec. `{ map }`
 * transforms each element of an array, an undefined result dropping it, and
 * `{ filter }` keeps the mapped elements that `filter(element)` accepts.
 * Anything else keeps the whole value.
 *
 * @param {string} filePath JSON file
 * @param {{start: number, end: number}} range Byte range of the value, such as one returned by indexJsonObject
 * @param {Object} [spec] What to keep
 * @param {Object} [options] Batch and chunk size overrides, for tests
 * @returns {*} The decoded value
 * @throws {SyntaxError} When the value is malformed
 */
export declare function readJsonRange(filePath: string, range: {
    start: number;
    end: number;
}, spec?: Object, options?: Object): any;
/**
 * Parse a JSON file of any size. A file that fits in one string is decoded
 * with JSON.parse, and a larger one is streamed through readJsonRange, so the
 * result is the same either way.
 *
 * @param {string} filePath JSON file
 * @param {Object} [spec] What to keep, as for readJsonRange
 * @param {Object} [options] Size overrides, for tests: maxTextBytes, batchBytes, chunkBytes
 * @returns {*} The decoded value
 * @throws {SyntaxError} When the file is malformed
 */
export declare function readJsonFile(filePath: string, spec?: Object, options?: Object): any;
//# sourceMappingURL=largeJson.d.ts.map
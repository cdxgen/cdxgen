/**
 * Converts a traced library path into a purl subpath. Windows paths
 * ("C:\Windows\System32\bcrypt.dll", "\\server\share\x.dll") use forward
 * slashes and drop the drive or UNC prefix, which a purl subpath cannot carry;
 * the full path stays in the cdx:dynamic:filePath property.
 *
 * @param {string} libPath - Absolute path of the loaded library
 * @returns {string|null} Subpath without leading separators, or null
 */
export declare function librarySubpath(libPath: string): string | null;
/**
 * The largest library file that is hashed.
 *
 * @type {number}
 */
export declare const MAX_TRACED_LIBRARY_BYTES: number;
/**
 * The most bytes hashed for all the libraries of one trace together.
 *
 * @type {number}
 */
export declare const MAX_TRACED_LIBRARIES_TOTAL_BYTES: number;
/**
 * Builds a flat list of CycloneDX component objects and services by executing
 * the given command and inspecting which shared libraries it loads at runtime
 * and which HTTP URLs it accesses.
 *
 * Each component receives:
 *  - type: "library"
 *  - scope: "required"  (loaded at runtime — definitely required)
 *  - hashes: SHA-256 of the on-disk file
 *  - evidence.identity[].methods[].technique: "instrumentation"
 *  - confidence: 0.8 when the OS package manager reports a version, 0.5 otherwise
 *
 * Services are detected from HTTP request URLs collected during tracing and
 * follow the CycloneDX service schema with endpoints.
 *
 * The certificate chains servers presented in TLS ≤ 1.2 handshakes become the
 * shared certificate model, with `provides` edges from the TLS protocol
 * components.
 *
 * @param {string} commandStr - Shell command to execute and trace (e.g. "node --version")
 * @param {string} workingDir - Working directory for the traced process
 * @param {Object} [traceOptions] - Additional sandbox options forwarded to executeAndTrace
 * @returns {Promise<{components: Array<Object>, services: Array<Object>, dependencies: Array<Object>}>} Components, services and dependencies
 */
export declare function buildDynamicComponents(commandStr: string, workingDir: string, traceOptions?: Object): Promise<{
    components: Array<Object>;
    services: Array<Object>;
    dependencies: Array<Object>;
}>;
//# sourceMappingURL=dynamic.d.ts.map
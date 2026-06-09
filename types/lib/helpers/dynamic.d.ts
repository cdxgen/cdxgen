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
 * @param {string} commandStr - Shell command to execute and trace (e.g. "node --version")
 * @param {string} workingDir - Working directory for the traced process
 * @param {Object} [traceOptions] - Additional sandbox options forwarded to executeAndTrace
 * @returns {Promise<{components: Array<Object>, services: Array<Object>}>} Components and services
 */
export function buildDynamicComponents(commandStr: string, workingDir: string, traceOptions?: Object): Promise<{
    components: Array<Object>;
    services: Array<Object>;
}>;
//# sourceMappingURL=dynamic.d.ts.map
/**
 * Parses a command string into command and arguments array.
 * @param {string} cmdStr - Command string to parse
 * @returns {{cmd: string, args: string[]}} Parsed command and arguments
 */
export function parseCommand(cmdStr: string): {
    cmd: string;
    args: string[];
};
/**
 * Custom cdxgen resolver for @cdxgen/safer-exec binary dependency.
 * Validates existence and ensures executable permissions to prevent EACCES issues.
 *
 * @returns {string|undefined} Path to the resolved binary or undefined if not found
 */
export function resolveSaferExecBinary(): string | undefined;
/**
 * Executes a command under safer-exec tracing and returns an array of loaded library paths
 * and collected HTTP access entries.
 *
 * @param {string} commandStr - Command to execute and trace
 * @param {string} [workingDir] - Working directory for the command
 * @param {Object} [options] - Additional sandbox options
 * @param {string[]} [options.readPaths] - Extra filesystem read paths merged with READ_PATHS
 * @param {string[]} [options.writePaths] - Sandbox write paths (default: [tmpdir()])
 * @param {number} [options.maxMemoryMB] - Max memory in MB (default: TRACE_MAX_MEMORY_MB)
 * @param {number} [options.maxProcesses] - Max process count (default: TRACE_MAX_PROCESSES)
 * @param {number} [options.timeoutMs] - Trace timeout in ms (default: TRACE_TIMEOUT_MS)
 * @param {boolean} [options.disableNetwork] - Disable network in sandbox (default: true)
 * @param {boolean} [options.traceHTTPURLs] - Enable eBPF-based HTTP URL tracing (Linux only)
 * @param {number} [options.tracePeriod] - Stop tracing after N seconds (for long-running commands)
 * @returns {Promise<{libPaths: string[], httpAccessEntries: Object[]}>} Collected libraries and HTTP URLs
 */
export function executeAndTrace(commandStr: string, workingDir?: string, options?: {
    readPaths?: string[] | undefined;
    writePaths?: string[] | undefined;
    maxMemoryMB?: number | undefined;
    maxProcesses?: number | undefined;
    timeoutMs?: number | undefined;
    disableNetwork?: boolean | undefined;
    traceHTTPURLs?: boolean | undefined;
    tracePeriod?: number | undefined;
}): Promise<{
    libPaths: string[];
    httpAccessEntries: Object[];
}>;
/**
 * Groups HTTP access entries into a CycloneDX services-ready map.
 * Each unique (host, port, protocol) combination becomes a service.
 *
 * @param {Object[]} httpAccessEntries - Collected HTTP access entries
 * @returns {Object.<string, { endpoints: Set<string>, properties: Object[] }>} Services map
 */
export function groupHttpEntriesToServices(httpAccessEntries: Object[]): {
    [x: string]: {
        endpoints: Set<string>;
        properties: Object[];
    };
};
//# sourceMappingURL=traceRunner.d.ts.map
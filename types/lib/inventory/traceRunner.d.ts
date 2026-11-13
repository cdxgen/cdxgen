/**
 * Whether the @cdxgen/safer-exec tracing runtime could be loaded. When false,
 * dynamic tracing cannot run at all, and every trace would otherwise exit 0
 * with a valid but empty BOM, hiding the broken installation (#4378).
 *
 * @returns {boolean} True when the tracing runtime is available
 */
export declare function isSaferExecAvailable(): boolean;
/**
 * Parses a command string into command and arguments array.
 * @param {string} cmdStr - Command string to parse
 * @returns {{cmd: string, args: string[]}} Parsed command and arguments
 */
export declare function parseCommand(cmdStr: string): {
    cmd: string;
    args: string[];
};
/**
 * Custom cdxgen resolver for @cdxgen/safer-exec binary dependency.
 * Validates existence and ensures executable permissions to prevent EACCES issues.
 *
 * @returns {string|undefined} Path to the resolved binary or undefined if not found
 */
export declare function resolveSaferExecBinary(): string | undefined;
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
 * @param {number} [options.maxCPUCores] - Max CPU cores as fractional number
 * @param {number} [options.maxProcesses] - Max process count (default: TRACE_MAX_PROCESSES)
 * @param {number} [options.timeoutMs] - Trace timeout in ms (default: TRACE_TIMEOUT_MS)
 * @param {boolean} [options.disableNetwork] - Disable network in sandbox (default: true)
 * @param {boolean} [options.traceHTTPURLs] - Enable eBPF-based HTTP URL tracing (Linux only)
 * @param {number} [options.tracePeriod] - Stop tracing after N seconds (for long-running commands)
 * @param {boolean} [options.sanitizeEnv] - Strip sensitive env vars before sandboxed execution
 * @param {boolean} [options.enableDiff] - Enable filesystem mutation diffing
 * @param {boolean} [options.strict] - Treat sandbox setup warnings as hard errors
 * @param {string[]} [options.allowHosts] - Hostnames to allow network access to
 * @param {number[]} [options.allowPorts] - TCP ports to allow
 * @param {string[]} [options.allowUrls] - URL-based allow rules (Linux, requires traceHTTPURLs)
 * @param {boolean} [options.blockFork] - Prevent forking new processes
 * @param {boolean} [options.traceExec] - Log every child process spawned
 * @param {string[]} [options.allowExec] - Executables the command is allowed to run
 * @param {string[]} [options.blockExec] - Executables to block from running
 * @param {boolean} [options.proxyEgress] - Route egress through safer-exec's hostname-pinning proxy (network stays enabled; only allowHosts are reachable)
 * @param {boolean} [options.allowLoopback] - Allow loopback connections
 * @param {boolean} [options.dryRun] - Deny every filesystem and network side effect and collect a dry-run report
 * @param {string} [options.policy] - Named safer-exec ecosystem policy (npm, pypi, maven, ...)
 * @param {string} [options.policyFile] - Path to a safer-exec JSON policy file
 * @param {boolean} [options.blockInterpreters] - Block interpreters with sandbox or task-port exemptions (macOS)
 * @param {boolean} [options.denyPersistenceWrites] - Deny writes to auto-execution and persistence locations
 * @param {boolean} [options.privateTmp] - Private tmpfs /tmp and /var/tmp (Linux)
 * @param {string} [options.protectHome] - Home isolation: read-only, tmpfs, or off (Linux)
 * @returns {Promise<{libPaths: string[], httpAccessEntries: Object[], cryptoEntries?: Object[], cryptoComponents?: Object[], cryptoResult?: Object, egressEntries?: Object[], dryRunSummary?: Object}>} Collected libraries, HTTP URLs, crypto observations, proxy egress decisions, and the dry-run summary
 * @throws {Error} When the @cdxgen/safer-exec tracing runtime is not installed
 *   (for example after pruning it from a standalone payload), or when the
 *   trace itself fails, since the BOM would otherwise silently be empty
 */
export declare function executeAndTrace(commandStr: string, workingDir?: string, options?: {
    readPaths?: string[];
    writePaths?: string[];
    maxMemoryMB?: number;
    maxCPUCores?: number;
    maxProcesses?: number;
    timeoutMs?: number;
    disableNetwork?: boolean;
    traceHTTPURLs?: boolean;
    tracePeriod?: number;
    sanitizeEnv?: boolean;
    enableDiff?: boolean;
    strict?: boolean;
    allowHosts?: string[];
    allowPorts?: number[];
    allowUrls?: string[];
    blockFork?: boolean;
    traceExec?: boolean;
    allowExec?: string[];
    blockExec?: string[];
    proxyEgress?: boolean;
    allowLoopback?: boolean;
    dryRun?: boolean;
    policy?: string;
    policyFile?: string;
    blockInterpreters?: boolean;
    denyPersistenceWrites?: boolean;
    privateTmp?: boolean;
    protectHome?: string;
}): Promise<{
    libPaths: string[];
    httpAccessEntries: Object[];
    cryptoEntries?: Object[];
    cryptoComponents?: Object[];
    cryptoResult?: Object;
    egressEntries?: Object[];
    dryRunSummary?: Object;
}>;
/**
 * A write sink for runPipe() that keeps at most about `limit` bytes of what is
 * written to it: the first and the last half, since the engine prints its
 * set-up warnings first and the error that stopped the run last. Everything
 * in between, which is the traced command's own output, is dropped.
 *
 * @param {number} limit Most bytes to keep
 * @returns {{write: (chunk: Buffer|string) => boolean, text: () => string}} The sink, and the text it kept
 */
export declare function headAndTailSink(limit: number): {
    write: (chunk: Buffer | string) => boolean;
    text: () => string;
};
/**
 * Picks the safer-exec engine's own lines out of the stderr it shares with the
 * traced command. Warnings start with "safer-exec: warning:"; when the engine
 * stops a run, its error is the last other "safer-exec: " line it prints.
 *
 * @param {string} stderr Captured stderr of a safer-exec run
 * @returns {{warnings: string[], error: string|undefined}} Unique engine warnings, and the engine's error if any
 */
export declare function engineMessages(stderr: string): {
    warnings: string[];
    error: string | undefined;
};
/**
 * Extracts the egress proxy's decisions from a safer-exec audit log.
 * "proxy-connect" targets are "host:port"; "proxy-violation" targets are
 * "CONNECT host:port" or "METHOD http://host[:port]/path". Only the authority
 * is kept, never a path or query.
 *
 * @param {Object[]} auditLog - safer-exec audit entries
 * @returns {{host: string, port: number, protocol: string, decision: string}[]} Unique egress decisions
 */
export declare function parseEgressEntries(auditLog: Object[]): {
    host: string;
    port: number;
    protocol: string;
    decision: string;
}[];
/**
 * Groups HTTP access entries into a CycloneDX services-ready map.
 * Each unique (host, port, protocol) combination becomes a service.
 *
 * @param {Object[]} httpAccessEntries - Collected HTTP access entries
 * @returns {Object.<string, { endpoints: Set<string>, properties: Object[] }>} Services map
 */
export declare function groupHttpEntriesToServices(httpAccessEntries: Object[]): Record<string, {
    endpoints: Set<string>;
    properties: Object[];
}>;
//# sourceMappingURL=traceRunner.d.ts.map
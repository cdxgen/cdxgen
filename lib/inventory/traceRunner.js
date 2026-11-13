import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch, platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { thoughtLog } from "../core/logger.js";
import { redactPackageManagerOutput } from "../core/outputRedaction.js";

let SaferExec;

try {
  ({ SaferExec } = await import("@cdxgen/safer-exec"));
} catch {
  SaferExec = undefined;
}

/**
 * Whether the @cdxgen/safer-exec tracing runtime could be loaded. When false,
 * dynamic tracing cannot run at all, and every trace would otherwise exit 0
 * with a valid but empty BOM, hiding the broken installation (#4378).
 *
 * @returns {boolean} True when the tracing runtime is available
 */
export function isSaferExecAvailable() {
  return Boolean(SaferExec);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Most bytes of the traced command's stderr kept in this process. Only the
// engine's own lines are read from it, and those come first and last.
const MAX_KEPT_STDERR_BYTES = 1024 * 1024;

/**
 * Parses a command string into command and arguments array.
 * @param {string} cmdStr - Command string to parse
 * @returns {{cmd: string, args: string[]}} Parsed command and arguments
 */
export function parseCommand(cmdStr) {
  const args = [];
  let current = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;
  for (let i = 0; i < cmdStr.length; i++) {
    const char = cmdStr[i];
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === " " && !inDoubleQuote && !inSingleQuote) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    args.push(current);
  }
  return {
    cmd: args[0],
    args: args.slice(1),
  };
}

/**
 * Custom cdxgen resolver for @cdxgen/safer-exec binary dependency.
 * Validates existence and ensures executable permissions to prevent EACCES issues.
 *
 * @returns {string|undefined} Path to the resolved binary or undefined if not found
 */
export function resolveSaferExecBinary() {
  const currentPlatform = platform();
  const currentArch = arch();
  const isWindows = currentPlatform === "win32";
  let pkgName = "";

  if (currentPlatform === "darwin") {
    if (currentArch === "arm64") {
      pkgName = "@cdxgen/safer-exec-darwin-arm64";
    } else if (currentArch === "x64") {
      pkgName = "@cdxgen/safer-exec-darwin-amd64";
    }
  } else if (currentPlatform === "linux") {
    if (currentArch === "x64") {
      pkgName = "@cdxgen/safer-exec-linux-amd64";
    } else if (currentArch === "arm64") {
      pkgName = "@cdxgen/safer-exec-linux-arm64";
    }
  } else if (isWindows) {
    // The Windows packages ship the MXC executor (wxc-exec.exe) next to the
    // engine, which is where the engine looks for it.
    if (currentArch === "x64") {
      pkgName = "@cdxgen/safer-exec-windows-amd64";
    } else if (currentArch === "arm64") {
      pkgName = "@cdxgen/safer-exec-windows-arm64";
    }
  }

  if (!pkgName) {
    return undefined;
  }

  try {
    const require = createRequire(import.meta.url);
    const mainPkgPath = require.resolve("@cdxgen/safer-exec");

    // Resolve standard pnpm, npm, and yarn physical locations of node_modules relative to resolved package file
    const searchDirs = [];
    let curDir = dirname(mainPkgPath);
    while (curDir && curDir !== dirname(curDir)) {
      if (basename(curDir) === "node_modules") {
        searchDirs.push(curDir);
      }
      const nodeModulesSub = join(curDir, "node_modules");
      if (existsSync(nodeModulesSub)) {
        searchDirs.push(nodeModulesSub);
      }
      curDir = dirname(curDir);
    }

    for (const modulesDir of searchDirs) {
      // Direct structure under node_modules. The Go runtime inside the
      // platform package is bin/safer-exec-rt(.exe); "safer-exec" is the JS
      // dispatcher's npm bin name, not a file on disk.
      const directPath = join(
        modulesDir,
        pkgName,
        "bin",
        isWindows ? "safer-exec-rt.exe" : "safer-exec-rt",
      );
      let realDirectPath;
      try {
        realDirectPath = realpathSync(directPath);
      } catch (_err) {
        realDirectPath = directPath;
      }
      if (existsSync(realDirectPath)) {
        if (!isWindows) {
          try {
            chmodSync(realDirectPath, 0o755);
          } catch (_err) {
            // ignore
          }
        }
        return realDirectPath;
      }
    }
  } catch (err) {
    console.log(
      "[cdxgen trace] error resolving safer-exec package path:",
      err.message,
    );
  }
  return undefined;
}

/**
 * The safer-exec check of whether a host path was readable inside the
 * sandbox of the last run, bound to that run, or undefined when the installed
 * safer-exec has no such check (before 1.3.0). The check returns the real
 * path to read, or null for a path the traced program could not read.
 *
 * @param {Object} exec SaferExec instance that ran the trace
 * @returns {Function|undefined} Path resolver, or undefined
 */
function visiblePathResolver(exec) {
  if (typeof exec?.resolveVisiblePath !== "function") {
    return undefined;
  }
  return (path) => {
    try {
      return exec.resolveVisiblePath(path);
    } catch {
      return null;
    }
  };
}

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
export async function executeAndTrace(commandStr, workingDir, options = {}) {
  const emptyResult = { libPaths: [], httpAccessEntries: [] };
  if (!commandStr) {
    return emptyResult;
  }
  const { cmd, args } = parseCommand(commandStr);
  if (!cmd) {
    return emptyResult;
  }

  thoughtLog(
    `Executing and tracing command: ${cmd} with args: ${args.join(", ")} in dir: ${workingDir || process.cwd()}`,
  );

  if (!SaferExec) {
    throw new Error(
      "Dynamic tracing requires the @cdxgen/safer-exec package, which could not be loaded from this installation. Re-install with optional dependencies enabled, or use the official tracebom standalone binary.",
    );
  }

  const exec = new SaferExec();
  // Policies are applied first so explicit options below take precedence, and
  // outside the try so an unknown policy or unreadable policy file fails the
  // run instead of producing an empty BOM.
  if (options.policy) {
    exec.applyPolicy(options.policy);
  }
  if (options.policyFile) {
    exec.applyPolicyFile(options.policyFile);
  }

  // The CBOM the engine writes when no --cbom path was given; removed once
  // read, whatever the run's outcome.
  let tempCbomPath;
  try {
    if (workingDir) {
      exec.workingDir(workingDir);
    }
    const detectedBinary = resolveSaferExecBinary();
    if (detectedBinary) {
      console.log(
        `[cdxgen trace] detected safer-exec go binary: ${detectedBinary}`,
      );
      exec.binaryPath(detectedBinary);
    }
    exec.traceLibraries().suppressLibLoadStderr(true).enableAudit();

    // Apply sandbox options
    // The egress proxy runs on the host side and must be reachable, so it
    // needs the network enabled (an isolated namespace would bypass it).
    if (
      options.disableNetwork !== false &&
      !options.traceHTTPURLs &&
      !options.proxyEgress
    ) {
      exec.disableNetwork();
    }
    if (options.proxyEgress) {
      if (!options.allowHosts?.length && !options.allowUrls?.length) {
        console.warn(
          "[cdxgen trace] egress proxy enabled without --allow-host: every outbound connection will be denied.",
        );
      }
      exec.proxyEgress();
    }
    if (options.allowLoopback) {
      exec.allowLoopback();
    }
    if (options.dryRun) {
      exec.enableDryRun();
    }
    if (platform() === "win32" && options.blockInterpreters) {
      // safer-exec reports --private-tmp and --protect-home on Windows when a
      // grant defeats them, but --block-interpreters is macOS-only and stays
      // silent (cdxgen/safer-exec#4).
      console.warn(
        "[cdxgen trace] --block-interpreters has no effect on Windows.",
      );
    }
    if (options.blockInterpreters) {
      exec.blockInterpreters();
    }
    if (options.denyPersistenceWrites) {
      exec.denyPersistenceWrites();
    }
    if (options.privateTmp) {
      exec.privateTmp();
    }
    if (options.protectHome && options.protectHome !== "off") {
      exec.protectHome(options.protectHome);
    }
    if (options.readPaths?.length) {
      exec.readPaths(options.readPaths);
    }
    if (options.writePaths?.length) {
      exec.writePaths(options.writePaths);
    }
    if (options.maxMemoryMB != null) {
      exec.maxMemory(options.maxMemoryMB);
    }
    if (options.maxProcesses != null) {
      exec.maxProcesses(options.maxProcesses);
    }
    if (options.maxCPUCores != null) {
      exec.maxCPUCores(options.maxCPUCores);
    }
    if (options.timeoutMs != null) {
      exec.timeout(options.timeoutMs);
    }

    // Sanitize environment
    if (options.sanitizeEnv) {
      exec.sanitizeEnv(true);
    }
    if (options.allowEnvs?.length) {
      exec.allowEnvs(...options.allowEnvs);
    }
    if (options.allowHidden != null) {
      exec.allowHidden(options.allowHidden);
    }
    if (options.allowListen?.length) {
      exec.allowListen(options.allowListen);
    }
    if (options.cryptoProbeMode) {
      exec.cryptoProbeMode(options.cryptoProbeMode);
    }

    // Filesystem diff
    if (options.enableDiff) {
      exec.enableDiff();
    }

    // Strict mode
    if (options.strict) {
      exec.strict();
    }

    // Network allow lists
    if (options.allowHosts?.length) {
      exec.allowHosts(...options.allowHosts);
    }
    if (options.allowPorts?.length) {
      exec.allowPorts(...options.allowPorts);
    }
    if (options.allowUrls?.length) {
      exec.allowUrls(...options.allowUrls);
    }

    // Fork and exec control
    if (options.blockFork) {
      exec.blockFork();
    }
    if (options.traceExec) {
      exec.traceExec();
    }
    if (options.allowExec?.length) {
      exec.allowExec(...options.allowExec);
    }
    if (options.blockExec?.length) {
      exec.blockExec(...options.blockExec);
    }

    // Enable HTTP URL tracing
    if (options.traceHTTPURLs) {
      exec.traceHTTPURLs();
    }

    // Set trace period as timeout to auto-stop long-running commands
    if (options.tracePeriod != null && options.tracePeriod > 0) {
      const periodMs = options.tracePeriod * 1000;
      exec.timeout(periodMs);
    }

    // Collect HTTP URLs and crypto from audit events
    const collectedUrls = [];
    const collectedCrypto = [];
    exec.on("audit", (entry) => {
      if (entry?.type === "http-request") {
        collectedUrls.push(entry);
      } else if (
        entry?.type === "crypto-library" ||
        entry?.type === "crypto-cipher"
      ) {
        collectedCrypto.push(entry);
      }
    });

    if (options.traceCrypto !== false) {
      exec.traceCrypto();
      if (options.cbom) {
        exec.cbom(options.cbom);
      } else {
        tempCbomPath = join(
          tmpdir(),
          `cdxgen-cbom-${Math.random().toString(36).substring(2, 15)}.json`,
        );
        exec.cbom(tempCbomPath);
      }
    }

    // run() would hold everything the traced command prints in this process,
    // outside the sandbox's memory limit, and fail the whole trace once a
    // stream outgrows a string. Its stdout is never read, so it is drained;
    // of its stderr only the engine's own lines are, so a bounded part is kept.
    const stderrSink = headAndTailSink(MAX_KEPT_STDERR_BYTES);
    const result = await exec.runPipe(cmd, args, {
      stdout: null,
      stderr: stderrSink,
    });
    const stderr = stderrSink.text();
    const { warnings, error: engineError } = engineMessages(stderr);
    // Windows records DLL loads through an ETW session, which only an
    // elevated process (or a Performance Log Users member) may start.
    const etwDenied =
      platform() === "win32" &&
      warnings.some(
        (line) =>
          line.includes("DLL tracing:") &&
          line.includes("administrator rights"),
      );
    // The engine's stderr is captured, so a control the sandbox could not
    // apply would otherwise read like one it did.
    for (const line of warnings) {
      if (etwDenied && line.includes("DLL tracing:")) {
        continue;
      }
      console.warn(line);
    }
    if (etwDenied) {
      console.warn(
        "[cdxgen trace] library tracing on Windows needs an elevated prompt (or membership in the Performance Log Users group); the BOM has no library components. Egress services from --proxy-egress are still recorded.",
      );
    }
    if (result && result.exitCode !== 0) {
      if (engineError) {
        console.error(engineError);
        if (options.strict) {
          // Under --strict the sandbox refused the run; an empty BOM would
          // read as a command that loaded nothing.
          throw Object.assign(
            new Error(`Tracing refused under --strict: ${engineError}`),
            { strictRefusal: true },
          );
        }
      } else if (stderr.includes("[safer-exec] Error:")) {
        console.error(
          "Tracing launcher execution failed:",
          redactPackageManagerOutput(stderr.trim()),
        );
      } else {
        // A failing command usually means a partial trace (for example a
        // sandbox denial), so the BOM may be incomplete.
        console.warn(
          `[cdxgen trace] traced command exited with code ${result.exitCode}; the BOM may be incomplete.`,
        );
      }
    }
    if (options.traceHTTPURLs) {
      // eBPF URL tracing needs CAP_BPF/CAP_PERFMON. Surface why it was not
      // available whatever the command's exit code, since the BOM otherwise
      // silently lacks services.
      const httpLines = stderr
        .split("\n")
        .filter(
          (line) =>
            line.includes("http-trace") ||
            line.includes("httptrace") ||
            line.includes("SSL/TLS libraries"),
        );
      if (
        httpLines.some((line) => /warning|not supported|failed/i.test(line))
      ) {
        console.warn(
          "[cdxgen trace] HTTP URL tracing unavailable or degraded (it needs root or CAP_BPF and CAP_PERFMON):",
          httpLines.join("\n"),
        );
      }
    }

    // Without an event source (strace on Linux) a dry run still denies every
    // side effect but reports nothing, which must not read as "no activity".
    let dryRunSummary = result?.dryRun?.summary;
    if (
      options.dryRun &&
      stderr.includes("dry-run cannot capture attempted operations")
    ) {
      console.warn(
        "[cdxgen trace] dry run could not capture attempted operations on this host (install strace or relax ptrace_scope); the BOM records no counts.",
      );
      dryRunSummary = { captured: false };
    }

    // Read and parse CBOM file if temp/explicit path was used
    let cryptoComponents = [];
    const cbomPathToRead = options.cbom || tempCbomPath;
    if (cbomPathToRead && existsSync(cbomPathToRead)) {
      try {
        const cbomData = JSON.parse(readFileSync(cbomPathToRead, "utf8"));
        if (cbomData && Array.isArray(cbomData.components)) {
          cryptoComponents = cbomData.components;
        }
      } catch (err) {
        console.warn("[cdxgen trace] failed to parse CBOM:", err.message);
      }
    }

    // Also collect any http-request entries from the audit log that arrived after event emission
    if (result?.auditLog) {
      const libs = result.auditLog
        .filter((e) => e.type === "lib-load")
        .map((e) => e.target)
        .filter(Boolean);
      const urls = result.auditLog
        .filter((e) => e.type === "http-request")
        .filter(
          (e) =>
            !collectedUrls.some(
              (u) =>
                u.host === e.host && u.path === e.path && u.method === e.method,
            ),
        );
      const cryptoLogs = result.auditLog
        .filter(
          (e) => e.type === "crypto-library" || e.type === "crypto-cipher",
        )
        .filter(
          (e) =>
            !collectedCrypto.some(
              (c) => c.type === e.type && c.name === e.name && c.pid === e.pid,
            ),
        );
      return {
        libPaths: Array.from(new Set(libs)),
        resolveVisiblePath: visiblePathResolver(exec),
        httpAccessEntries: [...collectedUrls, ...urls],
        cryptoEntries: [...collectedCrypto, ...cryptoLogs],
        cryptoComponents,
        // The CRYPTO result from the report channel: the cipher entries carry
        // the certificate chains servers presented (safer-exec ≥ 1.2.0).
        cryptoResult: result?.crypto,
        egressEntries: parseEgressEntries(result.auditLog),
        dryRunSummary,
      };
    }

    return {
      libPaths: [],
      resolveVisiblePath: visiblePathResolver(exec),
      httpAccessEntries: collectedUrls,
      cryptoEntries: collectedCrypto,
      cryptoComponents,
      cryptoResult: result?.crypto,
      egressEntries: [],
      dryRunSummary,
    };
  } catch (err) {
    if (err?.strictRefusal) {
      throw err;
    }
    // A trace that failed must not end as a valid BOM that reads as a
    // command which loaded nothing (#4378); the caller reports the error and
    // fails the run.
    thoughtLog("Tracing command execution failed", err);
    throw new Error(
      `Tracing command execution failed: ${err?.message || err}`,
      { cause: err },
    );
  } finally {
    if (tempCbomPath) {
      try {
        unlinkSync(tempCbomPath);
      } catch (_err) {
        // ignore
      }
    }
  }
}

/**
 * A write sink for runPipe() that keeps at most about `limit` bytes of what is
 * written to it: the first and the last half, since the engine prints its
 * set-up warnings first and the error that stopped the run last. Everything
 * in between, which is the traced command's own output, is dropped.
 *
 * @param {number} limit Most bytes to keep
 * @returns {{write: (chunk: Buffer|string) => boolean, text: () => string}} The sink, and the text it kept
 */
export function headAndTailSink(limit) {
  const half = Math.floor(limit / 2);
  let head = Buffer.alloc(0);
  const tail = [];
  let tailBytes = 0;
  let dropped = false;
  return {
    write(chunk) {
      let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (head.length < half) {
        const taken = data.subarray(0, half - head.length);
        head = Buffer.concat([head, taken]);
        data = data.subarray(taken.length);
      }
      if (data.length) {
        tail.push(data);
        tailBytes += data.length;
        while (tailBytes - tail[0].length >= half) {
          tailBytes -= tail.shift().length;
          dropped = true;
        }
      }
      return true;
    },
    text() {
      // A line cut where bytes were dropped must not join the next one.
      return Buffer.concat([
        head,
        Buffer.from(dropped ? "\n" : ""),
        ...tail,
      ]).toString("utf8");
    },
  };
}

/**
 * Picks the safer-exec engine's own lines out of the stderr it shares with the
 * traced command. Warnings start with "safer-exec: warning:"; when the engine
 * stops a run, its error is the last other "safer-exec: " line it prints.
 *
 * @param {string} stderr Captured stderr of a safer-exec run
 * @returns {{warnings: string[], error: string|undefined}} Unique engine warnings, and the engine's error if any
 */
export function engineMessages(stderr) {
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("safer-exec: "));
  const warnings = [
    ...new Set(lines.filter((line) => line.startsWith("safer-exec: warning:"))),
  ];
  const others = lines.filter(
    (line) => !line.startsWith("safer-exec: warning:"),
  );
  return { warnings, error: others.at(-1) };
}

/**
 * Returns the sorted, de-duplicated parameter names of a query string.
 *
 * @param {string} query - Raw query string, with or without a leading "?"
 * @returns {string} Comma-separated parameter names, or "" when there are none
 */
function queryParameterNames(query) {
  if (!query) {
    return "";
  }
  const names = new Set();
  for (const pair of String(query).replace(/^\?/, "").split("&")) {
    const eqIdx = pair.indexOf("=");
    const name = (eqIdx >= 0 ? pair.substring(0, eqIdx) : pair).trim();
    if (name) {
      names.add(name);
    }
  }
  return Array.from(names).sort().join(",");
}

/**
 * Extracts the egress proxy's decisions from a safer-exec audit log.
 * "proxy-connect" targets are "host:port"; "proxy-violation" targets are
 * "CONNECT host:port" or "METHOD http://host[:port]/path". Only the authority
 * is kept, never a path or query.
 *
 * @param {Object[]} auditLog - safer-exec audit entries
 * @returns {{host: string, port: number, protocol: string, decision: string}[]} Unique egress decisions
 */
export function parseEgressEntries(auditLog) {
  const seen = new Set();
  const entries = [];
  for (const e of auditLog || []) {
    if (e?.type !== "proxy-connect" && e?.type !== "proxy-violation") {
      continue;
    }
    const target = String(e.target || "");
    let authority = target;
    let protocol = "https";
    if (e.type === "proxy-connect") {
      protocol = e.details === "http" ? "http" : "https";
    } else {
      const spaceIdx = target.indexOf(" ");
      authority = spaceIdx >= 0 ? target.substring(spaceIdx + 1) : target;
      const schemeIdx = authority.indexOf("://");
      if (schemeIdx >= 0) {
        protocol = authority.substring(0, schemeIdx);
        authority = authority.substring(schemeIdx + 3);
        const slashIdx = authority.indexOf("/");
        if (slashIdx >= 0) {
          authority = authority.substring(0, slashIdx);
        }
      }
    }
    let host = authority;
    let port = protocol === "http" ? 80 : 443;
    const colonIdx = authority.lastIndexOf(":");
    if (colonIdx > 0 && !authority.endsWith("]")) {
      const parsedPort = Number.parseInt(authority.substring(colonIdx + 1), 10);
      if (!Number.isNaN(parsedPort)) {
        port = parsedPort;
        host = authority.substring(0, colonIdx);
      }
    }
    host = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host) {
      continue;
    }
    const decision = e.type === "proxy-connect" ? "allowed" : "denied";
    const key = `${decision}|${protocol}|${host}|${port}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push({ host, port, protocol, decision });
  }
  return entries;
}

/**
 * Groups HTTP access entries into a CycloneDX services-ready map.
 * Each unique (host, port, protocol) combination becomes a service.
 *
 * @param {Object[]} httpAccessEntries - Collected HTTP access entries
 * @returns {Object.<string, { endpoints: Set<string>, properties: Object[] }>} Services map
 */
export function groupHttpEntriesToServices(httpAccessEntries) {
  const servicesMap = {};
  for (const entry of httpAccessEntries) {
    const serviceName = `dynamic-${entry.host}-${entry.port || 443}`;
    if (!servicesMap[serviceName]) {
      servicesMap[serviceName] = {
        endpoints: new Set(),
        properties: [],
      };
    }
    const scheme = entry.protocol === "http" ? "http" : "https";
    const defaultPort = scheme === "http" ? 80 : 443;
    const endpoint = `${scheme}://${entry.host}${entry.port && entry.port !== defaultPort ? `:${entry.port}` : ""}${entry.path || "/"}`;
    servicesMap[serviceName].endpoints.add(endpoint);
    if (entry.method) {
      const methodProp = {
        name: "cdx:service:httpMethod",
        value: entry.method,
      };
      if (
        !servicesMap[serviceName].properties.some(
          (p) => p.name === methodProp.name && p.value === methodProp.value,
        )
      ) {
        servicesMap[serviceName].properties.push(methodProp);
      }
    }
    // Query values can carry tokens and signatures, so only the parameter
    // names are recorded.
    const queryParams = queryParameterNames(entry.query);
    if (queryParams) {
      const queryProp = {
        name: "cdx:dynamic:httpQueryParams",
        value: queryParams,
      };
      if (
        !servicesMap[serviceName].properties.some(
          (p) => p.name === queryProp.name && p.value === queryProp.value,
        )
      ) {
        servicesMap[serviceName].properties.push(queryProp);
      }
    }
  }
  return servicesMap;
}

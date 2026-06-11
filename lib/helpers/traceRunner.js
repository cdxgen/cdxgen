import { chmodSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { thoughtLog } from "./logger.js";

let SaferExec;

try {
  ({ SaferExec } = await import("@cdxgen/safer-exec"));
} catch {
  SaferExec = undefined;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
      // Direct structure under node_modules
      const directPath = join(modulesDir, pkgName, "bin", "safer-exec");
      let realDirectPath;
      try {
        realDirectPath = realpathSync(directPath);
      } catch (_err) {
        realDirectPath = directPath;
      }
      if (existsSync(realDirectPath)) {
        try {
          chmodSync(realDirectPath, 0o755);
        } catch (_err) {
          // ignore
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
 * @returns {Promise<{libPaths: string[], httpAccessEntries: Object[]}>} Collected libraries and HTTP URLs
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
    return emptyResult;
  }

  try {
    const exec = new SaferExec();
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
    if (options.disableNetwork !== false && !options.traceHTTPURLs) {
      exec.disableNetwork();
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

    // Collect HTTP URLs from audit events
    const collectedUrls = [];
    exec.on("audit", (entry) => {
      if (entry?.type === "http-request") {
        collectedUrls.push(entry);
      }
    });

    const result = await exec.run(cmd, args);
    if (result && result.exitCode !== 0 && result.stderr) {
      if (result.stderr.includes("[safer-exec] Error:")) {
        console.error(
          "Tracing launcher execution failed:",
          result.stderr.trim(),
        );
      }
    } else if (options.traceHTTPURLs && result?.stderr) {
      // Surface eBPF/http-trace warnings even when exit code is 0
      const stderr = result.stderr || "";
      if (
        stderr.includes("http-trace") ||
        stderr.includes("httptrace") ||
        stderr.includes("SSL/TLS libraries")
      ) {
        console.warn("[cdxgen trace] HTTP URL tracing warning:", stderr.trim());
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
      return {
        libPaths: Array.from(new Set(libs)),
        httpAccessEntries: [...collectedUrls, ...urls],
      };
    }

    return {
      libPaths: [],
      httpAccessEntries: collectedUrls,
    };
  } catch (err) {
    console.error("Tracing command execution failed:", err);
  }
  return emptyResult;
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
    const endpoint = `https://${entry.host}${entry.port && entry.port !== 443 ? `:${entry.port}` : ""}${entry.path || "/"}`;
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
    if (entry.query) {
      const queryProp = { name: "cdx:dynamic:httpQuery", value: entry.query };
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

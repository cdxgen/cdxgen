/**
 * cdxrs — JS bridge to the Rust-native CycloneDX BOM tooling binary.
 *
 * This module is the ONLY place that spawns the `cdxrs` binary. It enforces
 * the governing invariant: **no failure mode may abort SBOM generation.**
 * Every failure (missing binary, non-zero exit, timeout, oversized stdout,
 * malformed stdout, version-major mismatch, CDXGEN_RS_DISABLE) logs once at
 * `warn` and returns a sentinel that makes the caller take the JS path.
 *
 * Protocol:
 *   cdxrs <subcommand> --input <file|-> --output <file|-> --format json
 *   stdin/stdout carry JSON; stderr carries newline-delimited JSON log records.
 *   Exit codes: 0 ok, 1 operational failure, 2 bad usage, 3 validation findings.
 *
 * See docs/CDXRS_PROTOCOL.md for the full specification.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

import {
  DEBUG_MODE,
  isDryRun,
  readEnvironmentVariable,
} from "../core/activity.js";
import {
  commandsExecuted,
  isAllowedCommand,
  ownEnvironment,
  safeExistsSync,
} from "../core/fs.js";
import { getDefaultPluginRuntime, resolvePluginBinary } from "./plugins.js";

/**
 * Major version this bridge expects from the cdxrs binary. cdxgen-plugins-bin
 * versions every tool in lockstep, so this moves with
 * `@cdxgen/cdxgen-plugins-bin` in package.json even when cdxrs itself carries
 * no breaking change (4.0.0 is 3.2.0 renumbered by the release).
 */
const CDXRS_VERSION_MAJOR = "4";

/** Default timeout for a cdxrs invocation. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Above this size, in-memory content is spilled to a temp file and passed by
 * path instead of through stdin, per the protocol in docs/CDXRS_PROTOCOL.md.
 */
const MAX_STDIN_BYTES = 32 * 1024 * 1024;

/**
 * V8's maximum string length on 64-bit builds (2^29 − 24). Node exposes no
 * API for it, so it is stated exactly as the runtime's own ERR_STRING_TOO_LONG
 * message does. `Buffer#toString()` throws above it — the crash from issue
 * 4393, where a pnpm workspace's registry fetch crossed the ceiling.
 */
const V8_MAX_STRING_CHARS = 0x1fffffe8;

/**
 * Ceiling on the stdout bytes collected from a cdxrs child. stdout must end up
 * as a single JS string, so a payload above V8's string limit can never be
 * delivered no matter how long the child runs: buffering it only burns memory
 * until the concat throws. Past the ceiling the child is killed and the caller
 * takes the JS path. Counting bytes (never smaller than the decoded character
 * count) keeps the boundary safe for multibyte output.
 */
const DEFAULT_MAX_STDOUT_BYTES = V8_MAX_STRING_CHARS;

/**
 * Resolve the stdout ceiling for a run. CDXGEN_RS_MAX_STDOUT_BYTES lowers (or
 * raises) it — used by tests and by hosts that want the failover earlier.
 *
 * @returns {number} Maximum stdout bytes to collect before failing over.
 */
function maxStdoutBytes() {
  const raw = readEnvironmentVariable("CDXGEN_RS_MAX_STDOUT_BYTES");
  if (!raw) {
    return DEFAULT_MAX_STDOUT_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  console.warn(
    `cdxrs: ignoring malformed CDXGEN_RS_MAX_STDOUT_BYTES "${raw}"; using the default ${DEFAULT_MAX_STDOUT_BYTES} bytes.`,
  );
  return DEFAULT_MAX_STDOUT_BYTES;
}

/** Sentinel returned when the Rust path is unavailable. Callers take JS path. */
export const CDXRS_FALLBACK = Object.freeze({
  ok: false,
  reason: "fallback",
  stdout: "",
  exitCode: null,
});

// Subcommands supported by this bridge. `validate` is spoken by the protocol
// but cdxgen never dispatches it: BOM validation is done in JavaScript.
// See lib/validator/index.js.
const KNOWN_SUBCOMMANDS = new Set(["info", "validate", "fetch"]);

/**
 * Determine whether a subcommand is disabled by env vars or the --no-rust alias.
 *
 * @param {string} subcommand The subcommand name (e.g. "info").
 * @returns {boolean} True when the Rust path should be skipped.
 */
export function cdxrsDisabled(subcommand) {
  const raw = readEnvironmentVariable("CDXGEN_RS_DISABLE") || "";
  if (
    readEnvironmentVariable("CDXGEN_NO_RUST") === "true" ||
    process.argv.includes("--no-rust")
  ) {
    return true;
  }
  if (raw === "all") {
    return true;
  }
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.includes(subcommand);
}

/**
 * Resolve the cdxrs binary path for the current platform.
 *
 * @returns {string|undefined} Path to the binary, or undefined if not found.
 */
export function cdxrsBinaryPath() {
  return resolvePluginBinary("cdxrs", getDefaultPluginRuntime());
}

/**
 * Check whether cdxrs may be used for a subcommand: it must not be disabled,
 * the binary must be present, the run's policies must allow starting it (see
 * `cdxrsMayStart`), and its major version must match.
 *
 * The disable check comes first and is deliberate. Callers gate on this function
 * to decide between the Rust and JS paths, so it has to honour
 * `CDXGEN_RS_DISABLE` / `--no-rust`; otherwise a disabled run still reports (and
 * would still select) Rust, and `--no-rust` becomes a no-op for every caller
 * that does not go through `runCdxrs`.
 *
 * @param {string} [subcommand] Subcommand to check, e.g. "info".
 * @returns {{ available: boolean, version?: string, reason?: string }}
 */
export function cdxrsAvailable(subcommand) {
  if (cdxrsDisabled(subcommand)) {
    return { available: false, reason: "disabled" };
  }
  const binPath = cdxrsBinaryPath();
  if (!binPath || !safeExistsSync(binPath)) {
    return { available: false, reason: "binary-not-found" };
  }
  if (!cdxrsMayStart(binPath)) {
    return { available: false, reason: "blocked-by-policy" };
  }
  const version = probeVersion(binPath);
  if (!version) {
    return { available: false, reason: "version-probe-failed" };
  }
  const major = version.split(".")[0];
  if (major !== CDXRS_VERSION_MAJOR) {
    return {
      available: false,
      version,
      reason: `version-mismatch: expected major ${CDXRS_VERSION_MAJOR}, got ${major}`,
    };
  }
  return { available: true, version };
}

/**
 * Whether the cdxrs binary may be started at all.
 *
 * cdxrs is streamed to and from, so this bridge starts it itself rather than
 * through `safeSpawnSync`. The rules that wrapper applies to every other child
 * process still hold here: a dry run starts nothing, and neither does a run
 * whose `CDXGEN_ALLOWED_COMMANDS` does not list the binary. The allowlist
 * matches the command exactly, so the entry is the binary's full path.
 *
 * @param {string} binPath Path to the cdxrs binary.
 * @returns {boolean} True when the binary may be started.
 */
function cdxrsMayStart(binPath) {
  return !isDryRun && isAllowedCommand(binPath);
}

/**
 * The environment a cdxrs child starts with: the process's own variables
 * without `GITHUB_TOKEN`. Older cdxrs builds send that variable to any GitHub
 * host they are asked for, and newer ones receive a token only per request
 * through the fetch envelope, so no build ever reads it from the environment.
 * Windows variable names are case-insensitive.
 *
 * @returns {Object} Environment for the child process.
 */
function childEnvironment() {
  // Own properties only: spawn() also copies inherited ones into the child.
  const env = ownEnvironment();
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === "GITHUB_TOKEN") {
      delete env[name];
    }
  }
  return env;
}

/** @type {Map<string, Set<string>>} Capabilities per binary path. */
const capabilityCache = new Map();

/**
 * Optional behaviours the cdxrs binary advertises in the `capabilities` list
 * of `cdxrs schema-version`, such as `fetch-github-token`. A binary that
 * predates the list, or that cannot be used at all, has none. The answer is
 * remembered per binary path for the rest of the run.
 *
 * @param {string} [subcommand] Subcommand the capability belongs to, checked
 *   with {@link cdxrsAvailable} first.
 * @returns {Set<string>} Capability names.
 */
export function cdxrsCapabilities(subcommand) {
  if (!cdxrsAvailable(subcommand).available) {
    return new Set();
  }
  const binPath = cdxrsBinaryPath();
  const known = capabilityCache.get(binPath);
  if (known) {
    return known;
  }
  const capabilities = new Set();
  try {
    const result = spawnSync(binPath, ["schema-version"], {
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    if (result.status === 0 && result.stdout) {
      const parsed = JSON.parse(result.stdout.toString());
      if (Array.isArray(parsed?.capabilities)) {
        for (const name of parsed.capabilities) {
          if (typeof name === "string") {
            capabilities.add(name);
          }
        }
      }
    }
  } catch {
    // An older or broken binary advertises nothing.
  }
  capabilityCache.set(binPath, capabilities);
  return capabilities;
}

/**
 * Forget the remembered capabilities, for tests that swap the binary.
 */
export function resetCdxrsCapabilities() {
  capabilityCache.clear();
}

/**
 * Run `cdxrs --version` synchronously and parse the output.
 *
 * Only reached after `cdxrsMayStart`, and always before the subcommand itself
 * is spawned, so this is where the binary joins `commandsExecuted` and the
 * allowlist suggestion printed in debug mode.
 *
 * @param {string} binPath Path to the cdxrs binary.
 * @returns {string|undefined} Version string like "3.0.0", or undefined on failure.
 */
function probeVersion(binPath) {
  commandsExecuted.add(binPath);
  try {
    const result = spawnSync(binPath, ["--version"], {
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    if (result.status !== 0 || !result.stdout) {
      return undefined;
    }
    const match = result.stdout
      .toString()
      .trim()
      .match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Spawn the cdxrs binary, collect stdout/stderr, enforce a timeout, and
 * kill the process group if the child hangs.
 *
 * Every failure mode logs once at `warn` and returns the CDXRS_FALLBACK
 * sentinel so the caller can take the JS path.
 *
 * Pass BOM data one of two ways:
 *   - `content`: an in-memory string/Buffer, fed to the child over stdin with
 *     `--input -`. Content larger than 32 MB is spilled to a temp file and
 *     passed by path instead, per the protocol; the file is always removed.
 *   - `input`: a path to a file already on disk.
 *
 * Passing `content` is the normal case, since cdxgen holds BOMs in memory.
 *
 * Collected stdout is bounded: it must become a single JS string, so a child
 * that would exceed V8's string limit (by default; see
 * CDXGEN_RS_MAX_STDOUT_BYTES) is killed and reported as a fallback instead of
 * crashing the process at the concat.
 *
 * @param {string} subcommand The subcommand to run (e.g. "info").
 * @param {Object} opts
 * @param {string|Buffer} [opts.content] BOM data to feed over stdin.
 * @param {string} [opts.input] Input file path. Defaults to "-" (stdin), which
 *   requires `content`.
 * @param {string[]} [opts.args] Extra arguments to pass.
 * @param {number} [opts.timeoutMs] Timeout in milliseconds.
 * @param {boolean} [opts.secretContent] The content carries a credential, so
 *   it is never spilled to a temp file; above the stdin limit the call falls
 *   back instead.
 * @returns {Promise<{ok: boolean, stdout: string, exitCode: number|null, reason?: string}>}
 */
export async function runCdxrs(subcommand, opts = {}) {
  const {
    content,
    input = "-",
    args = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    secretContent = false,
  } = opts;

  // Guard the easiest way to misuse this function. `--input` is a *path*; a
  // caller that passes BOM JSON there would have it interpreted as a filename
  // (typically surfacing as ENAMETOOLONG from the child), so catch it here
  // rather than letting it look like a cdxrs failure.
  if (input !== "-" && (input.includes("\n") || input.length > 4096)) {
    console.warn(
      "cdxrs: `input` must be a file path; pass in-memory BOM data as `content`. Falling back to JS path.",
    );
    return { ...CDXRS_FALLBACK, reason: "bad-input-arg" };
  }
  if (input === "-" && content === undefined) {
    console.warn(
      "cdxrs: no `content` supplied for stdin input, falling back to JS path.",
    );
    return { ...CDXRS_FALLBACK, reason: "no-input" };
  }

  if (!KNOWN_SUBCOMMANDS.has(subcommand)) {
    console.warn(
      `cdxrs: unknown subcommand "${subcommand}", falling back to JS path.`,
    );
    return { ...CDXRS_FALLBACK, reason: "unknown-subcommand" };
  }

  if (cdxrsDisabled(subcommand)) {
    if (DEBUG_MODE) {
      console.log(
        `cdxrs: subcommand "${subcommand}" disabled via CDXGEN_RS_DISABLE.`,
      );
    }
    return { ...CDXRS_FALLBACK, reason: "disabled" };
  }

  const binPath = cdxrsBinaryPath();
  if (!binPath || !safeExistsSync(binPath)) {
    console.warn("cdxrs: binary not found, falling back to JS path.");
    return { ...CDXRS_FALLBACK, reason: "binary-not-found" };
  }
  if (!cdxrsMayStart(binPath)) {
    if (DEBUG_MODE) {
      console.log(
        `cdxrs: ${binPath} blocked by dry run or CDXGEN_ALLOWED_COMMANDS, falling back to JS path.`,
      );
    }
    return { ...CDXRS_FALLBACK, reason: "blocked-by-policy" };
  }

  const version = probeVersion(binPath);
  if (!version) {
    console.warn("cdxrs: version probe failed, falling back to JS path.");
    return { ...CDXRS_FALLBACK, reason: "version-probe-failed" };
  }
  const major = version.split(".")[0];
  if (major !== CDXRS_VERSION_MAJOR) {
    console.warn(
      `cdxrs: version mismatch (expected major ${CDXRS_VERSION_MAJOR}, got ${version}), falling back to JS path.`,
    );
    return { ...CDXRS_FALLBACK, reason: "version-mismatch" };
  }

  // Resolve how the child will actually receive its input. Content over
  // MAX_STDIN_BYTES goes via a temp file so we never hold a huge payload in a
  // pipe buffer; `spillDir` is cleaned up in the `close`/`error` handlers.
  let effectiveInput = input;
  let stdinContent = content;
  let spillDir;
  if (content !== undefined) {
    const byteLength = Buffer.byteLength(content);
    if (byteLength > MAX_STDIN_BYTES && secretContent) {
      // Content that carries a credential only ever travels over the pipe.
      console.warn(
        "cdxrs: input that carries a credential is too large for stdin, falling back to JS path.",
      );
      return { ...CDXRS_FALLBACK, reason: "stdin-too-large" };
    }
    if (byteLength > MAX_STDIN_BYTES) {
      try {
        spillDir = mkdtempSync(join(tmpdir(), "cdxgen-cdxrs-"));
        const spillPath = join(spillDir, "input.json");
        writeFileSync(spillPath, content);
        effectiveInput = spillPath;
        stdinContent = undefined;
        if (DEBUG_MODE) {
          console.log(
            `cdxrs: input is ${byteLength} bytes (> ${MAX_STDIN_BYTES}), spilled to ${spillPath}.`,
          );
        }
      } catch (err) {
        console.warn(
          `cdxrs: could not spill oversized input to disk (${err.message}), falling back to JS path.`,
        );
        return { ...CDXRS_FALLBACK, reason: "spill-failed" };
      }
    }
  }

  const cleanupSpill = () => {
    if (!spillDir) {
      return;
    }
    try {
      rmSync(spillDir, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp dir must never fail a BOM run.
    }
    spillDir = undefined;
  };

  const fullArgs = [subcommand, "--input", effectiveInput, ...args];
  if (DEBUG_MODE) {
    console.log(`cdxrs: spawning ${binPath} ${fullArgs.join(" ")}`);
  }

  return new Promise((resolve) => {
    let resolved = false;
    let timedOut = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutLimit = maxStdoutBytes();
    let stdoutBytes = 0;
    let stdoutOverflow = false;

    const pluginRuntime = getDefaultPluginRuntime();
    // Which request may carry GITHUB_TOKEN is decided on the JS side, where
    // cdxgen knows whether it composed the URL or read it from the scanned
    // project, so the child never sees the variable.
    const env = childEnvironment();
    if (
      pluginRuntime.extraNMBinPath &&
      !env.PATH?.includes(pluginRuntime.extraNMBinPath)
    ) {
      env.PATH = `${pluginRuntime.extraNMBinPath}${delimiter}${env.PATH}`;
    }

    const child = spawn(binPath, fullArgs, {
      // stdin is a pipe only when we have content to write; otherwise the child
      // reads from a file path and an open stdin would just be a way to hang.
      stdio: [stdinContent === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env,
      // detached: true creates a new process group so we can kill the
      // entire group on timeout, preventing a hung child from outliving us.
      detached: true,
    });

    if (stdinContent !== undefined) {
      // EPIPE is expected if the child exits before draining stdin (e.g. bad
      // usage); it must not become an unhandled error.
      child.stdin.on("error", () => {
        // Intentionally ignored.
      });
      child.stdin.end(stdinContent);
    }

    // Kill the process group (-pid) so any child processes of cdxrs die too.
    // Best effort: the process may have already exited, in which case the
    // close/error handlers take over.
    const killProcessGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (DEBUG_MODE) {
        console.warn(
          `cdxrs: timeout after ${timeoutMs}ms, killing process group.`,
        );
      }
      killProcessGroup();
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (stdoutOverflow) {
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimit) {
        // The payload can never become a deliverable string, so stop
        // buffering, kill the child, and let the close handler fall back.
        stdoutOverflow = true;
        killProcessGroup();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk);
      // Forward NDJSON log records to cdxgen's logger at appropriate levels.
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        forwardLogRecord(line);
      }
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      cleanupSpill();
      console.warn(
        `cdxrs: spawn error: ${err.message}, falling back to JS path.`,
      );
      resolve({ ...CDXRS_FALLBACK, reason: "spawn-error" });
    });

    child.on("close", (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      cleanupSpill();

      if (timedOut) {
        console.warn("cdxrs: timed out, falling back to JS path.");
        resolve({ ...CDXRS_FALLBACK, reason: "timeout" });
        return;
      }

      // Checked before the exit code: the child was killed mid-stream for
      // producing more stdout than can ever be delivered as a string, so even
      // an exit-0 result is an undeliverable truncation (issue 4393).
      if (stdoutOverflow) {
        console.warn(
          `cdxrs: stdout passed ${stdoutLimit} bytes (a string cannot exceed ${V8_MAX_STRING_CHARS} characters), so the child was stopped.`,
        );
        resolve({ ...CDXRS_FALLBACK, reason: "stdout-too-large" });
        return;
      }

      let stdout;
      try {
        stdout = Buffer.concat(stdoutChunks).toString();
      } catch (err) {
        // The byte cap above should make this unreachable; it is kept so that
        // no failure inside this handler can abort SBOM generation.
        console.warn(
          `cdxrs: could not collect child stdout (${err.message}), falling back to JS path.`,
        );
        resolve({ ...CDXRS_FALLBACK, reason: "stdout-collect-failed" });
        return;
      }
      let stderr = "";
      try {
        stderr = Buffer.concat(stderrChunks).toString();
      } catch {
        // stderr carries NDJSON logs, already forwarded as they arrived;
        // dropping the raw tail must not fail a run with valid stdout.
      }

      // For the validate subcommand, exit code 3 means "validation failure
      // with findings on stdout" — the operation succeeded, the BOM just has
      // error-severity findings. That is a successful result, not a fallback.
      // All other non-zero exits are operational failures → fallback.
      const isValidateSuccess = subcommand === "validate" && code === 3;

      if (code !== 0 && !isValidateSuccess) {
        console.warn(
          `cdxrs: non-zero exit ${code} (signal ${signal}), falling back to JS path.`,
        );
        resolve({ ...CDXRS_FALLBACK, reason: `non-zero-exit:${code}` });
        return;
      }

      // Validate that stdout is parseable JSON for subcommands that produce JSON.
      if (
        subcommand === "info" ||
        subcommand === "schema-version" ||
        subcommand === "validate" ||
        subcommand === "fetch"
      ) {
        try {
          JSON.parse(stdout);
        } catch {
          console.warn(
            "cdxrs: malformed stdout (not valid JSON), falling back to JS path.",
          );
          resolve({ ...CDXRS_FALLBACK, reason: "malformed-stdout" });
          return;
        }
      }

      if (DEBUG_MODE) {
        console.log(`cdxrs: "${subcommand}" completed (exit ${code}).`);
      }

      resolve({
        ok: true,
        stdout,
        stderr,
        exitCode: code,
      });
    });
  });
}

/**
 * Forward a stderr NDJSON log record from the cdxrs binary to cdxgen's logger.
 *
 * @param {string} line A single line of stderr output.
 */
function forwardLogRecord(line) {
  try {
    const record = JSON.parse(line);
    const msg = record.msg || record.message || "";
    const level = record.level || "info";
    if (level === "warn" || level === "error") {
      console.warn(`cdxrs: ${msg}`);
    } else if (DEBUG_MODE) {
      console.log(`cdxrs: ${msg}`);
    }
  } catch {
    // Not a JSON log record — ignore (the protocol says stderr carries NDJSON only,
    // but be resilient if a build has a bug).
    if (DEBUG_MODE) {
      console.log(`cdxrs stderr: ${line}`);
    }
  }
}

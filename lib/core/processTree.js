/**
 * Helpers for external commands stopped by cdxgen's spawn timeout.
 *
 * Layer 0: this module imports nothing outside `lib/core`, so both the atom
 * and the dosai runners (layer 2) can share it.
 */

import process from "node:process";

import { DEBUG_MODE } from "./activity.js";
import { safeSpawnSync } from "./fs.js";
import { isWin } from "./paths.js";

/**
 * A duration for a message: seconds to one decimal below a minute, minutes to
 * one decimal from there.
 *
 * @param {number} ms Duration in milliseconds
 * @returns {string} Human-readable duration
 */
export function formatDuration(ms) {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 6_000) / 10;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${Math.round(ms / 100) / 10} seconds`;
}

/**
 * Longest the PowerShell process snapshot behind reapProcessTree may run.
 */
const REAP_TIMEOUT_MS = 60000;

/**
 * Longest reapProcessTree waits for the processes it stopped to exit.
 */
const REAP_EXIT_WAIT_MS = 10000;

/**
 * Block the calling thread for a number of milliseconds.
 *
 * @param {number} ms Milliseconds to wait
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether a process with this pid is still running.
 *
 * @param {number} pid Process id
 * @returns {boolean} true while the process exists
 */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err?.code === "EPERM";
  }
}

/**
 * A UTC instant as a DMTF datetime, the form WQL compares CIM_DATETIME
 * properties such as Win32_Process.CreationDate against.
 *
 * @param {number} ms Epoch milliseconds
 * @returns {string} The instant as `yyyymmddHHMMSS.mmmmmm+000`
 */
export function toDmtfUtc(ms) {
  const date = new Date(ms);
  const pad = (value, width = 2) => `${value}`.padStart(width, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}000+000`;
}

/**
 * Stop the descendants a timed-out run left behind on Windows.
 *
 * The spawn timeout terminates only the process cdxgen spawned, and Windows
 * neither kills nor re-parents its children: a shell's command, a runtime's
 * workers, or the build hosts a .NET analyzer starts keep running while still
 * pointing at the dead process's pid. `taskkill /T` on that pid finds nothing,
 * because the root is already gone. The live descendants are therefore found
 * by parent pid in a PowerShell process snapshot, limited to processes
 * created after the run started, and stopped from Node.js. The root's own
 * children must also predate its end: once the root is gone its pid can be
 * handed to an unrelated process, whose children would otherwise look like
 * the run's. Elsewhere this
 * does nothing: an orphan is re-parented and can no longer be told apart.
 * It returns once the stopped processes have exited, or after ten seconds,
 * so the caller can remove files the run left half-written. When the
 * snapshot itself fails or runs past its time limit it warns and returns an
 * empty list, since processes may then still be running.
 *
 * @param {number|undefined} rootPid pid of the process cdxgen spawned
 * @param {number} startedAt Epoch milliseconds at which the run started
 * @param {number} [endedAt] Epoch milliseconds at which the spawned process ended
 * @param {string} [toolName] Name of the tool, for the debug message
 * @returns {number[]} The pids that were stopped
 */
export function reapProcessTree(
  rootPid,
  startedAt,
  endedAt = Date.now(),
  toolName = "external",
) {
  if (!isWin || !Number.isInteger(rootPid) || rootPid <= 0) {
    return [];
  }
  // All three values are integers, and the DMTF string is built from digits
  // only, so interpolating them cannot inject anything.
  const since = Math.max(0, Math.floor(startedAt) - 1000);
  const until = Math.max(since, Math.floor(endedAt) + 1000);
  const snapshotProperties = "-Property ProcessId,ParentProcessId,CreationDate";
  const script = [
    `$root = ${rootPid}`,
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${since}).UtcDateTime`,
    `$until = [DateTimeOffset]::FromUnixTimeMilliseconds(${until}).UtcDateTime`,
    // WMI drops the processes that predate the run before PowerShell sees
    // them, which keeps the snapshot small on a busy host. The loop below
    // applies the same bound, so a WMI that rejects the filter only costs the
    // full snapshot.
    "$procs = @()",
    `try { $procs = @(Get-CimInstance Win32_Process -Filter "CreationDate >= '${toDmtfUtc(since)}'" ${snapshotProperties} -ErrorAction Stop) }`,
    `catch { $procs = @(Get-CimInstance Win32_Process ${snapshotProperties}) }`,
    "$children = @{}",
    "foreach ($p in $procs) {",
    "  if (-not $p.CreationDate) { continue }",
    "  $created = $p.CreationDate.ToUniversalTime()",
    "  if ($created -lt $since) { continue }",
    "  if ([int]$p.ParentProcessId -eq $root -and $created -gt $until) { continue }",
    "  $children[[int]$p.ParentProcessId] += @([int]$p.ProcessId)",
    "}",
    "$found = [System.Collections.Generic.List[int]]::new()",
    "$queue = [System.Collections.Generic.Queue[int]]::new()",
    "$queue.Enqueue($root)",
    "while ($queue.Count) {",
    "  foreach ($child in @($children[$queue.Dequeue()])) {",
    "    if ($child -and -not $found.Contains($child)) { $found.Add($child); $queue.Enqueue($child) }",
    "  }",
    "}",
    "$found -join ','",
  ].join("\n");
  const result = safeSpawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: REAP_TIMEOUT_MS },
  );
  if (result?.error || result?.status !== 0) {
    // An empty result here is not evidence that nothing was left running.
    console.warn(
      result?.error?.code === "ETIMEDOUT"
        ? `Could not look for processes the timed-out ${toolName} run left behind: the process snapshot took longer than ${formatDuration(REAP_TIMEOUT_MS)}.`
        : `Could not look for processes the timed-out ${toolName} run left behind: PowerShell ${result?.error ? `failed to start (${result.error.message})` : `exited with status ${result?.status}`}.`,
    );
    return [];
  }
  const reaped = `${result?.stdout || ""}`
    .trim()
    .split(",")
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => pid > 0);
  for (const pid of reaped) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process exited between the snapshot and the kill.
    }
  }
  // A process that is still exiting keeps its files open, so wait for the
  // exits, but never longer than REAP_EXIT_WAIT_MS.
  const deadline = Date.now() + REAP_EXIT_WAIT_MS;
  let running = reaped.filter(isRunning);
  while (running.length && Date.now() < deadline) {
    sleepSync(100);
    running = running.filter(isRunning);
  }
  if (running.length) {
    console.warn(
      `${running.length} process(es) the timed-out ${toolName} run left behind were still exiting after ${formatDuration(REAP_EXIT_WAIT_MS)}: ${running.join(", ")}.`,
    );
  }
  if (DEBUG_MODE) {
    console.log(
      reaped.length
        ? `Stopped ${reaped.length} process(es) the timed-out ${toolName} run left behind: ${reaped.join(", ")}.`
        : `The timed-out ${toolName} run left no processes behind.`,
    );
  }
  return reaped;
}

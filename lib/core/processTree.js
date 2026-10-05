/**
 * Helpers for external commands stopped by cdxgen's spawn timeout.
 *
 * Layer 0: this module imports nothing outside `lib/core`, so both the atom
 * and the dosai runners (layer 2) can share it.
 */

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
 * Stop the descendants a timed-out run left behind on Windows.
 *
 * The spawn timeout terminates only the process cdxgen spawned, and Windows
 * neither kills nor re-parents its children: a shell's command, a runtime's
 * workers, or the build hosts a .NET analyzer starts keep running while still
 * pointing at the dead process's pid. `taskkill /T` on that pid finds nothing,
 * because the root is already gone. The live descendants are therefore found
 * by parent pid in a process snapshot and stopped, limited to processes
 * created after the run started. The root's own children must also predate
 * its end: once the root is gone its pid can be handed to an unrelated
 * process, whose children would otherwise look like the run's. Elsewhere this
 * does nothing: an orphan is re-parented and can no longer be told apart.
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
  // All three values are integers, so interpolating them cannot inject anything.
  const since = Math.max(0, Math.floor(startedAt) - 1000);
  const until = Math.max(since, Math.floor(endedAt) + 1000);
  const script = [
    `$root = ${rootPid}`,
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${since}).UtcDateTime`,
    `$until = [DateTimeOffset]::FromUnixTimeMilliseconds(${until}).UtcDateTime`,
    "$children = @{}",
    "foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate) {",
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
    "foreach ($child in $found) { Stop-Process -Id $child -Force -ErrorAction SilentlyContinue }",
    "$found -join ','",
  ].join("\n");
  const result = safeSpawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 60000 },
  );
  const reaped = `${result?.stdout || ""}`
    .trim()
    .split(",")
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => pid > 0);
  if (DEBUG_MODE) {
    console.log(
      reaped.length
        ? `Stopped ${reaped.length} process(es) the timed-out ${toolName} run left behind: ${reaped.join(", ")}.`
        : `The timed-out ${toolName} run left no processes behind.`,
    );
  }
  return reaped;
}

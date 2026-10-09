/**
 * Helpers for external commands stopped by cdxgen's spawn timeout.
 *
 * Layer 0: this module imports nothing outside `lib/core`, so both the atom
 * and the dosai runners (layer 2) can share it.
 */
/**
 * A duration for a message: seconds to one decimal below a minute, minutes to
 * one decimal from there.
 *
 * @param {number} ms Duration in milliseconds
 * @returns {string} Human-readable duration
 */
export declare function formatDuration(ms: number): string;
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
export declare function reapProcessTree(rootPid: number | undefined, startedAt: number, endedAt?: number, toolName?: string): number[];
//# sourceMappingURL=processTree.d.ts.map
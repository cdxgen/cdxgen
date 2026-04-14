/**
 * Logs a thought message to the think logger if THINK_MODE is enabled.
 * Automatically appends a period to the message if it lacks terminal punctuation.
 *
 * @param {string} s The thought message to log
 * @param {Object} [args] Optional additional arguments to log alongside the message
 * @returns {void}
 */
export function thoughtLog(s: string, args?: Object): void;
/**
 * Closes the think log group by emitting the closing `</think>` marker.
 * Has no effect if THINK_MODE is not enabled.
 *
 * @returns {void}
 */
export function thoughtEnd(): void;
/**
 * Log trace messages
 *
 * @param {String} traceType Trace type
 * @param {Object} args Additional arguments
 */
export function traceLog(traceType: string, args: Object): void;
export const THINK_MODE: any;
export const TRACE_MODE: any;
//# sourceMappingURL=logger.d.ts.map
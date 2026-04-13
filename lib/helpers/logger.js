import { Console } from "node:console";
import fs from "node:fs";
import process from "node:process";

import colors from "yoctocolors";

// Enable think mode
export const THINK_MODE =
  process.env.CDXGEN_THOUGHT_LOG ||
  ["true", "1"].includes(process.env.CDXGEN_THINK_MODE) ||
  process.env.CDXGEN_DEBUG_MODE === "verbose";

const thinkOutput = process.env.CDXGEN_THOUGHT_LOG
  ? fs.createWriteStream(process.env.CDXGEN_THOUGHT_LOG)
  : process.stdout;
const thinkErrorOutput = process.env.CDXGEN_THOUGHT_LOG
  ? fs.createWriteStream(process.env.CDXGEN_THOUGHT_LOG)
  : process.stderr;
const thinkLogger = new Console({
  stdout: thinkOutput,
  stderr: thinkErrorOutput,
  colorMode: process.env.CDXGEN_THOUGHT_LOG ? false : "auto",
});

// Enable trace mode
export const TRACE_MODE =
  process.env.CDXGEN_TRACE_LOG ||
  process.env.CDXGEN_TRACE_ID ||
  ["true", "1"].includes(process.env.CDXGEN_TRACE_MODE) ||
  process.env.CDXGEN_DEBUG_MODE === "verbose";

const traceOutput = process.env.CDXGEN_TRACE_LOG
  ? fs.createWriteStream(process.env.CDXGEN_TRACE_LOG)
  : process.stdout;
const traceErrorOutput = process.env.CDXGEN_TRACE_LOG
  ? fs.createWriteStream(process.env.CDXGEN_TRACE_LOG)
  : process.stderr;
const traceLogger = new Console({
  stdout: traceOutput,
  stderr: traceErrorOutput,
  colorMode: process.env.CDXGEN_TRACE_LOG ? false : "auto",
});

if (THINK_MODE) {
  thinkLogger.group(colorizeText("<think>"));
}
/**
 * Logs a thought message to the think logger if THINK_MODE is enabled.
 * Automatically appends a period to the message if it lacks terminal punctuation.
 *
 * @param {string} s The thought message to log
 * @param {Object} [args] Optional additional arguments to log alongside the message
 * @returns {void}
 */
export function thoughtLog(s, args) {
  if (!THINK_MODE) {
    return;
  }
  if (!s?.endsWith(".") && !s?.endsWith("?") && !s?.endsWith("!")) {
    s = `${s}.`;
  }
  s = s.replaceAll("'.'", "'<project dir>'");
  if (args) {
    thinkLogger.log(colorizeText(`${s}`), args);
  } else {
    thinkLogger.log(colorizeText(`${s}`));
  }
}
/**
 * Closes the think log group by emitting the closing `</think>` marker.
 * Has no effect if THINK_MODE is not enabled.
 *
 * @returns {void}
 */
export function thoughtEnd() {
  if (THINK_MODE) {
    thinkLogger.groupEnd();
    thinkLogger.log(colorizeText("</think>"));
  }
}

function colorizeText(s) {
  if (process.env.CDXGEN_THOUGHT_LOG) {
    return s;
  }
  s = s.replace(/(\d+)/g, colors.cyanBright("$1"));
  return colors.dim(s);
}

/**
 * Log trace messages
 *
 * @param {String} traceType Trace type
 * @param {Object} args Additional arguments
 */
export function traceLog(traceType, args) {
  if (!TRACE_MODE || !traceType || !args) {
    return;
  }
  const traceId = process.env.CDXGEN_TRACE_ID;
  const message = {};
  if (traceId) {
    message.traceId = traceId;
  }
  message["timestamp"] = new Date().toISOString();
  if (traceType) {
    message.type = traceType;
  }
  if (args) {
    for (const k of [
      "command",
      "cwd",
      "protocol",
      "host",
      "path",
      "pathname",
    ]) {
      if (args[k]) {
        message[k] = args[k];
      }
    }
  }
  if (Object.keys(message).length) {
    traceLogger.log(JSON.stringify(message, null, null));
  }
}

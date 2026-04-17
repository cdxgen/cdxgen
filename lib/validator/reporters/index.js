/**
 * Reporter registry — dispatches to the requested reporter.
 *
 * Reporters are intentionally kept as independent modules so they can also be
 * consumed by the BOM audit engine or future validators.
 */

import * as annotations from "./annotations.js";
import * as consoleReporter from "./console.js";
import * as json from "./json.js";
import * as sarif from "./sarif.js";

/**
 * Map of reporter name → module.
 */
export const reporters = {
  console: consoleReporter,
  json,
  sarif,
  annotations,
};

/**
 * Render a validation report using the named reporter.
 *
 * @param {string} name   Reporter identifier.
 * @param {object} report Output of validateBomAdvanced().
 * @param {object} [opts] Reporter-specific options.
 * @returns {string}
 */
export function render(name, report, opts) {
  const reporter = reporters[(name || "console").toLowerCase()];
  if (!reporter) {
    throw new Error(
      `Unknown reporter '${name}'. Expected one of: ${Object.keys(reporters).join(", ")}.`,
    );
  }
  return reporter.render(report, opts);
}

export { annotations, consoleReporter as console, json, sarif };

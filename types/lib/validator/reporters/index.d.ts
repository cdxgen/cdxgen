/**
 * Render a validation report using the named reporter.
 *
 * @param {string} name   Reporter identifier.
 * @param {object} report Output of validateBomAdvanced().
 * @param {object} [opts] Reporter-specific options.
 * @returns {string}
 */
export function render(name: string, report: object, opts?: object): string;
export namespace reporters {
    export { consoleReporter as console };
    export { json };
    export { sarif };
    export { annotations };
}
import * as consoleReporter from "./console.js";
import * as json from "./json.js";
import * as sarif from "./sarif.js";
import * as annotations from "./annotations.js";
export { annotations, consoleReporter as console, json, sarif };
//# sourceMappingURL=index.d.ts.map
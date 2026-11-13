/**
 * Record a CI file that a parser could not analyse, so that a BOM audit can
 * tell an empty result from a file it never read. A secure-mode audit fails
 * on any recorded file.
 *
 * @param {string} parserId Parser id, such as `github-actions`
 * @param {string} file Path of the file
 * @param {unknown} error Error the parser raised
 * @returns {void}
 */
export declare function recordCiParseFailure(parserId: string, file: string, error: unknown): void;
/**
 * The CI files of this run that a parser could not analyse.
 *
 * @returns {{parserId: string, file: string, reason: string}[]} One entry
 *   per failure, in the order they happened
 */
export declare function getCiParseFailures(): {
    parserId: string;
    file: string;
    reason: string;
}[];
/**
 * Forget the recorded CI parse failures.
 *
 * @returns {void}
 */
export declare function resetCiParseFailures(): void;
/**
 * The largest CI configuration file read. A larger file is skipped.
 *
 * @type {number}
 */
export declare const MAX_CI_FILE_BYTES: number;
/**
 * Read a CI configuration file found in the scanned tree. The file must be a
 * regular file no larger than MAX_CI_FILE_BYTES that resolves inside rootDir,
 * so a symbolic link out of the tree is not followed.
 *
 * @param {string} f path of the file
 * @param {string} [rootDir] scanned project root
 * @returns {string} the text
 * @throws {Error} when the file cannot be read under those rules
 */
export declare function readCiFile(f: string, rootDir?: string): string;
/**
 * Ensure all step objects in the array are unique (CycloneDX `uniqueItems: true`).
 *
 * Identical steps are disambiguated by appending a ` (N)` counter to the step name.
 * The first occurrence is always left unchanged.
 *
 * @param {Object[]} steps
 * @returns {Object[]|undefined}
 */
export declare function disambiguateSteps(steps: Object[]): Object[] | undefined;
/**
 * Sanitize, in place, the text a formulation parser copied from a scanned
 * file: the names, descriptions and properties of its workflows, tasks,
 * steps, components and services, and the commands of its steps. URL
 * userinfo, queries and fragments are removed and known token shapes are
 * redacted, as in every other BOM property. Commands, step names and
 * `*:command` properties also lose credential values passed as literal
 * arguments (see redactCommandCredentials()). Identifiers such as `bom-ref`,
 * `purl` and `version` are left alone.
 *
 * @param {Object} result Parser result with workflows, components, services and properties
 * @returns {Object} The same result
 */
export declare function sanitizeFormulationResult(result: Object): Object;
//# sourceMappingURL=common.d.ts.map
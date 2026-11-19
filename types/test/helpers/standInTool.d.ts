export declare const isWin: boolean;
/**
 * Write a stand-in for `name` into `binDir`.
 *
 * @param {string} binDir Directory to put first on PATH
 * @param {string} name Tool name without extension
 * @param {string} marker File each run appends its arguments to
 * @param {Object} [opts]
 * @param {number} [opts.exitCode] Exit status of the stand-in (default 1)
 * @param {string} [opts.stdout] Text the stand-in prints
 * @returns {string} Path of the stand-in
 */
export declare function writeStandInTool(binDir: string, name: string, marker: string, opts?: {
    exitCode?: number;
    stdout?: string;
}): string;
/**
 * The argument lines a stand-in recorded, or an empty list when it never ran.
 *
 * @param {string} marker Marker file of the stand-in
 * @returns {string[]} One entry per run
 */
export declare function standInRuns(marker: string): string[];
//# sourceMappingURL=standInTool.d.ts.map
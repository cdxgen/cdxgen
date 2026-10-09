/**
 * Shared plumbing for plugin (rusi/golem/kosi) invocations: resolving the
 * directory to analyze, and reporting a failed run.
 */
/**
 * The working directory, when a relative source argument names it.
 *
 * cdxgen is frequently launched with its working directory already set to the
 * project (depscan does exactly that) while the path argument stays relative
 * to some repository root, e.g. cwd `/work/repo/test/data/app` with argument
 * `test/data/app`. A plain `path.resolve` then produces the doubled
 * `/work/repo/test/data/app/test/data/app`. This recognises that shape and
 * nothing looser: the argument's path segments must be the trailing segments
 * of the working directory, so a mistyped argument run from some other
 * project is never silently redirected to that project.
 *
 * @param {string} src The source path as the caller typed it.
 * @param {string} [cwd] Working directory; defaults to `process.cwd()`.
 * @returns {string|undefined} The absolute working directory when the
 *   argument names it, otherwise undefined.
 */
export declare function cwdNamedByRelativeSource(src: string, cwd?: string): string | undefined;
/**
 * Resolve the source path argument once, at cdxgen's entry point.
 *
 * Everything downstream — the BOM generators, evinse, and the rusi/golem/kosi
 * launchers — resolves the argument against the working directory, so the
 * doubled-directory shape has to be corrected before any of them run;
 * correcting it only in the plugin launchers leaves the main BOM built from a
 * directory that does not exist.
 *
 * @param {string} src The source path as the caller typed it.
 * @param {string} [cwd] Working directory; defaults to `process.cwd()`.
 * @returns {{path: string, rewritten: boolean, missing: boolean}} `path` is
 *   the argument to use: unchanged when it resolves to an existing path, the
 *   working directory when the argument names it (`rewritten`), and otherwise
 *   unchanged with `missing` set.
 */
export declare function resolveSourcePathArgument(src: string, cwd?: string): {
    path: string;
    rewritten: boolean;
    missing: boolean;
};
/**
 * Resolve the directory a plugin should analyze.
 *
 * The entry point already corrects the doubled-directory shape (see
 * resolveSourcePathArgument); this is the same rule for callers that reach a
 * plugin launcher directly (evinse, the library API). An existing directory
 * wins and an absolute path is never rewritten. Otherwise the working
 * directory is used only when the argument names it AND it carries the
 * project marker the plugin needs (a `Cargo.toml` for rusi, a `go.mod` for
 * golem). Anything else keeps the resolved path so the plugin's own error
 * names the directory that was actually attempted.
 *
 * @param {string} src The source path as the caller typed it.
 * @param {string[]} markerFiles File names that, present in the working
 *   directory, identify it as the project the plugin should analyze.
 * @returns {string} The directory to pass to the plugin.
 */
export declare function resolvePluginSourceDir(src: string, markerFiles?: string[]): string;
/**
 * Report a failed plugin run, keeping the two failure classes apart.
 *
 * A spawn error means the plugin binary itself could not run — not installed,
 * not executable, blocked by the command policy — which is an installation
 * problem. A non-zero exit status or a missing report means the plugin ran
 * and the analysis failed, which must not be dressed up as an installation
 * problem: the message names the directory and says the reachability
 * evidence will be missing, because a silent degradation is what let a
 * doubled `--dir` go unnoticed in the first place.
 *
 * Under `--fail-on-error` the failure additionally claims the process exit
 * status through the deferred-exit contract.
 *
 * @param {Object} run What ran and how it failed.
 * @param {string} run.tool Plugin name, e.g. "rusi".
 * @param {string} run.ecosystem Ecosystem the plugin serves, e.g. "rust".
 * @param {string} run.executable The binary that was invoked.
 * @param {string[]} run.args The arguments it was invoked with.
 * @param {string} run.dir The directory that was analyzed.
 * @param {Object} run.result The spawn result.
 * @param {string} run.outputFile The report file the plugin should have written.
 * @param {Object} [run.options] CLI options, for the `--fail-on-error` contract.
 * @returns {void}
 */
export declare function reportPluginRunFailure({ tool, ecosystem, executable, args, dir, result, outputFile, options, }: {
    tool: string;
    ecosystem: string;
    executable: string;
    args: string[];
    dir: string;
    result: Object;
    outputFile: string;
    options?: Object;
}): void;
//# sourceMappingURL=pluginRun.d.ts.map
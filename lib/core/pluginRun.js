/**
 * Shared plumbing for plugin (rusi/golem/kosi) invocations: resolving the
 * directory to analyze, and reporting a failed run.
 */

import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import process from "node:process";

import { DEBUG_MODE } from "./activity.js";
import { deferFailOnError } from "./deferredExit.js";
import { safeExistsSync } from "./fs.js";

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
export function cwdNamedByRelativeSource(src, cwd = process.cwd()) {
  if (typeof src !== "string" || !src || isAbsolute(src)) {
    return undefined;
  }
  // normalize() converts separators to the platform's, so one split on sep
  // handles both "a/b" and "a\\b" on Windows; on POSIX a backslash is an
  // ordinary file-name character and must not split.
  const relParts = normalize(src)
    .split(sep)
    .filter((part) => part && part !== ".");
  if (!relParts.length || relParts.includes("..")) {
    return undefined;
  }
  const absCwd = resolve(cwd);
  const cwdParts = absCwd.split(sep).filter(Boolean);
  if (relParts.length > cwdParts.length) {
    return undefined;
  }
  const tail = cwdParts.slice(cwdParts.length - relParts.length);
  const caseInsensitive = process.platform === "win32";
  const same = (a, b) =>
    caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
  return relParts.every((part, i) => same(part, tail[i])) ? absCwd : undefined;
}

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
export function resolveSourcePathArgument(src, cwd = process.cwd()) {
  if (typeof src !== "string" || !src) {
    return { path: src, rewritten: false, missing: false };
  }
  if (safeExistsSync(resolve(cwd, src))) {
    return { path: src, rewritten: false, missing: false };
  }
  const named = cwdNamedByRelativeSource(src, cwd);
  if (named) {
    return { path: named, rewritten: true, missing: false };
  }
  return { path: src, rewritten: false, missing: true };
}

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
export function resolvePluginSourceDir(src, markerFiles = []) {
  const resolved = resolve(src);
  if (safeExistsSync(resolved) || isAbsolute(src)) {
    return resolved;
  }
  const cwd = cwdNamedByRelativeSource(src);
  if (!cwd) {
    return resolved;
  }
  for (const marker of markerFiles) {
    if (marker && safeExistsSync(join(cwd, marker))) {
      console.error(
        `Resolved source directory ${resolved} does not exist; the working directory ${cwd} is the project the argument names (found ${marker}), using it instead.`,
      );
      return cwd;
    }
  }
  return resolved;
}

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
export function reportPluginRunFailure({
  tool,
  ecosystem,
  executable,
  args,
  dir,
  result,
  outputFile,
  options,
}) {
  const command = `${executable} ${(args || []).join(" ")}`.trim();
  if (result?.error) {
    console.error(
      `${tool} plugin could not be executed for ${dir}: ${result.error.message}. Check if the ${tool} plugin was installed successfully.`,
    );
  } else {
    const status =
      typeof result?.status === "number" ? result.status : "unknown";
    const reason = safeExistsSync(outputFile)
      ? "exited unsuccessfully"
      : "wrote no report";
    console.error(
      `${tool} analysis ${reason} for directory ${dir} (exit status ${status}); ${ecosystem} reachability evidence will be missing from the BOM.`,
    );
  }
  if (DEBUG_MODE && (result?.stdout || result?.stderr)) {
    console.error(result.stdout, result.stderr);
  }
  deferFailOnError(options, {
    ecosystem,
    tool,
    detail: result?.error
      ? `${tool} plugin could not be executed: ${result.error.message}`
      : `${tool} analysis failed for directory ${dir}`,
    exitCode: typeof result?.status === "number" ? result.status : undefined,
    command,
  });
}

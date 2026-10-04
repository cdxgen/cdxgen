/**
 * Shared plumbing for plugin (rusi/golem/kosi) invocations: resolving the
 * directory to analyze, and reporting a failed run.
 */

import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

import { DEBUG_MODE } from "./activity.js";
import { deferFailOnError } from "./deferredExit.js";
import { safeExistsSync } from "./fs.js";

/**
 * Resolve the directory a plugin should analyze.
 *
 * cdxgen is frequently launched with its working directory already set to the
 * project (depscan does exactly that) while the path argument stays relative
 * to some repository root. A plain `path.resolve(src)` then joins the two and
 * produces `<project>/<repo-root-relative-arg>` — a directory that does not
 * exist — which the plugin dutifully fails on. Resolving the argument for a
 * plugin therefore has to check the result against the filesystem: an
 * existing directory wins, and when the join landed nowhere, the working
 * directory itself is the next candidate, but only when it carries the
 * project marker the plugin needs (a `Cargo.toml` for rusi, a `go.mod` for
 * golem). Anything else keeps the resolved path so the plugin's own error
 * names the directory that was actually attempted.
 *
 * @param {string} src The source path as the caller typed it.
 * @param {string[]} markerFiles File names that, present in the working
 *   directory, identify it as the project the plugin should analyze.
 * @returns {string} The resolved directory: the argument joined onto the
 *   working directory when that exists, the working directory itself when the
 *   join landed on a missing directory but the working directory carries a
 *   project marker, and otherwise the plain resolution (kept so a failure
 *   reports the directory that was really tried).
 */
export function resolvePluginSourceDir(src, markerFiles = []) {
  const resolved = resolve(src);
  if (safeExistsSync(resolved) || isAbsolute(src)) {
    return resolved;
  }
  const cwd = process.cwd();
  for (const marker of markerFiles) {
    if (marker && safeExistsSync(join(cwd, marker))) {
      console.error(
        `Resolved source directory ${resolved} does not exist; using the working directory ${cwd} (found ${marker}) instead.`,
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

/**
 * Policy for running the scanned project's own build tooling.
 *
 * Build tools such as Maven, Gradle, Poetry, MSBuild, SwiftPM, Leiningen and
 * CocoaPods read configuration or run code that ships with the project
 * (`.mvn/jvm.config`, `.poetry/plugins`, `Directory.Build.rsp`, `Package.swift`,
 * `project.clj`, podspecs). Running them on an untrusted project runs that
 * project's code, so they belong to the same surface as dependency
 * installation and are skipped whenever installation is disabled.
 */
import { isSecureMode, readEnvironmentVariable } from "./activity.js";
import { recordDegradation } from "./buildLedger.js";

/**
 * Whether secure mode is on right now. `isSecureMode` is read once when the
 * modules load, but the `cdxgen-secure` command turns secure mode on later,
 * by setting CDXGEN_SECURE_MODE before the scan starts.
 *
 * @returns {boolean} true when secure mode is on
 */
export function isSecureModeActive() {
  return (
    isSecureMode ||
    ["true", "1"].includes(readEnvironmentVariable("CDXGEN_SECURE_MODE"))
  );
}

/**
 * Whether the scan may install the scanned project's dependencies with an
 * installer that cdxgen starts unless told not to, such as `rush install` or
 * `pipenv install`.
 *
 * Follows `options.installDeps`, which defaults to off in secure mode when a
 * caller does not set it. The command line and the server always set the
 * option; an application that calls `createBom` may leave it out. Unlike
 * `isProjectToolingAllowed`, introspection does not turn installation back
 * on.
 *
 * @param {Object} [options] CLI options
 * @returns {boolean} true when dependencies may be installed
 */
export function isDependencyInstallAllowed(options) {
  const installDeps = options?.installDeps ?? !isSecureModeActive();
  return installDeps !== false;
}

/**
 * Whether the scan may run the scanned project's own build tooling, such as
 * wrapper scripts or build definitions that Maven, Gradle, sbt, Mill, Poetry,
 * PDM, MSBuild, SwiftPM, Leiningen and CocoaPods evaluate.
 *
 * Tooling follows `options.installDeps`, which defaults to off in secure mode
 * when a caller does not set it. Introspection mode exists to observe the
 * project's own toolchain, so it keeps that tooling on even when dependency
 * installation is disabled, as long as the operator asked for it rather than
 * a config file in the scanned project. Secure mode still wins:
 * CDXGEN_INTROSPECT alone must not make a secure-mode scan run the scanned
 * project's code.
 *
 * @param {Object} [options] CLI options
 * @returns {boolean} true when project tooling may run
 */
export function isProjectToolingAllowed(options) {
  if (isDependencyInstallAllowed(options)) {
    return true;
  }
  return (
    options?.introspect === true &&
    options?.introspectFromConfigFile !== true &&
    !isSecureModeActive()
  );
}

// The skips already reported for each scan, keyed by the scan's options.
// Callers without options share one key.
const reportedSkips = new WeakMap();
const noOptionsKey = {};

/**
 * Tell the user that a tool was skipped because project tooling is not
 * allowed, and record the matching degradation for the fidelity report.
 * Each skip is reported once per scan, however many manifests it applies to.
 * A skip that only costs evidence, not BOM content, passes no remediation id
 * and is only shown.
 *
 * @param {Object} options CLI options of the scan
 * @param {string|null} remediationId Remediation id from
 *   data/remediations.json, or null for a message only
 * @param {string} message Console message shown to the user
 * @param {Object} [fields] Degradation fields (ecosystem, tool, impact, detail)
 * @returns {void}
 */
export function reportProjectToolingSkipped(
  options,
  remediationId,
  message,
  fields,
) {
  const key = options && typeof options === "object" ? options : noOptionsKey;
  let reported = reportedSkips.get(key);
  if (!reported) {
    reported = new Set();
    reportedSkips.set(key, reported);
  }
  const skipKey = remediationId || message;
  if (reported.has(skipKey)) {
    return;
  }
  reported.add(skipKey);
  console.log(message);
  if (remediationId) {
    recordDegradation(remediationId, fields);
  }
}

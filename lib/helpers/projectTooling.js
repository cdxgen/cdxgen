import { isSecureMode, readEnvironmentVariable } from "./utils.js";

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
 * option; an application that calls `createBom` may leave it out.
 *
 * @param {Object} [options] CLI options
 * @returns {boolean} true when dependencies may be installed
 */
export function isDependencyInstallAllowed(options) {
  const installDeps = options?.installDeps ?? !isSecureModeActive();
  return installDeps !== false;
}

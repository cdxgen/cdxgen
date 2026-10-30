/**
 * Repo-root resolution, shared by every helper that loads a file from `data/`.
 *
 * This lives in its own leaf module — importing nothing from `utils.js` — because
 * the value is consumed at *module-evaluation* time (`JSON.parse(readFileSync(
 * join(dirNameStr, "data", …)))`). A module in a cycle with `utils.js` that reads
 * `dirNameStr` while `utils.js` is still evaluating gets the binding in its
 * temporal dead zone and throws `ReferenceError: Cannot access 'dirNameStr'
 * before initialization`. Keeping the definition in a leaf guarantees it is
 * initialized before any consumer runs.
 *
 * The `file://` normalization below is load-bearing, not defensive noise:
 * `jsr.json` publishes `lib/cli/index.js` to JSR, so `import.meta.url` can be an
 * `https://` URL, and `fileURLToPath` throws `ERR_INVALID_URL_SCHEME` on those.
 */

import { homedir, platform } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

let url = import.meta?.url;
if (url && !url.startsWith("file://")) {
  url = new URL(`file://${import.meta.url}`).toString();
}
// TODO: verify if this is a good method (Prabhu)
// this is due to dirNameStr being "cdxgen/lib/helpers" which causes errors
/** Absolute path to the cdxgen repository root, resolved from the module URL. */
export const dirNameStr = url
  ? dirname(dirname(dirname(fileURLToPath(url))))
  : __dirname;

/** True when running on Windows. */
export const isWin = platform() === "win32";
/** True when running on macOS. */
export const isMac = platform() === "darwin";

/**
 * Validate that a string is a Windows drive root such as `C:\`.
 *
 * @param {string} root Candidate drive root string.
 * @returns {boolean} True when the string is a valid Windows drive root.
 */
export function isValidDriveRoot(root) {
  if (root.length > 3) {
    return false;
  }
  const driveLetter = root.charAt(0);
  const colon = root.charAt(1);
  const backslash = root.charAt(2);
  const charCode = driveLetter.charCodeAt(0);
  const isAsciiLetter =
    (charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122);
  if (!isAsciiLetter) {
    return false;
  }
  if (colon.charCodeAt(0) !== 0x3a) {
    return false;
  }
  return !(backslash && backslash.charCodeAt(0) !== 0x5c);
}

/**
 * Convert a kebab-case string to camelCase.
 *
 * @param {string} str Kebab-case input string.
 * @returns {string} camelCase representation of the input.
 */
export function toCamel(str) {
  return str.replace(/-([a-z])/g, (_, g) => g.toUpperCase());
}

/**
 * Rewrite an absolute path under the user's home directory to a `~`-relative
 * form so the emitted BOM does not carry the local username.
 *
 * @param {string} filePath Absolute path
 * @param {string} [home] Home directory, defaulting to the current user's
 * @returns {string} Home-relative path when applicable, else the input
 */
export function redactHomePath(filePath, home = homedir()) {
  const value = String(filePath || "");
  if (!home || !value.startsWith(home)) {
    return value;
  }
  // Require a path boundary so a sibling home such as /Users/alice-backup is
  // not rewritten as if it sat under /Users/alice.
  const remainder = value.slice(home.length);
  if (remainder && !/^[/\\]/u.test(remainder)) {
    return value;
  }
  const rest = remainder.replace(/^[/\\]/u, "");
  return rest ? `~/${rest.replaceAll("\\", "/")}` : "~";
}

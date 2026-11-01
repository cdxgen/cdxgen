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
/** Absolute path to the cdxgen repository root, resolved from the module URL. */
export declare const dirNameStr: any;
/** True when running on Windows. */
export declare const isWin: boolean;
/** True when running on macOS. */
export declare const isMac: boolean;
/**
 * Validate that a string is a Windows drive root such as `C:\`.
 *
 * @param {string} root Candidate drive root string.
 * @returns {boolean} True when the string is a valid Windows drive root.
 */
export declare function isValidDriveRoot(root: string): boolean;
/**
 * Convert a kebab-case string to camelCase.
 *
 * @param {string} str Kebab-case input string.
 * @returns {string} camelCase representation of the input.
 */
export declare function toCamel(str: string): string;
/**
 * Rewrite an absolute path under the user's home directory to a `~`-relative
 * form so the emitted BOM does not carry the local username.
 *
 * @param {string} filePath Absolute path
 * @param {string} [home] Home directory, defaulting to the current user's
 * @returns {string} Home-relative path when applicable, else the input
 */
export declare function redactHomePath(filePath: string, home?: string): string;
//# sourceMappingURL=paths.d.ts.map
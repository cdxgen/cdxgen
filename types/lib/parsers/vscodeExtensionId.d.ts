/**
 * Target platforms a VS Code-family marketplace publishes an extension for.
 * `universal` and `web` builds are the same artefact on every platform and are
 * not part of the extension's identity.
 */
export declare const VSCODE_TARGET_PLATFORMS: Set<string>;
/**
 * Normalize a target platform value from a manifest, an `extensions.json`
 * record, or a folder name. Values that do not name a specific platform, such
 * as `universal`, `web`, `undefined`, or an empty string, return an empty
 * string.
 *
 * @param {string} value Raw target platform
 * @returns {string} A value from VSCODE_TARGET_PLATFORMS, or an empty string
 */
export declare function normalizeVscodeTargetPlatform(value: string): string;
/**
 * Split an installed extension folder name into its publisher, name, version
 * and target platform.
 *
 * @param {string} dirName Folder name, such as `ms-python.python-2025.4.0` or
 *   `anthropic.claude-code-2.1.313-darwin-arm64`
 * @returns {{publisher: string, name: string, version: string, platform: string}|undefined}
 *   The parts, or undefined when the name does not follow the pattern
 */
export declare function parseVscodeExtensionDirName(dirName: string): {
    publisher: string;
    name: string;
    version: string;
    platform: string;
} | undefined;
/**
 * Check a string is a semantic version: three numeric parts, then an optional
 * `-prerelease` and `+build`.
 *
 * @param {string} text Candidate version
 * @returns {boolean} true for a semver
 */
export declare function isSemver(text: string): boolean;
/**
 * Read the target platform from the path of an installed extension folder.
 *
 * @param {string} extensionPath Path to the extension folder, with either
 *   separator
 * @returns {string} The target platform, or an empty string
 */
export declare function vscodeExtensionPlatformFromPath(extensionPath: string): string;
//# sourceMappingURL=vscodeExtensionId.d.ts.map
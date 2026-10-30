// The one place that reads the identity of an installed VS Code-family
// extension from the name of its folder.
//
// An editor installs an extension into `<publisher>.<name>-<version>`, and a
// platform-specific build into `<publisher>.<name>-<version>-<platform>`, for
// example `anthropic.claude-code-2.1.313-darwin-arm64`. The extension scan and
// the osquery `vscode_extensions` rows both name the extension from this, so an
// extension found by `cdxgen -t vscode-extension` and by `obom` is the same
// component with the same purl.

/**
 * Target platforms a VS Code-family marketplace publishes an extension for.
 * `universal` and `web` builds are the same artefact on every platform and are
 * not part of the extension's identity.
 */
export const VSCODE_TARGET_PLATFORMS = new Set([
  "win32-x64",
  "win32-arm64",
  "win32-ia32",
  "linux-x64",
  "linux-arm64",
  "linux-armhf",
  "alpine-x64",
  "alpine-arm64",
  "darwin-x64",
  "darwin-arm64",
]);

// Folder suffixes for builds that run on every platform.
const NEUTRAL_PLATFORMS = ["universal", "web"];

/**
 * Normalize a target platform value from a manifest, an `extensions.json`
 * record, or a folder name. Values that do not name a specific platform, such
 * as `universal`, `web`, `undefined`, or an empty string, return an empty
 * string.
 *
 * @param {string} value Raw target platform
 * @returns {string} A value from VSCODE_TARGET_PLATFORMS, or an empty string
 */
export function normalizeVscodeTargetPlatform(value) {
  const platform = `${value || ""}`.trim().toLowerCase();
  return VSCODE_TARGET_PLATFORMS.has(platform) ? platform : "";
}

/**
 * Split an installed extension folder name into its publisher, name, version
 * and target platform.
 *
 * @param {string} dirName Folder name, such as `ms-python.python-2025.4.0` or
 *   `anthropic.claude-code-2.1.313-darwin-arm64`
 * @returns {{publisher: string, name: string, version: string, platform: string}|undefined}
 *   The parts, or undefined when the name does not follow the pattern
 */
export function parseVscodeExtensionDirName(dirName) {
  let value = `${dirName || ""}`.trim();
  while (value.endsWith("/") || value.endsWith("\\")) {
    value = value.slice(0, -1);
  }
  const dotIdx = value.indexOf(".");
  if (dotIdx < 1) {
    return undefined;
  }
  const publisher = value.substring(0, dotIdx);
  let rest = value.substring(dotIdx + 1);
  let platform = "";
  for (const candidate of [...VSCODE_TARGET_PLATFORMS, ...NEUTRAL_PLATFORMS]) {
    if (rest.toLowerCase().endsWith(`-${candidate}`)) {
      platform = normalizeVscodeTargetPlatform(candidate);
      rest = rest.substring(0, rest.length - candidate.length - 1);
      break;
    }
  }
  // Marketplaces require semver versions, so the version starts at the first
  // hyphen whose remainder is a whole semver: `python-3.11-tools-1.0.0` is the
  // name `python-3.11-tools` at 1.0.0, and `1.0.0-beta-2` stays one version.
  // A folder whose version is not semver falls back to the first hyphen
  // followed by digits and a dot.
  let versionStart = -1;
  let fallbackStart = -1;
  for (let i = 1; i < rest.length - 2; i++) {
    if (rest[i] !== "-" || !isDigit(rest[i + 1])) {
      continue;
    }
    if (isSemver(rest.substring(i + 1))) {
      versionStart = i;
      break;
    }
    let j = i + 1;
    while (j < rest.length && isDigit(rest[j])) {
      j++;
    }
    if (fallbackStart < 0 && rest[j] === ".") {
      fallbackStart = i;
    }
  }
  if (versionStart < 0) {
    versionStart = fallbackStart;
  }
  if (versionStart < 1) {
    return undefined;
  }
  const name = rest.substring(0, versionStart);
  const version = rest.substring(versionStart + 1);
  if (!name || !version) {
    return undefined;
  }
  return { publisher, name, version, platform };
}

function isDigit(character) {
  return character >= "0" && character <= "9";
}

function isIdentifierList(text, numericNoLeadingZero) {
  if (!text) {
    return false;
  }
  return text.split(".").every((part) => {
    if (!part.length) {
      return false;
    }
    for (const character of part) {
      const ok =
        isDigit(character) ||
        character === "-" ||
        (character >= "a" && character <= "z") ||
        (character >= "A" && character <= "Z");
      if (!ok) {
        return false;
      }
    }
    if (numericNoLeadingZero && [...part].every(isDigit)) {
      return part === "0" || part[0] !== "0";
    }
    return true;
  });
}

/**
 * Check a string is a semantic version: three numeric parts, then an optional
 * `-prerelease` and `+build`.
 *
 * @param {string} text Candidate version
 * @returns {boolean} true for a semver
 */
export function isSemver(text) {
  const plus = text.indexOf("+");
  const core = plus >= 0 ? text.substring(0, plus) : text;
  if (plus >= 0 && !isIdentifierList(text.substring(plus + 1), false)) {
    return false;
  }
  const dash = core.indexOf("-");
  const numbers = dash >= 0 ? core.substring(0, dash) : core;
  if (dash >= 0 && !isIdentifierList(core.substring(dash + 1), true)) {
    return false;
  }
  const parts = numbers.split(".");
  return (
    parts.length === 3 &&
    parts.every(
      (part) =>
        part.length > 0 &&
        [...part].every(isDigit) &&
        (part === "0" || part[0] !== "0"),
    )
  );
}

/**
 * Read the target platform from the path of an installed extension folder.
 *
 * @param {string} extensionPath Path to the extension folder, with either
 *   separator
 * @returns {string} The target platform, or an empty string
 */
export function vscodeExtensionPlatformFromPath(extensionPath) {
  const segments = `${extensionPath || ""}`
    .split(/[/\\]/u)
    .filter((segment) => segment.length);
  const dirName = segments[segments.length - 1];
  return parseVscodeExtensionDirName(dirName)?.platform || "";
}

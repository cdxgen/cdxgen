import { readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import process from "node:process";

import StreamZip from "node-stream-zip";
import { PackageURL } from "packageurl-js";
import { xml2js } from "xml-js";

import { DEBUG_MODE, safeExistsSync } from "./utils.js";

/**
 * The purl type for VS Code extensions as defined by the packageurl spec.
 */
export const VSCODE_EXTENSION_PURL_TYPE = "vscode-extension";

const isWin = platform() === "win32";
const isMac = platform() === "darwin";

/**
 * IDE configuration entries describing where each IDE stores its extensions.
 * Each entry contains the IDE name and an array of candidate extension
 * directory paths for Windows, macOS, and Linux (including remote/server
 * environments).
 *
 * The paths use platform-specific logic via `homedir()` and common
 * environment variables.
 */
export function getIdeExtensionDirs() {
  const home = homedir();
  const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
  const localAppData =
    process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  const xdgDataHome =
    process.env.XDG_DATA_HOME || join(home, ".local", "share");

  // Each entry: { name, dirs: string[] }
  // Only include directories that are relevant for the current platform,
  // plus well-known remote/server paths that are always Linux.
  const ides = [
    {
      name: "VS Code",
      dirs: isWin
        ? [join(appData, "Code", "User", "extensions")]
        : isMac
          ? [
              join(
                home,
                "Library",
                "Application Support",
                "Code",
                "User",
                "extensions",
              ),
            ]
          : [join(home, ".vscode", "extensions")],
    },
    {
      name: "VS Code Insiders",
      dirs: isWin
        ? [join(appData, "Code - Insiders", "User", "extensions")]
        : isMac
          ? [
              join(
                home,
                "Library",
                "Application Support",
                "Code - Insiders",
                "User",
                "extensions",
              ),
            ]
          : [join(home, ".vscode-insiders", "extensions")],
    },
    {
      name: "VSCodium",
      dirs: isWin
        ? [join(appData, "VSCodium", "User", "extensions")]
        : isMac
          ? [
              join(
                home,
                "Library",
                "Application Support",
                "VSCodium",
                "User",
                "extensions",
              ),
            ]
          : [
              join(home, ".vscode-oss", "extensions"),
              join(home, ".config", "VSCodium", "User", "extensions"),
            ],
    },
    {
      name: "Cursor",
      dirs: isWin
        ? [
            join(appData, "Cursor", "User", "extensions"),
            join(localAppData, "cursor", "extensions"),
          ]
        : isMac
          ? [
              join(
                home,
                "Library",
                "Application Support",
                "Cursor",
                "User",
                "extensions",
              ),
            ]
          : [join(home, ".cursor", "extensions")],
    },
    {
      name: "Windsurf",
      dirs: isWin
        ? [join(appData, "Windsurf", "User", "extensions")]
        : isMac
          ? [
              join(
                home,
                "Library",
                "Application Support",
                "Windsurf",
                "User",
                "extensions",
              ),
            ]
          : [join(home, ".windsurf", "extensions")],
    },
    {
      name: "Positron",
      dirs: isWin
        ? [join(appData, "Positron", "User", "extensions")]
        : isMac
          ? [
              join(
                home,
                "Library",
                "Application Support",
                "Positron",
                "User",
                "extensions",
              ),
            ]
          : [join(home, ".positron", "extensions")],
    },
    {
      name: "Theia",
      dirs: isWin
        ? [join(appData, "Theia", "extensions")]
        : isMac
          ? [
              join(
                home,
                "Library",
                "Application Support",
                "Theia",
                "extensions",
              ),
            ]
          : [
              join(home, ".theia", "extensions"),
              join(xdgDataHome, "theia", "extensions"),
            ],
    },
    // Remote / server environments (Linux only)
    {
      name: "code-server",
      dirs: [join(xdgDataHome, "code-server", "extensions")],
    },
    {
      name: "VS Code Remote",
      dirs: [join(home, ".vscode-remote", "extensions")],
    },
    {
      name: "OpenVSCode Server",
      dirs: [join(xdgDataHome, "openvscode-server", "extensions")],
    },
    {
      name: "Trae",
      dirs: isWin
        ? [join(appData, "Trae", "User", "extensions")]
        : isMac
          ? [
              join(
                home,
                "Library",
                "Application Support",
                "Trae",
                "User",
                "extensions",
              ),
            ]
          : [join(home, ".trae", "extensions")],
    },
    {
      name: "Augment Code",
      dirs: isWin
        ? [join(appData, "Augment Code", "User", "extensions")]
        : isMac
          ? [
              join(
                home,
                "Library",
                "Application Support",
                "Augment Code",
                "User",
                "extensions",
              ),
            ]
          : [join(home, ".augment-code", "extensions")],
    },
  ];

  return ides;
}

/**
 * Discover all existing IDE extension directories on the current system.
 *
 * @returns {Array<{name: string, dir: string}>} Array of objects with IDE name
 *   and the existing directory path.
 */
export function discoverIdeExtensionDirs() {
  const ides = getIdeExtensionDirs();
  const found = [];
  for (const ide of ides) {
    for (const dir of ide.dirs) {
      if (safeExistsSync(dir)) {
        found.push({ name: ide.name, dir });
      }
    }
  }
  return found;
}

/**
 * Parse a `.vsixmanifest` XML string and extract extension metadata.
 *
 * @param {string} manifestData Raw XML content of a `.vsixmanifest` file
 * @returns {Object|undefined} Object with { publisher, name, version, displayName, description, platform } or undefined on failure
 */
export function parseVsixManifest(manifestData) {
  if (!manifestData?.trim()) {
    return undefined;
  }
  try {
    const parsed = xml2js(manifestData, {
      compact: true,
      alwaysArray: false,
      spaces: 4,
      textKey: "_",
      attributesKey: "$",
    });
    const manifest =
      parsed.PackageManifest || parsed["PackageManifest:PackageManifest"];
    if (!manifest) {
      return undefined;
    }
    const metadata = manifest.Metadata || manifest["PackageManifest:Metadata"];
    if (!metadata) {
      return undefined;
    }
    const identity = metadata.Identity || metadata["PackageManifest:Identity"];
    if (!identity?.$) {
      return undefined;
    }
    const attrs = identity.$;
    const publisher =
      attrs.Publisher || attrs.publisher || attrs["d:Publisher"] || "";
    const name = attrs.Id || attrs.id || attrs["d:Id"] || "";
    const version = attrs.Version || attrs.version || attrs["d:Version"] || "";
    const targetPlatform =
      attrs.TargetPlatform ||
      attrs.targetPlatform ||
      attrs["d:TargetPlatform"] ||
      "";

    const displayNameNode =
      metadata.DisplayName || metadata["PackageManifest:DisplayName"];
    const descriptionNode =
      metadata.Description || metadata["PackageManifest:Description"];
    const displayName = displayNameNode?._ || displayNameNode || "";
    const description = descriptionNode?._ || descriptionNode || "";

    return {
      publisher: publisher.toLowerCase(),
      name: name.toLowerCase(),
      version,
      displayName: typeof displayName === "string" ? displayName : "",
      description: typeof description === "string" ? description : "",
      platform: targetPlatform || "",
    };
  } catch (e) {
    if (DEBUG_MODE) {
      console.log("Error parsing vsixmanifest:", e.message);
    }
    return undefined;
  }
}

/**
 * Parse a VS Code extension's `package.json` and extract metadata.
 *
 * @param {string|Object} packageJsonData Either raw JSON string or parsed object
 * @param {string} [srcPath] Optional path to the source directory for evidence
 * @returns {Object|undefined} Object with { publisher, name, version, displayName, description, platform } or undefined
 */
export function parseVsixPackageJson(packageJsonData, srcPath) {
  try {
    const pkg =
      typeof packageJsonData === "string"
        ? JSON.parse(packageJsonData)
        : packageJsonData;
    if (!pkg?.name) {
      return undefined;
    }
    return {
      publisher: (pkg.publisher || "").toLowerCase(),
      name: (pkg.name || "").toLowerCase(),
      version: pkg.version || "",
      displayName: pkg.displayName || "",
      description: pkg.description || "",
      platform: "",
      srcPath,
    };
  } catch (e) {
    if (DEBUG_MODE) {
      console.log("Error parsing extension package.json:", e.message);
    }
    return undefined;
  }
}

/**
 * Convert parsed extension metadata into a CycloneDX component object.
 *
 * @param {Object} extInfo Object with { publisher, name, version, displayName, description, platform, srcPath }
 * @param {string} [ideName] Optional IDE name for properties
 * @returns {Object|undefined} CycloneDX component object or undefined
 */
export function toComponent(extInfo, ideName) {
  if (!extInfo?.name) {
    return undefined;
  }
  const qualifiers = {};
  if (extInfo.platform) {
    qualifiers.platform = extInfo.platform;
  }
  const purl = new PackageURL(
    VSCODE_EXTENSION_PURL_TYPE,
    extInfo.publisher || null,
    extInfo.name,
    extInfo.version || null,
    Object.keys(qualifiers).length ? qualifiers : null,
    null,
  ).toString();
  const component = {
    publisher: extInfo.publisher || "",
    group: extInfo.publisher || "",
    name: extInfo.name,
    version: extInfo.version || "",
    description: extInfo.displayName || extInfo.description || "",
    purl,
    "bom-ref": decodeURIComponent(purl),
    type: "application",
  };
  if (extInfo.description && extInfo.description !== component.description) {
    component.description = extInfo.description;
  }
  const props = [];
  if (ideName) {
    props.push({ name: "cdx:vscode-extension:ide", value: ideName });
  }
  if (extInfo.srcPath) {
    props.push({ name: "SrcFile", value: extInfo.srcPath });
  }
  if (props.length) {
    component.properties = props;
  }
  component.evidence = {
    identity: {
      field: "purl",
      confidence: 0.8,
      methods: [
        {
          technique: "manifest-analysis",
          confidence: 0.8,
          value: extInfo.srcPath || "",
        },
      ],
    },
  };
  return component;
}

/**
 * Parse a `.vsix` file (ZIP archive) and extract the extension metadata.
 *
 * @param {string} vsixFile Absolute path to the `.vsix` file
 * @returns {Promise<Object|undefined>} CycloneDX component object or undefined
 */
export async function parseVsixFile(vsixFile) {
  try {
    const zip = new StreamZip.async({ file: vsixFile });
    const entries = await zip.entries();
    let extInfo;

    // Try .vsixmanifest first
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) {
        continue;
      }
      if (
        entry.name.endsWith(".vsixmanifest") ||
        entry.name.endsWith("extension.vsixmanifest")
      ) {
        const fileData = await zip.entryData(entry.name);
        const manifestData = fileData.toString("utf-8");
        extInfo = parseVsixManifest(manifestData);
        if (extInfo) {
          extInfo.srcPath = vsixFile;
          break;
        }
      }
    }

    // Fall back to package.json inside the extension/ directory
    if (!extInfo) {
      for (const entry of Object.values(entries)) {
        if (entry.isDirectory) {
          continue;
        }
        if (
          entry.name === "extension/package.json" ||
          entry.name === "package.json"
        ) {
          const fileData = await zip.entryData(entry.name);
          const packageJsonData = fileData.toString("utf-8");
          extInfo = parseVsixPackageJson(packageJsonData, vsixFile);
          if (extInfo) {
            break;
          }
        }
      }
    }

    await zip.close();

    if (extInfo) {
      return toComponent(extInfo);
    }
    return undefined;
  } catch (e) {
    if (DEBUG_MODE) {
      console.log(`Error parsing vsix file ${vsixFile}:`, e.message);
    }
    return undefined;
  }
}

/**
 * Parse a single installed extension directory (already extracted).
 * Looks for `package.json` (preferred) and `.vsixmanifest`.
 *
 * @param {string} extDir Absolute path to the extension directory (e.g. `~/.vscode/extensions/ms-python.python-2023.1.0`)
 * @param {string} [ideName] Optional IDE name
 * @returns {Object|undefined} CycloneDX component object or undefined
 */
export function parseInstalledExtensionDir(extDir, ideName) {
  // First try package.json at the root of the extension directory
  const packageJsonPath = join(extDir, "package.json");
  if (safeExistsSync(packageJsonPath)) {
    try {
      const data = readFileSync(packageJsonPath, { encoding: "utf-8" });
      const extInfo = parseVsixPackageJson(data, extDir);
      if (extInfo?.name) {
        return toComponent(extInfo, ideName);
      }
    } catch (_e) {
      // Fall through to vsixmanifest
    }
  }

  // Try .vsixmanifest at the root
  const manifestPath = join(extDir, ".vsixmanifest");
  if (safeExistsSync(manifestPath)) {
    try {
      const data = readFileSync(manifestPath, { encoding: "utf-8" });
      const extInfo = parseVsixManifest(data);
      if (extInfo) {
        extInfo.srcPath = extDir;
        return toComponent(extInfo, ideName);
      }
    } catch (_e) {
      // Ignore
    }
  }

  // Try to infer from directory name (publisher.name-version pattern)
  return parseExtensionDirName(extDir, ideName);
}

/**
 * Attempt to extract extension metadata from a directory name following the
 * pattern `publisher.name-version`.
 *
 * @param {string} extDir Absolute path to extension directory
 * @param {string} [ideName] IDE name
 * @returns {Object|undefined} CycloneDX component or undefined
 */
export function parseExtensionDirName(extDir, ideName) {
  const dirName = extDir.split(/[/\\]/).pop();
  if (!dirName) {
    return undefined;
  }
  // Pattern: publisher.name-version (e.g., ms-python.python-2023.25.0)
  // Use a non-backtracking approach: split on the last hyphen followed by a digit
  const dotIdx = dirName.indexOf(".");
  if (dotIdx < 1) {
    return undefined;
  }
  const publisher = dirName.substring(0, dotIdx);
  const rest = dirName.substring(dotIdx + 1);
  // Find the last hyphen followed by a digit to separate name from version
  let versionStart = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i] === "-" && i + 1 < rest.length && /\d/.test(rest[i + 1])) {
      versionStart = i;
      break;
    }
  }
  if (versionStart < 1) {
    return undefined;
  }
  const name = rest.substring(0, versionStart);
  const version = rest.substring(versionStart + 1);
  if (name && version) {
    const extInfo = {
      publisher: publisher.toLowerCase(),
      name: name.toLowerCase(),
      version,
      displayName: "",
      description: "",
      platform: "",
      srcPath: extDir,
    };
    return toComponent(extInfo, ideName);
  }
  return undefined;
}

/**
 * Collect all installed extensions from a set of IDE extension directories.
 *
 * @param {Array<{name: string, dir: string}>} ideDirs Array of { name, dir } from discoverIdeExtensionDirs
 * @returns {Object[]} Array of CycloneDX component objects
 */
export function collectInstalledExtensions(ideDirs) {
  const pkgList = [];
  const seen = new Set();

  for (const { name: ideName, dir } of ideDirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      // Skip hidden directories and special directories
      if (entry.name.startsWith(".")) {
        continue;
      }
      const extDir = join(dir, entry.name);
      const component = parseInstalledExtensionDir(extDir, ideName);
      if (component && !seen.has(component.purl)) {
        seen.add(component.purl);
        pkgList.push(component);
      }
    }
  }
  return pkgList;
}

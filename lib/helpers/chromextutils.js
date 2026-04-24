import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { PackageURL } from "packageurl-js";

import { isMac, isWin, safeExistsSync } from "./utils.js";

/**
 * The purl type for Chrome extensions as defined by the packageurl spec.
 */
export const CHROME_EXTENSION_PURL_TYPE = "chrome-extension";

const CHROME_EXTENSION_ID_REGEX = /^[a-z]{32}$/i;

/**
 * Discover known Chromium-based browser user-data directories.
 *
 * @returns {Array<{browser: string, channel: string, dir: string}>}
 */
export function getChromiumExtensionDirs() {
  const home = homedir();
  const localAppData =
    process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
  const dirs = [
    // Google Chrome
    {
      browser: "Google Chrome",
      channel: "stable",
      dir: isWin
        ? join(localAppData, "Google", "Chrome", "User Data")
        : isMac
          ? join(home, "Library", "Application Support", "Google", "Chrome")
          : join(xdgConfigHome, "google-chrome"),
    },
    {
      browser: "Google Chrome",
      channel: "beta",
      dir: isWin
        ? join(localAppData, "Google", "Chrome Beta", "User Data")
        : isMac
          ? join(
              home,
              "Library",
              "Application Support",
              "Google",
              "Chrome Beta",
            )
          : join(xdgConfigHome, "google-chrome-beta"),
    },
    {
      browser: "Google Chrome",
      channel: "dev",
      dir: isWin
        ? join(localAppData, "Google", "Chrome Dev", "User Data")
        : isMac
          ? join(home, "Library", "Application Support", "Google", "Chrome Dev")
          : join(xdgConfigHome, "google-chrome-unstable"),
    },
    {
      browser: "Google Chrome",
      channel: "canary",
      dir: isWin
        ? join(localAppData, "Google", "Chrome SxS", "User Data")
        : isMac
          ? join(
              home,
              "Library",
              "Application Support",
              "Google",
              "Chrome Canary",
            )
          : "",
    },
    // Chromium
    {
      browser: "Chromium",
      channel: "stable",
      dir: isWin
        ? join(localAppData, "Chromium", "User Data")
        : isMac
          ? join(home, "Library", "Application Support", "Chromium")
          : join(xdgConfigHome, "chromium"),
    },
    // Microsoft Edge
    {
      browser: "Microsoft Edge",
      channel: "stable",
      dir: isWin
        ? join(localAppData, "Microsoft", "Edge", "User Data")
        : isMac
          ? join(home, "Library", "Application Support", "Microsoft Edge")
          : join(xdgConfigHome, "microsoft-edge"),
    },
    {
      browser: "Microsoft Edge",
      channel: "beta",
      dir: isWin
        ? join(localAppData, "Microsoft", "Edge Beta", "User Data")
        : isMac
          ? join(home, "Library", "Application Support", "Microsoft Edge Beta")
          : join(xdgConfigHome, "microsoft-edge-beta"),
    },
    {
      browser: "Microsoft Edge",
      channel: "dev",
      dir: isWin
        ? join(localAppData, "Microsoft", "Edge Dev", "User Data")
        : isMac
          ? join(home, "Library", "Application Support", "Microsoft Edge Dev")
          : join(xdgConfigHome, "microsoft-edge-dev"),
    },
    {
      browser: "Microsoft Edge",
      channel: "canary",
      dir: isWin
        ? join(localAppData, "Microsoft", "Edge SxS", "User Data")
        : isMac
          ? join(
              home,
              "Library",
              "Application Support",
              "Microsoft Edge Canary",
            )
          : "",
    },
    // Brave
    {
      browser: "Brave",
      channel: "stable",
      dir: isWin
        ? join(localAppData, "BraveSoftware", "Brave-Browser", "User Data")
        : isMac
          ? join(
              home,
              "Library",
              "Application Support",
              "BraveSoftware",
              "Brave-Browser",
            )
          : join(xdgConfigHome, "BraveSoftware", "Brave-Browser"),
    },
    {
      browser: "Brave",
      channel: "beta",
      dir: isWin
        ? join(localAppData, "BraveSoftware", "Brave-Browser-Beta", "User Data")
        : isMac
          ? join(
              home,
              "Library",
              "Application Support",
              "BraveSoftware",
              "Brave-Browser-Beta",
            )
          : join(xdgConfigHome, "BraveSoftware", "Brave-Browser-Beta"),
    },
    {
      browser: "Brave",
      channel: "dev",
      dir: isWin
        ? join(localAppData, "BraveSoftware", "Brave-Browser-Dev", "User Data")
        : isMac
          ? join(
              home,
              "Library",
              "Application Support",
              "BraveSoftware",
              "Brave-Browser-Dev",
            )
          : join(xdgConfigHome, "BraveSoftware", "Brave-Browser-Dev"),
    },
    {
      browser: "Brave",
      channel: "nightly",
      dir: isWin
        ? join(
            localAppData,
            "BraveSoftware",
            "Brave-Browser-Nightly",
            "User Data",
          )
        : isMac
          ? join(
              home,
              "Library",
              "Application Support",
              "BraveSoftware",
              "Brave-Browser-Nightly",
            )
          : join(xdgConfigHome, "BraveSoftware", "Brave-Browser-Nightly"),
    },
    // Vivaldi
    {
      browser: "Vivaldi",
      channel: "stable",
      dir: isWin
        ? join(localAppData, "Vivaldi", "User Data")
        : isMac
          ? join(home, "Library", "Application Support", "Vivaldi")
          : join(xdgConfigHome, "vivaldi"),
    },
    {
      browser: "Vivaldi",
      channel: "snapshot",
      dir: isWin
        ? join(localAppData, "Vivaldi Snapshot", "User Data")
        : isMac
          ? join(home, "Library", "Application Support", "Vivaldi Snapshot")
          : join(xdgConfigHome, "vivaldi-snapshot"),
    },
  ];
  return dirs.filter((entry) => entry.dir);
}

/**
 * Discover existing Chromium-based browser user-data directories.
 *
 * @returns {Array<{browser: string, channel: string, dir: string}>}
 */
export function discoverChromiumExtensionDirs() {
  const found = [];
  const seen = new Set();
  for (const browserDir of getChromiumExtensionDirs()) {
    if (safeExistsSync(browserDir.dir) && !seen.has(browserDir.dir)) {
      seen.add(browserDir.dir);
      found.push(browserDir);
    }
  }
  return found;
}

/**
 * Compare Chromium extension versions with numeric dot-separated semantics.
 *
 * @param {string} leftVersion Left version
 * @param {string} rightVersion Right version
 * @returns {number} Negative when left<right, positive when left>right, zero when equal
 */
export function compareChromiumExtensionVersions(leftVersion, rightVersion) {
  const leftParts = String(leftVersion || "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const rightParts = String(rightVersion || "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < maxLength; i++) {
    const leftPart = Number.isNaN(leftParts[i]) ? 0 : (leftParts[i] ?? 0);
    const rightPart = Number.isNaN(rightParts[i]) ? 0 : (rightParts[i] ?? 0);
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return String(leftVersion || "").localeCompare(String(rightVersion || ""));
}

/**
 * Read profile names from Chromium user-data directory.
 *
 * @param {string} userDataDir Browser user-data directory
 * @returns {string[]} Profile directory names
 */
export function getChromiumProfiles(userDataDir) {
  const profiles = [];
  const localStateFile = join(userDataDir, "Local State");
  if (safeExistsSync(localStateFile)) {
    try {
      const localState = JSON.parse(readFileSync(localStateFile, "utf-8"));
      const infoCache = localState?.profile?.info_cache;
      if (infoCache && typeof infoCache === "object") {
        for (const profileName of Object.keys(infoCache)) {
          if (safeExistsSync(join(userDataDir, profileName, "Extensions"))) {
            profiles.push(profileName);
          }
        }
      }
      const lastUsed = localState?.profile?.last_used;
      if (
        lastUsed &&
        safeExistsSync(join(userDataDir, lastUsed, "Extensions")) &&
        !profiles.includes(lastUsed)
      ) {
        profiles.push(lastUsed);
      }
    } catch (_err) {
      // Ignore malformed Local State and fallback to directory scan
    }
  }
  if (profiles.length) {
    return profiles;
  }
  try {
    const profileDirs = readdirSync(userDataDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name === "Default" || /^Profile\s+\d+$/.test(name))
      .filter((name) => safeExistsSync(join(userDataDir, name, "Extensions")));
    if (profileDirs.length) {
      return profileDirs;
    }
  } catch (_err) {
    // Ignore directory scan errors
  }
  return safeExistsSync(join(userDataDir, "Default", "Extensions"))
    ? ["Default"]
    : [];
}

/**
 * Parse a Chromium extension manifest file.
 *
 * @param {string} manifestFile Absolute path to manifest.json
 * @returns {Object|undefined} Parsed manifest metadata
 */
export function parseChromiumExtensionManifest(manifestFile) {
  if (!safeExistsSync(manifestFile)) {
    return undefined;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    return {
      name: manifest.name || "",
      description: manifest.description || "",
      version: manifest.version || "",
      manifestVersion: manifest.manifest_version,
      updateUrl: manifest.update_url || "",
    };
  } catch (_err) {
    return undefined;
  }
}

/**
 * Convert parsed Chromium extension metadata into a CycloneDX component object.
 *
 * @param {Object} extInfo Extension metadata
 * @returns {Object|undefined} CycloneDX component object or undefined
 */
export function toComponent(extInfo) {
  if (!extInfo?.extensionId) {
    return undefined;
  }
  const extensionId = extInfo.extensionId.toLowerCase();
  const purl = new PackageURL(
    CHROME_EXTENSION_PURL_TYPE,
    null,
    extensionId,
    extInfo.version || null,
    null,
    null,
  ).toString();
  const component = {
    name: extensionId,
    version: extInfo.version || "",
    description: extInfo.displayName || extInfo.description || "",
    purl,
    "bom-ref": decodeURIComponent(purl),
    type: "application",
  };
  const properties = [];
  if (extInfo.browser) {
    properties.push({
      name: "cdx:chrome-extension:browser",
      value: extInfo.browser,
    });
  }
  if (extInfo.channel) {
    properties.push({
      name: "cdx:chrome-extension:channel",
      value: extInfo.channel,
    });
  }
  if (extInfo.profile) {
    properties.push({
      name: "cdx:chrome-extension:profile",
      value: extInfo.profile,
    });
  }
  if (extInfo.profilePath) {
    properties.push({
      name: "cdx:chrome-extension:profilePath",
      value: extInfo.profilePath,
    });
  }
  if (extInfo.manifestVersion !== undefined) {
    properties.push({
      name: "cdx:chrome-extension:manifestVersion",
      value: String(extInfo.manifestVersion),
    });
  }
  if (extInfo.updateUrl) {
    properties.push({
      name: "cdx:chrome-extension:updateUrl",
      value: extInfo.updateUrl,
    });
  }
  if (extInfo.srcPath) {
    properties.push({ name: "SrcFile", value: extInfo.srcPath });
  }
  if (properties.length) {
    component.properties = properties;
  }
  return component;
}

/**
 * Collect installed Chromium extension components from discovered browser directories.
 *
 * @param {Array<{browser: string, channel: string, dir: string}>} browserDirs Browser directories
 * @returns {Object[]} Array of CycloneDX component objects
 */
export function collectInstalledChromeExtensions(browserDirs) {
  const installMap = new Map();
  for (const browserDir of browserDirs) {
    const profiles = getChromiumProfiles(browserDir.dir);
    for (const profileName of profiles) {
      const profilePath = join(browserDir.dir, profileName);
      const extensionsDir = join(profilePath, "Extensions");
      if (!safeExistsSync(extensionsDir)) {
        continue;
      }
      let extensionEntries;
      try {
        extensionEntries = readdirSync(extensionsDir, { withFileTypes: true });
      } catch (_err) {
        continue;
      }
      for (const extensionEntry of extensionEntries) {
        if (!extensionEntry.isDirectory()) {
          continue;
        }
        const extensionId = extensionEntry.name.toLowerCase();
        if (!CHROME_EXTENSION_ID_REGEX.test(extensionId)) {
          continue;
        }
        const versionRoot = join(extensionsDir, extensionEntry.name);
        let versionEntries;
        try {
          versionEntries = readdirSync(versionRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch (_err) {
          continue;
        }
        if (!versionEntries.length) {
          continue;
        }
        versionEntries.sort(compareChromiumExtensionVersions);
        const version = versionEntries[versionEntries.length - 1];
        const manifestPath = join(versionRoot, version, "manifest.json");
        const manifest = parseChromiumExtensionManifest(manifestPath);
        const extInfo = {
          extensionId,
          version: manifest?.version || version,
          displayName: manifest?.name || "",
          description: manifest?.description || "",
          manifestVersion: manifest?.manifestVersion,
          updateUrl: manifest?.updateUrl || "",
          browser: browserDir.browser,
          channel: browserDir.channel,
          profile: profileName,
          profilePath,
          srcPath: manifestPath,
        };
        const key = `${browserDir.browser}|${browserDir.channel}|${profileName}|${extensionId}`;
        const existing = installMap.get(key);
        if (
          !existing ||
          compareChromiumExtensionVersions(existing.version, extInfo.version) <
            0
        ) {
          installMap.set(key, extInfo);
        }
      }
    }
  }
  const components = [];
  const seen = new Set();
  for (const extInfo of installMap.values()) {
    const component = toComponent(extInfo);
    if (component && !seen.has(component["bom-ref"])) {
      seen.add(component["bom-ref"]);
      components.push(component);
    }
  }
  return components;
}

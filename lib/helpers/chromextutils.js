import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
    const leftRawPart = leftParts[i];
    const rightRawPart = rightParts[i];
    const leftPart =
      leftRawPart === undefined || Number.isNaN(leftRawPart) ? 0 : leftRawPart;
    const rightPart =
      rightRawPart === undefined || Number.isNaN(rightRawPart)
        ? 0
        : rightRawPart;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return 0;
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
      .filter((name) => name === "Default" || /^Profile \d+$/.test(name))
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
    const permissions = Array.isArray(manifest.permissions)
      ? manifest.permissions.filter((value) => typeof value === "string")
      : [];
    const optionalPermissions = Array.isArray(manifest.optional_permissions)
      ? manifest.optional_permissions.filter(
          (value) => typeof value === "string",
        )
      : [];
    const hostPermissions = Array.isArray(manifest.host_permissions)
      ? manifest.host_permissions.filter((value) => typeof value === "string")
      : [];
    const commands =
      manifest.commands && typeof manifest.commands === "object"
        ? Object.keys(manifest.commands).filter(Boolean)
        : [];
    const contentScriptsRunAt = Array.isArray(manifest.content_scripts)
      ? [
          ...new Set(
            manifest.content_scripts
              .map((script) => script?.run_at)
              .filter((value) => typeof value === "string"),
          ),
        ]
      : [];
    const hasAutofillInContentScripts = Array.isArray(manifest.content_scripts)
      ? manifest.content_scripts.some((script) => {
          if (!script || typeof script !== "object") {
            return false;
          }
          const jsEntries = Array.isArray(script.js) ? script.js : [];
          const cssEntries = Array.isArray(script.css) ? script.css : [];
          const hasAutofillInJs = jsEntries.some(
            (entry) =>
              typeof entry === "string" &&
              entry.toLowerCase().includes("autofill"),
          );
          const hasAutofillInCss = cssEntries.some(
            (entry) =>
              typeof entry === "string" &&
              entry.toLowerCase().includes("autofill"),
          );
          return hasAutofillInJs || hasAutofillInCss;
        })
      : false;
    const hasAutofill =
      permissions.some((permission) =>
        permission.toLowerCase().includes("autofill"),
      ) ||
      optionalPermissions.some((permission) =>
        permission.toLowerCase().includes("autofill"),
      ) ||
      hasAutofillInContentScripts ||
      commands.some((commandName) =>
        commandName.toLowerCase().includes("autofill"),
      );
    let contentSecurityPolicy = "";
    if (typeof manifest.content_security_policy === "string") {
      contentSecurityPolicy = manifest.content_security_policy;
    } else if (
      manifest.content_security_policy &&
      typeof manifest.content_security_policy === "object"
    ) {
      contentSecurityPolicy = JSON.stringify(manifest.content_security_policy);
    }
    return {
      name: manifest.name || "",
      description: manifest.description || "",
      version: manifest.version || "",
      manifestVersion: manifest.manifest_version,
      updateUrl: manifest.update_url || "",
      permissions,
      optionalPermissions,
      hostPermissions,
      commands,
      contentScriptsRunAt,
      contentSecurityPolicy,
      storageManagedSchema: manifest?.storage?.managed_schema || "",
      hasAutofill,
    };
  } catch (_err) {
    return undefined;
  }
}

/**
 * Infer browser context from a resolved Chromium extension manifest path.
 *
 * @param {string} manifestFile Absolute path to manifest.json
 * @returns {{browser?: string, channel?: string, profile?: string, profilePath?: string}}
 */
export function inferChromiumContextFromManifest(manifestFile) {
  const resolvedManifest = resolve(manifestFile);
  for (const browserDir of getChromiumExtensionDirs()) {
    const resolvedBrowserDir = resolve(browserDir.dir);
    const browserRootPrefix = `${resolvedBrowserDir}${sep}`;
    if (!resolvedManifest.startsWith(browserRootPrefix)) {
      continue;
    }
    const rel = relative(resolvedBrowserDir, resolvedManifest);
    const relParts = rel.split(sep);
    if (
      relParts.length >= 5 &&
      relParts[0] &&
      relParts[1] === "Extensions" &&
      CHROME_EXTENSION_ID_REGEX.test(relParts[2]) &&
      relParts[4] === "manifest.json"
    ) {
      return {
        browser: browserDir.browser,
        channel: browserDir.channel,
        profile: relParts[0],
        profilePath: join(resolvedBrowserDir, relParts[0]),
      };
    }
  }
  return {};
}

/**
 * Pick the latest installed version directory for an extension-id directory.
 *
 * @param {string} extensionIdDir Path to `<...>/Extensions/<extension-id>`
 * @returns {string|undefined} Absolute path to the latest version directory
 */
function getLatestExtensionVersionDir(extensionIdDir) {
  if (!safeExistsSync(extensionIdDir)) {
    return undefined;
  }
  let versionDirs;
  try {
    versionDirs = readdirSync(extensionIdDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (_err) {
    return undefined;
  }
  if (!versionDirs.length) {
    return undefined;
  }
  versionDirs.sort(compareChromiumExtensionVersions);
  return join(extensionIdDir, versionDirs[versionDirs.length - 1]);
}

/**
 * Convert a manifest file path into a CycloneDX component and extension dir.
 *
 * @param {string} manifestFile Absolute path to manifest.json
 * @returns {{component?: Object, extensionDir?: string}}
 */
function parseChromeExtensionFromManifestPath(manifestFile) {
  if (!safeExistsSync(manifestFile)) {
    return {};
  }
  const extensionDir = dirname(manifestFile);
  const extensionId = basename(dirname(extensionDir)).toLowerCase();
  if (!CHROME_EXTENSION_ID_REGEX.test(extensionId)) {
    return {};
  }
  const versionFromPath = basename(extensionDir);
  const manifest = parseChromiumExtensionManifest(manifestFile);
  const context = inferChromiumContextFromManifest(manifestFile);
  return {
    component: toComponent({
      extensionId,
      version: manifest?.version || versionFromPath,
      displayName: manifest?.name || "",
      description: manifest?.description || "",
      manifestVersion: manifest?.manifestVersion,
      updateUrl: manifest?.updateUrl || "",
      permissions: manifest?.permissions || [],
      optionalPermissions: manifest?.optionalPermissions || [],
      hostPermissions: manifest?.hostPermissions || [],
      commands: manifest?.commands || [],
      contentScriptsRunAt: manifest?.contentScriptsRunAt || [],
      contentSecurityPolicy: manifest?.contentSecurityPolicy || "",
      storageManagedSchema: manifest?.storageManagedSchema || "",
      hasAutofill: manifest?.hasAutofill || false,
      srcPath: manifestFile,
      ...context,
    }),
    extensionDir,
  };
}

/**
 * Collect one directly specified extension from a path.
 *
 * Supported path forms:
 * - `<...>/manifest.json`
 * - `<...>/<version>/` (contains manifest.json)
 * - `<...>/<extension-id>/` (contains version subdirectories)
 *
 * @param {string} extensionPath Candidate extension path
 * @returns {{components: Object[], extensionDirs: string[]}}
 */
export function collectChromeExtensionsFromPath(extensionPath) {
  if (!extensionPath || !safeExistsSync(extensionPath)) {
    return { components: [], extensionDirs: [] };
  }
  const resolvedPath = resolve(extensionPath);
  const manifestCandidates = [];
  const extensionDirs = [];
  const seenManifestFiles = new Set();
  const name = basename(resolvedPath);
  if (name === "manifest.json") {
    manifestCandidates.push(resolvedPath);
  } else if (safeExistsSync(join(resolvedPath, "manifest.json"))) {
    manifestCandidates.push(join(resolvedPath, "manifest.json"));
  } else if (CHROME_EXTENSION_ID_REGEX.test(name)) {
    const latestVersionDir = getLatestExtensionVersionDir(resolvedPath);
    if (latestVersionDir) {
      manifestCandidates.push(join(latestVersionDir, "manifest.json"));
    }
  }
  const components = [];
  const seenBomRefs = new Set();
  for (const manifestFile of manifestCandidates) {
    if (seenManifestFiles.has(manifestFile)) {
      continue;
    }
    seenManifestFiles.add(manifestFile);
    const { component, extensionDir } =
      parseChromeExtensionFromManifestPath(manifestFile);
    if (extensionDir && !extensionDirs.includes(extensionDir)) {
      extensionDirs.push(extensionDir);
    }
    if (component?.["bom-ref"] && !seenBomRefs.has(component["bom-ref"])) {
      seenBomRefs.add(component["bom-ref"]);
      components.push(component);
    }
  }
  return { components, extensionDirs };
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
  if (extInfo.permissions?.length) {
    properties.push({
      name: "cdx:chrome-extension:permissions",
      value: extInfo.permissions.join(", "),
    });
  }
  if (extInfo.optionalPermissions?.length) {
    properties.push({
      name: "cdx:chrome-extension:optionalPermissions",
      value: extInfo.optionalPermissions.join(", "),
    });
  }
  if (extInfo.hostPermissions?.length) {
    properties.push({
      name: "cdx:chrome-extension:hostPermissions",
      value: extInfo.hostPermissions.join(", "),
    });
  }
  if (extInfo.commands?.length) {
    properties.push({
      name: "cdx:chrome-extension:commands",
      value: extInfo.commands.join(", "),
    });
  }
  if (extInfo.contentScriptsRunAt?.length) {
    properties.push({
      name: "cdx:chrome-extension:contentScriptsRunAt",
      value: extInfo.contentScriptsRunAt.join(", "),
    });
  }
  if (extInfo.contentSecurityPolicy) {
    properties.push({
      name: "cdx:chrome-extension:contentSecurityPolicy",
      value: extInfo.contentSecurityPolicy,
    });
  }
  if (extInfo.storageManagedSchema) {
    properties.push({
      name: "cdx:chrome-extension:storageManagedSchema",
      value: extInfo.storageManagedSchema,
    });
  }
  if (extInfo.hasAutofill) {
    properties.push({
      name: "cdx:chrome-extension:hasAutofill",
      value: "true",
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
          permissions: manifest?.permissions || [],
          optionalPermissions: manifest?.optionalPermissions || [],
          hostPermissions: manifest?.hostPermissions || [],
          commands: manifest?.commands || [],
          contentScriptsRunAt: manifest?.contentScriptsRunAt || [],
          contentSecurityPolicy: manifest?.contentSecurityPolicy || "",
          storageManagedSchema: manifest?.storageManagedSchema || "",
          hasAutofill: manifest?.hasAutofill || false,
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

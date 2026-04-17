import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";

import StreamZip from "node-stream-zip";
import { PackageURL } from "packageurl-js";
import { xml2js } from "xml-js";

import {
  DEBUG_MODE,
  getTmpDir,
  isMac,
  isWin,
  safeExistsSync,
} from "./utils.js";
import { toVersRange } from "./versutils.js";

/**
 * The purl type for VS Code extensions as defined by the packageurl spec.
 */
export const VSCODE_EXTENSION_PURL_TYPE = "vscode-extension";

/**
 * Confidence value for extension metadata discovered via manifest analysis.
 */
const MANIFEST_ANALYSIS_CONFIDENCE = 0.6;

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
 * @returns {Object|undefined} Object with { publisher, name, version, displayName, description, platform, tags } or undefined on failure
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
    const tags = metadata?.Tags?._?.split(",").map((s) => s.trim());
    const displayNameNode =
      metadata.DisplayName || metadata["PackageManifest:DisplayName"];
    const descriptionNode =
      metadata.Description || metadata["PackageManifest:Description"];
    const displayName = displayNameNode?._ || displayNameNode || "";
    const description = descriptionNode?._ || descriptionNode || "";

    // Parse Properties tag for additional metadata
    const properties = {};
    const propsNode = metadata?.Properties;
    if (propsNode?.Property) {
      const propEntries = Array.isArray(propsNode.Property)
        ? propsNode.Property
        : [propsNode.Property];
      for (const prop of propEntries) {
        const propId = prop?.$?.Id || "";
        const propValue = prop?.$?.Value || "";
        if (propId && propValue) {
          properties[propId] = propValue;
        }
      }
    }

    const result = {
      publisher: publisher,
      name: name,
      version,
      displayName: typeof displayName === "string" ? displayName : "",
      description: typeof description === "string" ? description : "",
      platform: targetPlatform || "",
      tags,
    };

    // Map well-known VSIX properties to structured fields
    if (properties["Microsoft.VisualStudio.Code.Engine"]) {
      result.vscodeEngine = properties["Microsoft.VisualStudio.Code.Engine"];
    }
    if (properties["Microsoft.VisualStudio.Code.ExtensionDependencies"]) {
      const deps =
        properties["Microsoft.VisualStudio.Code.ExtensionDependencies"];
      if (deps) {
        result.extensionDependencies = deps.split(",").map((s) => s.trim());
      }
    }
    if (properties["Microsoft.VisualStudio.Code.ExtensionPack"]) {
      const pack = properties["Microsoft.VisualStudio.Code.ExtensionPack"];
      if (pack) {
        result.extensionPack = pack.split(",").map((s) => s.trim());
      }
    }
    if (properties["Microsoft.VisualStudio.Code.ExtensionKind"]) {
      const kind = properties["Microsoft.VisualStudio.Code.ExtensionKind"];
      if (kind) {
        result.extensionKind = kind.split(",").map((s) => s.trim());
      }
    }
    if (properties["Microsoft.VisualStudio.Code.ExecutesCode"]) {
      result.executesCode =
        properties["Microsoft.VisualStudio.Code.ExecutesCode"] === "true";
    }
    // Collect links from properties
    const links = {};
    for (const [id, value] of Object.entries(properties)) {
      if (id.startsWith("Microsoft.VisualStudio.Services.Links.") && value) {
        const linkType = id.replace(
          "Microsoft.VisualStudio.Services.Links.",
          "",
        );
        links[linkType] = value;
      }
    }
    if (Object.keys(links).length) {
      result.links = links;
    }

    return result;
  } catch (e) {
    if (DEBUG_MODE) {
      console.log("Error parsing vsixmanifest:", e.message);
    }
    return undefined;
  }
}

/**
 * Parse npm-style dependency maps from a VS Code extension's package.json
 * and create CycloneDX component objects with versionRange attributes.
 *
 * @param {Object} pkg Parsed package.json object
 * @param {string} extensionPurl The purl of the parent extension (for dependency tree)
 * @returns {{ components: Object[], dependencies: Object[] }} CycloneDX components and dependency tree
 */
export function parseExtensionDependencies(pkg, extensionPurl) {
  const components = [];
  const dependsOn = [];
  const seen = new Set();

  const depGroups = [
    { key: "dependencies", scope: "required" },
    { key: "devDependencies", scope: "optional" },
    { key: "peerDependencies", scope: "optional" },
    { key: "optionalDependencies", scope: "optional" },
  ];

  for (const { key, scope } of depGroups) {
    const deps = pkg[key];
    if (!deps || typeof deps !== "object") {
      continue;
    }
    for (const [depName, depVersion] of Object.entries(deps)) {
      if (!depName || typeof depVersion !== "string") {
        continue;
      }
      // Parse scoped npm package names
      let group = "";
      let name = depName;
      if (depName.startsWith("@") && depName.includes("/")) {
        const parts = depName.split("/");
        group = parts[0];
        name = parts.slice(1).join("/");
      }
      const purlObj = new PackageURL(
        "npm",
        group || null,
        name,
        null,
        null,
        null,
      );
      const purlString = purlObj.toString();
      if (seen.has(purlString)) {
        continue;
      }
      seen.add(purlString);
      const versRange = toVersRange(depVersion);
      const component = {
        group,
        name,
        purl: purlString,
        "bom-ref": decodeURIComponent(purlString),
        type: "library",
        scope,
      };
      if (versRange) {
        component.versionRange = versRange;
      }
      components.push(component);
      dependsOn.push(decodeURIComponent(purlString));
    }
  }

  const dependencies = [];
  if (extensionPurl && dependsOn.length) {
    dependencies.push({
      ref: decodeURIComponent(extensionPurl),
      dependsOn: dependsOn.sort(),
    });
  }

  return { components, dependencies };
}

/**
 * Parse a VS Code extension's `package.json` and extract metadata
 * including deep capability and permission information.
 *
 * @param {string|Object} packageJsonData Either raw JSON string or parsed object
 * @param {string} [srcPath] Optional path to the source directory for evidence
 * @returns {Object|undefined} Object with metadata and capabilities or undefined
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
    const externalReferences = [];
    if (pkg.repository?.url) {
      externalReferences.push({ type: "vcs", url: pkg.repository.url });
    }
    return {
      publisher: pkg.publisher || "",
      name: pkg.name || "",
      version: pkg.version || "",
      displayName: pkg.displayName || "",
      description: pkg.description || "",
      platform: "",
      srcPath,
      externalReferences: externalReferences.length
        ? externalReferences
        : undefined,
      capabilities: extractExtensionCapabilities(pkg),
      dependencies: pkg.dependencies,
      devDependencies: pkg.devDependencies,
      peerDependencies: pkg.peerDependencies,
      optionalDependencies: pkg.optionalDependencies,
    };
  } catch (e) {
    if (DEBUG_MODE) {
      console.log("Error parsing extension package.json:", e.message);
    }
    return undefined;
  }
}

/**
 * Extract deep capability and permission information from a VS Code
 * extension package.json.
 *
 * This captures security-relevant metadata such as:
 * - activationEvents: when the extension activates (e.g., `*` means always)
 * - extensionKind: where the extension runs (ui, workspace, or both)
 * - permissions: workspace trust, virtual workspace support
 * - contributes: commands, debuggers, terminal profiles, task providers, fs providers
 * - extensionDependencies/extensionPack: required extensions
 * - scripts: whether postinstall or other lifecycle scripts exist
 * - main/browser: entry points for analysis
 *
 * @param {Object} pkg Parsed package.json object
 * @returns {Object} Capabilities object with structured metadata
 */
export function extractExtensionCapabilities(pkg) {
  if (!pkg) {
    return {};
  }
  const capabilities = {};

  // Activation events - security relevant: "*" means the extension activates for every workspace
  if (pkg.activationEvents?.length) {
    capabilities.activationEvents = pkg.activationEvents;
  }

  // Extension kind - where the extension runs (ui=local, workspace=remote, both)
  if (pkg.extensionKind?.length) {
    capabilities.extensionKind = pkg.extensionKind;
  }

  // Extension dependencies - other extensions this requires
  if (pkg.extensionDependencies?.length) {
    capabilities.extensionDependencies = pkg.extensionDependencies;
  }

  // Extension pack - bundled extensions
  if (pkg.extensionPack?.length) {
    capabilities.extensionPack = pkg.extensionPack;
  }

  // Workspace trust configuration
  if (pkg.capabilities?.untrustedWorkspaces) {
    capabilities.untrustedWorkspaces = pkg.capabilities.untrustedWorkspaces;
  }
  if (pkg.capabilities?.virtualWorkspaces) {
    capabilities.virtualWorkspaces = pkg.capabilities.virtualWorkspaces;
  }

  // Contributed features
  const contributes = pkg.contributes || {};
  const contributedFeatures = [];
  for (const feature of [
    "authentication",
    "breakpoints",
    "commands",
    "chatInstructions",
    "chatPromptFiles",
    "customEditors",
    "configuration",
    "debuggers",
    "taskDefinitions",
    "terminal",
    "views",
  ]) {
    if (contributes[feature]?.length) {
      contributedFeatures.push(
        `${feature}:count:${contributes[feature].length}`,
      );
    }
  }
  if (contributes.terminal?.length || contributes.taskDefinitions?.length) {
    contributedFeatures.push("terminal-access");
  }
  if (contributes["terminal.profiles"]?.length) {
    contributedFeatures.push("terminal-profiles");
  }
  if (
    contributes.typescriptServerPlugins?.length ||
    contributes.jsonValidation?.length
  ) {
    contributedFeatures.push("language-server-plugins");
  }
  if (
    contributes["resourceLabelFormatters"]?.length ||
    contributes["fileSystemProviders"]?.length
  ) {
    contributedFeatures.push("filesystem-provider");
  }
  if (contributes.authentication?.length) {
    contributedFeatures.push("authentication-provider");
  }
  if (contributes.walkthroughs?.length) {
    contributedFeatures.push("walkthroughs");
  }
  if (contributedFeatures.length) {
    capabilities.contributes = contributedFeatures;
  }
  if (pkg.main) {
    capabilities.main = pkg.main;
  }
  if (pkg.browser) {
    capabilities.browser = pkg.browser;
  }
  const scripts = pkg.scripts || {};
  const lifecycleScripts = [];
  for (const scriptName of [
    "postinstall",
    "preinstall",
    "install",
    "prepare",
    "prepublish",
    "vscode:prepublish",
    "vscode:uninstall",
  ]) {
    if (scripts[scriptName]) {
      lifecycleScripts.push(scriptName);
    }
  }
  if (lifecycleScripts.length) {
    capabilities.lifecycleScripts = lifecycleScripts;
  }

  return capabilities;
}

/**
 * Convert parsed extension metadata into a CycloneDX component object.
 *
 * @param {Object} extInfo Object with { publisher, name, version, displayName, description, platform, srcPath, capabilities }
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
  // Add capability properties from deep extension analysis
  const caps = extInfo.capabilities || {};
  if (caps.activationEvents?.length) {
    props.push({
      name: "cdx:vscode-extension:activationEvents",
      value: caps.activationEvents.join(", "),
    });
  }
  // extensionKind can come from capabilities (package.json) or directly from manifest Properties
  const extensionKind = caps.extensionKind || extInfo.extensionKind;
  if (extensionKind?.length) {
    props.push({
      name: "cdx:vscode-extension:extensionKind",
      value: extensionKind.join(", "),
    });
  }
  // extensionDependencies can come from capabilities or manifest Properties
  const extensionDeps =
    caps.extensionDependencies || extInfo.extensionDependencies;
  if (extensionDeps?.length) {
    props.push({
      name: "cdx:vscode-extension:extensionDependencies",
      value: extensionDeps.join(", "),
    });
  }
  // extensionPack can come from capabilities or manifest Properties
  const extensionPack = caps.extensionPack || extInfo.extensionPack;
  if (extensionPack?.length) {
    props.push({
      name: "cdx:vscode-extension:extensionPack",
      value: extensionPack.join(", "),
    });
  }
  if (caps.untrustedWorkspaces !== undefined) {
    const uws = caps.untrustedWorkspaces;
    props.push({
      name: "cdx:vscode-extension:untrustedWorkspaces",
      value:
        typeof uws === "object" && uws.supported !== undefined
          ? String(uws.supported)
          : String(uws),
    });
  }
  if (caps.virtualWorkspaces !== undefined) {
    const vws = caps.virtualWorkspaces;
    props.push({
      name: "cdx:vscode-extension:virtualWorkspaces",
      value:
        typeof vws === "object" && vws.supported !== undefined
          ? String(vws.supported)
          : String(vws),
    });
  }
  if (caps.contributes?.length) {
    props.push({
      name: "cdx:vscode-extension:contributes",
      value: caps.contributes.join(", "),
    });
  }
  if (caps.main) {
    props.push({ name: "cdx:vscode-extension:main", value: caps.main });
  }
  if (caps.browser) {
    props.push({ name: "cdx:vscode-extension:browser", value: caps.browser });
  }
  if (caps.lifecycleScripts?.length) {
    props.push({
      name: "cdx:vscode-extension:lifecycleScripts",
      value: caps.lifecycleScripts.join(", "),
    });
  }
  // Properties from vsixmanifest Properties tag
  if (extInfo.executesCode !== undefined) {
    props.push({
      name: "cdx:vscode-extension:executesCode",
      value: String(extInfo.executesCode),
    });
  }
  if (extInfo.vscodeEngine) {
    props.push({
      name: "cdx:vscode-extension:vscodeEngine",
      value: extInfo.vscodeEngine,
    });
  }
  if (props.length) {
    component.properties = props;
  }
  // Build externalReferences from links (manifest Properties) or from package.json repository
  const externalRefs = [];
  if (extInfo.externalReferences?.length) {
    externalRefs.push(...extInfo.externalReferences);
  }
  if (extInfo.links) {
    if (extInfo.links.Source || extInfo.links.GitHub) {
      const vcsUrl = extInfo.links.Source || extInfo.links.GitHub;
      if (!externalRefs.some((r) => r.type === "vcs")) {
        externalRefs.push({ type: "vcs", url: vcsUrl });
      }
    }
    if (extInfo.links.Support) {
      externalRefs.push({ type: "issue-tracker", url: extInfo.links.Support });
    }
    if (extInfo.links.Learn) {
      externalRefs.push({ type: "documentation", url: extInfo.links.Learn });
    }
    if (extInfo.links.Getstarted) {
      externalRefs.push({ type: "website", url: extInfo.links.Getstarted });
    }
  }
  if (externalRefs.length) {
    component.externalReferences = externalRefs;
  }
  component.evidence = {
    identity: {
      field: "purl",
      confidence: MANIFEST_ANALYSIS_CONFIDENCE,
      methods: [
        {
          technique: "manifest-analysis",
          confidence: MANIFEST_ANALYSIS_CONFIDENCE,
          value: extInfo.srcPath || "",
        },
      ],
    },
  };
  return component;
}

/**
 * Extract a `.vsix` file (ZIP archive) to a temporary directory for deep
 * analysis. The caller is responsible for cleaning up the temp directory.
 *
 * @param {string} vsixFile Absolute path to the `.vsix` file
 * @returns {Promise<string|undefined>} Path to the extracted temp directory, or undefined on failure
 */
export async function extractVsixToTempDir(vsixFile) {
  let tempDir;
  let zip;
  try {
    tempDir = mkdtempSync(join(getTmpDir(), "vsix-deps-"));
    zip = new StreamZip.async({ file: vsixFile });
    await zip.extract(null, tempDir);
    // Most vsix files have content under extension/ subdirectory
    const extensionSubDir = join(tempDir, "extension");
    if (safeExistsSync(extensionSubDir)) {
      return extensionSubDir;
    }
    return tempDir;
  } catch (e) {
    if (DEBUG_MODE) {
      console.log(`Error extracting vsix file ${vsixFile}:`, e.message);
    }
    cleanupTempDir(tempDir);
    return undefined;
  } finally {
    if (zip) {
      try {
        await zip.close();
      } catch (_e) {
        // Best effort close
      }
    }
  }
}

/**
 * Clean up a temporary directory created during vsix extraction.
 *
 * @param {string} tempDir Path to the temp directory to remove
 */
export function cleanupTempDir(tempDir) {
  if (!tempDir) {
    return;
  }
  // The tempDir might be a subdirectory (e.g., "extension" inside the actual temp dir)
  // Walk up to verify the parent is under the temp base
  const resolvedDir = resolve(tempDir);
  const dirToRemove =
    basename(resolvedDir) === "extension"
      ? resolve(resolvedDir, "..")
      : resolvedDir;
  try {
    // Safety: only remove dirs that are direct children of the temp base with vsix-deps- prefix
    const expectedBase = resolve(getTmpDir());
    const dirBaseName = basename(dirToRemove);
    if (
      dirBaseName.startsWith("vsix-deps-") &&
      resolve(dirToRemove, "..") === expectedBase
    ) {
      rmSync(dirToRemove, { recursive: true, force: true });
    }
  } catch (_e) {
    // Best effort cleanup
  }
}

/**
 * Parse a `.vsix` file (ZIP archive) and extract the extension metadata.
 *
 * @param {string} vsixFile Absolute path to the `.vsix` file
 * @returns {Promise<Object|undefined>} CycloneDX component object or undefined
 */
export async function parseVsixFile(vsixFile) {
  let zip;
  try {
    zip = new StreamZip.async({ file: vsixFile });
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

    if (extInfo) {
      return toComponent(extInfo);
    }
    return undefined;
  } catch (e) {
    if (DEBUG_MODE) {
      console.log(`Error parsing vsix file ${vsixFile}:`, e.message);
    }
    return undefined;
  } finally {
    if (zip) {
      try {
        await zip.close();
      } catch (_e) {
        // Best effort close
      }
    }
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
      publisher: publisher,
      name: name,
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

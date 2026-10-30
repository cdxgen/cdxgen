import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { build, Purl } from "@cdxgen/cdx-purl";
import StreamZip from "node-stream-zip";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import {
  hashRegularFile,
  isRunningAsRoot,
  readRegularTextFile,
  readUserFileText,
} from "../core/boundedFile.js";
import {
  getTmpDir,
  safeExistsSync,
  safeExtractArchive,
  safeMkdtempSync,
  safeRmSync,
} from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { isMac, isWin, redactHomePath } from "../core/paths.js";
import { sanitizeBomUrl } from "../core/propertySanitizer.js";
import {
  normalizeVscodeTargetPlatform,
  parseVscodeExtensionDirName,
} from "../parsers/vscodeExtensionId.js";
import { xml2js } from "../parsers/xml.js";
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
 * Namespace of the `pkg:generic` purl given to an installed editor, which has
 * no package type of its own.
 */
export const IDE_PURL_NAMESPACE = "cdxgen-ide";

/**
 * VS Code-family editors and remote servers whose installed extensions cdxgen
 * can inventory.
 *
 * Every editor built from VS Code installs extensions into
 * `<home>/<dataFolderName>/extensions` on Windows, macOS and Linux alike, and
 * its remote server installs them into `<home>/<serverDataFolderName>/extensions`
 * on the remote host. Settings and global storage live elsewhere (for example
 * `~/Library/Application Support/Cursor/User`), and that folder never holds
 * extensions.
 *
 * `apps` lists where the editor itself is installed, relative to the
 * platform's application folders, so its version can be read from
 * `resources/app/product.json` and `package.json`.
 */
export const IDE_PRODUCTS = [
  {
    id: "vscode",
    name: "VS Code",
    dataFolderName: ".vscode",
    serverDataFolderName: ".vscode-server",
    apps: {
      darwin: ["Visual Studio Code.app"],
      linux: [
        "/usr/share/code",
        "/opt/visual-studio-code",
        "/snap/code/current/usr/share/code",
      ],
      win32: ["Microsoft VS Code"],
    },
  },
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    dataFolderName: ".vscode-insiders",
    serverDataFolderName: ".vscode-server-insiders",
    apps: {
      darwin: ["Visual Studio Code - Insiders.app"],
      linux: [
        "/usr/share/code-insiders",
        "/snap/code-insiders/current/usr/share/code-insiders",
      ],
      win32: ["Microsoft VS Code Insiders"],
    },
  },
  {
    // VSCodium keeps the Code - OSS data folder, so a self-built Code - OSS
    // shares it.
    id: "vscodium",
    name: "VSCodium",
    dataFolderName: ".vscode-oss",
    serverDataFolderName: ".vscodium-server",
    apps: {
      darwin: ["VSCodium.app"],
      linux: [
        "/usr/share/codium",
        "/opt/vscodium-bin",
        "/snap/codium/current/usr/share/codium",
      ],
      win32: ["VSCodium"],
    },
  },
  {
    id: "vscodium-insiders",
    name: "VSCodium Insiders",
    dataFolderName: ".vscodium-insiders",
    serverDataFolderName: ".vscodium-server-insiders",
    apps: {
      darwin: ["VSCodium - Insiders.app"],
      linux: ["/usr/share/codium-insiders"],
      win32: ["VSCodium Insiders"],
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    dataFolderName: ".cursor",
    serverDataFolderName: ".cursor-server",
    apps: {
      darwin: ["Cursor.app"],
      linux: ["/usr/share/cursor", "/opt/Cursor", "/opt/cursor"],
      win32: ["cursor"],
    },
  },
  {
    id: "windsurf",
    name: "Windsurf",
    dataFolderName: ".windsurf",
    serverDataFolderName: ".windsurf-server",
    apps: {
      darwin: ["Windsurf.app"],
      linux: ["/usr/share/windsurf", "/opt/Windsurf", "/opt/windsurf"],
      win32: ["Windsurf"],
    },
  },
  {
    id: "windsurf-next",
    name: "Windsurf Next",
    dataFolderName: ".windsurf-next",
    serverDataFolderName: ".windsurf-next-server",
    apps: {
      darwin: ["Windsurf - Next.app"],
      linux: ["/usr/share/windsurf-next"],
      win32: ["Windsurf Next"],
    },
  },
  {
    // Windsurf was renamed Devin Desktop, and new installs use these folders.
    id: "devin-desktop",
    name: "Devin Desktop",
    dataFolderName: ".devin",
    serverDataFolderName: ".devin-server",
    apps: {
      darwin: ["Devin.app", "Devin Desktop.app"],
      linux: ["/usr/share/devin"],
      win32: ["Devin"],
    },
  },
  {
    id: "positron",
    name: "Positron",
    dataFolderName: ".positron",
    serverDataFolderName: ".positron-server",
    apps: {
      darwin: ["Positron.app"],
      linux: ["/usr/share/positron", "/usr/lib/positron"],
      win32: ["Positron"],
    },
  },
  {
    id: "kiro",
    name: "Kiro",
    dataFolderName: ".kiro",
    serverDataFolderName: ".kiro-server",
    apps: {
      darwin: ["Kiro.app"],
      linux: ["/usr/share/kiro", "/opt/Kiro"],
      win32: ["Kiro"],
    },
  },
  {
    id: "trae",
    name: "Trae",
    dataFolderName: ".trae",
    serverDataFolderName: ".trae-server",
    apps: {
      darwin: ["Trae.app"],
      linux: ["/usr/share/trae"],
      win32: ["Trae"],
    },
  },
  {
    id: "antigravity",
    name: "Antigravity",
    dataFolderName: ".antigravity",
    serverDataFolderName: ".antigravity-server",
    apps: {
      darwin: ["Antigravity.app"],
      linux: ["/usr/share/antigravity"],
      win32: ["Antigravity"],
    },
  },
  {
    id: "antigravity-ide",
    name: "Antigravity IDE",
    dataFolderName: ".antigravity-ide",
    serverDataFolderName: ".antigravity-ide-server",
    apps: {
      darwin: ["Antigravity IDE.app"],
      linux: ["/usr/share/antigravity-ide"],
      win32: ["Antigravity IDE"],
    },
  },
  {
    id: "qoder",
    name: "Qoder",
    dataFolderName: ".qoder",
    serverDataFolderName: ".qoder-server",
    apps: { darwin: ["Qoder.app"], linux: [], win32: ["Qoder"] },
  },
  {
    id: "void",
    name: "Void",
    dataFolderName: ".void-editor",
    serverDataFolderName: ".void-server",
    apps: { darwin: ["Void.app"], linux: ["/usr/share/void"], win32: ["Void"] },
  },
  {
    id: "pearai",
    name: "PearAI",
    dataFolderName: ".pearai",
    serverDataFolderName: ".pearai-server",
    apps: { darwin: ["PearAI.app"], linux: [], win32: ["PearAI"] },
  },
  {
    id: "theia",
    name: "Theia IDE",
    dataFolderName: ".theia-ide",
    apps: {},
  },
  {
    id: "theia-legacy",
    name: "Theia",
    dataFolderName: ".theia",
    apps: {},
  },
];

/**
 * Remote and hosted servers that are not tied to one desktop editor.
 * `appDirs` lists where the server itself is installed, so its version can be
 * read.
 */
const REMOTE_EXTENSION_HOSTS = [
  {
    id: "code-server",
    name: "code-server",
    dirs: (_home, xdgDataHome) => [
      join(xdgDataHome, "code-server", "extensions"),
    ],
    // The deb and rpm packages install into /usr/lib/code-server, and the
    // standalone installer into ~/.local/lib/code-server-<version>. Its
    // product.json, which carries codeServerVersion, is in lib/vscode.
    appDirs: (home) => [
      join("/usr", "lib", "code-server", "lib", "vscode"),
      ...listChildDirs(join(home, ".local", "lib"))
        .filter((name) => name.startsWith("code-server-"))
        .map((name) => join(home, ".local", "lib", name, "lib", "vscode")),
    ],
  },
  {
    id: "openvscode-server",
    name: "OpenVSCode Server",
    dirs: (home) => [join(home, ".openvscode-server", "extensions")],
  },
  {
    id: "vscode-remote",
    name: "VS Code Remote",
    dirs: (home) => [join(home, ".vscode-remote", "extensions")],
  },
];

// Largest editor metadata file read: product.json, package.json and the
// .vsixmanifest of one extension, and .obsolete.
const MAX_METADATA_FILE_BYTES = 8 * 1024 * 1024;
// extensions.json lists every installed extension and grows with them.
const MAX_REGISTRY_FILE_BYTES = 32 * 1024 * 1024;
// Most remote server builds a host keeps, and most extension folders, read
// from one directory.
const MAX_SERVER_BUILDS = 64;
const MAX_EXTENSION_FOLDERS = 10000;

/**
 * List the names of the folders in a directory, or nothing when it cannot be
 * read. A symlink to a folder counts as a folder except when the scan runs as
 * root.
 *
 * @param {string} dir Directory
 * @param {number} [limit] Most names returned
 * @returns {string[]} Folder names
 */
function listChildDirs(dir, limit = MAX_EXTENSION_FOLDERS) {
  if (!safeExistsSync(dir)) {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    if (names.length >= limit) {
      break;
    }
    if (entry.isDirectory()) {
      names.push(entry.name);
    } else if (entry.isSymbolicLink() && !isRunningAsRoot()) {
      try {
        if (statSync(join(dir, entry.name)).isDirectory()) {
          names.push(entry.name);
        }
      } catch {
        // dangling link
      }
    }
  }
  return names;
}

/**
 * The XDG data folder for a home. The environment only describes the current
 * user, so another home, such as a fixture or another user's home in a root
 * scan, uses the default.
 *
 * @param {string} home Home directory
 * @returns {string} Data folder
 */
function xdgDataHomeFor(home) {
  const defaultDir = join(home, ".local", "share");
  if (home !== homedir()) {
    return defaultDir;
  }
  return readEnvironmentVariable("XDG_DATA_HOME") || defaultDir;
}

/**
 * Describe where each known editor and remote server installs extensions for
 * the given home directory.
 *
 * Each desktop editor contributes one entry for its own extensions folder and,
 * when it has a remote server, a second entry for the server's folder. For the
 * current user's home, the `VSCODE_EXTENSIONS` environment variable, which VS
 * Code reads in place of the default folder, adds one more entry.
 *
 * @param {string} [home] Home directory to resolve the folders against
 * @returns {Array<{id: string, name: string, kind: string, dirs: string[]}>}
 *   One entry per editor or server, with `kind` set to `desktop` or `server`
 */
export function getIdeExtensionDirs(home = homedir()) {
  const xdgDataHome = xdgDataHomeFor(home);
  const entries = [];
  for (const product of IDE_PRODUCTS) {
    entries.push({
      id: product.id,
      name: product.name,
      kind: "desktop",
      dirs: [join(home, product.dataFolderName, "extensions")],
    });
    if (product.serverDataFolderName) {
      entries.push({
        id: `${product.id}-server`,
        name: `${product.name} Server`,
        kind: "server",
        dirs: [join(home, product.serverDataFolderName, "extensions")],
      });
    }
  }
  for (const host of REMOTE_EXTENSION_HOSTS) {
    entries.push({
      id: host.id,
      name: host.name,
      kind: "server",
      dirs: host.dirs(home, xdgDataHome),
    });
  }
  const overrideDir =
    home === homedir() ? readEnvironmentVariable("VSCODE_EXTENSIONS") : "";
  if (overrideDir) {
    entries.push({
      id: "vscode",
      name: "VS Code",
      kind: "desktop",
      dirs: [resolve(overrideDir)],
    });
  }
  return entries;
}

/**
 * True when a path, or the folder holding it, is a symlink. A root scan does
 * not follow these, because a user could point them at files only root reads.
 *
 * @param {string} dir Extensions folder
 * @returns {boolean} true when either is a symlink
 */
function isLinkedFolder(dir) {
  for (const candidate of [dir, dirname(dir)]) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        return true;
      }
    } catch {
      // missing
    }
  }
  return false;
}

/**
 * Discover the extension folders that exist for the given home directory.
 *
 * @param {string} [home] Home directory to resolve the folders against
 * @returns {Array<{id: string, name: string, kind: string, dir: string, home: string}>}
 *   One entry per existing folder
 */
export function discoverIdeExtensionDirs(home = homedir()) {
  const found = [];
  const seenDirs = new Set();
  for (const ide of getIdeExtensionDirs(home)) {
    for (const dir of ide.dirs) {
      if (seenDirs.has(dir) || !safeExistsSync(dir)) {
        continue;
      }
      if (isRunningAsRoot() && isLinkedFolder(dir)) {
        thoughtLog(
          `Skipping ${dir}: a root scan does not follow a symlinked extensions folder.`,
        );
        continue;
      }
      seenDirs.add(dir);
      found.push({ id: ide.id, name: ide.name, kind: ide.kind, dir, home });
    }
  }
  return found;
}

/**
 * Find the editor or server an extensions folder belongs to from its path,
 * such as `~/.cursor/extensions` or `/home/dev/.cursor-server/extensions`.
 *
 * @param {string} extensionsDir Path to an extensions folder
 * @returns {{id: string, name: string, kind: string, home: string}|undefined}
 *   The match, with the home folder it sits in, or undefined for a folder no
 *   known editor uses
 */
export function identifyIdeFromExtensionsDir(extensionsDir) {
  const resolved = resolve(extensionsDir);
  const segments = resolved.split(/[/\\]/u).filter((segment) => segment.length);
  if (segments[segments.length - 1] !== "extensions" || segments.length < 2) {
    return undefined;
  }
  const parent = segments[segments.length - 2];
  const dataHome = dirname(dirname(resolved));
  for (const product of IDE_PRODUCTS) {
    if (parent === product.dataFolderName) {
      return {
        id: product.id,
        name: product.name,
        kind: "desktop",
        home: dataHome,
      };
    }
    if (
      product.serverDataFolderName &&
      parent === product.serverDataFolderName
    ) {
      return {
        id: `${product.id}-server`,
        name: `${product.name} Server`,
        kind: "server",
        home: dataHome,
      };
    }
  }
  if (parent === "code-server") {
    // ~/.local/share/code-server/extensions
    return {
      id: "code-server",
      name: "code-server",
      kind: "server",
      home: dirname(dirname(dataHome)),
    };
  }
  if (parent === ".openvscode-server") {
    return {
      id: "openvscode-server",
      name: "OpenVSCode Server",
      kind: "server",
      home: dataHome,
    };
  }
  if (parent === ".vscode-remote") {
    return {
      id: "vscode-remote",
      name: "VS Code Remote",
      kind: "server",
      home: dataHome,
    };
  }
  return undefined;
}

/**
 * Candidate `resources/app` folders for an installed desktop editor on the
 * current platform.
 *
 * @param {Object} product Entry from IDE_PRODUCTS
 * @param {string} home Home directory
 * @returns {string[]} Candidate folders, which may not exist
 */
function ideAppResourceDirs(product, home) {
  const apps = product.apps || {};
  if (isMac) {
    return (apps.darwin || []).flatMap((bundle) => [
      join("/Applications", bundle, "Contents", "Resources", "app"),
      join(home, "Applications", bundle, "Contents", "Resources", "app"),
    ]);
  }
  if (isWin) {
    const ownHome = home === homedir();
    const localAppData =
      (ownHome && readEnvironmentVariable("LOCALAPPDATA")) ||
      join(home, "AppData", "Local");
    const programFiles =
      readEnvironmentVariable("ProgramFiles") || "C:\\Program Files";
    return (apps.win32 || []).flatMap((dirName) => [
      join(localAppData, "Programs", dirName, "resources", "app"),
      join(programFiles, dirName, "resources", "app"),
    ]);
  }
  return (apps.linux || []).map((dir) => join(dir, "resources", "app"));
}

/**
 * Candidate `product.json` folders for the remote server an editor installs on
 * a remote host. Newer servers live under `cli/servers/<quality>-<commit>/server`
 * and older ones under `bin/<commit>`.
 *
 * @param {Object} product Entry from IDE_PRODUCTS
 * @param {string} home Home directory
 * @returns {string[]} Existing server folders
 */
function ideServerResourceDirs(product, home) {
  if (!product.serverDataFolderName) {
    return [];
  }
  const root = join(home, product.serverDataFolderName);
  return [
    ...listChildDirs(join(root, "cli", "servers"), MAX_SERVER_BUILDS).map(
      (name) => join(root, "cli", "servers", name, "server"),
    ),
    ...listChildDirs(join(root, "bin"), MAX_SERVER_BUILDS).map((name) =>
      join(root, "bin", name),
    ),
  ];
}

function readJsonFile(filePath, maxBytes = MAX_METADATA_FILE_BYTES) {
  try {
    const text = readUserFileText(filePath, maxBytes);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function boundedString(value, maxLength = 256) {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : undefined;
}

/**
 * Read an editor's identity from the `product.json` and `package.json` in its
 * `resources/app` folder (or the root of a remote server).
 *
 * Forks report their own release in different fields of `product.json`:
 * `version` (Cursor, Kiro), `windsurfVersion` (Windsurf and Devin Desktop),
 * `positronVersion`, `appVersion` (Trae) and `codeServerVersion`. VS Code
 * itself has none of these and keeps its release in `package.json`, as every
 * fork does for the VS Code release it is based on.
 *
 * @param {string} appDir Folder holding `product.json`
 * @returns {Object|undefined} `{ version, vscodeVersion, commit, quality,
 *   nameLong, dataFolderName, serverDataFolderName, appDir }`, or undefined
 *   when there is no product.json
 */
export function readIdeProductInfo(appDir) {
  const product = readJsonFile(join(appDir, "product.json"));
  if (!product || typeof product !== "object" || Array.isArray(product)) {
    return undefined;
  }
  const pkg = readJsonFile(join(appDir, "package.json")) || {};
  const ownVersion = [
    product.windsurfVersion,
    product.positronVersion,
    product.codeServerVersion,
    product.appVersion,
    product.version,
  ]
    .map((value) => boundedString(value, 64))
    .find(Boolean);
  const vscodeVersion = [product.vscodeVersion, pkg.version]
    .map((value) => boundedString(value, 64))
    .find(Boolean);
  return {
    version: ownVersion || boundedString(pkg.version, 64),
    vscodeVersion,
    commit: boundedString(product.commit, 64),
    quality: boundedString(product.quality, 32),
    nameLong: boundedString(product.nameLong, 128),
    applicationName: boundedString(product.applicationName, 64),
    dataFolderName: boundedString(product.dataFolderName, 64),
    serverDataFolderName: boundedString(product.serverDataFolderName, 64),
    appDir,
  };
}

const productInfoCache = new Map();

/**
 * Find the installed editor (or remote server) for an extensions folder and
 * read its identity.
 *
 * A remote server is looked up in the home the folder is in. A desktop editor
 * and code-server are looked up in the application folders of the machine
 * running cdxgen, so that lookup happens only when `probeApps` is true: for a
 * scan of this host, not for a folder copied from another machine.
 *
 * @param {{id: string, kind: string}} ide Entry from discoverIdeExtensionDirs
 * @param {string} [home] Home directory
 * @param {Object} [options] Lookup options
 * @param {boolean} [options.probeApps] Look in this machine's application
 *   folders; defaults to true only for the current user's home
 * @param {string[]} [options.appDirs] Folders to read in place of the
 *   application folders
 * @returns {Object|undefined} Result of readIdeProductInfo for the newest
 *   installation whose data folder matches, or undefined
 */
export function findIdeProductInfo(ide, home = homedir(), options = {}) {
  const probeApps = options.probeApps ?? home === homedir();
  const cacheKey = `${ide.kind}\u0000${ide.id}\u0000${home}\u0000${probeApps}\u0000${(options.appDirs || []).join("\u0000")}`;
  if (productInfoCache.has(cacheKey)) {
    return productInfoCache.get(cacheKey);
  }
  const productId =
    ide.kind === "server" ? ide.id.replace(/-server$/u, "") : ide.id;
  const product = IDE_PRODUCTS.find((p) => p.id === productId);
  const host = REMOTE_EXTENSION_HOSTS.find((h) => h.id === ide.id);
  let candidates = [];
  if (options.appDirs) {
    candidates = options.appDirs;
  } else if (product && ide.kind === "server") {
    candidates = ideServerResourceDirs(product, home);
  } else if (product && probeApps) {
    candidates = ideAppResourceDirs(product, home);
  } else if (host?.appDirs && probeApps) {
    candidates = host.appDirs(home);
  }
  const infos = [];
  for (const candidate of candidates) {
    const info = readIdeProductInfo(candidate);
    if (!info) {
      continue;
    }
    if (product) {
      const expectedFolder =
        ide.kind === "server"
          ? product.serverDataFolderName
          : product.dataFolderName;
      const actualFolder =
        ide.kind === "server" ? info.serverDataFolderName : info.dataFolderName;
      if (actualFolder && actualFolder !== expectedFolder) {
        continue;
      }
    }
    infos.push(info);
  }
  // A remote host keeps one server per editor release it has connected from.
  // The newest by version is the one in use.
  infos.sort((a, b) =>
    `${b.version || ""}`.localeCompare(`${a.version || ""}`, undefined, {
      numeric: true,
    }),
  );
  productInfoCache.set(cacheKey, infos[0]);
  return infos[0];
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
      const purlObj = new Purl({
        type: "npm",
        namespace: group || null || null,
        name: name,
      });
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
    const repositoryUrl = boundedString(
      typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
      2048,
    );
    const vcsUrl = repositoryUrl ? sanitizeBomUrl(repositoryUrl) : "";
    if (vcsUrl) {
      externalReferences.push({ type: "vcs", url: vcsUrl });
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
 * Keep the string members of a manifest list, each bounded in length, so a
 * crafted package.json cannot put objects or very long text into a property.
 *
 * @param {unknown} value List from package.json
 * @param {number} [maxItems=200] Most members kept
 * @param {number} [maxLength=256] Longest member kept
 * @returns {string[]} The members
 */
function stringList(value, maxItems = 200, maxLength = 256) {
  if (!Array.isArray(value)) {
    return typeof value === "string" ? stringList([value]) : [];
  }
  return value
    .map((item) => boundedString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
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
  const activationEvents = stringList(pkg.activationEvents);
  if (activationEvents.length) {
    capabilities.activationEvents = activationEvents;
  }

  // Extension kind - where the extension runs (ui=local, workspace=remote, both)
  const extensionKind = stringList(pkg.extensionKind);
  if (extensionKind.length) {
    capabilities.extensionKind = extensionKind;
  }

  // Extension dependencies - other extensions this requires
  const extensionDependencies = stringList(pkg.extensionDependencies);
  if (extensionDependencies.length) {
    capabilities.extensionDependencies = extensionDependencies;
  }

  // Extension pack - bundled extensions
  const extensionPack = stringList(pkg.extensionPack);
  if (extensionPack.length) {
    capabilities.extensionPack = extensionPack;
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
  const main = boundedString(pkg.main, 512);
  if (main) {
    capabilities.main = main;
  }
  const browser = boundedString(pkg.browser, 512);
  if (browser) {
    capabilities.browser = browser;
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
 * Read a workspace support declaration, which package.json gives as a boolean,
 * a string such as `limited`, or an object with a `supported` field.
 *
 * @param {unknown} value Declaration from package.json capabilities
 * @returns {string|undefined} `true`, `false`, `limited`, or undefined
 */
function workspaceSupportValue(value) {
  const supported =
    value && typeof value === "object" ? value.supported : value;
  if (typeof supported === "boolean") {
    return String(supported);
  }
  return boundedString(supported, 32);
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
  let purl;
  try {
    purl = build({
      type: VSCODE_EXTENSION_PURL_TYPE,
      namespace: extInfo.publisher || null,
      name: extInfo.name,
      version: extInfo.version || null,
      qualifiers: Object.keys(qualifiers).length ? qualifiers : null,
    });
  } catch {
    purl = null;
  }
  const component = {
    publisher: extInfo.publisher || "",
    group: extInfo.publisher || "",
    name: extInfo.name,
    version: extInfo.version || "",
    description: extInfo.displayName || extInfo.description || "",
    purl,
    "bom-ref": purl ? decodeURIComponent(purl) : extInfo.name,
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
    props.push({ name: "internal:SrcFile", value: extInfo.srcPath });
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
  const uwsValue = workspaceSupportValue(caps.untrustedWorkspaces);
  if (uwsValue) {
    props.push({
      name: "cdx:vscode-extension:untrustedWorkspaces",
      value: uwsValue,
    });
  }
  const vwsValue = workspaceSupportValue(caps.virtualWorkspaces);
  if (vwsValue) {
    props.push({
      name: "cdx:vscode-extension:virtualWorkspaces",
      value: vwsValue,
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
    const link = (value) => {
      const url = boundedString(value, 2048);
      return url ? sanitizeBomUrl(url) : "";
    };
    const vcsUrl = link(extInfo.links.Source) || link(extInfo.links.GitHub);
    if (vcsUrl && !externalRefs.some((r) => r.type === "vcs")) {
      externalRefs.push({ type: "vcs", url: vcsUrl });
    }
    for (const [key, type] of [
      ["Support", "issue-tracker"],
      ["Learn", "documentation"],
      ["Getstarted", "website"],
    ]) {
      const url = link(extInfo.links[key]);
      if (url) {
        externalRefs.push({ type, url });
      }
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

/** Largest .vsix whose SHA-256 is computed. */
const MAX_VSIX_BYTES = 2 * 1024 * 1024 * 1024;

function realpathOrSelf(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * True when a .vsix path is a regular file. A FIFO or a device named `*.vsix`
 * would block or never end, and a root scan does not follow a symlink.
 *
 * @param {string} vsixFile Path to the .vsix
 * @returns {boolean} true when the archive can be opened
 */
export function isReadableVsix(vsixFile) {
  try {
    const link = lstatSync(vsixFile);
    if (link.isSymbolicLink()) {
      return !isRunningAsRoot() && statSync(vsixFile).isFile();
    }
    return link.isFile();
  } catch {
    return false;
  }
}

/**
 * Extract a `.vsix` file (ZIP archive) to a temporary directory for deep
 * analysis. The caller is responsible for cleaning up the temp directory.
 *
 * @param {string} vsixFile Absolute path to the `.vsix` file
 * @returns {Promise<string|undefined>} Path to the extracted temp directory, or undefined on failure
 */
export async function extractVsixToTempDir(vsixFile) {
  if (!isReadableVsix(vsixFile)) {
    return undefined;
  }
  let tempDir;
  let zip;
  try {
    tempDir = safeMkdtempSync(join(getTmpDir(), "vsix-deps-"));
    zip = new StreamZip.async({ file: vsixFile });
    const extracted = await safeExtractArchive(vsixFile, tempDir, async () => {
      await zip.extract(null, tempDir);
    });
    if (!extracted) {
      return undefined;
    }
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
      safeRmSync(dirToRemove, { recursive: true, force: true });
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
  if (!isReadableVsix(vsixFile)) {
    return undefined;
  }
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
      const component = toComponent(extInfo);
      // Marketplaces and security notices publish the SHA-256 of the .vsix
      // itself, so that is the hash that identifies this build.
      const digest = hashRegularFile(
        isRunningAsRoot() ? vsixFile : realpathOrSelf(vsixFile),
        MAX_VSIX_BYTES,
      );
      if (digest) {
        component.hashes = [{ alg: "SHA-256", content: digest }];
      }
      return component;
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
 * Read the install registry an editor keeps beside its extensions.
 *
 * `extensions.json` lists every installed extension with where it came from
 * and when it was installed. `.obsolete` names the folders of extensions that
 * were uninstalled or replaced by an update but are still on disk until the
 * editor next starts. Folder names from either file are only compared with the
 * names in the folder, never turned into paths.
 *
 * @param {string} extensionsDir Extensions folder
 * @returns {{records: Map<string, Object>, obsolete: Set<string>, hasRegistry: boolean}}
 *   Install records keyed by folder name, the obsolete folder names, and
 *   whether an extensions.json was read
 */
export function readInstalledExtensionsRegistry(extensionsDir) {
  const records = new Map();
  const obsolete = new Set();
  const registry = readJsonFile(
    join(extensionsDir, "extensions.json"),
    MAX_REGISTRY_FILE_BYTES,
  );
  if (Array.isArray(registry)) {
    for (const record of registry) {
      if (!record || typeof record !== "object") {
        continue;
      }
      const location = record.location || {};
      const folder =
        boundedString(record.relativeLocation, 512) ||
        basename(
          `${boundedString(location.path || location.fsPath, 4096) || ""}`,
        );
      if (folder) {
        records.set(folder, record);
      }
    }
  }
  const obsoleteMap = readJsonFile(join(extensionsDir, ".obsolete"));
  if (
    obsoleteMap &&
    typeof obsoleteMap === "object" &&
    !Array.isArray(obsoleteMap)
  ) {
    for (const [folder, flag] of Object.entries(obsoleteMap)) {
      if (flag === true) {
        obsolete.add(folder);
      }
    }
  }
  return { records, obsolete, hasRegistry: Array.isArray(registry) };
}

/** Largest extension entry file whose SHA-256 is computed. */
const MAX_HASHED_ENTRY_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Hash the `main` and `browser` entry files of an installed extension the way
 * the extension host resolves them: the path as written, with a `.js` suffix,
 * or as a folder holding `index.js`. Only regular files that stay inside the
 * extension folder are read; a symlink, a FIFO or a path that leaves the
 * folder is not.
 *
 * @param {string} extDir Installed extension folder
 * @param {{main?: string, browser?: string}} entries Entry points from
 *   package.json
 * @returns {Array<{role: string, name: string, digest: string, path: string}>}
 *   One entry per hashed file, with its path relative to the folder
 */
export function hashExtensionEntryFiles(extDir, entries) {
  const files = [];
  const seen = new Set();
  const root = resolve(extDir);
  for (const role of ["main", "browser"]) {
    const entry = boundedString(entries?.[role], 512);
    if (!entry) {
      continue;
    }
    for (const candidate of [entry, `${entry}.js`, join(entry, "index.js")]) {
      const filePath = resolve(root, candidate);
      if (!filePath.startsWith(`${root}${sep}`)) {
        break;
      }
      const digest = hashRegularFile(
        filePath,
        MAX_HASHED_ENTRY_FILE_BYTES,
        root,
      );
      if (!digest) {
        continue;
      }
      if (!seen.has(filePath)) {
        seen.add(filePath);
        files.push({
          role,
          name: relative(root, filePath).replaceAll("\\", "/"),
          digest,
          path: filePath,
        });
      }
      break;
    }
  }
  return files;
}

/**
 * Describe the code an installed extension runs as `file` components with
 * their SHA-256, so the extension can be matched against a published hash of
 * a known good or known bad build.
 *
 * @param {string} extDir Installed extension folder
 * @param {Object} capabilities Capabilities from extractExtensionCapabilities
 * @param {string} parentRef bom-ref of the extension component
 * @returns {Object[]} File components, empty when no entry file is found
 */
export function describeExtensionEntryFiles(extDir, capabilities, parentRef) {
  return hashExtensionEntryFiles(extDir, capabilities).map((file) =>
    toEntryFileComponent(parentRef, file, false),
  );
}

function toEntryFileComponent(parentRef, file, qualifyRef) {
  return {
    type: "file",
    name: file.name,
    "bom-ref": qualifyRef
      ? `${parentRef}#${file.name}@sha256:${file.digest}`
      : `${parentRef}#${file.name}`,
    hashes: [{ alg: "SHA-256", content: file.digest }],
    properties: [
      { name: "cdx:vscode-extension:entryPoint", value: file.role },
      { name: "internal:SrcFile", value: file.path },
    ],
  };
}

const INSTALL_SOURCES = new Set(["gallery", "vsix", "resource"]);
// The largest millisecond value a JavaScript Date holds.
const MAX_DATE_MS = 8.64e15;

function isUuid(value) {
  if (typeof value !== "string") {
    return false;
  }
  const groups = value.split("-");
  const lengths = [8, 4, 4, 4, 12];
  return (
    groups.length === lengths.length &&
    groups.every(
      (group, i) =>
        group.length === lengths[i] &&
        [...group].every((c) => "0123456789abcdefABCDEF".includes(c)),
    )
  );
}

/**
 * Read what an editor's install registry says about one folder, keeping only
 * enumerated values, a UUID and a valid timestamp.
 *
 * @param {Object} [record] Entry from extensions.json
 * @returns {Object} Install state
 */
function installStateFromRecord(record) {
  const metadata =
    record?.metadata && typeof record.metadata === "object"
      ? record.metadata
      : {};
  const state = {};
  if (INSTALL_SOURCES.has(metadata.source)) {
    state.source = metadata.source;
  }
  const installedAt = Number(metadata.installedTimestamp);
  if (
    Number.isFinite(installedAt) &&
    installedAt > 0 &&
    installedAt <= MAX_DATE_MS
  ) {
    state.installedAt = installedAt;
  }
  state.preRelease =
    metadata.isPreReleaseVersion === true || metadata.preRelease === true;
  state.pinned = metadata.pinned === true;
  state.builtin = metadata.isBuiltin === true;
  state.updated = metadata.updated === true;
  if (isUuid(metadata.id)) {
    state.galleryId = metadata.id.toLowerCase();
  } else if (isUuid(record?.identifier?.uuid)) {
    state.galleryId = record.identifier.uuid.toLowerCase();
  }
  return state;
}

/**
 * Record on an extension component what the editors' install registries say
 * about every folder it was found in.
 *
 * Each value describes the whole host: the install sources are all listed, the
 * install time is the earliest, a flag such as `pinned` is set when any copy
 * has it, an extension is pending removal only when every copy is, and it is
 * unregistered when any copy is missing from a registry that exists.
 *
 * @param {Object} component Extension component
 * @param {Object[]} states Install state of each folder
 */
function applyInstallStates(component, states) {
  const props = component.properties || [];
  const addProp = (name, value) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    if (!props.some((p) => p.name === name)) {
      props.push({ name, value: String(value) });
    }
  };
  const sources = [...new Set(states.map((s) => s.source).filter(Boolean))];
  addProp("cdx:vscode-extension:installSource", sources.sort().join(", "));
  const times = states.map((s) => s.installedAt).filter(Boolean);
  if (times.length) {
    addProp(
      "cdx:vscode-extension:installedAt",
      new Date(Math.min(...times)).toISOString(),
    );
  }
  for (const [key, name] of [
    ["preRelease", "cdx:vscode-extension:preRelease"],
    ["pinned", "cdx:vscode-extension:pinned"],
    ["builtin", "cdx:vscode-extension:builtin"],
    ["updated", "cdx:vscode-extension:updated"],
    ["symlink", "cdx:vscode-extension:symlink"],
  ]) {
    if (states.some((s) => s[key])) {
      addProp(name, "true");
    }
  }
  addProp(
    "cdx:vscode-extension:galleryId",
    states.map((s) => s.galleryId).find(Boolean),
  );
  if (states.length && states.every((s) => s.obsolete)) {
    addProp("cdx:vscode-extension:pendingRemoval", "true");
  }
  if (states.some((s) => s.unregistered)) {
    addProp("cdx:vscode-extension:registered", "false");
  }
  if (props.length) {
    component.properties = props;
  }
}

/**
 * Read one installed extension folder as JSON text, only from a regular file
 * inside that folder.
 *
 * @param {string} extDir Extension folder
 * @param {string} fileName File in the folder
 * @returns {string|undefined} File text
 */
function readExtensionFileText(extDir, fileName) {
  return readRegularTextFile(
    join(extDir, fileName),
    MAX_METADATA_FILE_BYTES,
    extDir,
  );
}

/**
 * Parse a single installed extension folder.
 *
 * `package.json` gives the identity and capabilities. The `.vsixmanifest` the
 * editor keeps beside it adds the target platform, links and manifest
 * properties, and the folder name supplies the platform when neither does.
 *
 * @param {string} extDir Absolute path to the extension folder (e.g. `~/.cursor/extensions/anthropic.claude-code-2.1.313-darwin-arm64`)
 * @param {string} [ideName] Name of the editor the folder belongs to
 * @param {Object} [installRecord] Entry for the folder from extensions.json
 * @param {Object} [options] Parse options
 * @param {boolean} [options.nameOnly] Read only the folder name, as a root
 *   scan does for a symlinked folder
 * @returns {Object|undefined} CycloneDX component object or undefined
 */
export function parseInstalledExtensionDir(
  extDir,
  ideName,
  installRecord,
  options = {},
) {
  const dirParts = parseVscodeExtensionDirName(basename(extDir));
  let extInfo;
  let manifestInfo;
  if (!options.nameOnly) {
    const packageJson = readExtensionFileText(extDir, "package.json");
    if (packageJson !== undefined) {
      const parsed = parseVsixPackageJson(packageJson, extDir);
      if (parsed?.name) {
        extInfo = parsed;
      }
    }
    const manifest = readExtensionFileText(extDir, ".vsixmanifest");
    if (manifest !== undefined) {
      manifestInfo = parseVsixManifest(manifest);
    }
  }
  if (!extInfo && manifestInfo) {
    extInfo = { ...manifestInfo, srcPath: extDir };
  } else if (extInfo && manifestInfo) {
    for (const key of [
      "vscodeEngine",
      "executesCode",
      "links",
      "extensionKind",
      "extensionDependencies",
      "extensionPack",
    ]) {
      if (extInfo[key] === undefined && manifestInfo[key] !== undefined) {
        extInfo[key] = manifestInfo[key];
      }
    }
    extInfo.platform = manifestInfo.platform || "";
  }
  if (!extInfo && dirParts) {
    extInfo = {
      publisher: dirParts.publisher,
      name: dirParts.name,
      version: dirParts.version,
      displayName: "",
      description: "",
      platform: "",
      srcPath: extDir,
    };
  }
  if (!extInfo) {
    return undefined;
  }
  extInfo.platform =
    normalizeVscodeTargetPlatform(extInfo.platform) ||
    normalizeVscodeTargetPlatform(installRecord?.metadata?.targetPlatform) ||
    dirParts?.platform ||
    "";
  return toComponent(extInfo, ideName);
}

/**
 * Attempt to extract extension metadata from a directory name following the
 * pattern `publisher.name-version` or `publisher.name-version-platform`.
 *
 * @param {string} extDir Absolute path to extension directory
 * @param {string} [ideName] IDE name
 * @returns {Object|undefined} CycloneDX component or undefined
 */
export function parseExtensionDirName(extDir, ideName) {
  const dirName = extDir
    .split(/[/\\]/)
    .filter((segment) => segment.length)
    .pop();
  const parts = parseVscodeExtensionDirName(dirName);
  if (!parts) {
    return undefined;
  }
  return toComponent(
    {
      publisher: parts.publisher,
      name: parts.name,
      version: parts.version,
      displayName: "",
      description: "",
      platform: parts.platform,
      srcPath: extDir,
    },
    ideName,
  );
}

/**
 * Decide whether a folder is an editor's extensions folder: one at a path a
 * known editor uses, or one holding the `extensions.json` or `.obsolete` an
 * editor writes. A source repository whose subfolders happen to include an
 * extension is not one.
 *
 * @param {string} dir Folder to check
 * @returns {boolean} True when the folder is an extensions folder
 */
export function isInstalledExtensionsDir(dir) {
  if (identifyIdeFromExtensionsDir(dir)) {
    return safeExistsSync(dir);
  }
  return (
    safeExistsSync(join(dir, "extensions.json")) ||
    safeExistsSync(join(dir, ".obsolete"))
  );
}

/**
 * Decide whether a folder is one installed extension: a `.vsixmanifest`, or a
 * package.json with a publisher and a `vscode` engine.
 *
 * @param {string} dir Folder to check
 * @returns {boolean} True for an extension folder
 */
export function isInstalledExtensionDir(dir) {
  if (readExtensionFileText(dir, ".vsixmanifest") !== undefined) {
    return true;
  }
  let pkg;
  try {
    pkg = JSON.parse(readExtensionFileText(dir, "package.json") ?? "");
  } catch {
    return false;
  }
  return Boolean(
    typeof pkg?.publisher === "string" && pkg?.engines?.vscode !== undefined,
  );
}

/**
 * Build a CycloneDX component for an installed editor or remote server.
 *
 * @param {{id: string, name: string, kind: string, dirs?: string[], dir?: string, home?: string}} ide
 *   Discovered extensions folder, or folders, of one editor
 * @param {Object} [productInfo] Result of findIdeProductInfo
 * @param {number} extensionCount Number of extension builds found
 * @returns {Object} CycloneDX application component
 */
export function toIdeComponent(ide, productInfo, extensionCount) {
  const version = productInfo?.version;
  let purl;
  try {
    purl = build({
      type: "generic",
      namespace: IDE_PURL_NAMESPACE,
      name: ide.id,
      version: version || null,
    });
  } catch {
    purl = undefined;
  }
  const dirs = ide.dirs || [ide.dir];
  const properties = [
    { name: "cdx:ide:id", value: ide.id },
    { name: "cdx:ide:kind", value: ide.kind },
    {
      name: "cdx:ide:extensionsDir",
      value: [...new Set(dirs.map((d) => redactHomePath(d, ide.home)))].join(
        ", ",
      ),
    },
    { name: "cdx:ide:extensionCount", value: String(extensionCount) },
  ];
  if (productInfo?.vscodeVersion && productInfo.vscodeVersion !== version) {
    properties.push({
      name: "cdx:ide:vscodeVersion",
      value: productInfo.vscodeVersion,
    });
  }
  if (productInfo?.commit) {
    properties.push({ name: "cdx:ide:commit", value: productInfo.commit });
  }
  if (productInfo?.quality) {
    properties.push({ name: "cdx:ide:quality", value: productInfo.quality });
  }
  if (productInfo?.appDir) {
    properties.push({
      name: "cdx:ide:installDir",
      value: redactHomePath(productInfo.appDir, ide.home),
    });
  }
  const component = {
    type: "application",
    group: IDE_PURL_NAMESPACE,
    name: ide.name,
    version: version || "",
    description: productInfo?.nameLong || ide.name,
    "bom-ref": purl ? decodeURIComponent(purl) : `urn:ide:${ide.id}`,
    properties,
    tags: ["ide", ide.kind === "server" ? "ide-server" : "ide-desktop"],
  };
  if (purl) {
    component.purl = purl;
  }
  return component;
}

/**
 * Collect the installed extensions of each editor folder, plus a component for
 * each editor and the dependency edges from an editor to its extensions.
 *
 * One extension installed in two editors is one component: the editors are
 * listed in `cdx:vscode-extension:ide`, every folder it was found in is an
 * occurrence, and every copy's entry files are hashed. When two copies of the
 * same build have different entry-file bytes, each digest becomes its own file
 * component and the extension is marked `cdx:vscode-extension:entryHashMismatch`.
 *
 * @param {Array<{id?: string, name?: string, kind?: string, dir: string, home?: string, only?: string, probeApps?: boolean}>} ideDirs
 *   Extensions folders, as returned by discoverIdeExtensionDirs. `only` limits
 *   a folder to one extension; `home` and `probeApps` say where the editor's
 *   own version is looked up (see findIdeProductInfo)
 * @param {Object} [options] Collection options
 * @param {boolean} [options.includeIdeComponents=true] Emit a component for
 *   each editor and link it to its extensions
 * @param {string} [options.home] Home directory used when a folder names none
 * @param {boolean} [options.probeApps] Default for folders that do not say
 * @returns {{components: Object[], dependencies: Object[]}} Inventory
 */
export function collectIdeInventory(ideDirs, options = {}) {
  const includeIdeComponents = options.includeIdeComponents !== false;
  const extensions = new Map();
  const ideGroups = new Map();
  for (const ide of ideDirs) {
    try {
      collectIdeFolder(ide, options, extensions, ideGroups);
    } catch (err) {
      thoughtLog(`Unable to read the extensions in ${ide.dir}: ${err.message}`);
    }
  }
  const components = [];
  const dependencies = [];
  if (includeIdeComponents) {
    for (const group of ideGroups.values()) {
      const home = group.home || options.home || homedir();
      const probeApps = group.probeApps ?? options.probeApps;
      const ideComponent = toIdeComponent(
        group,
        findIdeProductInfo(group, home, { probeApps }),
        group.refs.size,
      );
      components.push(ideComponent);
      if (group.refs.size) {
        dependencies.push({
          ref: ideComponent["bom-ref"],
          dependsOn: [...group.refs].sort(),
        });
      }
    }
  }
  for (const entry of extensions.values()) {
    components.push(finishExtension(entry));
  }
  return { components, dependencies };
}

function collectIdeFolder(ide, options, extensions, ideGroups) {
  const { name: ideName, dir } = ide;
  const { records, obsolete, hasRegistry } =
    readInstalledExtensionsRegistry(dir);
  let group;
  if (ide.id) {
    const home = ide.home || options.home;
    const key = `${ide.kind || "desktop"}\u0000${ide.id}\u0000${home || ""}`;
    group = ideGroups.get(key);
    if (!group) {
      group = {
        id: ide.id,
        name: ide.name,
        kind: ide.kind || "desktop",
        home,
        probeApps: ide.probeApps,
        dirs: [],
        refs: new Set(),
      };
      ideGroups.set(key, group);
    }
    group.dirs.push(dir);
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  let seenFolders = 0;
  for (const entry of entries) {
    if (seenFolders >= MAX_EXTENSION_FOLDERS) {
      thoughtLog(
        `Stopped reading ${dir} after ${MAX_EXTENSION_FOLDERS} extension folders.`,
      );
      break;
    }
    if (entry.name.startsWith(".") || (ide.only && entry.name !== ide.only)) {
      continue;
    }
    const extDir = join(dir, entry.name);
    let isLink = false;
    if (entry.isSymbolicLink()) {
      isLink = true;
      try {
        if (!statSync(extDir).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
    } else if (!entry.isDirectory()) {
      continue;
    }
    // A root scan reads only the name of a symlinked folder, which a user
    // could point anywhere.
    const nameOnly = isLink && isRunningAsRoot();
    if (
      !parseVscodeExtensionDirName(entry.name) &&
      (nameOnly || !isInstalledExtensionDir(extDir))
    ) {
      continue;
    }
    seenFolders++;
    const record = records.get(entry.name);
    const component = parseInstalledExtensionDir(extDir, ideName, record, {
      nameOnly,
    });
    if (!component) {
      continue;
    }
    const ref = component["bom-ref"];
    group?.refs.add(ref);
    let target = extensions.get(ref);
    if (!target) {
      target = {
        component,
        ideNames: [],
        occurrences: [],
        states: [],
        files: new Map(),
      };
      extensions.set(ref, target);
    }
    if (ideName && !target.ideNames.includes(ideName)) {
      target.ideNames.push(ideName);
    }
    target.occurrences.push(extDir);
    const state = installStateFromRecord(record);
    state.obsolete = obsolete.has(entry.name);
    state.unregistered = hasRegistry && !record && !state.obsolete;
    state.symlink = isLink;
    target.states.push(state);
    if (!nameOnly) {
      const props = component.properties || [];
      for (const file of hashExtensionEntryFiles(extDir, {
        main: props.find((p) => p.name === "cdx:vscode-extension:main")?.value,
        browser: props.find((p) => p.name === "cdx:vscode-extension:browser")
          ?.value,
      })) {
        const digests = target.files.get(file.name) || new Map();
        if (!digests.has(file.digest)) {
          digests.set(file.digest, file);
        }
        target.files.set(file.name, digests);
      }
    }
  }
}

function finishExtension(entry) {
  const { component } = entry;
  const ref = component["bom-ref"];
  component.properties = (component.properties || []).filter(
    (p) => p.name !== "cdx:vscode-extension:ide",
  );
  if (entry.ideNames.length) {
    component.properties.unshift({
      name: "cdx:vscode-extension:ide",
      value: entry.ideNames.join(", "),
    });
  }
  applyInstallStates(component, entry.states);
  const files = [];
  let mismatch = false;
  for (const digests of entry.files.values()) {
    if (digests.size > 1) {
      mismatch = true;
    }
    for (const file of digests.values()) {
      files.push(toEntryFileComponent(ref, file, digests.size > 1));
    }
  }
  if (mismatch) {
    component.properties.push({
      name: "cdx:vscode-extension:entryHashMismatch",
      value: "true",
    });
  }
  if (files.length) {
    component.components = files;
  }
  component.evidence = {
    ...(component.evidence || {}),
    occurrences: entry.occurrences.map((location) => ({ location })),
  };
  if (!component.properties.length) {
    delete component.properties;
  }
  return component;
}

/**
 * Collect all installed extensions from a set of IDE extension directories.
 *
 * @param {Array<{name: string, dir: string}>} ideDirs Array of { name, dir } from discoverIdeExtensionDirs
 * @returns {Object[]} Array of CycloneDX component objects
 */
export function collectInstalledExtensions(ideDirs) {
  return collectIdeInventory(ideDirs, { includeIdeComponents: false })
    .components;
}

/**
 * Merge two descriptions of the same extension build, such as a `.vsix` file
 * and the folder it was installed into, so neither loses its hashes,
 * occurrences, entry files or properties.
 *
 * @param {Object[]} components Components, some of which share a bom-ref
 * @returns {Object[]} Components with one entry per extension bom-ref
 */
export function mergeExtensionComponents(components) {
  const merged = [];
  const byRef = new Map();
  for (const component of components) {
    const ref = component?.["bom-ref"];
    if (!ref || !component.purl?.startsWith("pkg:vscode-extension/")) {
      merged.push(component);
      continue;
    }
    const known = byRef.get(ref);
    if (!known) {
      byRef.set(ref, component);
      merged.push(component);
      continue;
    }
    mergeInto(known, component);
  }
  return merged;
}

function mergeInto(known, component) {
  for (const hash of component.hashes || []) {
    known.hashes = known.hashes || [];
    if (
      !known.hashes.some(
        (h) => h.alg === hash.alg && h.content === hash.content,
      )
    ) {
      known.hashes.push(hash);
    }
  }
  known.properties = known.properties || [];
  for (const prop of component.properties || []) {
    const existing = known.properties.find((p) => p.name === prop.name);
    if (!existing) {
      known.properties.push(prop);
    } else if (prop.name === "cdx:vscode-extension:ide") {
      const names = existing.value.split(", ");
      for (const name of prop.value.split(", ")) {
        if (!names.includes(name)) {
          names.push(name);
        }
      }
      existing.value = names.join(", ");
    }
  }
  const occurrences = known.evidence?.occurrences || [];
  for (const occurrence of component.evidence?.occurrences || []) {
    if (!occurrences.some((o) => o.location === occurrence.location)) {
      occurrences.push(occurrence);
    }
  }
  if (occurrences.length) {
    known.evidence = { ...(known.evidence || {}), occurrences };
  }
  for (const child of component.components || []) {
    known.components = known.components || [];
    if (!known.components.some((c) => c["bom-ref"] === child["bom-ref"])) {
      known.components.push(child);
    }
  }
}

/**
 * Add the host's editors and the extensions osquery could not see to an OBOM
 * component list.
 *
 * osquery's `vscode_extensions` table reads `extensions.json` for a fixed set
 * of editors, so extensions of other editors, and folders an editor never
 * registered, are missing from its rows. The editor folders of each home are
 * read here: an extension osquery already reported keeps its row and gains the
 * editor names, the occurrences and the hashed entry files, and the rest are
 * added. Every editor found also becomes a component. No dependency edges are
 * added, because an OBOM has no dependency graph.
 *
 * @param {Object[]} pkgList OBOM components, which are updated in place
 * @param {Object} [options] Collection options
 * @param {string[]} [options.homes] Home directories to read
 * @param {string} [options.home] One home directory to read, used when
 *   `homes` is not given; defaults to the current user's
 * @param {Array<Object>} [options.ideDirs] Extensions folders to read in place
 *   of discovering them
 * @returns {Object[]} Components to append to the OBOM
 */
export function collectObomIdeInventory(pkgList, options = {}) {
  const homes = options.homes?.length
    ? options.homes
    : [options.home || homedir()];
  const ideDirs =
    options.ideDirs ||
    homes.flatMap((home) =>
      discoverIdeExtensionDirs(home).map((ide) => ({
        ...ide,
        probeApps: true,
      })),
    );
  if (!ideDirs.length) {
    return [];
  }
  const inventory = collectIdeInventory(ideDirs, {
    home: homes[0],
    probeApps: true,
  });
  const existing = new Map(
    pkgList
      .filter((c) => c?.["bom-ref"])
      .map((component) => [component["bom-ref"], component]),
  );
  const additions = [];
  for (const component of inventory.components) {
    const known = existing.get(component["bom-ref"]);
    if (!known) {
      additions.push(component);
      continue;
    }
    const scanned = {
      ...component,
      properties: (component.properties || []).filter((p) =>
        p.name.startsWith("cdx:vscode-extension:"),
      ),
      hashes: undefined,
    };
    mergeInto(known, scanned);
  }
  return additions;
}

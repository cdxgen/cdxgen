import { arch as runtimeArch, platform as runtimePlatform } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

import {
  DEBUG_MODE,
  dirNameStr,
  retrieveCdxgenPluginVersion,
  safeExistsSync,
  safeSpawnSync,
} from "./utils.js";

const PLUGIN_ENV_COMMAND_NAMES = {
  "cargo-auditable": "CARGO_AUDITABLE_CMD",
  dosai: "DOSAI_CMD",
  golem: "GOLEM_CMD",
  osquery: "OSQUERY_CMD",
  sourcekitten: "SOURCEKITTEN_CMD",
  trivy: "TRIVY_CMD",
  trustinspector: "TRUSTINSPECTOR_CMD",
};

function isMusl() {
  const result = safeSpawnSync("ldd", ["--version"]);
  return result?.stdout?.includes("musl") || result?.stderr?.includes("musl");
}

function hasUsablePluginsDir(pluginsDir) {
  return (
    safeExistsSync(pluginsDir) &&
    (safeExistsSync(join(pluginsDir, "plugins-manifest.json")) ||
      [
        "cargo-auditable",
        "dosai",
        "golem",
        "osquery",
        "sourcekitten",
        "trivy",
        "trustinspector",
      ].some((pluginName) => safeExistsSync(join(pluginsDir, pluginName))))
  );
}

/**
 * Determine the normalized plugin target tuple for the current runtime.
 *
 * @returns {{arch: string, extn: string, platform: string, pluginsBinSuffix: string}}
 */
export function getPluginsBinTarget() {
  let platform = runtimePlatform();
  let extn = "";
  let pluginsBinSuffix = "";
  if (platform === "win32") {
    platform = "windows";
    extn = ".exe";
  } else if (platform === "linux" && isMusl()) {
    platform = "linuxmusl";
  }

  let arch = `${runtimeArch()}`;
  if (arch === "x32") {
    arch = "386";
  } else if (arch === "x64") {
    arch = "amd64";
    pluginsBinSuffix = `-${platform}-amd64`;
  } else if (arch === "arm64") {
    pluginsBinSuffix = `-${platform}-arm64`;
  } else if (arch === "ppc64") {
    arch = "ppc64le";
    pluginsBinSuffix = "-ppc64";
  }

  return {
    arch,
    extn,
    platform,
    pluginsBinSuffix,
  };
}

/**
 * Resolve cdxgen companion plugin directory candidates for npx-style layouts.
 *
 * npm's npx layout installs cdxgen and @cdxgen/cdxgen-plugins-bin as sibling
 * packages under a shared node_modules root such as
 * `~/.npm/_npx/<hash>/node_modules/`. Deno's npm cache keeps versioned package
 * directories under a registry root such as
 * `~/.cache/deno/npm/registry.npmjs.org/`. This helper derives both candidate
 * plugin directories from `dirNameStr`.
 *
 * @param {string} dirNameStr The directory of the cdxgen package.
 * @param {string} pluginVersion The version of cdxgen-plugins-bin.
 * @param {{pluginsBinSuffix: string}} target The plugin target info.
 * @returns {{extraNMBinPath: string|undefined, pluginsDir: string}[]}
 */
function resolveNpxPluginsDirs(dirNameStr, pluginVersion, target) {
  // Normalize Windows and POSIX separators before tokenizing the path.
  const normalizedDirName = dirNameStr.replaceAll("\\", "/");
  const parts = normalizedDirName.split("/");
  const pluginsPackageName = `cdxgen-plugins-bin${target.pluginsBinSuffix}`;
  /** @type {{extraNMBinPath: string|undefined, pluginsDir: string}[]} */
  const candidates = [];

  const nodeModulesIdx = parts.lastIndexOf("node_modules");
  if (nodeModulesIdx !== -1) {
    const nodeModulesRoot = parts.slice(0, nodeModulesIdx + 1).join("/");
    candidates.push({
      extraNMBinPath: join(nodeModulesRoot, ".bin"),
      pluginsDir: join(
        nodeModulesRoot,
        "@cdxgen",
        pluginsPackageName,
        "plugins",
      ),
    });
  }

  const registryIdx = parts.lastIndexOf("registry.npmjs.org");
  if (registryIdx !== -1) {
    const registryRoot = parts.slice(0, registryIdx).join("/");
    candidates.push({
      extraNMBinPath: undefined,
      pluginsDir: join(
        registryRoot,
        "@cdxgen",
        pluginsPackageName,
        pluginVersion,
        "plugins",
      ),
    });
  }

  return candidates;
}

/**
 * Resolve the cdxgen companion plugins directory for the current runtime.
 *
 * @returns {{
 *   arch: string,
 *   extn: string,
 *   extraNMBinPath: string|undefined,
 *   platform: string,
 *   pluginManifestFile: string|undefined,
 *   pluginVersion: string|undefined,
 *   pluginsBinSuffix: string,
 *   pluginsDir: string,
 * }}
 */
export function resolveCdxgenPlugins() {
  const target = getPluginsBinTarget();
  const pluginVersion = retrieveCdxgenPluginVersion();
  let pluginsDir = process.env.CDXGEN_PLUGINS_DIR || "";
  let extraNMBinPath;

  if (!pluginsDir && hasUsablePluginsDir(join(dirNameStr, "plugins"))) {
    pluginsDir = join(dirNameStr, "plugins");
  }

  if (
    !pluginsDir &&
    hasUsablePluginsDir(
      join(
        dirNameStr,
        "node_modules",
        "@cdxgen",
        `cdxgen-plugins-bin${target.pluginsBinSuffix}`,
        "plugins",
      ),
    )
  ) {
    pluginsDir = join(
      dirNameStr,
      "node_modules",
      "@cdxgen",
      `cdxgen-plugins-bin${target.pluginsBinSuffix}`,
      "plugins",
    );
    if (safeExistsSync(join(dirNameStr, "node_modules", ".bin"))) {
      extraNMBinPath = join(dirNameStr, "node_modules", ".bin");
    }
  }

  if (!pluginsDir) {
    let globalNodePath = process.env.GLOBAL_NODE_MODULES_PATH || undefined;
    if (!globalNodePath) {
      if (DEBUG_MODE) {
        console.log(
          'Trying to find the global node_modules path with "pnpm root -g" command.',
        );
      }
      const result = safeSpawnSync(
        target.platform === "windows" ? "pnpm.cmd" : "pnpm",
        ["root", "-g"],
      );
      if (result?.stdout) {
        globalNodePath = `${result.stdout.trim()}/`;
      }
    }

    let globalPlugins;
    if (globalNodePath) {
      globalPlugins = join(
        globalNodePath,
        "@cdxgen",
        `cdxgen-plugins-bin${target.pluginsBinSuffix}`,
        "plugins",
      );
      extraNMBinPath = join(
        globalNodePath,
        "..",
        ".pnpm",
        "node_modules",
        ".bin",
      );
    }

    let altGlobalPlugins;
    if (
      dirNameStr.includes(join("node_modules", ".pnpm", "@cyclonedx+cdxgen"))
    ) {
      const tmpA = dirNameStr.split(join("node_modules", ".pnpm"));
      altGlobalPlugins = join(
        tmpA[0],
        "node_modules",
        ".pnpm",
        `@cdxgen+cdxgen-plugins-bin${target.pluginsBinSuffix}@${pluginVersion}`,
        "node_modules",
        "@cdxgen",
        `cdxgen-plugins-bin${target.pluginsBinSuffix}`,
        "plugins",
      );
      if (safeExistsSync(join(tmpA[0], "node_modules", ".bin"))) {
        extraNMBinPath = join(tmpA[0], "node_modules", ".bin");
      }
    } else if (dirNameStr.includes(join(".pnpm", "@cyclonedx+cdxgen"))) {
      const tmpA = dirNameStr.split(".pnpm");
      altGlobalPlugins = join(
        tmpA[0],
        ".pnpm",
        `@cdxgen+cdxgen-plugins-bin${target.pluginsBinSuffix}@${pluginVersion}`,
        "node_modules",
        "@cdxgen",
        `cdxgen-plugins-bin${target.pluginsBinSuffix}`,
        "plugins",
      );
      if (safeExistsSync(join(tmpA[0], ".bin"))) {
        extraNMBinPath = join(tmpA[0], ".bin");
      }
    } else if (dirNameStr.includes(join("caxa", "applications"))) {
      altGlobalPlugins = join(
        dirNameStr,
        "node_modules",
        "pnpm",
        `@cdxgen+cdxgen-plugins-bin${target.pluginsBinSuffix}@${pluginVersion}`,
        "node_modules",
        "@cdxgen",
        `cdxgen-plugins-bin${target.pluginsBinSuffix}`,
        "plugins",
      );
      extraNMBinPath = join(dirNameStr, "node_modules", ".bin");
    }

    // Fallback: npx cache layout (Deno/npm) where cdxgen lives alongside
    // @cdxgen/cdxgen-plugins-bin under a shared registry root such as
    // `~/.cache/deno/npm/registry.npmjs.org/`.
    if (!pluginsDir) {
      const npxPluginCandidates = resolveNpxPluginsDirs(
        dirNameStr,
        pluginVersion,
        target,
      );
      for (const npxPluginCandidate of npxPluginCandidates) {
        if (!hasUsablePluginsDir(npxPluginCandidate.pluginsDir)) {
          continue;
        }
        pluginsDir = npxPluginCandidate.pluginsDir;
        if (
          npxPluginCandidate.extraNMBinPath &&
          safeExistsSync(npxPluginCandidate.extraNMBinPath)
        ) {
          extraNMBinPath = npxPluginCandidate.extraNMBinPath;
        }
        if (DEBUG_MODE) {
          console.log("Found npx plugins", pluginsDir);
        }
        break;
      }
    }

    if (globalPlugins && safeExistsSync(globalPlugins)) {
      pluginsDir = globalPlugins;
      if (DEBUG_MODE) {
        console.log("Found global plugins", pluginsDir);
      }
    } else if (altGlobalPlugins && safeExistsSync(altGlobalPlugins)) {
      pluginsDir = altGlobalPlugins;
      if (DEBUG_MODE) {
        console.log("Found global plugins", pluginsDir);
      }
    }
  }

  if (!pluginsDir) {
    if (DEBUG_MODE) {
      console.warn(
        "The optional cdxgen plugin was not found. Please install cdxgen without excluding optional dependencies if needed.",
      );
    }
    pluginsDir = "";
  }

  const pluginManifestFile = safeExistsSync(
    join(pluginsDir, "plugins-manifest.json"),
  )
    ? join(pluginsDir, "plugins-manifest.json")
    : undefined;

  return {
    ...target,
    extraNMBinPath,
    pluginManifestFile,
    pluginVersion,
    pluginsDir,
  };
}

function getPluginRuntimeCacheKey() {
  return [
    process.env.CDXGEN_PLUGINS_DIR || "",
    process.env.GLOBAL_NODE_MODULES_PATH || "",
  ].join("\u0000");
}

let cachedPluginRuntime;
let cachedPluginRuntimeKey;

/**
 * Retrieve the default plugin runtime, recomputing it only when the
 * environment that influences plugin discovery changes.
 *
 * @returns {ReturnType<typeof resolveCdxgenPlugins>} The resolved plugin runtime.
 */
export function getDefaultPluginRuntime() {
  const cacheKey = getPluginRuntimeCacheKey();
  if (!cachedPluginRuntime || cachedPluginRuntimeKey !== cacheKey) {
    cachedPluginRuntime = resolveCdxgenPlugins();
    cachedPluginRuntimeKey = cacheKey;
  }
  return cachedPluginRuntime;
}

/**
 * Add the detected node_modules binary directory to PATH when present.
 *
 * @param {ReturnType<typeof resolveCdxgenPlugins>} [pluginRuntime] Detected plugin runtime.
 * @returns {ReturnType<typeof resolveCdxgenPlugins>} The resolved plugin runtime.
 */
export function setPluginsPathEnv(pluginRuntime = undefined) {
  pluginRuntime ??= getDefaultPluginRuntime();
  if (
    pluginRuntime.extraNMBinPath &&
    !process.env?.PATH?.includes(pluginRuntime.extraNMBinPath)
  ) {
    process.env.PATH = `${pluginRuntime.extraNMBinPath}${delimiter}${process.env.PATH}`;
  }
  return pluginRuntime;
}

function resolveBundledPluginBinary(toolName, pluginRuntime) {
  if (!pluginRuntime.pluginsDir) {
    return undefined;
  }
  if (!safeExistsSync(join(pluginRuntime.pluginsDir, toolName))) {
    return undefined;
  }
  switch (toolName) {
    case "trivy":
      return join(
        pluginRuntime.pluginsDir,
        "trivy",
        `trivy-cdxgen-${pluginRuntime.platform}-${pluginRuntime.arch}${pluginRuntime.extn}`,
      );
    case "cargo-auditable":
      return join(
        pluginRuntime.pluginsDir,
        "cargo-auditable",
        `cargo-auditable-cdxgen-${pluginRuntime.platform}-${pluginRuntime.arch}${pluginRuntime.extn}`,
      );
    case "osquery": {
      let osqueryBin = join(
        pluginRuntime.pluginsDir,
        "osquery",
        `osqueryi-${pluginRuntime.platform}-${pluginRuntime.arch}${pluginRuntime.extn}`,
      );
      if (pluginRuntime.platform === "darwin") {
        osqueryBin = `${osqueryBin}.app/Contents/MacOS/osqueryd`;
      }
      return osqueryBin;
    }
    case "dosai":
      return join(
        pluginRuntime.pluginsDir,
        "dosai",
        `dosai-${pluginRuntime.platform}-${pluginRuntime.arch}${pluginRuntime.extn}`,
      );
    case "golem":
      return join(
        pluginRuntime.pluginsDir,
        "golem",
        `golem-${pluginRuntime.platform}-${pluginRuntime.arch}${pluginRuntime.extn}`,
      );
    case "trustinspector":
      return join(
        pluginRuntime.pluginsDir,
        "trustinspector",
        `trustinspector-cdxgen-${pluginRuntime.platform}-${pluginRuntime.arch}${pluginRuntime.extn}`,
      );
    case "sourcekitten":
      return join(pluginRuntime.pluginsDir, "sourcekitten", "sourcekitten");
    default:
      return undefined;
  }
}

/**
 * Resolve a known plugin binary path, honoring explicit environment overrides.
 *
 * @param {string} toolName Tool identifier.
 * @param {ReturnType<typeof resolveCdxgenPlugins>} [pluginRuntime] Detected plugin runtime.
 * @returns {string|undefined} Resolved binary path or configured override.
 */
export function resolvePluginBinary(toolName, pluginRuntime = undefined) {
  pluginRuntime ??= getDefaultPluginRuntime();
  const envCommandName = PLUGIN_ENV_COMMAND_NAMES[toolName];
  if (envCommandName && process.env[envCommandName]) {
    return process.env[envCommandName];
  }
  return resolveBundledPluginBinary(toolName, pluginRuntime);
}

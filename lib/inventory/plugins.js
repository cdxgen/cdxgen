import { arch as runtimeArch, platform as runtimePlatform } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { isDeno } from "../core/env.js";
import { safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { dirNameStr } from "../core/paths.js";
import { retrieveCdxgenPluginVersion } from "./envcontext.js";

const PLUGIN_ENV_COMMAND_NAMES = {
  "cargo-auditable": "CARGO_AUDITABLE_CMD",
  cdxrs: "CDXRS_CMD",
  dosai: "DOSAI_CMD",
  golem: "GOLEM_CMD",
  osquery: "OSQUERY_CMD",
  rusi: "RUSI_CMD",
  sourcekitten: "SOURCEKITTEN_CMD",
  trivy: "TRIVY_CMD",
  trustinspector: "TRUSTINSPECTOR_CMD",
  cdxui: "CDXUI_CMD",
  kosi: "KOSI_CMD",
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
        "cdxrs",
        "dosai",
        "golem",
        "osquery",
        "rusi",
        "sourcekitten",
        "trivy",
        "trustinspector",
        "cdxui",
        "kosi",
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
    // Include the registry segment itself so the plugins directory resolves
    // to `<registry-root>/registry.npmjs.org/@cdxgen/...`. The previous
    // `slice(0, registryIdx)` dropped `registry.npmjs.org`, which broke plugin
    // discovery for Deno installs (`deno add` / `deno run npm:`) whose cache
    // nests versioned packages under `.../npm/registry.npmjs.org/`.
    const registryRoot = parts.slice(0, registryIdx + 1).join("/");
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
  let pluginsDir = readEnvironmentVariable("CDXGEN_PLUGINS_DIR") || "";
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
    let globalNodePath =
      readEnvironmentVariable("GLOBAL_NODE_MODULES_PATH") || undefined;
    if (!globalNodePath) {
      // Under Deno there is no global pnpm store to probe; spawning
      // `pnpm root -g` only clutters debug output (the binary may not even be
      // installed). The registry/npx fallbacks below cover the Deno cache.
      if (isDeno) {
        if (DEBUG_MODE) {
          console.log(
            'Skipping "pnpm root -g" lookup under the Deno runtime; relying on the Deno npm cache layout instead.',
          );
        }
      } else {
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
    // The plugins directory ships inside the platform-specific package
    // (`@cdxgen/cdxgen-plugins-bin${pluginsBinSuffix}`), which is an optional
    // dependency. cdxgen falls back to its JavaScript implementations for every
    // plugin-backed feature, so an absent plugins directory is a supported
    // install and must not be reported as an error.
    if (DEBUG_MODE) {
      console.log(
        target.pluginsBinSuffix
          ? `@cdxgen/cdxgen-plugins-bin${target.pluginsBinSuffix} was not found; using the JavaScript implementations instead.`
          : `No cdxgen-plugins-bin package is published for ${target.platform}/${target.arch}; using the JavaScript implementations instead.`,
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
    readEnvironmentVariable("CDXGEN_PLUGINS_DIR") || "",
    readEnvironmentVariable("GLOBAL_NODE_MODULES_PATH") || "",
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
    !readEnvironmentVariable("PATH")?.includes(pluginRuntime.extraNMBinPath)
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
    case "golem":
    case "rusi":
    case "cdxrs":
    case "cdxui":
      return join(
        pluginRuntime.pluginsDir,
        toolName,
        `${toolName}-${pluginRuntime.platform}-${pluginRuntime.arch}${pluginRuntime.extn}`,
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
  if (envCommandName && readEnvironmentVariable(envCommandName)) {
    return readEnvironmentVariable(envCommandName);
  }
  return resolveBundledPluginBinary(toolName, pluginRuntime);
}

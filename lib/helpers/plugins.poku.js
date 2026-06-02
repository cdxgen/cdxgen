import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import { resolveCdxgenPlugins, resolvePluginBinary } from "./plugins.js";

describe("plugins helper", () => {
  it("resolvePluginBinary() prefers explicit OSQUERY_CMD overrides", () => {
    const previousOsqueryCmd = process.env.OSQUERY_CMD;
    try {
      process.env.OSQUERY_CMD = "/tmp/osqueryd";
      assert.strictEqual(resolvePluginBinary("osquery"), "/tmp/osqueryd");
    } finally {
      if (previousOsqueryCmd === undefined) {
        delete process.env.OSQUERY_CMD;
      } else {
        process.env.OSQUERY_CMD = previousOsqueryCmd;
      }
    }
  });

  it("resolveCdxgenPlugins() honors CDXGEN_PLUGINS_DIR for bundled osquery binaries", () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), "cdxgen-plugins-helper-"));
    const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
    try {
      mkdirSync(join(pluginsDir, "osquery"), { recursive: true });
      process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
      const pluginRuntime = resolveCdxgenPlugins();
      const osqueryBinary = resolvePluginBinary("osquery", pluginRuntime);
      const expectedPrefix = join(
        pluginsDir,
        "osquery",
        `osqueryi-${pluginRuntime.platform}-${pluginRuntime.arch}${pluginRuntime.extn}`,
      );

      assert.strictEqual(pluginRuntime.pluginsDir, pluginsDir);
      if (pluginRuntime.platform === "darwin") {
        assert.strictEqual(
          osqueryBinary,
          `${expectedPrefix}.app/Contents/MacOS/osqueryd`,
        );
      } else {
        assert.strictEqual(osqueryBinary, expectedPrefix);
      }
    } finally {
      rmSync(pluginsDir, { force: true, recursive: true });
      if (previousPluginsDir === undefined) {
        delete process.env.CDXGEN_PLUGINS_DIR;
      } else {
        process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
      }
    }
  });

  it("resolveCdxgenPlugins() finds plugins in npx cache layout on windows paths", async () => {
    const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
    const previousGlobalNodePath = process.env.GLOBAL_NODE_MODULES_PATH;
    try {
      delete process.env.CDXGEN_PLUGINS_DIR;
      delete process.env.GLOBAL_NODE_MODULES_PATH;

      const mockedDirNameStr =
        "C:\\Users\\runneradmin\\AppData\\Local\\deno\\npm\\registry.npmjs.org\\@cyclonedx\\cdxgen\\12.5.0";
      const expectedPluginsDir =
        "C:\\Users\\runneradmin\\AppData\\Local\\deno\\npm\\@cdxgen\\cdxgen-plugins-bin-windows-amd64\\2.2.4\\plugins";

      const normalizePath = (pathValue) => pathValue.replaceAll("\\", "/");
      const normalizedExpectedPluginsDir = normalizePath(expectedPluginsDir);
      const normalizedExpectedManifest = `${normalizedExpectedPluginsDir}/plugins-manifest.json`;

      const { resolveCdxgenPlugins: resolveCdxgenPluginsWithWindowsPath } =
        await esmock("./plugins.js", {
          "node:os": {
            arch: () => "x64",
            platform: () => "win32",
          },
          "./utils.js": {
            DEBUG_MODE: false,
            dirNameStr: mockedDirNameStr,
            retrieveCdxgenPluginVersion: () => "2.2.4",
            safeExistsSync: (pathValue) => {
              const normalizedPath = normalizePath(pathValue);
              return (
                normalizedPath === normalizedExpectedPluginsDir ||
                normalizedPath === normalizedExpectedManifest
              );
            },
            safeSpawnSync: () => ({ stdout: "" }),
          },
        });

      const pluginRuntime = resolveCdxgenPluginsWithWindowsPath();
      assert.strictEqual(
        normalizePath(pluginRuntime.pluginsDir),
        normalizedExpectedPluginsDir,
      );
      assert.strictEqual(pluginRuntime.platform, "windows");
    } finally {
      if (previousPluginsDir === undefined) {
        delete process.env.CDXGEN_PLUGINS_DIR;
      } else {
        process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
      }
      if (previousGlobalNodePath === undefined) {
        delete process.env.GLOBAL_NODE_MODULES_PATH;
      } else {
        process.env.GLOBAL_NODE_MODULES_PATH = previousGlobalNodePath;
      }
    }
  });

  it("resolveCdxgenPlugins() finds sibling plugins in npm npx node_modules layout", async () => {
    const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
    const previousGlobalNodePath = process.env.GLOBAL_NODE_MODULES_PATH;
    try {
      delete process.env.CDXGEN_PLUGINS_DIR;
      delete process.env.GLOBAL_NODE_MODULES_PATH;

      const mockedDirNameStr =
        "/Users/tester/.npm/_npx/abc123/node_modules/@cyclonedx/cdxgen";
      const expectedPluginsDir =
        "/Users/tester/.npm/_npx/abc123/node_modules/@cdxgen/cdxgen-plugins-bin-linux-amd64/plugins";
      const expectedManifest = `${expectedPluginsDir}/plugins-manifest.json`;
      const expectedBinPath =
        "/Users/tester/.npm/_npx/abc123/node_modules/.bin";
      const normalizePath = (pathValue) => pathValue.replaceAll("\\", "/");
      const normalizedExpectedPluginsDir = normalizePath(expectedPluginsDir);
      const normalizedExpectedManifest = normalizePath(expectedManifest);
      const normalizedExpectedBinPath = normalizePath(expectedBinPath);

      const { resolveCdxgenPlugins: resolveCdxgenPluginsWithNpxLayout } =
        await esmock("./plugins.js", {
          "node:os": {
            arch: () => "x64",
            platform: () => "linux",
          },
          "./utils.js": {
            DEBUG_MODE: false,
            dirNameStr: mockedDirNameStr,
            retrieveCdxgenPluginVersion: () => "2.2.4",
            safeExistsSync: (pathValue) =>
              [
                normalizedExpectedPluginsDir,
                normalizedExpectedManifest,
                normalizedExpectedBinPath,
              ].includes(normalizePath(pathValue)),
            safeSpawnSync: () => ({ stdout: "" }),
          },
        });

      const pluginRuntime = resolveCdxgenPluginsWithNpxLayout();
      assert.strictEqual(
        normalizePath(pluginRuntime.pluginsDir),
        normalizedExpectedPluginsDir,
      );
      assert.strictEqual(
        normalizePath(pluginRuntime.extraNMBinPath),
        normalizedExpectedBinPath,
      );
      assert.strictEqual(pluginRuntime.platform, "linux");
    } finally {
      if (previousPluginsDir === undefined) {
        delete process.env.CDXGEN_PLUGINS_DIR;
      } else {
        process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
      }
      if (previousGlobalNodePath === undefined) {
        delete process.env.GLOBAL_NODE_MODULES_PATH;
      } else {
        process.env.GLOBAL_NODE_MODULES_PATH = previousGlobalNodePath;
      }
    }
  });
});

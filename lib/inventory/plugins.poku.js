import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import { resolveCdxgenPlugins, resolvePluginBinary } from "./plugins.js";

// Drop any ambient CDXGEN_PLUGINS_DIR for this whole file. Every test here that
// cares sets the variable itself, and the tests that must run *without* it
// delete it inside a try/finally — but poku runs them concurrently, so one
// test's `finally` would restore the ambient value in the middle of another and
// make it resolve to the wrong plugins directory. That only bites when the
// variable is set in the environment, which is exactly what
// contrib/link-local-plugins.sh asks you to do when testing against a real
// cdxrs binary, so the suite has to be immune to it.
delete process.env.CDXGEN_PLUGINS_DIR;

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
        "C:\\Users\\runneradmin\\AppData\\Local\\deno\\npm\\registry.npmjs.org\\@cdxgen\\cdxgen-plugins-bin-windows-amd64\\2.2.4\\plugins";

      const normalizePath = (pathValue) => pathValue.replaceAll("\\", "/");
      const normalizedExpectedPluginsDir = normalizePath(expectedPluginsDir);
      const normalizedExpectedManifest = `${normalizedExpectedPluginsDir}/plugins-manifest.json`;

      const { resolveCdxgenPlugins: resolveCdxgenPluginsWithWindowsPath } =
        await esmock("./plugins.js", {
          "node:os": {
            arch: () => "x64",
            platform: () => "win32",
          },
          "../core/activity.js": { DEBUG_MODE: false },
          "../core/paths.js": { dirNameStr: mockedDirNameStr },
          "./envcontext.js": { retrieveCdxgenPluginVersion: () => "2.2.4" },
          "../core/fs.js": {
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

  it("resolveCdxgenPlugins() keeps the registry.npmjs.org segment for deno npm cache (POSIX, regression for off-by-one)", async () => {
    const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
    const previousGlobalNodePath = process.env.GLOBAL_NODE_MODULES_PATH;
    try {
      delete process.env.CDXGEN_PLUGINS_DIR;
      delete process.env.GLOBAL_NODE_MODULES_PATH;

      // Real deno cache layout: versioned packages live under
      // <DENO_DIR>/npm/registry.npmjs.org/<scope>/<name>/<version>. The plugins
      // package must resolve to a path that RETAINS the registry.npmjs.org
      // segment (the off-by-one bug dropped it).
      const mockedDirNameStr =
        "/home/runner/.cache/deno/npm/registry.npmjs.org/@cyclonedx/cdxgen/12.7.1";
      const expectedPluginsDir =
        "/home/runner/.cache/deno/npm/registry.npmjs.org/@cdxgen/cdxgen-plugins-bin-linux-amd64/2.5.1/plugins";
      const expectedManifest = `${expectedPluginsDir}/plugins-manifest.json`;
      const normalizePath = (pathValue) => pathValue.replaceAll("\\", "/");
      const normalizedExpectedPluginsDir = normalizePath(expectedPluginsDir);
      const normalizedExpectedManifest = normalizePath(expectedManifest);

      const { resolveCdxgenPlugins: resolveCdxgenPluginsWithDenoCache } =
        await esmock("./plugins.js", {
          "node:os": {
            arch: () => "x64",
            platform: () => "linux",
          },
          "../core/activity.js": { DEBUG_MODE: false },
          "../core/paths.js": { dirNameStr: mockedDirNameStr },
          "../core/env.js": { isDeno: true },
          "./envcontext.js": { retrieveCdxgenPluginVersion: () => "2.5.1" },
          "../core/fs.js": {
            safeExistsSync: (pathValue) =>
              [
                normalizedExpectedPluginsDir,
                normalizedExpectedManifest,
              ].includes(normalizePath(pathValue)),
            safeSpawnSync: () => ({ stdout: "" }),
          },
        });

      const pluginRuntime = resolveCdxgenPluginsWithDenoCache();
      assert.strictEqual(
        normalizePath(pluginRuntime.pluginsDir),
        normalizedExpectedPluginsDir,
      );
      // The path must retain the registry segment before @cdxgen. Normalize
      // separators first so the substring check holds on Windows, where join()
      // produces backslashes.
      assert.ok(
        normalizePath(pluginRuntime.pluginsDir).includes(
          "registry.npmjs.org/@cdxgen",
        ),
        `expected pluginsDir to retain registry.npmjs.org before @cdxgen, got: ${pluginRuntime.pluginsDir}`,
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
          "../core/activity.js": { DEBUG_MODE: false },
          "../core/paths.js": { dirNameStr: mockedDirNameStr },
          "./envcontext.js": { retrieveCdxgenPluginVersion: () => "2.2.4" },
          "../core/fs.js": {
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

  it("resolveCdxgenPlugins() ignores a plugins-manifest.json in the working directory when no plugins directory exists", async () => {
    const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
    const previousGlobalNodePath = process.env.GLOBAL_NODE_MODULES_PATH;
    try {
      delete process.env.CDXGEN_PLUGINS_DIR;
      delete process.env.GLOBAL_NODE_MODULES_PATH;
      const { resolveCdxgenPlugins: resolveCdxgenPluginsWithoutPlugins } =
        await esmock("./plugins.js", {
          "../core/activity.js": { DEBUG_MODE: false },
          "../core/paths.js": { dirNameStr: "/opt/cdxgen" },
          "./envcontext.js": { retrieveCdxgenPluginVersion: () => "2.2.4" },
          "../core/fs.js": {
            // Only the scanned project's cwd-relative manifest exists.
            safeExistsSync: (pathValue) =>
              pathValue === "plugins-manifest.json",
            safeSpawnSync: () => ({ stdout: "" }),
          },
        });

      const pluginRuntime = resolveCdxgenPluginsWithoutPlugins();
      assert.strictEqual(pluginRuntime.pluginsDir, "");
      assert.strictEqual(pluginRuntime.pluginManifestFile, undefined);
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

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

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
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import { projectSettingsArgs } from "./jvmLocalRepos.js";

// projectSettingsArgs reads MVN_ARGS and MAVEN_ARGS, which are process-wide,
// so this file holds one sequential test.

it("projectSettingsArgs passes a project's settings.xml as global settings unless the user chose one", () => {
  const saved = {
    MVN_ARGS: process.env.MVN_ARGS,
    MAVEN_ARGS: process.env.MAVEN_ARGS,
  };
  const root = mkdtempSync(join(tmpdir(), "cdxgen-mvn-settings-"));
  try {
    delete process.env.MVN_ARGS;
    delete process.env.MAVEN_ARGS;

    const plain = join(root, "plain");
    mkdirSync(plain);
    assert.deepStrictEqual(projectSettingsArgs(plain), { args: [] });

    const project = join(root, "project");
    mkdirSync(project);
    const settingsFile = join(project, "settings.xml");
    writeFileSync(settingsFile, "<settings/>");
    assert.deepStrictEqual(projectSettingsArgs(project), {
      settingsFile,
      args: ["-gs", settingsFile],
    });

    assert.deepStrictEqual(projectSettingsArgs(project, { secureMode: true }), {
      settingsFile,
      args: [],
      skipped: "secure-mode",
    });

    for (const [name, value] of [
      ["MVN_ARGS", "-B -s /elsewhere/settings.xml"],
      ["MVN_ARGS", "--settings=/elsewhere/settings.xml"],
      ["MAVEN_ARGS", "-gs /elsewhere/global.xml"],
      ["MAVEN_ARGS", "--global-settings=/elsewhere/global.xml"],
    ]) {
      process.env[name] = value;
      assert.strictEqual(
        projectSettingsArgs(project).skipped,
        "user-settings",
        `${name}=${value}`,
      );
      delete process.env[name];
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { force: true, recursive: true });
  }
});

/**
 * Tests that the `.create` command of cdxi follows the same install rule as
 * the cdxgen command. It used to pass a fixed `installDeps: true` to
 * createBom(), so a cdxi session in secure mode ran the package manager
 * install step of the scanned project, which cdxgen skips in the same
 * environment.
 *
 * Each case starts cdxi the way an analyst would, with a stand-in npm first
 * on PATH, and types `.create <project>` on its standard input.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assert, it } from "poku";

import { standInRuns, writeStandInTool } from "../test/helpers/standInTool.js";

const binDir = path.dirname(fileURLToPath(import.meta.url));
const replEntry = path.join(binDir, "repl.js");

// Variables that would change the scan or make the secure-mode environment
// audit stop the scan before it reaches the install step.
const SCRUBBED_ENV = new Set([
  "NPM_INSTALL_ARGS",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "FETCH_LICENSE",
  "HOME",
  "USERPROFILE",
  "PATH",
  "Path",
]);

/**
 * Run `.create` on an npm project without a lock file in a cdxi session, with
 * a stand-in npm first on PATH.
 *
 * @param {Object} extraEnv Environment variables of the session
 * @returns {{status: number, output: string, npmRuns: string[]}}
 */
function createInRepl(extraEnv) {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-repl-create-"));
  try {
    const toolDir = path.join(root, "bin");
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const marker = path.join(root, "npm-runs.txt");
    mkdirSync(toolDir);
    mkdirSync(home);
    mkdirSync(project);
    writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0" }),
    );
    writeStandInTool(toolDir, "npm", marker);
    const env = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.startsWith("CDXGEN_") && !SCRUBBED_ENV.has(name)) {
        env[name] = value;
      }
    }
    env.PATH = [toolDir, process.env.PATH ?? process.env.Path]
      .filter(Boolean)
      .join(path.delimiter);
    env.HOME = home;
    env.USERPROFILE = home;
    env.CDXGEN_TEMP_DIR = path.join(root, "tmp");
    env.CDXGEN_REPL_HISTORY = path.join(root, "repl_history");
    // Secure mode refuses to run as root outside the cdxgen container image
    if (process.getuid?.() === 0) {
      env.CDXGEN_IN_CONTAINER = "true";
    }
    mkdirSync(env.CDXGEN_TEMP_DIR);
    const result = spawnSync(process.execPath, [replEntry], {
      cwd: root,
      encoding: "utf-8",
      env: { ...env, ...extraEnv },
      input: `.create ${project}\n`,
      timeout: 120000,
    });
    return {
      status: result.status,
      output: `${result.stdout || ""}${result.stderr || ""}`,
      npmRuns: standInRuns(marker),
    };
  } finally {
    rmSync(root, { force: true, recursive: true, maxRetries: 3 });
  }
}

await it("cdxi .create runs the project's npm install by default", () => {
  // Positive control: the stand-in npm is reachable, so the next case does
  // not pass only because npm was never found.
  const { npmRuns, output } = createInRepl({});
  assert.ok(
    npmRuns.some((line) => line.startsWith("install")),
    `the stand-in npm never ran an install: ${output}`,
  );
});

await it("cdxi .create keeps installs off in secure mode", () => {
  const { npmRuns, output } = createInRepl({ CDXGEN_SECURE_MODE: "true" });
  assert.deepStrictEqual(
    npmRuns.filter((line) => line.startsWith("install")),
    [],
    `cdxi .create ran npm install in secure mode: ${output}`,
  );
});

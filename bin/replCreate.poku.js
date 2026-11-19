/**
 * Tests that the `.create` command of cdxi follows the same install rule as
 * the cdxgen command. It used to pass a fixed `installDeps: true` to
 * createBom(), so a cdxi session in secure mode ran the scanned project's
 * build tooling and install steps, which cdxgen skips in the same environment.
 *
 * Each case starts cdxi the way an analyst would, with a stand-in mvn first
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

const POM =
  "<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>demo</artifactId><version>1.0.0</version><dependencies><dependency><groupId>com.example</groupId><artifactId>demo-lib</artifactId><version>1.0.0</version></dependency></dependencies></project>";

// Variables that would pick another Maven, change the scan, or make the
// secure-mode environment audit stop the scan before it reaches Maven.
const SCRUBBED_ENV = new Set([
  "MAVEN_HOME",
  "M2_HOME",
  "MVN_CMD",
  "MAVEN_CMD",
  "MVN_ARGS",
  "MAVEN_ARGS",
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

// Deno runs a script only through its run subcommand, with permissions.
function runtimeArgs(script) {
  return globalThis.Deno ? ["run", "--allow-all", script] : [script];
}

/**
 * Run `.create` on a Maven project in a cdxi session, with a stand-in mvn
 * first on PATH.
 *
 * @param {Object} extraEnv Environment variables of the session
 * @returns {{status: number, output: string, mvnRuns: string[]}}
 */
function createInRepl(extraEnv) {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-repl-create-"));
  try {
    const toolDir = path.join(root, "bin");
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const marker = path.join(root, "mvn-runs.txt");
    mkdirSync(toolDir);
    mkdirSync(home);
    mkdirSync(project);
    writeFileSync(path.join(project, "pom.xml"), POM);
    writeStandInTool(toolDir, "mvn", marker);
    const env = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.startsWith("CDXGEN_") && !SCRUBBED_ENV.has(name)) {
        env[name] = value;
      } else if (globalThis.Deno) {
        // Deno merges the env option of spawnSync into its own environment
        // instead of replacing it, so a variable left out would still reach
        // the child. An empty value hides it.
        env[name] = "";
      }
    }
    env.PATH = [toolDir, process.env.PATH ?? process.env.Path]
      .filter(Boolean)
      .join(path.delimiter);
    env.HOME = home;
    env.USERPROFILE = home;
    env.CDXGEN_TEMP_DIR = path.join(root, "tmp");
    env.CDXGEN_REPL_HISTORY = path.join(root, "repl_history");
    // Secure mode refuses to run as root outside the cdxgen container image,
    // which would end the scan before the Maven step.
    if (process.getuid?.() === 0) {
      env.CDXGEN_IN_CONTAINER = "true";
    }
    mkdirSync(env.CDXGEN_TEMP_DIR);
    const result = spawnSync(process.execPath, runtimeArgs(replEntry), {
      cwd: root,
      encoding: "utf-8",
      env: { ...env, ...extraEnv },
      input: `.create ${project}\n`,
      timeout: 120000,
    });
    return {
      status: result.status,
      output: `${result.stdout || ""}${result.stderr || ""}`,
      mvnRuns: standInRuns(marker),
    };
  } finally {
    rmSync(root, { force: true, recursive: true, maxRetries: 3 });
  }
}

await it("cdxi .create keeps installs off in secure mode", () => {
  const { status, output, mvnRuns } = createInRepl({
    CDXGEN_SECURE_MODE: "true",
  });
  assert.strictEqual(status, 0, output);
  assert.deepStrictEqual(
    mvnRuns,
    [],
    "cdxi .create ran the project's Maven in secure mode",
  );
  assert.ok(
    output.includes("Skipping Maven"),
    `expected the skip message, got: ${output}`,
  );
});

await it("cdxi .create lets the operator turn installs back on in secure mode", () => {
  const { status, output, mvnRuns } = createInRepl({
    CDXGEN_SECURE_MODE: "true",
    CDXGEN_INSTALL_DEPS: "true",
  });
  assert.strictEqual(status, 0, output);
  assert.ok(
    mvnRuns.length > 0,
    `CDXGEN_INSTALL_DEPS=true did not run Maven: ${output}`,
  );
});

await it("cdxi .create honours CDXGEN_INSTALL_DEPS=false outside secure mode", () => {
  const { status, output, mvnRuns } = createInRepl({
    CDXGEN_INSTALL_DEPS: "false",
  });
  assert.strictEqual(status, 0, output);
  assert.deepStrictEqual(
    mvnRuns,
    [],
    "cdxi .create ran the project's Maven with CDXGEN_INSTALL_DEPS=false",
  );
});

await it("cdxi .create runs the project's Maven by default", () => {
  // Positive control: the stand-in mvn is reachable, so the cases above do
  // not pass only because Maven was never found.
  const { status, output, mvnRuns } = createInRepl({});
  assert.strictEqual(status, 0, output);
  assert.ok(mvnRuns.length > 0, `the stand-in mvn never ran: ${output}`);
});

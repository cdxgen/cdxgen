/**
 * Secure-mode test for the project-tooling gate.
 *
 * Lives in its own file because `isSecureMode` is an import-time snapshot of
 * CDXGEN_SECURE_MODE, so the environment must be prepared before any cdxgen
 * module is first imported. No cdxgen module may be statically imported here.
 *
 * Introspection mode normally keeps the scanned project's build tooling
 * available, but secure mode wins: `isProjectToolingAllowed` must refuse to
 * run it even with introspect on (issue #4527). The positive control in the
 * same process proves the stand-in mvn is reachable, so the first test cannot
 * pass only because mvn was never found.
 *
 * The installers cdxgen starts unless told not to (`rush install`, `pipenv
 * install`) follow the same secure-mode default through
 * `isDependencyInstallAllowed`.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assert, it } from "poku";

import {
  standInRuns,
  writeStandInTool,
} from "../../test/helpers/standInTool.js";

process.env.CDXGEN_SECURE_MODE = "true";

const ENV_NAMES = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "MVN_CMD",
  "MAVEN_CMD",
  "MVN_ARGS",
  "MAVEN_ARGS",
  "MAVEN_HOME",
  "M2_HOME",
  "CDXGEN_ALLOWED_COMMANDS",
];

const POM =
  "<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>demo</artifactId><version>1.0.0</version><dependencies><dependency><groupId>com.example</groupId><artifactId>demo-lib</artifactId><version>1.0.0</version></dependency></dependencies></project>";

/**
 * Scan a Maven project in secure mode with a stand-in mvn first on PATH.
 *
 * @param {Object} options Scan options
 * @returns {Promise<{mvnRuns: string[], printed: string[]}>}
 */
async function scanInSecureMode(options) {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-tooling-secure-"));
  const printed = [];
  const originalLog = console.log;
  try {
    const binDir = join(root, "bin");
    const project = join(root, "project");
    const home = join(root, "home");
    const marker = join(root, "mvn-runs.txt");
    mkdirSync(binDir);
    mkdirSync(home);
    mkdirSync(join(project, ".mvn"), { recursive: true });
    writeFileSync(join(project, "pom.xml"), POM);
    writeFileSync(
      join(project, ".mvn", "jvm.config"),
      "-javaagent:.mvn/agent.jar\n",
    );
    writeStandInTool(binDir, "mvn", marker);
    const searchPath = saved.PATH ?? saved.Path;
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.PATH = [binDir, searchPath].filter(Boolean).join(delimiter);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    console.log = (...args) => printed.push(args.join(" "));
    const { createJavaBom } = await import("./jvmBom.js");
    await createJavaBom(project, {
      projectType: ["java"],
      specVersion: 1.6,
      ...options,
    });
    return { mvnRuns: standInRuns(marker), printed };
  } finally {
    console.log = originalLog;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { force: true, recursive: true });
  }
}

await it("secure mode wins over introspection: mvn does not start", async () => {
  const { mvnRuns, printed } = await scanInSecureMode({
    installDeps: false,
    introspect: true,
  });
  assert.deepStrictEqual(
    mvnRuns,
    [],
    "mvn started in secure mode even though dependency installation is disabled",
  );
  assert.ok(
    printed.some((line) => line.includes("Skipping Maven")),
    `expected the skip message, printed: ${printed.join(" | ")}`,
  );
});

await it("secure mode keeps installs off when the options leave them unset", async () => {
  // A library caller that never sets installDeps gets the secure-mode
  // default, which is off.
  const { mvnRuns } = await scanInSecureMode({});
  assert.deepStrictEqual(mvnRuns, []);
});

await it("secure mode still runs mvn when installs are explicitly enabled (positive control)", async () => {
  const { mvnRuns } = await scanInSecureMode({ installDeps: true });
  assert.ok(mvnRuns.length > 0, "the stand-in mvn was never invoked");
});

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "sec-wrapper-gate",
);

/**
 * Scan a copy of a sec-wrapper-gate fixture in secure mode with stand-in
 * installers first on PATH.
 *
 * @param {string} fixture Fixture directory name
 * @param {string[]} tools Installers to stand in for; the first is reported
 * @param {Function} scan Receives the project directory and runs the scan
 * @returns {Promise<string[]>} Argument lines the first stand-in recorded
 */
async function installerRunsInSecureMode(fixture, tools, scan) {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-install-secure-"));
  const originalLog = console.log;
  const originalError = console.error;
  try {
    const binDir = join(root, "bin");
    const project = join(root, "project");
    mkdirSync(binDir);
    cpSync(join(FIXTURE_ROOT, fixture), project, { recursive: true });
    for (const tool of tools) {
      writeStandInTool(binDir, tool, join(root, `${tool}-runs.txt`), {
        exitCode: 0,
      });
    }
    const searchPath = saved.PATH ?? saved.Path;
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.PATH = [binDir, searchPath].filter(Boolean).join(delimiter);
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    // The scans report skipped and failed tools; keep the test output quiet
    console.log = () => undefined;
    console.error = () => undefined;
    await scan(project);
    return standInRuns(join(root, `${tools[0]}-runs.txt`));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { force: true, recursive: true });
  }
}

const scanRush = (options) =>
  installerRunsInSecureMode("rush", ["rush", "npm"], async (project) => {
    const { createNodejsBom } = await import("./jsBom.js");
    await createNodejsBom(project, {
      projectType: ["js"],
      specVersion: 1.6,
      ...options,
    });
  });

const scanPipenv = (options) =>
  installerRunsInSecureMode("pipenv", ["pipenv"], async (project) => {
    const { createPythonBom } = await import("./managedBom.js");
    await createPythonBom(project, {
      projectType: ["python"],
      specVersion: 1.6,
      ...options,
    });
  });

await it("secure mode keeps rush install off when the options leave installs unset", async () => {
  assert.deepStrictEqual(await scanRush({}), []);
  assert.deepStrictEqual(await scanRush({ installDeps: false }), []);
});

await it("secure mode still runs rush install when installs are explicitly enabled (positive control)", async () => {
  const rushRuns = await scanRush({ installDeps: true });
  assert.deepStrictEqual(rushRuns, ["install --no-link --bypass-policy"]);
});

await it("secure mode keeps pipenv install off when the options leave installs unset", async () => {
  assert.deepStrictEqual(await scanPipenv({}), []);
  assert.deepStrictEqual(await scanPipenv({ installDeps: false }), []);
});

await it("secure mode still runs pipenv install when installs are explicitly enabled (positive control)", async () => {
  const pipenvRuns = await scanPipenv({ installDeps: true });
  assert.deepStrictEqual(pipenvRuns, ["install"]);
});

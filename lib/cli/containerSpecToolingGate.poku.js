/**
 * Tests that the image scans a container manifest triggers never start the
 * scanned project's build tooling. An image name comes from the project, and
 * one that is a symlink to a directory of the project is not taken for an
 * image, so the nested scan reaches the source scanners. The stand-in mvn
 * records its invocation, and a positive control scans the same module
 * directly with installs on, so the negative tests cannot pass just because
 * the stand-in was never reachable.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import {
  standInRuns,
  writeStandInTool,
} from "../../test/helpers/standInTool.js";
import { resetRunState } from "../core/runState.js";

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
  "CDXGEN_INTROSPECT",
  "CDXGEN_SECURE_MODE",
];

const POM =
  "<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>demo</artifactId><version>1.0.0</version></project>";

/**
 * Scan a project whose compose file names the image `app`, where `app` is a
 * symlink to the project's Maven module, with a stand-in mvn on PATH.
 *
 * @param {Object} [extraOptions] Options added to the scan's own.
 * @param {string} [scanPath] Path to scan, relative to the project (default: the project itself).
 * @returns {Promise<string[]>} The runs the stand-in mvn recorded.
 */
async function scanComposeProject(extraOptions = {}, scanPath = "") {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const savedCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "cdxgen-compose-tooling-gate-"));
  try {
    const binDir = join(root, "bin");
    const project = join(root, "project");
    const emptyHome = join(root, "home");
    const marker = join(root, "mvn-runs.txt");
    mkdirSync(binDir);
    mkdirSync(emptyHome);
    mkdirSync(join(project, "module"), { recursive: true });
    writeFileSync(join(project, "module", "pom.xml"), POM);
    writeFileSync(
      join(project, "docker-compose.yml"),
      "services:\n  web:\n    image: app\n",
    );
    symlinkSync(join(project, "module"), join(project, "app"), "junction");
    writeStandInTool(binDir, "mvn", marker);
    const searchPath = saved.PATH ?? saved.Path;
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.PATH = [binDir, searchPath].filter(Boolean).join(delimiter);
    process.env.HOME = emptyHome;
    process.env.USERPROFILE = emptyHome;
    // Image names resolve against the working directory
    process.chdir(project);

    resetRunState();
    const { createBom } = await import("./index.js");
    await createBom(join(project, scanPath), {
      projectType: ["docker-compose"],
      specVersion: 1.6,
      ...extraOptions,
    });
    return standInRuns(marker);
  } finally {
    process.chdir(savedCwd);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    resetRunState();
    rmSync(root, { force: true, recursive: true });
  }
}

await it("starts mvn for a direct scan of the module with installs on (positive control)", async () => {
  const mvnRuns = await scanComposeProject(
    { projectType: ["java"], installDeps: true },
    "module",
  );
  assert.ok(
    mvnRuns.length > 0,
    "the stand-in mvn never ran, so the tests below prove nothing",
  );
});

await it("does not start mvn for a compose image name that is a symlink to a project directory with --no-install-deps", async () => {
  const mvnRuns = await scanComposeProject({ installDeps: false });
  assert.deepStrictEqual(
    mvnRuns,
    [],
    "the nested image scan started mvn even though dependency installation is disabled",
  );
});

await it("does not start mvn for a compose image scan that leaves installDeps unset", async () => {
  const mvnRuns = await scanComposeProject();
  assert.deepStrictEqual(
    mvnRuns,
    [],
    "the nested image scan started mvn; an image is only inventoried",
  );
});

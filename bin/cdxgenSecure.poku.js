/**
 * Tests that the cdxgen-secure command runs in secure mode however the
 * runtime reports the script path. It used to be a second name for
 * bin/cdxgen.js, recognised from process.argv[1]. Bun reports the real file
 * behind a symlink there, and the npm shims on Windows run bin/cdxgen.js by
 * its own path, so in both cases cdxgen-secure ran as plain cdxgen and
 * --introspect kept the project's Maven running. bin/cdxgen-secure.js now
 * turns secure mode on itself.
 *
 * The scans run with the runtime that runs this file, so the bun job checks
 * bun's own symlink handling.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assert, it } from "poku";

import {
  isWin,
  standInRuns,
  writeStandInTool,
} from "../test/helpers/standInTool.js";

const binDir = path.dirname(fileURLToPath(import.meta.url));
const secureEntry = path.join(binDir, "cdxgen-secure.js");
const cdxgenEntry = path.join(binDir, "cdxgen.js");

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
  "GRADLE_ARGS",
  "BAZEL_ARGS",
  "DENO_CERT",
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
 * Scan a Maven project whose `.mvn/jvm.config` plants a javaagent, with a
 * stand-in mvn first on PATH.
 *
 * @param {function(string): string} entryFor Script to run, given the scratch
 *   directory
 * @param {string[]} extraArgs Arguments after the project type
 * @returns {{status: number, output: string, mvnRuns: string[]}}
 */
function scan(entryFor, extraArgs) {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-secure-entry-"));
  try {
    const toolDir = path.join(root, "bin");
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const marker = path.join(root, "mvn-runs.txt");
    mkdirSync(toolDir);
    mkdirSync(home);
    mkdirSync(path.join(project, ".mvn"), { recursive: true });
    writeFileSync(path.join(project, "pom.xml"), POM);
    writeFileSync(
      path.join(project, ".mvn", "jvm.config"),
      "-javaagent:.mvn/agent.jar\n",
    );
    writeStandInTool(toolDir, "mvn", marker);
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
    // Secure mode refuses to run as root outside the cdxgen container image,
    // which would end the scan before the Maven step.
    if (process.getuid?.() === 0) {
      env.CDXGEN_IN_CONTAINER = "true";
    }
    const result = spawnSync(
      process.execPath,
      [
        entryFor(root),
        "-t",
        "java",
        ...extraArgs,
        // These tests are about secure mode; the formulation CI=true turns
        // on adds slow toolchain probes and nothing they check.
        "--no-include-formulation",
        "--no-banner",
        "-o",
        path.join(root, "bom.json"),
        project,
      ],
      { cwd: root, encoding: "utf-8", env, timeout: 120000 },
    );
    return {
      status: result.status,
      output: `${result.stdout || ""}${result.stderr || ""}`,
      mvnRuns: standInRuns(marker),
    };
  } finally {
    rmSync(root, { force: true, recursive: true, maxRetries: 3 });
  }
}

await it("cdxgen-secure stays in secure mode when the runtime names the real script", () => {
  // Bun reports this path for a symlinked command, and so do the npm shims
  // on Windows.
  const { status, output, mvnRuns } = scan(() => secureEntry, ["--introspect"]);
  assert.strictEqual(status, 0, output);
  assert.deepStrictEqual(
    mvnRuns,
    [],
    "cdxgen-secure ran the project's Maven with --introspect",
  );
  assert.ok(
    output.includes("Skipping Maven"),
    `expected the skip message, got: ${output}`,
  );
});

// Creating a symlink needs extra privileges on Windows.
await (isWin ? it.skip : it)(
  "a cdxgen-secure symlink stays in secure mode under this runtime",
  () => {
    const { status, output, mvnRuns } = scan(
      (root) => {
        const link = path.join(root, "cdxgen-secure");
        symlinkSync(secureEntry, link);
        return link;
      },
      ["--introspect"],
    );
    assert.strictEqual(status, 0, output);
    assert.deepStrictEqual(
      mvnRuns,
      [],
      "a cdxgen-secure symlink ran the project's Maven with --introspect",
    );
  },
);

await it("plain cdxgen with --introspect still runs the stand-in mvn (positive control)", () => {
  // Introspection keeps the project's tooling running outside secure mode,
  // so the stand-in is reachable and the tests above are not vacuous.
  const { mvnRuns, output } = scan(
    () => cdxgenEntry,
    ["--introspect", "--no-install-deps"],
  );
  assert.ok(mvnRuns.length > 0, `the stand-in mvn never ran: ${output}`);
});

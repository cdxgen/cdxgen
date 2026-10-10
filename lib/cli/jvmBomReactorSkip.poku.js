import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import { resetRunState } from "../core/runState.js";

// Runs createJavaBom over a two-project tree: one aggregator reactor with a
// nested aggregator, and one standalone project beside it. The stand-in mvn
// records the directory it ran in and writes trees as Maven does: a
// recursive run writes every reactor module's tree to -DoutputFile in
// reactor order, with ${project.groupId} and ${project.artifactId} expanded
// per module, so a fixed file name ends up holding only the last module.
// PATH and the Maven variables are process-wide, so the cases run one after
// the other.

const ENV_NAMES = [
  "PATH",
  "HOME",
  "MVN_CMD",
  "MAVEN_CMD",
  "MVN_ARGS",
  "MAVEN_ARGS",
  "MAVEN_HOME",
  "M2_HOME",
  "CDXGEN_DEBUG_MODE",
];

const POM = (artifactId, modules = []) =>
  `<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>${artifactId}</artifactId><version>1.0.0</version><modules>${modules
    .map((m) => `<module>${m}</module>`)
    .join("")}</modules></project>`;

/** Each module depends on one library named after it, so the BOM shows
 * whose tree was read. With __JSON__ set to "missing", the JSON attempts
 * write nothing, so the text retry runs, as with a real Maven whose JSON
 * output goes missing. */
const MVN_OK = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(__ARGS_LOG, basename(process.cwd()) + " " + args.join(" ") + "\\n");
const out = args.find((a) => a.startsWith("-DoutputFile="))?.slice("-DoutputFile=".length);
if (!out) process.exit(0);
const json = args.includes("-DoutputType=json");
if (json && __JSON__ === "missing") process.exit(0);
const reactor = (dir) => {
  const pom = readFileSync(join(dir, "pom.xml"), "utf-8");
  const modules = [...pom.matchAll(/<module>([^<]+)<\\/module>/g)].map((m) => m[1]);
  return [dir, ...(args.includes("-N") ? [] : modules.flatMap((m) => reactor(join(dir, m))))];
};
for (const dir of reactor(process.cwd())) {
  const artifactId = readFileSync(join(dir, "pom.xml"), "utf-8").match(/<artifactId>([^<]+)</)[1];
  const file = out.replaceAll("\${project.groupId}", "org.example").replaceAll("\${project.artifactId}", artifactId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, json
    ? JSON.stringify({ groupId: "org.example", artifactId, version: "1.0.0", type: "jar",
        children: [{ groupId: "com.example", artifactId: artifactId + "-lib", version: "1.0.0", type: "jar", scope: "compile" }] })
    : "org.example:" + artifactId + ":jar:1.0.0\\n+- com.example:" + artifactId + "-lib:jar:1.0.0:compile\\n");
}
`;

/** The stand-in that always fails with the recorded missing-artifact output. */
const MVN_FAIL = `#!/bin/sh
printf '%s %s\\n' "$(basename "$PWD")" "$*" >> __ARGS_LOG
cat __RECORDING
exit 1
`;

const ALL_LIBS = [
  "module-a-lib",
  "module-b-lib",
  "nested-lib",
  "root-app-lib",
  "standalone-lib",
];

/**
 * Scan the tree once and return the recorded (directory, arguments) pairs and
 * the names of the libraries in the BOM.
 *
 * @param {string} script Body of the stand-in mvn.
 * @returns {Promise<{runs: string[], dirs: string[], libs: string[]}>}
 */
async function scanWith(script) {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-mvn-reactor-"));
  try {
    const binDir = join(root, "bin");
    const project = join(root, "scan");
    const emptyHome = join(root, "home");
    const argsLog = join(root, "args.log");
    mkdirSync(binDir);
    mkdirSync(emptyHome);
    mkdirSync(project);
    mkdirSync(join(project, "module-a"), { recursive: true });
    mkdirSync(join(project, "module-b", "nested"), { recursive: true });
    mkdirSync(join(project, "other-project"), { recursive: true });
    writeFileSync(
      join(project, "pom.xml"),
      POM("root-app", ["module-a", "module-b"]),
    );
    writeFileSync(join(project, "module-a", "pom.xml"), POM("module-a"));
    writeFileSync(
      join(project, "module-b", "pom.xml"),
      POM("module-b", ["nested"]),
    );
    writeFileSync(
      join(project, "module-b", "nested", "pom.xml"),
      POM("nested"),
    );
    writeFileSync(join(project, "other-project", "pom.xml"), POM("standalone"));
    const fakeMvn = join(binDir, "mvn");
    writeFileSync(
      fakeMvn,
      script
        .replaceAll("__ARGS_LOG", JSON.stringify(argsLog))
        .replaceAll(
          "__RECORDING",
          JSON.stringify(
            join(
              import.meta.dirname,
              "..",
              "..",
              "test",
              "data",
              "jvm-rate-limits",
              "maven-404.txt",
            ),
          ),
        ),
    );
    chmodSync(fakeMvn, 0o755);
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.PATH = [binDir, saved.PATH].filter(Boolean).join(delimiter);
    process.env.HOME = emptyHome;

    resetRunState();
    const { createJavaBom } = await import("./jvmBom.js");
    const bomNSData = await createJavaBom(project, {
      multiProject: true,
      projectType: ["java"],
      specVersion: 1.6,
    });
    const runs = readFileSync(argsLog, "utf-8").split("\n").filter(Boolean);
    const libs = (bomNSData?.bomJson?.components || [])
      .filter((c) => c.group === "com.example")
      .map((c) => c.name)
      .sort();
    return {
      runs,
      dirs: [...new Set(runs.map((r) => r.split(" ")[0]))],
      libs,
    };
  } finally {
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

await it("a successful recursive root run skips the reactor's own poms and keeps their trees", async () => {
  if (process.platform === "win32") {
    // The stand-in is started through its shebang line.
    return;
  }
  const { runs, dirs, libs } = await scanWith(
    MVN_OK.replaceAll("__JSON__", '"written"'),
  );
  // Positive control: the stand-in recorded its calls.
  assert.ok(runs.length >= 1, "the stand-in mvn recorded no call");
  assert.deepEqual(
    dirs.sort(),
    ["other-project", "scan"],
    `the reactor members ran on their own: ${dirs.join(", ")}`,
  );
  // The aggregator spends a parent run and one tree run for the reactor;
  // the standalone project still runs its own tree.
  assert.equal(runs.length, 3, runs.join(" | "));
  assert.deepEqual(
    libs,
    ALL_LIBS,
    "a reactor module's dependencies were lost with its skipped run",
  );
});

await it("the text retry keeps every module's tree as well", async () => {
  if (process.platform === "win32") {
    return;
  }
  const { runs, dirs, libs } = await scanWith(
    MVN_OK.replaceAll("__JSON__", '"missing"'),
  );
  assert.deepEqual(dirs.sort(), ["other-project", "scan"]);
  // JSON and text for the parent run, the reactor tree and the standalone
  // project.
  assert.equal(runs.length, 6, runs.join(" | "));
  assert.deepEqual(libs, ALL_LIBS);
});

await it("a failed root run keeps every pom file running", async () => {
  if (process.platform === "win32") {
    // The stand-in is a POSIX shell script.
    return;
  }
  const { runs, dirs } = await scanWith(MVN_FAIL);
  assert.deepEqual(
    dirs.sort(),
    ["module-a", "module-b", "nested", "other-project", "scan"],
    "a failed root run must not cover the reactor",
  );
  // Full ladder for the aggregator, JSON plus text for each other pom.
  assert.equal(runs.length, 12, runs.join(" | "));
});

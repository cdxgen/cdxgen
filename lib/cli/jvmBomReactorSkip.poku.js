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
// records the directory it ran in. PATH and the Maven variables are
// process-wide, so the cases run one after the other.

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

/** The stand-in writes a text tree to the -DoutputFile the run names, except
 * for the JSON attempts, which write nothing so the text retry runs, as with
 * a real Maven whose JSON output goes missing. */
const MVN_OK = `#!/bin/sh
printf '%s %s\\n' "$(basename "$PWD")" "$*" >> __ARGS_LOG
out=""
for arg do
case "$arg" in
  -DoutputFile=*) out="\${arg#-DoutputFile=}";;
esac
done
if [ -n "$out" ]; then
case "$out" in
  *.json) ;;
  *) printf 'org.example:sample:jar:1.0.0\\n+- com.example:acme-lib:jar:1.0.0 compile\\n' > "$out" ;;
esac
fi
exit 0
`;

/** The stand-in that always fails with the recorded missing-artifact output. */
const MVN_FAIL = `#!/bin/sh
printf '%s %s\\n' "$(basename "$PWD")" "$*" >> __ARGS_LOG
cat __RECORDING
exit 1
`;

/**
 * Scan the tree once and return the recorded (directory, arguments) pairs.
 *
 * @param {string} script Body of the stand-in mvn.
 * @returns {Promise<{runs: string[], dirs: string[]}>}
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
    await createJavaBom(project, {
      multiProject: true,
      projectType: ["java"],
      specVersion: 1.6,
    });
    const runs = readFileSync(argsLog, "utf-8").split("\n").filter(Boolean);
    return { runs, dirs: [...new Set(runs.map((r) => r.split(" ")[0]))] };
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

await it("a successful recursive root run skips the reactor's own poms", async () => {
  if (process.platform === "win32") {
    // The stand-in is a POSIX shell script.
    return;
  }
  const { runs, dirs } = await scanWith(MVN_OK);
  // Positive control: the stand-in recorded its calls.
  assert.ok(runs.length >= 1, "the stand-in mvn recorded no call");
  assert.deepEqual(
    [...dirs].sort(),
    ["other-project", "scan"],
    `the reactor members ran on their own: ${dirs.join(", ")}`,
  );
  // The aggregator spends a parent run, a JSON tree run and its text retry;
  // the standalone project still runs its own tree.
  assert.equal(runs.length, 6, runs.join(" | "));
});

await it("a failed root run keeps every pom file running", async () => {
  if (process.platform === "win32") {
    // The stand-in is a POSIX shell script.
    return;
  }
  const { runs, dirs } = await scanWith(MVN_FAIL);
  assert.deepEqual(
    [...dirs].sort(),
    ["module-a", "module-b", "nested", "other-project", "scan"],
    "a failed root run must not cover the reactor",
  );
  // Full ladder for the aggregator, JSON plus text for each other pom.
  assert.equal(runs.length, 12, runs.join(" | "));
});

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

import { getLedgerEvents, resetLedgerEvents } from "../core/buildLedger.js";
import { resetRunState } from "../core/runState.js";

// Runs createJavaBom with a stand-in mvn on PATH that replays a recorded
// origin 429 (or a plain 404) from a repository and records its arguments.
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
  "CDXGEN_INTROSPECT",
];

const POM = (artifactId) =>
  `<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>${artifactId}</artifactId><version>1.0.0</version><dependencies><dependency><groupId>com.example</groupId><artifactId>acme-lib</artifactId><version>1.0.0</version></dependency></dependencies></project>`;

/**
 * Scan a three-pom reactor whose mvn always fails with the recorded output,
 * and return the argument lines of every mvn run plus what cdxgen printed.
 *
 * @param {string} recording Fixture file the stand-in mvn replays.
 * @returns {Promise<{runs: string[], printed: string[], events: Object[], home: string}>}
 */
async function scanWithRecording(recording) {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-mvn-rate-limit-"));
  const printed = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  try {
    const binDir = join(root, "bin");
    const project = join(root, "project");
    const emptyHome = join(root, "home");
    const argsLog = join(root, "args.log");
    mkdirSync(binDir);
    mkdirSync(emptyHome);
    mkdirSync(project);
    mkdirSync(join(project, "module-a"));
    mkdirSync(join(project, "module-b"));
    writeFileSync(join(project, "pom.xml"), POM("app"));
    writeFileSync(join(project, "module-a", "pom.xml"), POM("module-a"));
    writeFileSync(join(project, "module-b", "pom.xml"), POM("module-b"));
    const fakeMvn = join(binDir, "mvn");
    writeFileSync(
      fakeMvn,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}
cat ${JSON.stringify(join(dirNameStr(), recording))}
exit 1
`,
    );
    chmodSync(fakeMvn, 0o755);
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.PATH = [binDir, saved.PATH].filter(Boolean).join(delimiter);
    process.env.HOME = emptyHome;
    process.env.CDXGEN_INTROSPECT = "true";
    console.warn = (...args) => printed.push(args.join(" "));
    console.log = (...args) => printed.push(args.join(" "));

    resetRunState();
    resetLedgerEvents();
    const { createJavaBom } = await import("./jvmBom.js");
    await createJavaBom(project, {
      multiProject: true,
      projectType: ["java"],
      specVersion: 1.6,
    });
    const events = getLedgerEvents();
    return {
      runs: readFileSync(argsLog, "utf-8").split("\n").filter(Boolean),
      printed,
      events,
      home: emptyHome,
    };
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    resetRunState();
    resetLedgerEvents();
    rmSync(root, { force: true, recursive: true });
  }
}

/** Absolute test data directory, from this file's location. */
function dirNameStr() {
  return join(
    import.meta.dirname,
    "..",
    "..",
    "test",
    "data",
    "jvm-rate-limits",
  );
}

/** One run reduced to the facts that matter: tree goal, -N, json or text. */
function runShape(line) {
  const args = line.split(" ");
  const goal = ["dependency:tree", "-N"].filter((a) => args.includes(a));
  const format = args.includes("-DoutputType=json") ? "json" : "text";
  return [...goal, format].join(" ");
}

await it("a recorded 429 stops the scan after one Maven run", async () => {
  if (process.platform === "win32") {
    // The stand-in is a POSIX shell script.
    return;
  }
  const { runs, printed, events } = await scanWithRecording("maven-429.txt");
  // Positive control: the stand-in recorded its call before any assertion on
  // the empty list is made.
  assert.ok(runs.length >= 1, "the stand-in mvn recorded no call");
  assert.equal(
    runs.length,
    1,
    `expected one Maven run under a rate limit, got ${runs.length}: ${runs.join(" | ")}`,
  );
  assert.equal(runShape(runs[0]), "dependency:tree -N json", runs[0]);
  const hints = printed.filter((line) =>
    line.includes("rate limiting this machine"),
  );
  assert.equal(hints.length, 1, `the hint printed ${hints.length} times`);
  assert.match(hints[0] ?? "", /<mirror>/);
  assert.match(hints[0] ?? "", /MVNW_REPOURL/);
  assert.match(hints[0] ?? "", /MAVEN_CENTRAL_URL/);
  assert.ok(
    !printed.some((line) => line.includes("Java version requirement")),
    "the generic build hints replaced nothing",
  );
  const rateEvents = events.filter(
    (event) => event.remediationId === "build.rate-limited",
  );
  assert.equal(
    rateEvents.length,
    1,
    "build.rate-limited was not recorded once",
  );
  assert.equal(rateEvents[0]?.tool, "maven");
});

await it("a recorded 404 keeps today's retry behaviour", async () => {
  if (process.platform === "win32") {
    // The stand-in is a POSIX shell script.
    return;
  }
  const { runs, printed, events } = await scanWithRecording("maven-404.txt");
  const shapes = runs.map(runShape);
  assert.deepEqual(shapes, [
    "dependency:tree -N json",
    "dependency:tree -N text",
    "dependency:tree json",
    "dependency:tree text",
    "dependency:tree json",
    "dependency:tree text",
    "dependency:tree json",
    "dependency:tree text",
  ]);
  assert.ok(
    !printed.some((line) => line.includes("rate limiting this machine")),
    "a 404 was mistaken for a rate limit",
  );
  assert.equal(
    events.filter((event) => event.remediationId === "build.rate-limited")
      .length,
    0,
  );
});

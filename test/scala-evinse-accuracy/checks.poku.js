// Unit tests for the check logic of the Scala evinse accuracy script
// (contrib/scala-evinse-accuracy/check-chen.mjs). The checks are pure, so
// every fixture is a hand-written BOM, report and file resolver that answers
// from a Map; no cdxgen run and no chen checkout is involved.
import { join, normalize, resolve } from "node:path";

import { assert, describe, it } from "poku";

import {
  checkCallStacks,
  checkDependencyOccurrences,
  checkNoScalasemDiagnostics,
  checkOccurrenceLocations,
  checkScalasemRan,
  checkSingleSpelling,
  componentArtifacts,
  EXPECTED_DEPENDENCIES,
  MAX_OFFENDERS_PER_COMPONENT,
  matchesDependency,
  runAllChecks,
} from "../../contrib/scala-evinse-accuracy/checks.mjs";

const CPG2 = "pkg:maven/io.appthreat/cpg2@3.1.1?type=jar";

/** A BOM that passes every check, with its report and resolver. */
function passingBom() {
  return {
    specVersion: "1.6",
    metadata: {
      component: {
        type: "application",
        "bom-ref": "pkg:generic/io.appthreat/chen@4.0.0",
        purl: "pkg:generic/io.appthreat/chen@4.0.0",
        name: "chen",
        properties: [
          { name: "cdx:scalasem:schemaVersion", value: "scalasem/2" },
          { name: "cdx:scalasem:filesAnalyzed", value: "525" },
        ],
        evidence: {
          occurrences: [{ location: "src/Main.scala", line: 4 }],
        },
      },
    },
    components: [
      {
        type: "library",
        "bom-ref": CPG2,
        purl: CPG2,
        group: "io.appthreat",
        name: "cpg2",
        version: "3.1.1",
        properties: [{ name: "cdx:scala:compilerVersion", value: "3" }],
        evidence: {
          occurrences: [
            { location: "semanticcpg/src/main/scala/Explorer.scala", line: 12 },
          ],
          callstack: {
            frames: [
              {
                module: "io.appthreat.chen.Main$",
                function: "run",
                line: 4,
                fullFilename: "src/Main.scala",
              },
              {
                module: "io.shiftleft.semanticcpg.Explorer$.Walker",
                function: "walk",
                line: 12,
                fullFilename: "semanticcpg/src/main/scala/Explorer.scala",
              },
            ],
          },
        },
      },
      {
        type: "library",
        "bom-ref": "pkg:maven/com.lihaoyi/upickle_3@4.4.3?type=jar",
        purl: "pkg:maven/com.lihaoyi/upickle_3@4.4.3?type=jar",
        group: "com.lihaoyi",
        name: "upickle_3",
        version: "4.4.3",
        evidence: {
          occurrences: [{ location: "src/Main.scala", line: 9 }],
        },
      },
      {
        type: "library",
        "bom-ref": "pkg:maven/org.ow2.asm/asm@9.10.1?type=jar",
        purl: "pkg:maven/org.ow2.asm/asm@9.10.1?type=jar",
        group: "org.ow2.asm",
        name: "asm",
        version: "9.10.1",
        evidence: {
          occurrences: [{ location: "src/Main.scala#11" }],
        },
      },
      {
        type: "library",
        purl: "pkg:maven/org.ow2.asm/asm-util@9.10.1?type=jar",
        group: "org.ow2.asm",
        name: "asm-util",
        version: "9.10.1",
      },
    ],
  };
}

function passingReport() {
  return {
    _meta: {
      schemaVersion: "scalasem/2",
      diagnostics: [
        { code: "unresolved-symbols", module: "a", count: 3 },
        { code: "unresolved-symbols", module: "b", count: 4 },
        { code: "stale-output", module: "a", count: 1 },
      ],
    },
    "semanticcpg/src/main/scala/Explorer.scala": {
      calls: [{ line: 12, owner: "io.shiftleft.codepropertygraph.Cpg" }],
    },
    callStacks: [
      {
        frames: [],
        sink: {
          file: "semanticcpg/src/main/scala/Explorer.scala",
          line: 12,
          owner: "io.shiftleft.semanticcpg.Unrelated",
        },
      },
    ],
  };
}

// Paths go through node:path so the fixture answers for the separators the
// checks produce on Windows as well as on POSIX.
function passingResolver() {
  const chen = resolve("/chen");
  const files = new Map(
    [
      [join(chen, "src", "Main.scala"), { exists: true, lineCount: 20 }],
      [
        join(chen, "semanticcpg", "src", "main", "scala", "Explorer.scala"),
        { exists: true, lineCount: 15 },
      ],
      [join(chen, "empty.scala"), { exists: true, lineCount: 0 }],
    ].map(([path, stat]) => [normalize(path), stat]),
  );
  return {
    root: chen,
    statFile: (path) => files.get(normalize(path)) || { exists: false },
    namespacesOf: (component) =>
      component.purl === CPG2
        ? ["io.shiftleft.codepropertygraph.Cpg", "io.shiftleft.Implicits$"]
        : undefined,
  };
}

describe("dependency matching", () => {
  it("collects the names a component answers to, with and without Scala suffixes", () => {
    assert.deepEqual(
      componentArtifacts({
        name: "upickle_3",
        purl: "pkg:maven/com.lihaoyi/upickle_3@4.4.3?type=jar",
      }),
      ["upickle_3", "upickle"],
    );
    assert.deepEqual(
      componentArtifacts({ name: "org.ow2.asm:asm-util", purl: undefined }),
      ["asm-util"],
    );
  });

  it("matches the artifact exactly, never by prefix", () => {
    const upickleCore = {
      name: "upickle-core_3",
      purl: "pkg:maven/com.lihaoyi/upickle-core_3@4.4.3",
    };
    assert.ok(!matchesDependency("upickle", upickleCore));
    assert.ok(matchesDependency("upickle-core", upickleCore));
    assert.ok(matchesDependency("asm", { name: "asm", purl: undefined }));
    assert.ok(!matchesDependency("asm", { name: "asmack", purl: undefined }));
    assert.ok(!EXPECTED_DEPENDENCIES.some((entry) => entry.endsWith("*")));
  });
});

describe("check (a): scalasem ran", () => {
  it("passes when the BOM names the report schema and analysed files", () => {
    assert.deepEqual(
      checkScalasemRan(passingBom(), passingReport()).problems,
      [],
    );
  });

  it("fails a BOM from a run with the analyzer disabled or without a report", () => {
    const bom = passingBom();
    bom.metadata.component.properties = [];
    const { problems } = checkScalasemRan(bom, undefined);
    assert.equal(problems.length, 3);
    assert.ok(problems.some((problem) => problem.includes("no scalasem report")));
    const empty = passingBom();
    empty.metadata.component.properties[1].value = "0";
    assert.equal(checkScalasemRan(empty, passingReport()).problems.length, 1);
  });
});

describe("check (b): scalasem diagnostics", () => {
  it("lists every cdx:scalasem:diagnostic:* property", () => {
    const bom = passingBom();
    bom.metadata.component.properties.push(
      { name: "cdx:scalasem:diagnostic:helper-compile-failed", value: "12" },
      { name: "cdx:scalasem:degraded", value: "true" },
    );
    const { found } = checkNoScalasemDiagnostics(bom, passingReport());
    assert.deepEqual(
      found.map((diagnostic) => diagnostic.name),
      ["cdx:scalasem:diagnostic:helper-compile-failed"],
    );
  });

  it("sums the report's informational counts per code without failing", () => {
    const { found, informational } = checkNoScalasemDiagnostics(
      passingBom(),
      passingReport(),
    );
    assert.deepEqual(found, []);
    assert.deepEqual(informational, [
      { code: "stale-output", count: 1 },
      { code: "unresolved-symbols", count: 7 },
    ]);
  });
});

describe("check (c): expected dependencies have occurrences", () => {
  it("tells a dependency missing from the BOM from one without occurrences", () => {
    const { results } = checkDependencyOccurrences(passingBom(), [
      "cpg2",
      "upickle",
      "asm",
      "asm-util",
      "javaparser-symbol-solver-core",
    ]);
    assert.deepEqual(
      Object.fromEntries(results.map((r) => [r.dependency, r.status])),
      {
        cpg2: "ok",
        upickle: "ok",
        asm: "ok",
        "asm-util": "no-occurrence",
        "javaparser-symbol-solver-core": "missing",
      },
    );
  });
});

describe("check (d): occurrence locations resolve", () => {
  it("resolves locations against the project root, with the line inline or apart", () => {
    const { checked, offenderCount, offenders } = checkOccurrenceLocations(
      passingBom(),
      passingResolver(),
    );
    assert.equal(checked, 4);
    assert.equal(offenderCount, 0);
    assert.deepEqual(offenders, []);
  });

  it("fails missing files, lines past the end, and lines that are no positive whole number", () => {
    const bom = passingBom();
    bom.components[1].evidence.occurrences = [
      { location: "gone/Vanished.scala", line: 2 },
      { location: "src/Main.scala", line: 21 },
      { location: "src/Main.scala", line: 0 },
      { location: "src/Main.scala", line: 3.5 },
      { location: "src/Main.scala#99", line: 2 },
      { location: "empty.scala", line: 1 },
      // A file-only occurrence, and one whose line is null, are checked for
      // the file alone.
      { location: "src/Main.scala" },
      { location: "src/Main.scala", line: null },
      { location: "" },
    ];
    const { offenders, offenderCount } = checkOccurrenceLocations(
      bom,
      passingResolver(),
      { maxOffenders: 10 },
    );
    assert.equal(offenderCount, 7);
    assert.deepEqual(
      offenders.map((offender) => offender.reason),
      [
        "file not found",
        "line beyond end of file (20 lines)",
        "line must be a positive whole number",
        "line must be a positive whole number",
        "line 2 disagrees with the location's #99",
        "line beyond end of file (0 lines)",
        "no location",
      ],
    );
  });

  it("counts every offender while listing the first ones per component", () => {
    const bom = passingBom();
    bom.components[1].evidence.occurrences = Array.from(
      { length: MAX_OFFENDERS_PER_COMPONENT + 45 },
      (_, index) => ({ location: `gone/Gone${index}.scala`, line: 1 }),
    );
    const { offenders, offenderCount } = checkOccurrenceLocations(
      bom,
      passingResolver(),
    );
    assert.equal(offenders.length, MAX_OFFENDERS_PER_COMPONENT);
    assert.equal(offenderCount, MAX_OFFENDERS_PER_COMPONENT + 45);
    const row = runAllChecks(bom, passingReport(), passingResolver()).find(
      (candidate) => candidate.check === "occurrence locations resolve",
    );
    assert.match(row.summary, /^50 of 53 occurrences point nowhere \(5 listed\)$/);
  });
});

describe("check (e): call stacks end in the component that carries them", () => {
  it("verifies the stack against a class called at the report sink", () => {
    const result = checkCallStacks(
      passingBom(),
      passingReport(),
      passingResolver(),
    );
    assert.deepEqual(result, {
      stacks: 1,
      verified: 1,
      unverifiable: 0,
      offenders: [],
    });
  });

  it("fails a stack that calls a class the component does not ship", () => {
    const report = passingReport();
    report["semanticcpg/src/main/scala/Explorer.scala"].calls = [];
    const { offenders } = checkCallStacks(
      passingBom(),
      report,
      passingResolver(),
    );
    assert.equal(offenders.length, 1);
    assert.match(offenders[0].reason, /does not ship/);
  });

  it("fails a stack no report stack ends at, and broken frames", () => {
    const report = passingReport();
    report.callStacks[0].sink.line = 13;
    assert.match(
      checkCallStacks(passingBom(), report, passingResolver()).offenders[0]
        .reason,
      /no report stack has its sink/,
    );
    const bom = passingBom();
    bom.components[0].evidence.callstack.frames[0].line = 0;
    assert.match(
      checkCallStacks(bom, passingReport(), passingResolver()).offenders[0]
        .reason,
      /frame 1 of 2/,
    );
    bom.components[0].evidence.callstack.frames = [];
    assert.match(
      checkCallStacks(bom, passingReport(), passingResolver()).offenders[0]
        .reason,
      /without frames/,
    );
  });

  it("counts a component without namespaces, and fails a BOM without stacks", () => {
    const unverified = checkCallStacks(passingBom(), passingReport(), {});
    assert.equal(unverified.unverifiable, 1);
    assert.deepEqual(unverified.offenders, []);
    const bom = passingBom();
    delete bom.components[0].evidence.callstack;
    assert.match(
      checkCallStacks(bom, passingReport(), passingResolver()).offenders[0]
        .reason,
      /no component carries a call stack/,
    );
  });
});

describe("check (f): each library is listed once", () => {
  it("passes distinct libraries and the artifacts of different Scala versions", () => {
    const bom = passingBom();
    bom.components.push(
      {
        purl: "pkg:maven/org.apache.kafka/kafka_2.12@3.6.0",
        group: "org.apache.kafka",
        name: "kafka_2.12",
        version: "3.6.0",
      },
      {
        purl: "pkg:maven/org.apache.kafka/kafka_2.13@3.6.0",
        group: "org.apache.kafka",
        name: "kafka_2.13",
        version: "3.6.0",
      },
    );
    assert.deepEqual(checkSingleSpelling(bom).duplicates, []);
  });

  it("finds a library spelled twice, and a staged spelling left beside it", () => {
    const bom = passingBom();
    bom.components.push(
      {
        purl: "pkg:maven/io.appthreat/cpg2_3@3.1.1?type=jar",
        group: "io.appthreat",
        name: "cpg2_3",
        version: "3.1.1",
      },
      {
        purl: "pkg:maven/cpg2/io.appthreat.cpg2_3@3.1.1?type=jar",
        group: "cpg2",
        name: "io.appthreat.cpg2_3",
        version: "3.1.1",
      },
    );
    const { duplicates } = checkSingleSpelling(bom);
    assert.deepEqual(
      duplicates.map((duplicate) => duplicate.purls[1]),
      [
        "pkg:maven/io.appthreat/cpg2_3@3.1.1?type=jar",
        "pkg:maven/cpg2/io.appthreat.cpg2_3@3.1.1?type=jar",
      ],
    );
  });
});

describe("runAllChecks", () => {
  it("passes every row on a sound BOM", () => {
    const rows = runAllChecks(passingBom(), passingReport(), passingResolver(), {
      expectedDependencies: ["cpg2", "upickle", "asm"],
    });
    assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.ok(row.pass, `${row.check}: ${row.summary}`);
    }
  });

  it("fails the rows of an unsound BOM and says why", () => {
    const bom = passingBom();
    bom.metadata.component.properties.push({
      name: "cdx:scalasem:diagnostic:helper-compile-failed",
      value: "12",
    });
    bom.components = bom.components.filter((c) => c.name !== "upickle_3");
    bom.components[0].evidence.occurrences.push({
      location: "gone/Vanished.scala",
      line: 2,
    });
    const rows = runAllChecks(bom, passingReport(), passingResolver(), {
      expectedDependencies: ["cpg2", "upickle"],
    });
    assert.deepEqual(
      rows.map((row) => row.pass),
      [true, false, false, false, true, true],
    );
    assert.ok(rows[1].details[0].includes("helper-compile-failed"));
    assert.ok(rows[2].details[0].includes("missing from BOM"));
    assert.ok(rows[3].details[0].includes("gone/Vanished.scala"));
  });
});

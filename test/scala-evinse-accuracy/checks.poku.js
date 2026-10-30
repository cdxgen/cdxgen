// Unit tests for the check logic of the Scala evinse accuracy script
// (contrib/scala-evinse-accuracy/check-chen.mjs). The checks are pure, so
// every fixture is a hand-written BOM and a file resolver that answers from a
// Map; no cdxgen run and no chen checkout is involved.
import { join, normalize, resolve } from "node:path";

import { assert, describe, it } from "poku";

import {
  checkCallStacks,
  checkDependencyOccurrences,
  checkNoScalasemDiagnostics,
  checkOccurrenceLocations,
  componentArtifacts,
  matchesDependency,
  MAX_OFFENDERS_PER_COMPONENT,
  runAllChecks,
} from "../../contrib/scala-evinse-accuracy/checks.mjs";

/** A BOM that passes every check, over a resolver that holds its files. */
function passingBom() {
  return {
    specVersion: "1.5",
    metadata: {
      component: {
        type: "application",
        "bom-ref": "pkg:generic/io.appthreat/chen@4.0.0",
        purl: "pkg:generic/io.appthreat/chen@4.0.0",
        name: "chen",
        evidence: {
          occurrences: [{ location: "src/Main.scala", line: 4 }],
        },
      },
    },
    components: [
      {
        type: "library",
        "bom-ref": "pkg:maven/io.appthreat/cpg2_3@3.1.1?type=jar",
        purl: "pkg:maven/io.appthreat/cpg2_3@3.1.1?type=jar",
        name: "cpg2_3",
        evidence: {
          occurrences: [
            { location: "semanticcpg/src/main/scala/Explorer.scala", line: 12 },
            { location: "extracted/Gen.scala", line: 3 },
          ],
          callstack: {
            frames: [
              {
                module: "io.appthreat.chen.Main",
                function: "run",
                line: 4,
                fullFilename: "src/Main.scala",
              },
              {
                module: "io.shiftleft.cpg2.Cpg",
                function: "apply",
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
        name: "upickle_3",
        evidence: {
          occurrences: [{ location: "src/Main.scala", line: 9 }],
        },
      },
      {
        type: "library",
        "bom-ref": "pkg:maven/io.circe/circe-core_3@0.14.16?type=jar",
        purl: "pkg:maven/io.circe/circe-core_3@0.14.16?type=jar",
        name: "circe-core_3",
        evidence: {
          occurrences: [{ location: "extracted/Gen.scala", line: 3 }],
        },
      },
      {
        type: "library",
        "bom-ref": "pkg:maven/org.ow2.asm/asm-util@9.10.1?type=jar",
        purl: "pkg:maven/org.ow2.asm/asm-util@9.10.1?type=jar",
        name: "asm-util",
        evidence: {
          occurrences: [{ location: "platform/frontends/jimple2cpg/Asm.scala", line: 21 }],
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
      [
        join(chen, "extracted-roots", "overlay", "extracted", "Gen.scala"),
        { exists: true, lineCount: 5 },
      ],
      [
        join(chen, "platform", "frontends", "jimple2cpg", "Asm.scala"),
        { exists: true, lineCount: 30 },
      ],
    ].map(([path, stat]) => [normalize(path), stat]),
  );
  return {
    roots: [chen, join(chen, "extracted-roots", "overlay")],
    statFile: (path) => files.get(normalize(path)),
  };
}

describe("dependency matching", () => {
  it("collects the name and the purl artifact of a component", () => {
    assert.deepEqual(
      componentArtifacts({
        name: "upickle_3",
        purl: "pkg:maven/com.lihaoyi/upickle_3@4.4.3?type=jar",
      }),
      ["upickle_3"],
    );
    assert.deepEqual(
      componentArtifacts({ name: "org.ow2.asm:asm-util", purl: undefined }),
      ["org.ow2.asm:asm-util", "asm-util"],
    );
  });

  it("matches entries exactly and by prefix", () => {
    const upickle = { name: "upickle_3", purl: "pkg:maven/com.lihaoyi/upickle_3@4.4.3" };
    const upickleCore = { name: "upickle-core_3", purl: "pkg:maven/com.lihaoyi/upickle-core_3@4.4.3" };
    assert.ok(matchesDependency("upickle*", upickle));
    assert.ok(matchesDependency("upickle*", upickleCore));
    assert.ok(!matchesDependency("upickle", upickleCore));
    assert.ok(matchesDependency("javaparser-symbol-solver-core", {
      name: "javaparser-symbol-solver-core",
      purl: "pkg:maven/com.github.javaparser/javaparser-symbol-solver-core@3.27.0",
    }));
    assert.ok(matchesDependency("asm*", { name: "asm-util", purl: undefined }));
  });
});

describe("check (a): scalasem diagnostics", () => {
  it("passes when the metadata component carries no diagnostic property", () => {
    const bom = passingBom();
    bom.metadata.component.properties = [
      { name: "cdx:scalasem:degraded", value: "false" },
      { name: "cdx:scalasem:schemaVersion", value: "scalasem/2" },
    ];
    assert.deepEqual(checkNoScalasemDiagnostics(bom).found, []);
  });

  it("lists every cdx:scalasem:diagnostic:* property", () => {
    const bom = passingBom();
    bom.metadata.component.properties = [
      { name: "cdx:scalasem:diagnostic:helper-compile-failed", value: "12" },
      { name: "cdx:scalasem:diagnostic:stale-output", value: "3" },
      { name: "cdx:scalasem:degraded", value: "true" },
    ];
    const { found } = checkNoScalasemDiagnostics(bom);
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((d) => d.name),
      [
        "cdx:scalasem:diagnostic:helper-compile-failed",
        "cdx:scalasem:diagnostic:stale-output",
      ],
    );
  });
});

describe("check (b): expected dependencies have occurrences", () => {
  it("passes when every expected dependency has an occurrence", () => {
    const { results } = checkDependencyOccurrences(passingBom(), [
      "cpg2*",
      "upickle*",
      "circe-*",
      "asm*",
      "javaparser-symbol-solver-core",
    ]);
    // javaparser-symbol-solver-core is not in this fixture's BOM; only the
    // four present dependencies must be ok.
    const statuses = Object.fromEntries(
      results.map((r) => [r.dependency, r.status]),
    );
    assert.equal(statuses["cpg2*"], "ok");
    assert.equal(statuses["upickle*"], "ok");
    assert.equal(statuses["circe-*"], "ok");
    assert.equal(statuses["asm*"], "ok");
    assert.equal(statuses["javaparser-symbol-solver-core"], "missing");
  });

  it("reports a dependency that is not in the BOM as missing", () => {
    const bom = passingBom();
    bom.components = bom.components.filter((c) => c.name !== "upickle_3");
    const { results } = checkDependencyOccurrences(bom, ["upickle*"]);
    assert.equal(results[0].status, "missing");
    assert.equal(results[0].components, 0);
  });

  it("reports a present dependency without occurrences separately", () => {
    const bom = passingBom();
    delete bom.components[1].evidence.occurrences;
    const { results } = checkDependencyOccurrences(bom, ["upickle*"]);
    assert.equal(results[0].status, "no-occurrence");
    assert.equal(results[0].components, 1);
    assert.equal(results[0].occurrences, 0);
  });
});

describe("check (c): occurrence locations resolve", () => {
  it("passes when every occurrence resolves through the roots", () => {
    const bom = passingBom();
    // A location that still carries its line in the string resolves the same.
    bom.metadata.component.evidence.occurrences[0] = {
      location: "src/Main.scala#4",
    };
    const { checked, offenders } = checkOccurrenceLocations(
      bom,
      passingResolver(),
    );
    assert.equal(checked, 6);
    assert.deepEqual(offenders, []);
  });

  it("fails an occurrence whose file no root holds", () => {
    const bom = passingBom();
    bom.components[1].evidence.occurrences.push({
      location: "gone/Vanished.scala",
      line: 2,
    });
    const { offenders } = checkOccurrenceLocations(bom, passingResolver());
    assert.equal(offenders.length, 1);
    assert.equal(offenders[0].location, "gone/Vanished.scala");
    assert.equal(offenders[0].reason, "file not found");
  });

  it("fails an occurrence whose line is beyond the file", () => {
    const bom = passingBom();
    bom.components[1].evidence.occurrences = [
      { location: "src/Main.scala", line: 21 },
    ];
    const { offenders } = checkOccurrenceLocations(bom, passingResolver());
    assert.equal(offenders.length, 1);
    assert.match(offenders[0].reason, /beyond end of file \(20 lines\)/);
  });

  it("fails a non-positive line and accepts a file-only occurrence", () => {
    const bom = passingBom();
    bom.components[1].evidence.occurrences = [
      { location: "src/Main.scala", line: 0 },
      { location: "src/Main.scala" },
    ];
    const { offenders, checked } = checkOccurrenceLocations(bom, passingResolver());
    // The other components still contribute their occurrences to the count.
    assert.equal(checked, 7);
    assert.equal(offenders.length, 1);
    assert.equal(offenders[0].reason, "line must be positive");
  });

  it("reports at most the first offenders per component", () => {
    const bom = passingBom();
    bom.components[1].evidence.occurrences = Array.from(
      { length: MAX_OFFENDERS_PER_COMPONENT + 3 },
      (_, index) => ({ location: `gone/Gone${index}.scala`, line: 1 }),
    );
    const { offenders } = checkOccurrenceLocations(bom, passingResolver());
    assert.equal(offenders.length, MAX_OFFENDERS_PER_COMPONENT);
  });
});

describe("check (d): call stacks end in a component of the BOM", () => {
  it("passes on an intact stack over an identified component", () => {
    const { stacks, offenders } = checkCallStacks(passingBom());
    assert.equal(stacks, 1);
    assert.deepEqual(offenders, []);
  });

  it("fails call stack evidence without frames", () => {
    const bom = passingBom();
    bom.components[0].evidence.callstack.frames = [];
    const { offenders } = checkCallStacks(bom);
    assert.equal(offenders.length, 1);
    assert.match(offenders[0].reason, /without frames/);
  });

  it("fails a stack whose final frame names neither a class nor a file", () => {
    const bom = passingBom();
    bom.components[0].evidence.callstack.frames = [
      { module: "io.appthreat.chen.Main", function: "run", fullFilename: "src/Main.scala", line: 4 },
      { function: "apply" },
    ];
    const { offenders } = checkCallStacks(bom);
    assert.equal(offenders.length, 1);
    assert.match(offenders[0].reason, /neither a class nor a file/);
  });

  it("fails a stack on a component without a bom-ref or purl", () => {
    const bom = passingBom();
    delete bom.components[0]["bom-ref"];
    delete bom.components[0].purl;
    const { offenders } = checkCallStacks(bom);
    assert.equal(offenders.length, 1);
    assert.match(offenders[0].reason, /without a bom-ref or purl/);
  });
});

describe("runAllChecks", () => {
  it("passes every row on a sound BOM", () => {
    const rows = runAllChecks(passingBom(), passingResolver(), {
      expectedDependencies: ["cpg2*", "upickle*", "circe-*", "asm*"],
    });
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.ok(row.pass, `${row.check}: ${row.summary}`);
    }
  });

  it("fails the rows of an unsound BOM and says why", () => {
    const bom = passingBom();
    bom.metadata.component.properties = [
      { name: "cdx:scalasem:diagnostic:helper-compile-failed", value: "12" },
    ];
    bom.components = bom.components.filter((c) => c.name !== "upickle_3");
    bom.components[0].evidence.occurrences.push({
      location: "gone/Vanished.scala",
      line: 2,
    });
    const rows = runAllChecks(bom, passingResolver(), {
      expectedDependencies: ["cpg2*", "upickle*"],
    });
    assert.deepEqual(
      rows.map((row) => row.pass),
      [false, false, false, true],
    );
    assert.ok(rows[0].details[0].includes("helper-compile-failed"));
    assert.ok(rows[1].details[0].includes("missing from BOM"));
    assert.ok(rows[2].details[0].includes("gone/Vanished.scala"));
  });
});

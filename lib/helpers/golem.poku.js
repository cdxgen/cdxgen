import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { collectGolemEvidence, isGolemGoLanguage } from "./golem.js";

describe("golem helpers", () => {
  it("recognizes Go language aliases", () => {
    assert.strictEqual(isGolemGoLanguage("go"), true);
    assert.strictEqual(isGolemGoLanguage("golang"), true);
    assert.strictEqual(isGolemGoLanguage("java"), false);
  });

  it("collects occurrence, callstack, and safe property evidence", () => {
    const report = {
      tool: { version: "2.2.0" },
      modules: [
        {
          path: "example.com/app",
          main: true,
          purl: "pkg:golang/example.com/app",
          goVersion: "1.26",
        },
        {
          path: "github.com/google/uuid",
          version: "v1.6.0",
          purl: "pkg:golang/github.com/google/uuid@v1.6.0",
          goVersion: "1.20",
        },
      ],
      imports: [
        {
          module: { purl: "pkg:golang/github.com/google/uuid@v1.6.0" },
          direct: true,
          aliasKind: "default",
          range: { start: { filename: "main.go", line: 2, column: 8 } },
        },
      ],
      usages: [
        {
          module: { purl: "pkg:golang/github.com/google/uuid@v1.6.0" },
          kind: "selector",
          symbolKind: "function",
          range: { start: { filename: "main.go", line: 3, column: 22 } },
          enclosing: {
            id: "example.com/app||main|func()",
            kind: "function",
            name: "main",
          },
        },
      ],
      buildDirectives: [{ kind: "go-generate" }, { kind: "go-embed" }],
      nativeArtifacts: [{ kind: "assembly" }],
      securitySignals: [
        {
          category: "weak-crypto",
          severity: "high",
          packagePath: "github.com/google/uuid",
        },
      ],
      callGraph: {
        mode: "static",
        stats: { nodeCount: 2, edgeCount: 1 },
        edges: [
          {
            sourceId: "example.com/app.main",
            sourceName: "example.com/app.main",
            targetId: "github.com/google/uuid.NewString",
            callType: "static",
            position: { filename: "main.go", line: 3, column: 36 },
          },
        ],
      },
      stats: {
        packageCount: 2,
        moduleCount: 2,
        fileCount: 1,
        importCount: 1,
        declarationCount: 1,
        usageCount: 1,
        buildDirectiveCount: 2,
        nativeArtifactCount: 1,
        securitySignalCount: 1,
      },
    };

    const evidence = collectGolemEvidence(report, [
      { purl: "pkg:golang/example.com/app" },
      { purl: "pkg:golang/github.com/google/uuid@v1.6.0" },
    ]);

    assert.deepStrictEqual(
      Array.from(
        evidence.purlLocationMap["pkg:golang/github.com/google/uuid@v1.6.0"],
      ).sort(),
      ["main.go#2", "main.go#3"],
    );
    assert.strictEqual(
      evidence.dataFlowFrames["pkg:golang/github.com/google/uuid@v1.6.0"]
        .length,
      2,
    );
    assert.ok(
      evidence.componentPropertiesMap[
        "pkg:golang/github.com/google/uuid@v1.6.0"
      ].some(
        (property) =>
          property.name === "cdx:golem:securitySignalCategory" &&
          property.value === "weak-crypto",
      ),
    );
    assert.ok(
      evidence.metadataProperties.some(
        (property) =>
          property.name === "cdx:golem:buildDirectiveKinds" &&
          property.value === "go-embed,go-generate",
      ),
    );
    assert.ok(!JSON.stringify(evidence).includes("go run"));
  });

  it("spawns golem with argument arrays and shell disabled", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    const { runGolemAnalysis } = await esmock("./golem.js", {
      "./plugins.js": { resolvePluginBinary: sinon.stub().returns("golem") },
      "./utils.js": {
        DEBUG_MODE: false,
        getTmpDir: sinon.stub().returns("/tmp"),
        safeExistsSync: sinon.stub().returns(true),
        safeMkdtempSync: sinon.stub(),
        safeRmSync: sinon.stub(),
        safeSpawnSync,
      },
    });

    assert.strictEqual(
      runGolemAnalysis("/tmp/project", "/tmp/out.json", {
        golemCallgraph: "rta",
      }),
      true,
    );
    sinon.assert.calledOnce(safeSpawnSync);
    assert.strictEqual(safeSpawnSync.firstCall.args[0], "golem");
    assert.ok(Array.isArray(safeSpawnSync.firstCall.args[1]));
    assert.strictEqual(safeSpawnSync.firstCall.args[2].shell, false);
  });
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  collectGolemEvidence,
  isGolemGoLanguage,
  readGolemJsonFile,
  runGolemAnalysis,
} from "./golem.js";

describe("golem helpers", () => {
  it("recognizes Go language aliases", () => {
    assert.strictEqual(isGolemGoLanguage("go"), true);
    assert.strictEqual(isGolemGoLanguage("golang"), true);
    assert.strictEqual(isGolemGoLanguage("java"), false);
  });

  it("collects occurrence, callstack, and safe property evidence", () => {
    const report = {
      tool: { version: "2.2.0" },
      options: {
        noRecurse: false,
        includeAllFlows: false,
      },
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
          usageScope: "runtime",
          range: { start: { filename: "main.go", line: 2, column: 8 } },
        },
      ],
      usages: [
        {
          module: { purl: "pkg:golang/github.com/google/uuid@v1.6.0" },
          kind: "selector",
          symbolKind: "function",
          call: true,
          usageScope: "test",
          range: { start: { filename: "main.go", line: 3, column: 22 } },
          enclosing: {
            id: "example.com/app||main|func()",
            kind: "function",
            name: "main",
            usageScope: "test",
          },
        },
      ],
      files: [{ generatedBy: "protoc-gen-go" }],
      buildDirectives: [{ kind: "go-generate" }, { kind: "go-embed" }],
      nativeArtifacts: [{ kind: "assembly" }],
      supplyChain: {
        goDirectiveVersion: "1.26",
        toolchainDirective: "go1.26.3",
        goWorkPresent: true,
        vendorDirectoryPresent: true,
        replaces: [
          {
            modulePath: "github.com/google/uuid",
            targetPathKind: "relative",
            localReplacement: true,
          },
        ],
        excludes: [{ modulePath: "example.com/unused/module" }],
        modules: [
          {
            purl: "pkg:golang/github.com/google/uuid@v1.6.0",
            vendored: true,
            privateModuleCandidate: false,
            licenseFiles: ["LICENSE"],
            properties: { localReplacement: "true" },
          },
        ],
      },
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
          {
            sourceId: "example.com/app.main",
            sourceName: "example.com/app.main",
            targetId: "opaque.generated.symbol",
            sourcePurl: "pkg:golang/example.com/app",
            sinkPurl: "pkg:golang/github.com/google/uuid@v1.6.0#uuid",
            purls: [
              "pkg:golang/example.com/app",
              "pkg:golang/github.com/google/uuid@v1.6.0#uuid",
            ],
            callType: "static",
            position: { filename: "main.go", line: 4, column: 11 },
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
        runtimeUsageCount: 1,
        testUsageCount: 1,
        generatedFileCount: 1,
        buildDirectiveCount: 2,
        nativeArtifactCount: 1,
        securitySignalCount: 1,
        goModReplaceCount: 1,
        goModExcludeCount: 1,
        vendorModuleCount: 1,
        workspaceModuleCount: 1,
        licenseFileModuleCount: 1,
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
      ["main.go#2", "main.go#3", "main.go#4"],
    );
    assert.strictEqual(
      evidence.dataFlowFrames["pkg:golang/github.com/google/uuid@v1.6.0"]
        .length,
      3,
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
      evidence.componentPropertiesMap[
        "pkg:golang/github.com/google/uuid@v1.6.0"
      ].some(
        (property) =>
          property.name === "cdx:golem:usageScopes" &&
          property.value === "runtime,test",
      ),
    );
    assert.ok(
      evidence.componentPropertiesMap[
        "pkg:golang/github.com/google/uuid@v1.6.0"
      ].some(
        (property) =>
          property.name === "cdx:golem:occurrenceEvidenceKinds" &&
          property.value === "import,symbolCall",
      ),
    );
    assert.ok(
      evidence.componentPropertiesMap[
        "pkg:golang/github.com/google/uuid@v1.6.0"
      ].some(
        (property) =>
          property.name === "cdx:golem:licenseFiles" &&
          property.value === "LICENSE",
      ),
    );
    assert.ok(
      evidence.metadataProperties.some(
        (property) =>
          property.name === "cdx:golem:buildDirectiveKinds" &&
          property.value === "go-embed,go-generate",
      ),
    );
    assert.ok(
      evidence.metadataProperties.some(
        (property) =>
          property.name === "cdx:golem:generatorKinds" &&
          property.value === "protoc-gen-go",
      ),
    );
    assert.ok(
      evidence.metadataProperties.some(
        (property) =>
          property.name === "cdx:golem:goModReplaceCount" &&
          property.value === "1",
      ),
    );
    assert.ok(
      evidence.metadataProperties.some(
        (property) =>
          property.name === "cdx:golem:noRecurse" && property.value === "false",
      ),
    );
    assert.ok(
      evidence.metadataProperties.some(
        (property) =>
          property.name === "cdx:golem:includeAllFlows" &&
          property.value === "false",
      ),
    );
    assert.ok(!JSON.stringify(evidence).includes("go run"));
    assert.ok(!JSON.stringify(evidence).includes("example.com/unused/module@"));
  });

  it("uses direct Golem purl attributes for data-flow evidence matching", () => {
    const report = {
      modules: [
        {
          path: "example.com/app",
          main: true,
          purl: "pkg:golang/example.com/app",
        },
        {
          path: "github.com/acme/dep",
          version: "v1.2.3",
          purl: "pkg:golang/github.com/acme/dep@v1.2.3",
        },
      ],
      dataFlow: {
        nodes: [
          {
            id: "source",
            purl: "pkg:golang/github.com/acme/dep@v1.2.3#subpkg",
            function: "github.com/acme/dep/subpkg.Source",
            position: { filename: "dep.go", line: 12, column: 7 },
            category: "config",
          },
          {
            id: "sink",
            purl: "pkg:golang/github.com/acme/dep@v1.2.3#subpkg",
            function: "github.com/acme/dep/subpkg.Sink",
            position: { filename: "dep.go", line: 18, column: 3 },
            category: "filesystem",
          },
        ],
        slices: [
          {
            id: "slice",
            sourceId: "source",
            sinkId: "sink",
            nodeIds: ["source", "sink"],
            purls: ["pkg:golang/github.com/acme/dep@v1.2.3#subpkg"],
            sourceCategory: "config",
            sinkCategory: "filesystem",
            ruleId: "GOLEM-DATAFLOW-CONFIG-FILE",
            sinkScope: "runtime",
            taintKinds: ["config"],
          },
        ],
      },
    };

    const evidence = collectGolemEvidence(report, [
      { purl: "pkg:golang/example.com/app" },
      { purl: "pkg:golang/github.com/acme/dep@v1.2.3" },
    ]);

    assert.deepStrictEqual(
      Array.from(
        evidence.purlLocationMap["pkg:golang/github.com/acme/dep@v1.2.3"],
      ).sort(),
      ["dep.go#12", "dep.go#18"],
    );
    assert.strictEqual(
      evidence.dataFlowFrames["pkg:golang/github.com/acme/dep@v1.2.3"][0]
        .length,
      2,
    );
    assert.ok(
      evidence.componentPropertiesMap[
        "pkg:golang/github.com/acme/dep@v1.2.3"
      ].some(
        (property) =>
          property.name === "cdx:golem:dataFlowRuleId" &&
          property.value === "GOLEM-DATAFLOW-CONFIG-FILE",
      ),
    );
  });

  it("converts golem crypto evidence into crypto components", () => {
    const report = {
      modules: [
        {
          path: "example.com/app",
          main: true,
          purl: "pkg:golang/example.com/app",
        },
      ],
      crypto: {
        assets: [
          {
            id: "asset-md5",
            name: "md5",
            assetType: "algorithm",
            primitive: "hash",
            oid: "1.2.840.113549.2.5",
            strength: "weak",
            packagePath: "example.com/app",
            symbol: "crypto/md5.Sum",
            usageScope: "runtime",
            range: { start: { filename: "main.go", line: 10, column: 8 } },
          },
        ],
        operations: [
          {
            operationType: "hash",
            algorithm: "md5",
            assetId: "asset-md5",
            packagePath: "example.com/app",
            symbol: "crypto/md5.Sum",
            usageScope: "runtime",
            range: { start: { filename: "main.go", line: 10, column: 8 } },
          },
        ],
        materials: [
          {
            id: "material-private-key",
            type: "private-key",
            name: "privateKeyPEM",
            packagePath: "example.com/app",
            symbol: "literal",
            usageScope: "runtime",
            range: { start: { filename: "main.go", line: 5, column: 6 } },
          },
        ],
        protocols: [
          {
            id: "protocol-tls",
            name: "TLS",
            type: "tls",
            packagePath: "example.com/app",
            symbol: "crypto/tls.Config",
            usageScope: "runtime",
            range: { start: { filename: "main.go", line: 12, column: 10 } },
          },
        ],
        findings: [
          {
            ruleId: "GOLEM-CRYPTO-WEAK-MD5",
            severity: "high",
            packagePath: "example.com/app",
            range: { start: { filename: "main.go", line: 10, column: 8 } },
          },
        ],
      },
      dataFlow: {
        mode: "all",
        nodes: [
          {
            id: "source-env",
            kind: "source",
            name: "Getenv",
            symbol: "os.Getenv",
            packagePath: "example.com/app",
            module: { purl: "pkg:golang/example.com/app" },
            purl: "pkg:golang/example.com/app",
            function: "example.com/app.main",
            position: { filename: "main.go", line: 9, column: 10 },
            source: true,
            category: "environment",
            taintKinds: ["secret", "crypto-key"],
          },
          {
            id: "sink-crypto",
            kind: "sink",
            name: "Sum",
            symbol: "crypto/md5.Sum",
            packagePath: "example.com/app",
            module: { purl: "pkg:golang/example.com/app" },
            purl: "pkg:golang/example.com/app",
            function: "example.com/app.main",
            position: { filename: "main.go", line: 10, column: 8 },
            sink: true,
            category: "crypto",
            taintKinds: ["secret", "crypto-key"],
          },
        ],
        slices: [
          {
            id: "slice-crypto",
            sourceId: "source-env",
            sinkId: "sink-crypto",
            nodeIds: ["source-env", "sink-crypto"],
            sourceCategory: "environment",
            sinkCategory: "crypto",
            sourcePackagePath: "example.com/app",
            sourcePurl: "pkg:golang/example.com/app",
            sinkPackagePath: "example.com/app",
            sinkPurl: "pkg:golang/example.com/app",
            sinkSymbol: "crypto/md5.Sum",
            ruleId: "GOLEM-DATAFLOW-CRYPTO-MATERIAL",
            severity: "high",
            confidence: "medium",
            sinkScope: "runtime",
            taintKinds: ["crypto-key", "secret"],
          },
        ],
        stats: {
          sourceCount: 1,
          sinkCount: 1,
          sliceCount: 1,
          nodeCount: 2,
          edgeCount: 1,
          summaryCount: 0,
          functionCount: 1,
          instructionCount: 4,
        },
      },
      options: {
        dataFlowMode: "all",
        dataFlowCallGraphMode: "none",
        dataFlowPacks: ["all"],
      },
      stats: {
        dataFlowSourceCount: 1,
        dataFlowSinkCount: 1,
        dataFlowSliceCount: 1,
      },
    };

    const evidence = collectGolemEvidence(report, [
      { purl: "pkg:golang/example.com/app" },
    ]);

    const algorithmComponent = evidence.cryptoComponents.find(
      (component) => component.name === "md5",
    );
    assert.strictEqual(algorithmComponent.type, "cryptographic-asset");
    assert.strictEqual(
      algorithmComponent.cryptoProperties.assetType,
      "algorithm",
    );
    assert.strictEqual(
      algorithmComponent.cryptoProperties.oid,
      "1.2.840.113549.2.5",
    );
    assert.ok(
      evidence.cryptoComponents.some(
        (component) =>
          component.cryptoProperties?.relatedCryptoMaterialProperties?.type ===
          "private-key",
      ),
    );
    assert.ok(
      evidence.cryptoComponents.some(
        (component) =>
          component.cryptoProperties?.protocolProperties?.type === "tls",
      ),
    );
    assert.ok(
      evidence.componentPropertiesMap["pkg:golang/example.com/app"].some(
        (property) =>
          property.name === "cdx:golem:cryptoFinding" &&
          property.value === "GOLEM-CRYPTO-WEAK-MD5",
      ),
    );
    assert.ok(
      evidence.cryptoGeneratePurls["pkg:golang/example.com/app"].has(
        algorithmComponent["bom-ref"],
      ),
    );
    assert.ok(
      evidence.componentPropertiesMap["pkg:golang/example.com/app"].some(
        (property) =>
          property.name === "cdx:golem:cryptoDataFlowRuleId" &&
          property.value === "GOLEM-DATAFLOW-CRYPTO-MATERIAL",
      ),
    );
    assert.ok(
      evidence.metadataProperties.some(
        (property) =>
          property.name === "cdx:golem:cryptoDataFlowCount" &&
          property.value === "1",
      ),
    );
    assert.strictEqual(
      evidence.dataFlowFrames["pkg:golang/example.com/app"][0].length,
      2,
    );
    assert.ok(!JSON.stringify(evidence).includes("PRIVATE KEY"));
  });

  it("spawns golem deep mode with performance-oriented data-flow defaults", async () => {
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
      runGolemAnalysis("/tmp/project", "/tmp/out.json", { deep: true }),
      true,
    );
    const args = safeSpawnSync.firstCall.args[1];
    assert.strictEqual(args[args.indexOf("--callgraph") + 1], "none");
    assert.strictEqual(args[args.indexOf("--dataflow") + 1], "all");
    assert.strictEqual(
      args[args.indexOf("--dataflow-callgraph") + 1],
      "static",
    );
    assert.strictEqual(
      args[args.indexOf("--dataflow-pattern-packs") + 1],
      "all",
    );
    assert.strictEqual(args[args.indexOf("--dataflow-max-slices") + 1], "250");
    assert.ok(args.includes("--dataflow-skip-generated"));
    assert.ok(args.includes("--dataflow-skip-tests"));
    assert.ok(args.includes("--max-procs"));
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

  it("runs optional golem data-flow E2E smoke test when the binary is available", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-golem-e2e-"));
    const outputFile = join(projectDir, "golem.json");
    try {
      writeFileSync(
        join(projectDir, "go.mod"),
        "module example.com/app\n\ngo 1.22\n",
      );
      writeFileSync(
        join(projectDir, "main.go"),
        `package main

import (
  "crypto/aes"
  "os"
)

func main() {
  key := []byte(os.Getenv("APP_CRYPTO_KEY"))
  if len(key) >= 16 {
    _, _ = aes.NewCipher(key[:16])
  }
}
`,
      );
      if (
        !runGolemAnalysis(projectDir, outputFile, {
          deep: true,
          golemDataflowMaxSlices: 20,
          golemDataflowWorkers: 1,
          golemMaxProcs: 1,
        }) ||
        !existsSync(outputFile)
      ) {
        return;
      }
      const report = readGolemJsonFile(outputFile);
      assert.ok(report?.dataFlow);
      const evidence = collectGolemEvidence(report, [
        { purl: "pkg:golang/example.com/app" },
      ]);
      assert.ok(
        evidence.metadataProperties.some(
          (property) => property.name === "cdx:golem:dataFlowMode",
        ),
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

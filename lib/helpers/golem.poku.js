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
    assert.ok(!JSON.stringify(evidence).includes("go run"));
    assert.ok(!JSON.stringify(evidence).includes("example.com/unused/module@"));
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
    assert.ok(!JSON.stringify(evidence).includes("PRIVATE KEY"));
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

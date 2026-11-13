import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { fullFormats } from "ajv-formats/dist/formats.js";
import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  collectGolemEvidence,
  collectGolemServices,
  isGolemGoLanguage,
  normalizeGolemRoutePath,
  parseGolemRoutePattern,
  readGolemJsonFile,
  runGolemAnalysis,
  sanitizeGolemEndpointUrl,
} from "./golem.js";

/**
 * Assert every endpoint of a golem service map is an RFC 3986 reference:
 * ajv's uri-reference pattern, which lets a colon into the first segment of
 * a relative reference, plus that rule, so `:8080` fails as it should.
 */
function assertUriReferences(servicesMap) {
  for (const definition of Object.values(servicesMap)) {
    for (const endpoint of definition.endpoints) {
      assert.ok(
        fullFormats["uri-reference"].test(endpoint) &&
          (endpoint.startsWith("/") ||
            /^[a-z][a-z0-9+.-]*:\/\//.test(endpoint)),
        `${endpoint} is not an RFC 3986 reference`,
      );
    }
  }
}

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

  // A Windows golem report names files with backslashes; the occurrence keys
  // use forward slashes so the same place is one occurrence whatever spelled it
  // (issue 4726).
  it("keys occurrences with forward slashes whatever separator the report uses", () => {
    const report = {
      modules: [
        {
          path: "example.com/app",
          main: true,
          purl: "pkg:golang/example.com/app",
        },
        {
          path: "github.com/google/uuid",
          version: "v1.6.0",
          purl: "pkg:golang/github.com/google/uuid@v1.6.0",
        },
      ],
      imports: [
        {
          module: { purl: "pkg:golang/github.com/google/uuid@v1.6.0" },
          direct: true,
          range: {
            start: { filename: "src\\app\\main.go", line: 2, column: 8 },
          },
        },
      ],
    };
    const evidence = collectGolemEvidence(report, [
      { purl: "pkg:golang/example.com/app" },
      { purl: "pkg:golang/github.com/google/uuid@v1.6.0" },
    ]);
    assert.deepStrictEqual(
      Array.from(
        evidence.purlLocationMap["pkg:golang/github.com/google/uuid@v1.6.0"],
      ),
      ["src/app/main.go#2"],
    );
  });

  it("matches golem module purls to the canonical purls of mixed-case modules", () => {
    // golem 2.5.1 prints module paths as Go does, keeping their upper-case
    // letters, while cdxgen components carry the canonical golang purl.
    const report = JSON.parse(
      readFileSync(
        join("test", "data", "golem-mixed-case", "golem-report.json"),
        "utf-8",
      ),
    );
    assert.ok(
      report.modules.some(
        (module) =>
          module.purl === "pkg:golang/github.com/BurntSushi/toml@v1.3.2",
      ),
    );
    // The component purls `cdxgen -t go` reports for the same project.
    const purls = [
      "pkg:golang/github.com/burntsushi/toml@v1.3.2",
      "pkg:golang/github.com/dgrijalva/jwt-go@v3.2.0%2Bincompatible",
      "pkg:golang/github.com/masterminds/semver/v3@v3.2.1",
    ];
    const evidence = collectGolemEvidence(
      report,
      purls.map((purl) => ({ purl })),
    );
    for (const purl of purls) {
      assert.ok(evidence.purlLocationMap[purl]?.size, purl);
    }
    // The module path keeps Go's spelling.
    assert.ok(
      evidence.componentPropertiesMap[
        "pkg:golang/github.com/burntsushi/toml@v1.3.2"
      ].some(
        (property) =>
          property.name === "cdx:golem:modulePath" &&
          property.value === "github.com/BurntSushi/toml",
      ),
    );
    assert.ok(
      evidence.componentPropertiesMap[
        "pkg:golang/github.com/masterminds/semver/v3@v3.2.1"
      ].some((property) => property.name === "cdx:golem:usageScopes"),
    );
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

  it("attaches the evidence of a replaced module to the replacement cdxgen reports", () => {
    // Module records golem 2.5.1 printed for test/data/go-replace. cdxgen
    // reports a module replacement under the replacement's purl, and a
    // directory replacement without a version.
    const report = {
      modules: [
        {
          path: "example.com/local",
          version: "v0.0.0",
          purl: "pkg:golang/example.com/local@v0.0.0",
          replace: { path: "./local", goVersion: "1.22" },
        },
        {
          path: "github.com/mholt/archiver/v3",
          version: "v3.5.1",
          purl: "pkg:golang/github.com/mholt/archiver/v3@v3.5.1",
          replace: {
            path: "github.com/anchore/archiver/v3",
            version: "v3.5.2",
            goVersion: "1.13",
            purl: "pkg:golang/github.com/anchore/archiver/v3@v3.5.2",
          },
        },
      ],
    };
    const evidence = collectGolemEvidence(report, [
      { purl: "pkg:golang/example.com/local" },
      { purl: "pkg:golang/github.com/anchore/archiver/v3@v3.5.2" },
    ]);
    assert.ok(
      evidence.componentPropertiesMap[
        "pkg:golang/github.com/anchore/archiver/v3@v3.5.2"
      ].some(
        (property) =>
          property.name === "cdx:golem:modulePath" &&
          property.value === "github.com/mholt/archiver/v3",
      ),
    );
    assert.ok(
      evidence.componentPropertiesMap["pkg:golang/example.com/local"].some(
        (property) =>
          property.name === "cdx:golem:modulePath" &&
          property.value === "example.com/local",
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
      "../inventory/plugins.js": {
        resolvePluginBinary: sinon.stub().returns("golem"),
      },
      "../core/activity.js": { DEBUG_MODE: false },
      "../core/fs.js": {
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
    assert.strictEqual(args[args.indexOf("--callgraph") + 1], "static");
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
      "../inventory/plugins.js": {
        resolvePluginBinary: sinon.stub().returns("golem"),
      },
      "../core/activity.js": { DEBUG_MODE: false },
      "../core/fs.js": {
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

  it("falls back to the static call graph for an unrecognised mode", async () => {
    // The fallback used to be the data-flow mode ("security"), which is not
    // a call-graph mode and made golem reject the whole run.
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    const { runGolemAnalysis } = await esmock("./golem.js", {
      "../inventory/plugins.js": {
        resolvePluginBinary: sinon.stub().returns("golem"),
      },
      "../core/activity.js": { DEBUG_MODE: false },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns("/tmp"),
        safeExistsSync: sinon.stub().returns(true),
        safeMkdtempSync: sinon.stub(),
        safeRmSync: sinon.stub(),
        safeSpawnSync,
      },
    });
    runGolemAnalysis("/tmp/project", "/tmp/out.json", {
      golemCallgraph: "bogus",
      golemDataflow: "security",
    });
    const args = safeSpawnSync.firstCall.args[1];
    assert.strictEqual(args[args.indexOf("--callgraph") + 1], "static");
  });

  it("resolves a doubled directory against the working directory for golem", async () => {
    // depscan launches cdxgen with cwd set to the project while forwarding a
    // repo-root-relative source path; a plain resolve joins the two into a
    // directory that does not exist. runGolemAnalysis must pass the working
    // directory (a Go module) to the plugin instead.
    // The working directory is the project the repo-root-relative argument
    // names: its trailing segments are the argument itself.
    const fixtureRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "cdxgen-golem-cwd-")),
    );
    const projectDir = join(
      fixtureRoot,
      "test",
      "data",
      "golem",
      "repos",
      "some-app",
    );
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "go.mod"), "module example.com/app\n");
    const previousCwd = process.cwd();
    process.chdir(projectDir);
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    try {
      const { runGolemAnalysis } = await esmock("./golem.js", {
        "../inventory/plugins.js": {
          resolvePluginBinary: sinon.stub().returns("golem"),
        },
        "../core/activity.js": { DEBUG_MODE: false },
        "../core/fs.js": {
          getTmpDir: sinon.stub().returns("/tmp"),
          // Only the report file exists; the doubled directory does not.
          safeExistsSync: (p) => p === "/tmp/out.json",
          safeMkdtempSync: sinon.stub(),
          safeRmSync: sinon.stub(),
          safeSpawnSync,
        },
      });
      assert.strictEqual(
        runGolemAnalysis("test/data/golem/repos/some-app", "/tmp/out.json", {
          deep: true,
        }),
        true,
      );
      const args = safeSpawnSync.firstCall.args[1];
      assert.strictEqual(args[args.indexOf("--dir") + 1], projectDir);
      assert.strictEqual(safeSpawnSync.firstCall.args[2].cwd, projectDir);
    } finally {
      process.chdir(previousCwd);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("reports a failed analysis with its directory and honors fail-on-error", async () => {
    const safeSpawnSync = sinon
      .stub()
      .returns({ status: 3, stderr: "boom", error: undefined });
    const { runGolemAnalysis } = await esmock("./golem.js", {
      "../inventory/plugins.js": {
        resolvePluginBinary: sinon.stub().returns("golem"),
      },
      "../core/activity.js": { DEBUG_MODE: false },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns("/tmp"),
        safeExistsSync: sinon.stub().returns(false),
        safeMkdtempSync: sinon.stub(),
        safeRmSync: sinon.stub(),
        safeSpawnSync,
      },
    });
    // Without introspection, --fail-on-error exits the process; stubbed here
    // so the test can observe the call instead of dying.
    const exitStub = sinon.stub(process, "exit");
    const errorSpy = sinon.spy(console, "error");
    try {
      assert.strictEqual(
        runGolemAnalysis("/tmp/project", "/tmp/out.json", {
          failOnError: true,
        }),
        false,
      );
    } finally {
      errorSpy.restore();
      exitStub.restore();
    }
    const messages = errorSpy.getCalls().map((c) => c.args.join(" "));
    // resolve() keeps the assertion path-separator agnostic (Windows renders
    // the drive-relative form with backslashes).
    const projectDir = resolve("/tmp/project");
    assert.ok(
      messages.some(
        (m) => m.includes("golem analysis") && m.includes(projectDir),
      ),
      `expected an analysis failure message naming the directory, got ${JSON.stringify(messages)}`,
    );
    assert.ok(
      !messages.some((m) => m.includes("installed successfully")),
      "an analysis failure must not be reported as an installation problem",
    );
    sinon.assert.calledOnceWithExactly(exitStub, 1);
  });

  it("persists the raw golem report to semanticsSlicesFile when provided", async () => {
    // Under --profile research, evinse passes --semantics-slices-file to golem;
    // analyzeGolemProject must persist the FULL raw report there (call graph +
    // data-flow slices + usages) instead of writing it to a throwaway temp dir.
    const durableDir = mkdtempSync(join(tmpdir(), "cdxgen-golem-durable-"));
    const durablePath = join(durableDir, "go-semantics.slices.json");
    const mkdtempSpy = sinon.spy((...args) => mkdtempSync(...args));
    const rmSpy = sinon.spy((...args) => rmSync(...args));
    const syntheticReport = {
      schemaVersion: "0.1",
      tool: { name: "golem", version: "2.2.0" },
      callGraph: {
        mode: "static",
        nodes: [{ id: "n1", name: "main" }],
        edges: [],
      },
      dataFlow: {
        mode: "all",
        nodes: [],
        edges: [],
        slices: [],
        stats: { truncated: false },
      },
      usages: [],
      stats: { moduleCount: 1 },
    };
    // Stub the golem spawn to write the synthetic report to --out and succeed.
    const safeSpawnSync = sinon.stub().callsFake((_executable, args) => {
      writeFileSync(
        args[args.indexOf("--out") + 1],
        JSON.stringify(syntheticReport),
      );
      return { status: 0, stdout: "", stderr: "" };
    });
    const { analyzeGolemProject: mockedAnalyze } = await esmock("./golem.js", {
      "../inventory/plugins.js": {
        resolvePluginBinary: sinon.stub().returns("golem"),
      },
      "../core/activity.js": { DEBUG_MODE: false },
      "../core/fs.js": {
        getTmpDir: () => tmpdir(),
        safeExistsSync: existsSync,
        safeMkdtempSync: mkdtempSpy,
        safeRmSync: rmSpy,
        safeSpawnSync,
      },
    });

    const report = mockedAnalyze("/tmp/project", {
      semanticsSlicesFile: durablePath,
      profile: "research",
    });

    // the returned report carries the full call graph + data flow
    assert.strictEqual(report?.schemaVersion, syntheticReport.schemaVersion);
    assert.ok(report?.callGraph, "returned report must carry callGraph");
    assert.ok(report?.dataFlow, "returned report must carry dataFlow");
    // the durable file persists on disk with the full report
    assert.ok(existsSync(durablePath), "durable report file must persist");
    const persisted = JSON.parse(readFileSync(durablePath, "utf-8"));
    assert.ok(persisted.callGraph, "persisted report must carry callGraph");
    assert.ok(persisted.dataFlow, "persisted report must carry dataFlow");
    assert.strictEqual(
      persisted.schemaVersion,
      "0.1",
      "persisted report must declare a schemaVersion",
    );
    // the durable path is used directly -- no temp dir created or cleaned up
    assert.strictEqual(mkdtempSpy.callCount, 0);
    assert.strictEqual(rmSpy.callCount, 0);

    rmSync(durableDir, { recursive: true, force: true });
  });

  it("uses a temp dir and deletes the report when semanticsSlicesFile is absent", async () => {
    // Default behaviour: without --semantics-slices-file the report is written
    // to a temp dir and removed after parsing, so no file persists on disk.
    const mkdtempSpy = sinon.spy((...args) => mkdtempSync(...args));
    const rmSpy = sinon.spy((...args) => rmSync(...args));
    const syntheticReport = {
      schemaVersion: "0.1",
      tool: { name: "golem", version: "2.2.0" },
      callGraph: { mode: "static", nodes: [], edges: [] },
      dataFlow: { mode: "all", nodes: [], edges: [], slices: [] },
    };
    const safeSpawnSync = sinon.stub().callsFake((_executable, args) => {
      writeFileSync(
        args[args.indexOf("--out") + 1],
        JSON.stringify(syntheticReport),
      );
      return { status: 0, stdout: "", stderr: "" };
    });
    const { analyzeGolemProject: mockedAnalyze } = await esmock("./golem.js", {
      "../inventory/plugins.js": {
        resolvePluginBinary: sinon.stub().returns("golem"),
      },
      "../core/activity.js": { DEBUG_MODE: false },
      "../core/fs.js": {
        getTmpDir: () => tmpdir(),
        safeExistsSync: existsSync,
        safeMkdtempSync: mkdtempSpy,
        safeRmSync: rmSpy,
        safeSpawnSync,
      },
    });

    const report = mockedAnalyze("/tmp/project", { profile: "research" });

    // the report is still parsed and returned
    assert.strictEqual(report?.schemaVersion, syntheticReport.schemaVersion);
    // a temp dir was created and cleaned up in the finally block
    assert.strictEqual(mkdtempSpy.callCount, 1);
    assert.strictEqual(rmSpy.callCount, 1);
    const tempDir = mkdtempSpy.firstCall.returnValue;
    assert.ok(
      tempDir?.startsWith(tmpdir()),
      "temp dir should live under getTmpDir()",
    );
    assert.ok(
      !existsSync(tempDir),
      "temp dir must be removed in the finally block so no report persists",
    );
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

  // #4498 — golem rolls the routes it found into a services[] section. The
  // collector projects it into the evinse service map, the way kosi and dosai
  // already do for their languages, so a Go saasbom run can list services.
  it("collects services with normalized route paths", () => {
    const report = {
      services: [
        {
          id: "service|server|example.com/gotest-gin|gin",
          name: "gin",
          kind: "server",
          packagePath: "example.com/gotest-gin",
          endpoints: [
            {
              endpointId: "example.com/gotest-gin|endpoint|1",
              method: "GET",
              path: "/api/users/:id",
              properties: { framework: "gin", handler: "func literal" },
            },
            {
              endpointId: "example.com/gotest-gin|endpoint|2",
              method: "GET",
              path: "/ping",
              properties: { framework: "gin" },
            },
            {
              endpointId: "example.com/gotest-gin|endpoint|3",
              method: "POST",
              path: "/api/users",
              properties: { framework: "gin" },
            },
          ],
          properties: { evidence: "api-endpoint" },
        },
        {
          id: "service|server|example.com/gotest|:8080",
          name: ":8080",
          kind: "server",
          host: ":8080",
          scheme: "http",
          endpoints: [
            {
              endpointId: "example.com/gotest|endpoint|4",
              path: ":8080",
              properties: { framework: "net/http", handler: "r" },
            },
          ],
        },
      ],
    };
    const servicesMap = collectGolemServices(report);
    assert.deepStrictEqual(Object.keys(servicesMap).sort(), [
      "service|server|example.com/gotest-gin|gin",
      "service|server|example.com/gotest|:8080",
    ]);
    const ginService = servicesMap["service|server|example.com/gotest-gin|gin"];
    assert.deepStrictEqual(ginService.name, "gin");
    // CycloneDX types endpoints as iri-references, which cannot hold braces.
    assert.deepStrictEqual(Array.from(ginService.endpoints).sort(), [
      "/api/users",
      "/api/users/%7Bid%7D",
      "/ping",
    ]);
    const prop = (name) =>
      ginService.properties
        .filter((p) => p.name === name)
        .map((p) => p.value)
        .sort();
    assert.deepStrictEqual(prop("cdx:service:httpMethod"), ["get", "post"]);
    assert.deepStrictEqual(prop("cdx:golem:service:framework"), ["gin"]);
    assert.deepStrictEqual(prop("cdx:golem:service:kind"), ["server"]);
    assert.deepStrictEqual(prop("cdx:golem:service:package"), [
      "example.com/gotest-gin",
    ]);
    // A listener address is not a route or a valid URI reference: the
    // service keeps it as its host property only.
    const listener = servicesMap["service|server|example.com/gotest|:8080"];
    assert.deepStrictEqual(Array.from(listener.endpoints), []);
    const listenerProps = listener.properties
      .filter((p) => p.name === "cdx:golem:service:host")
      .map((p) => p.value);
    assert.deepStrictEqual(listenerProps, [":8080"]);
  });

  it("collects no services from a report without any", () => {
    const servicesMap = collectGolemServices({ tool: { name: "golem" } });
    assert.deepStrictEqual(servicesMap, {});
  });

  it("normalizes go route path placeholders", () => {
    // gin, echo and iris
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/api/users/:id"),
      "/api/users/{id}",
    );
    // chi and gorilla/mux, with and without a regex constraint
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/api/users/{id}"),
      "/api/users/{id}",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/api/users/{id:[0-9]+}"),
      "/api/users/{id}",
    );
    // catch-all wildcards
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/static/*filepath"),
      "/static/{filepath}",
    );
    // Go 1.22 net/http pattern catch-alls
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/files/{path...}"),
      "/files/{path}",
    );
    // placeholders are only recognised at the start of a segment: literal
    // colons inside one are left alone
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/time/09:30"),
      "/time/09:30",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/colon:path"),
      "/colon:path",
    );
    // echo's bare catch-all has no placeholder name to normalise
    assert.deepStrictEqual(normalizeGolemRoutePath("/static/*"), "/static/*");
    // listener addresses and odd values are returned as they are
    assert.deepStrictEqual(normalizeGolemRoutePath(":8080"), ":8080");
    assert.deepStrictEqual(normalizeGolemRoutePath(undefined), undefined);
  });

  // The paths below are the ones golem 4.1.1 reported for gorilla/mux, gin,
  // chi, fiber and net/http routes registered in small sample programs.
  it("normalizes nested braces and framework placeholders", () => {
    // gorilla/mux counts brace depth, so a regex with its own braces or
    // slashes stays inside one variable
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/codes/{code:[0-9]{3}}"),
      "/codes/{code}",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/files/{rest:[a-z/]+}"),
      "/files/{rest}",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/hex/{hash:[0-9a-f]{40}}/raw"),
      "/hex/{hash}/raw",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/dates/{month}-{day}"),
      "/dates/{month}-{day}",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/u/{user-id:[0-9]+}"),
      "/u/{user-id}",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/chi/regex/{slug:[a-z-]+}"),
      "/chi/regex/{slug}",
    );
    // unbalanced braces are kept as written
    assert.deepStrictEqual(normalizeGolemRoutePath("/x/{open"), "/x/{open");
    // gin and echo names run to the next slash
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/u/:user-id", "gin"),
      "/u/{user-id}",
    );
    // fiber's optional marker and constraint are not part of the name, and
    // "-" and "." separate two parameters in one segment
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/fiber/:name?", "fiber"),
      "/fiber/{name}",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/fapi/items/:id<int>", "fiber"),
      "/fapi/items/{id}",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/opt/:id<int>?", "fiber"),
      "/opt/{id}",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/flights/:from-:to", "fiber"),
      "/flights/{from}-{to}",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/plantae/:genus.:species", "fiber"),
      "/plantae/{genus}.{species}",
    );
    assert.deepStrictEqual(
      normalizeGolemRoutePath("/fiber/+", "fiber"),
      "/fiber/+",
    );
    // net/http's {$} matches the trailing slash only and names nothing
    assert.deepStrictEqual(normalizeGolemRoutePath("/exact/{$}"), "/exact/");
  });

  it("splits Go 1.22 ServeMux patterns into method, host and path", () => {
    assert.deepStrictEqual(parseGolemRoutePattern("/GET /items/{id}"), {
      method: "GET",
      host: undefined,
      path: "/items/{id}",
    });
    assert.deepStrictEqual(
      parseGolemRoutePattern("/GET example.com/hosted2/{id}"),
      { method: "GET", host: "example.com", path: "/hosted2/{id}" },
    );
    assert.deepStrictEqual(parseGolemRoutePattern("/PUT\t/tabbed/{id}"), {
      method: "PUT",
      host: undefined,
      path: "/tabbed/{id}",
    });
    // a plain route, and a space inside a path rather than after a method
    assert.deepStrictEqual(parseGolemRoutePattern("/static/"), {
      method: undefined,
      host: undefined,
      path: "/static/",
    });
    assert.deepStrictEqual(
      parseGolemRoutePattern("/files/my file").path,
      "/files/my file",
    );
    // values that are not routes
    assert.deepStrictEqual(parseGolemRoutePattern("GET"), undefined);
    assert.deepStrictEqual(parseGolemRoutePattern(":8080"), undefined);
    assert.deepStrictEqual(parseGolemRoutePattern(undefined), undefined);
    // net/http rejects a brace in the host
    assert.deepStrictEqual(parseGolemRoutePattern("/GET {h}/x"), undefined);

    // The net/http service golem 4.1.1 reported for a ServeMux with
    // method, host and wildcard patterns.
    const servicesMap = collectGolemServices({
      services: [
        {
          id: "service|server|example.com/nethttp|net/http",
          name: "net/http",
          kind: "server",
          scheme: null,
          host: null,
          packagePath: "example.com/nethttp",
          endpoints: [
            "/GET /exact/{$}",
            "/GET /files/{path...}",
            "/GET /items/{id}",
            "/GET example.com/hosted2/{id}",
            "/POST /items/",
            "/default",
            "/example.com/hosted",
            "/get /lower",
            "/h",
            "/static/",
          ].map((path, index) => ({
            endpointId: `example.com/nethttp|endpoint|${index + 1}`,
            path,
            properties: { framework: "net/http", handler: "items" },
          })),
        },
        {
          id: "service|server|example.com/fw3|net/http",
          name: "net/http",
          kind: "server",
          scheme: null,
          host: null,
          packagePath: "example.com/fw3",
          endpoints: [
            "/DELETE /orgs/{org}/members/{user}",
            "/GET api.example.com/v2/{rest...}",
            "/PUT\t/tabbed/{id}",
          ].map((path) => ({
            path,
            properties: { framework: "net/http", handler: "h" },
          })),
        },
      ],
    });
    const mux = servicesMap["service|server|example.com/nethttp|net/http"];
    assert.deepStrictEqual(Array.from(mux.endpoints).sort(), [
      "/default",
      "/exact/",
      // a host pattern without a method reaches the report as a plain path
      "/example.com/hosted",
      "/files/%7Bpath%7D",
      "/h",
      "/hosted2/%7Bid%7D",
      "/items/",
      "/items/%7Bid%7D",
      "/lower",
      "/static/",
    ]);
    const prop = (service, name) =>
      service.properties
        .filter((p) => p.name === name)
        .map((p) => p.value)
        .sort();
    assert.deepStrictEqual(prop(mux, "cdx:service:httpMethod"), [
      "get",
      "post",
    ]);
    assert.deepStrictEqual(prop(mux, "cdx:golem:service:host"), [
      "example.com",
    ]);
    const fw3 = servicesMap["service|server|example.com/fw3|net/http"];
    assert.deepStrictEqual(Array.from(fw3.endpoints).sort(), [
      "/orgs/%7Borg%7D/members/%7Buser%7D",
      "/tabbed/%7Bid%7D",
      "/v2/%7Brest%7D",
    ]);
    assert.deepStrictEqual(prop(fw3, "cdx:service:httpMethod"), [
      "delete",
      "get",
      "put",
    ]);
    assert.deepStrictEqual(prop(fw3, "cdx:golem:service:host"), [
      "api.example.com",
    ]);
    assertUriReferences(servicesMap);
  });

  it("keeps only routes and HTTP methods from server services", () => {
    // Services golem 4.1.1 reported for gorilla/mux, gin, fiber and net/http
    // listeners in the sample programs.
    const servicesMap = collectGolemServices({
      services: [
        {
          id: "service|server|example.com/fw|gorilla/mux",
          name: "gorilla/mux",
          kind: "server",
          scheme: null,
          host: null,
          packagePath: "example.com/fw",
          endpoints: [
            {
              path: "/articles/{category}/{id:[0-9]+}",
              properties: { framework: "gorilla/mux", handler: "h" },
            },
            {
              path: "/{key}",
              properties: { framework: "gorilla/mux", handler: "h" },
            },
            // r.HandleFunc(...).Methods("GET", "POST")
            {
              method: "METHODS",
              path: "GET",
              properties: {
                framework: "gorilla/mux",
                handler: "*ast.BasicLit",
              },
            },
            // r.PathPrefix("/products").Subrouter()
            {
              method: "PATHPREFIX",
              path: "/products",
              properties: { framework: "gorilla/mux", handler: "" },
            },
          ],
        },
        {
          id: "service|server|example.com/fw|gin",
          name: "gin",
          kind: "server",
          scheme: null,
          host: null,
          packagePath: "example.com/fw",
          endpoints: [
            // g.Handle("PATCH", "/patch/:id", ...), method read as the path
            {
              path: "/PATCH",
              properties: { framework: "gin", handler: "func literal" },
            },
            {
              method: "ANY",
              path: "/any",
              properties: { framework: "gin", handler: "func literal" },
            },
            {
              method: "GET",
              path: "/files/*filepath",
              properties: { framework: "gin", handler: "func literal" },
            },
          ],
        },
        {
          id: "service|server|example.com/fw|:9092",
          name: ":9092",
          kind: "server",
          scheme: "http",
          host: ":9092",
          packagePath: "example.com/fw",
          endpoints: [
            {
              path: ":9092",
              properties: { framework: "net/http", handler: "r" },
            },
          ],
        },
        {
          id: "service|server|example.com/fw3|/127.0.0.1:9095",
          name: "/127.0.0.1:9095",
          kind: "server",
          scheme: "http",
          host: "/127.0.0.1:9095",
          packagePath: "example.com/fw3",
          endpoints: [
            {
              path: "/127.0.0.1:9095",
              properties: { framework: "net/http", handler: "mx" },
            },
          ],
        },
      ],
    });
    const prop = (service, name) =>
      service.properties
        .filter((p) => p.name === name)
        .map((p) => p.value)
        .sort();
    const gorilla = servicesMap["service|server|example.com/fw|gorilla/mux"];
    assert.deepStrictEqual(Array.from(gorilla.endpoints).sort(), [
      "/%7Bkey%7D",
      "/articles/%7Bcategory%7D/%7Bid%7D",
      "/products",
    ]);
    assert.deepStrictEqual(prop(gorilla, "cdx:service:httpMethod"), []);
    assert.deepStrictEqual(prop(gorilla, "cdx:golem:service:framework"), [
      "gorilla/mux",
    ]);
    const gin = servicesMap["service|server|example.com/fw|gin"];
    assert.deepStrictEqual(Array.from(gin.endpoints).sort(), [
      "/any",
      "/files/%7Bfilepath%7D",
    ]);
    assert.deepStrictEqual(prop(gin, "cdx:service:httpMethod"), ["any", "get"]);
    // A listener entry repeats the bound address; it stays a host property.
    const listener = servicesMap["service|server|example.com/fw|:9092"];
    assert.deepStrictEqual(Array.from(listener.endpoints), []);
    assert.deepStrictEqual(prop(listener, "cdx:golem:service:framework"), [
      "net/http",
    ]);
    const bound = servicesMap["service|server|example.com/fw3|/127.0.0.1:9095"];
    assert.deepStrictEqual(Array.from(bound.endpoints), []);
    assert.deepStrictEqual(prop(bound, "cdx:golem:service:host"), [
      "127.0.0.1:9095",
    ]);
    assertUriReferences(servicesMap);
  });

  it("normalizes framework placeholders in collected endpoints", () => {
    // Services golem 4.1.1 reported for gin, fiber and gorilla/mux routes.
    const servicesMap = collectGolemServices({
      services: [
        {
          id: "service|server|example.com/fw2|gin",
          name: "gin",
          kind: "server",
          endpoints: [
            {
              method: "GET",
              path: "/u/:user-id",
              properties: { framework: "gin", handler: "func literal" },
            },
            {
              method: "GET",
              path: "/time/09:30",
              properties: { framework: "gin", handler: "func literal" },
            },
          ],
        },
        {
          id: "service|server|example.com/fw2|gorilla/mux",
          name: "gorilla/mux",
          kind: "server",
          endpoints: [
            {
              path: "/codes/{code:[0-9]{3}}",
              properties: { framework: "gorilla/mux", handler: "h" },
            },
            {
              path: "/files/{rest:[a-z/]+}",
              properties: { framework: "gorilla/mux", handler: "h" },
            },
          ],
        },
        {
          id: "service|server|example.com/fw|fiber",
          name: "fiber",
          kind: "server",
          endpoints: [
            {
              method: "GET",
              path: "/fiber/+",
              properties: { framework: "fiber", handler: "func literal" },
            },
            {
              method: "GET",
              path: "/fiber/:name?",
              properties: { framework: "fiber", handler: "func literal" },
            },
            {
              method: "POST",
              path: "/fapi/items/:id<int>",
              properties: { framework: "fiber", handler: "func literal" },
            },
            {
              method: "GET",
              path: "/flights/:from-:to",
              properties: { framework: "fiber", handler: "func literal" },
            },
          ],
        },
      ],
    });
    assert.deepStrictEqual(
      Array.from(servicesMap["service|server|example.com/fw2|gin"].endpoints),
      ["/u/%7Buser-id%7D", "/time/09:30"],
    );
    assert.deepStrictEqual(
      Array.from(
        servicesMap["service|server|example.com/fw2|gorilla/mux"].endpoints,
      ),
      ["/codes/%7Bcode%7D", "/files/%7Brest%7D"],
    );
    assert.deepStrictEqual(
      Array.from(servicesMap["service|server|example.com/fw|fiber"].endpoints),
      [
        "/fiber/+",
        "/fiber/%7Bname%7D",
        "/fapi/items/%7Bid%7D",
        "/flights/%7Bfrom%7D-%7Bto%7D",
      ],
    );
    assertUriReferences(servicesMap);
  });

  it("collects no services from a null or malformed report", () => {
    assert.deepStrictEqual(collectGolemServices(null), {});
    assert.deepStrictEqual(collectGolemServices(undefined), {});
    assert.deepStrictEqual(collectGolemServices({ services: {} }), {});
    const servicesMap = collectGolemServices({
      services: [
        null,
        "gin",
        { id: 7 },
        {
          id: "s1",
          name: "gin",
          kind: "server",
          endpoints: [
            null,
            { method: 1, path: "/x", properties: { framework: ["gin"] } },
          ],
        },
        { id: "s2", name: "chi", kind: "server", endpoints: "/y" },
      ],
    });
    assert.deepStrictEqual(Object.keys(servicesMap).sort(), ["s1", "s2"]);
    assert.deepStrictEqual(Array.from(servicesMap.s1.endpoints), ["/x"]);
    assert.deepStrictEqual(
      servicesMap.s1.properties.map((p) => p.name),
      ["cdx:golem:service:kind"],
    );
    assert.deepStrictEqual(Array.from(servicesMap.s2.endpoints), []);
  });

  it("reads a golem report that is not a JSON object as no report", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "golem-null-report-"));
    try {
      for (const content of ["null", "[]", "5", '"report"']) {
        const reportFile = join(tempDir, "golem.json");
        writeFileSync(reportFile, content);
        assert.deepStrictEqual(readGolemJsonFile(reportFile), undefined);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // #4498 — golem also rolls outbound hosts into services of kind
  // "external". Those are egress dependencies, so they carry the CycloneDX
  // trust-boundary flag and name full URLs rather than route paths.
  it("collects external services as trust-boundary crossings", () => {
    const report = {
      services: [
        {
          id: "service|external|https|api.example.com",
          name: "api.example.com",
          kind: "external",
          host: "api.example.com",
          scheme: "https",
          packagePath: "example.com/app",
          properties: { evidence: "external-url" },
          endpoints: [
            { url: "https://api.example.com/v1/users", path: "/v1/users" },
          ],
        },
      ],
    };
    const servicesMap = collectGolemServices(report);
    const external = servicesMap["service|external|https|api.example.com"];
    assert.ok(external, "the external service must be collected");
    assert.deepStrictEqual(Array.from(external.endpoints), [
      "https://api.example.com/v1/users",
    ]);
    assert.deepStrictEqual(external["x-trust-boundary"], true);
    const prop = (name) =>
      external.properties.filter((p) => p.name === name).map((p) => p.value);
    assert.deepStrictEqual(prop("cdx:golem:service:kind"), ["external"]);
    // A server service does not get the flag.
    const server = collectGolemServices({
      services: [
        {
          id: "s1",
          name: "gin",
          kind: "server",
          endpoints: [{ method: "GET", path: "/x" }],
        },
      ],
    });
    assert.deepStrictEqual(server.s1["x-trust-boundary"], undefined);
  });

  it("drops credentials and secret-bearing paths from external endpoints", () => {
    // External services golem 4.1.1 reported for hard-coded URLs. golem
    // already drops userinfo and the query, but keeps `;` path parameters
    // and secrets that sit in the path itself.
    const external = (host, scheme, urls) => ({
      id: `service|external|${scheme}|${host}`,
      name: host,
      kind: "external",
      scheme,
      host,
      packagePath: "example.com/urls",
      endpoints: urls.map((url) => ({
        path: new URL(url).pathname,
        url,
      })),
    });
    const services = [
      external("admin.example.com", "https", [
        "https://admin.example.com/panel;jsessionid=ABC123",
      ]),
      external("stream.example.com", "wss", [
        "wss://stream.example.com/feed;token=abcdef",
      ]),
      external("api.example.com", "https", [
        "https://api.example.com/v1/download;sig=0123456789abcdef/file",
        "https://api.example.com/v1/%7Bid%7D/details",
        "https://api.example.com/v1/a%7Cb%5Ec",
        "https://api.example.com/v1/x?",
      ]),
      external("hooks.slack.com", "https", [
        "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX",
      ]),
      external("discord.com", "https", [
        "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      ]),
      external("api.telegram.org", "https", [
        "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage",
      ]),
      external("hooks.zapier.com", "https", [
        "https://hooks.zapier.com/hooks/catch/1234567/abcdefg/",
      ]),
      external("raw.example.com", "https", [
        "https://raw.example.com/ghp_abcdefghijklmnopqrstuvwxyz0123456789/file.txt",
      ]),
      external("[::1]:9000", "http", ["http://[::1]:9000/metrics"]),
      // Not what golem emits, but nothing upstream may be relied on.
      {
        id: "synthetic",
        name: "h.example",
        kind: "external",
        endpoints: [{ url: "https://u:p@h.example/x?token=abc#f" }],
      },
      {
        id: "synthetic-path",
        name: "h.example",
        kind: "external",
        scheme: "https",
        host: "h.example",
        endpoints: [{ path: "/y;token=abc" }],
      },
    ];
    const servicesMap = collectGolemServices({ services });
    const endpoints = (id) => Array.from(servicesMap[id].endpoints);
    assert.deepStrictEqual(
      endpoints("service|external|https|admin.example.com"),
      ["https://admin.example.com/panel"],
    );
    assert.deepStrictEqual(
      endpoints("service|external|wss|stream.example.com"),
      ["wss://stream.example.com/feed"],
    );
    assert.deepStrictEqual(
      endpoints("service|external|https|api.example.com"),
      [
        "https://api.example.com/v1/download/file",
        "https://api.example.com/v1/%7Bid%7D/details",
        "https://api.example.com/v1/a%7Cb%5Ec",
        "https://api.example.com/v1/x",
      ],
    );
    assert.deepStrictEqual(
      endpoints("service|external|https|hooks.slack.com"),
      ["https://hooks.slack.com/services"],
    );
    assert.deepStrictEqual(endpoints("service|external|https|discord.com"), [
      "https://discord.com/api/webhooks",
    ]);
    assert.deepStrictEqual(
      endpoints("service|external|https|api.telegram.org"),
      ["https://api.telegram.org/bot"],
    );
    assert.deepStrictEqual(
      endpoints("service|external|https|hooks.zapier.com"),
      ["https://hooks.zapier.com/hooks/catch"],
    );
    assert.deepStrictEqual(
      endpoints("service|external|https|raw.example.com"),
      ["https://raw.example.com/"],
    );
    assert.deepStrictEqual(endpoints("service|external|http|[::1]:9000"), [
      "http://[::1]:9000/metrics",
    ]);
    assert.deepStrictEqual(endpoints("synthetic"), ["https://h.example/x"]);
    assert.deepStrictEqual(endpoints("synthetic-path"), [
      "https://h.example/y",
    ]);
    const serialized = JSON.stringify(
      Object.values(servicesMap).map((definition) => ({
        ...definition,
        endpoints: Array.from(definition.endpoints),
      })),
    );
    for (const secret of [
      "ABC123",
      "abcdef",
      "0123456789abcdef",
      "XXXXXXXXXXXXXXXXXXXXXXXX",
      "abcdefghijklmnopqrstuvwxyzABCDEF",
      "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
      "abcdefg",
      "ghp_",
      "u:p@",
      "token",
    ]) {
      assert.ok(!serialized.includes(secret), `${secret} reached the BOM`);
    }
    assertUriReferences(servicesMap);
    // What is not a URL with a host is not an endpoint.
    assert.deepStrictEqual(sanitizeGolemEndpointUrl("not a url"), undefined);
    assert.deepStrictEqual(sanitizeGolemEndpointUrl("mailto:a@b"), undefined);
    assert.deepStrictEqual(sanitizeGolemEndpointUrl(undefined), undefined);
  });
});

// A call-graph edge is attributed to the module with the longest path that
// is the symbol or ends before a "." in it, looked up per edge without
// walking every module of the report.
it("finds the module of a call-graph symbol by its longest module path", () => {
  const dependencies = Array.from({ length: 20000 }, (_, i) => ({
    path: `example.com/dep${i}`,
    version: "v1.0.0",
    purl: `pkg:golang/example.com/dep${i}@v1.0.0`,
  }));
  const modules = [
    { path: "example.com/app", main: true, purl: "pkg:golang/example.com/app" },
    ...dependencies,
    {
      path: "example.com/dep0/sub",
      version: "v2.0.0",
      purl: "pkg:golang/example.com/dep0/sub@v2.0.0",
    },
    {
      path: "gopkg.in/yaml.v3",
      version: "v3.0.1",
      purl: "pkg:golang/gopkg.in/yaml.v3@v3.0.1",
    },
  ];
  const edge = (targetId, line) => ({
    sourceId: "example.com/app.main",
    targetId,
    position: { filename: "main.go", line },
  });
  const edges = dependencies.map((_, i) =>
    edge(`example.com/dep${i}.F`, i + 1),
  );
  edges.push(
    edge("example.com/dep0/sub.G", 5001),
    edge("example.com/dep0/sub", 5002),
    edge("gopkg.in/yaml.v3.Marshal", 5003),
    // a path that only shares a prefix with a module names no module
    edge("example.com/dep1x.H", 5004),
  );
  const started = process.cpuUsage();
  const evidence = collectGolemEvidence(
    { modules, callGraph: { mode: "static", edges } },
    modules.map((module) => ({ purl: module.purl })),
  );
  const elapsed = process.cpuUsage(started);
  const locations = (purl) =>
    Array.from(evidence.purlLocationMap[purl] || []).sort();
  assert.deepStrictEqual(locations("pkg:golang/example.com/dep0/sub@v2.0.0"), [
    "main.go#5001",
    "main.go#5002",
  ]);
  assert.deepStrictEqual(locations("pkg:golang/example.com/dep0@v1.0.0"), [
    "main.go#1",
  ]);
  assert.deepStrictEqual(locations("pkg:golang/example.com/dep1@v1.0.0"), [
    "main.go#2",
  ]);
  assert.deepStrictEqual(locations("pkg:golang/gopkg.in/yaml.v3@v3.0.1"), [
    "main.go#5003",
  ]);
  assert.strictEqual(
    locations("pkg:golang/example.com/dep19999@v1.0.0").length,
    1,
  );
  assert.ok(
    elapsed.user + elapsed.system < 3_000_000,
    `took ${elapsed.user + elapsed.system} microseconds`,
  );
});

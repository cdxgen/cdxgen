import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  collectRusiEvidence,
  isRusiRustLanguage,
  readRusiJsonFile,
  runRusiAnalysis,
} from "./rusi.js";

describe("rusi helpers", () => {
  it("recognizes Rust language aliases", () => {
    assert.strictEqual(isRusiRustLanguage("rust"), true);
    assert.strictEqual(isRusiRustLanguage("rs"), true);
    assert.strictEqual(isRusiRustLanguage("rust-lang"), true);
    assert.strictEqual(isRusiRustLanguage("RUST"), true);
    assert.strictEqual(isRusiRustLanguage("java"), false);
    assert.strictEqual(isRusiRustLanguage("go"), false);
  });

  it("collects metadata, import, usage, callgraph, dataflow, security, and crypto evidence", () => {
    const report = {
      schema_version: "1.0",
      tool: { version: "0.1.0" },
      runtime: {
        rustc_version: "1.75.0",
        cargo_version: "1.75.0",
        host: "x86_64-unknown-linux-gnu",
      },
      options: {
        backend: "stable",
        analysis_scope: "default",
        call_graph_mode: "static",
        data_flow_mode: "security",
      },
      modules: [{ name: "mini-redis", version: "0.1.0" }],
      imports: [
        {
          path: "tokio::net::TcpListener",
          purl: "pkg:cargo/tokio@1.35.0",
          position: { filename: "src/server.rs", line: 10, column: 5 },
        },
      ],
      usages: [
        {
          kind: "call",
          name: "bind",
          purl: "pkg:cargo/tokio@1.35.0",
          package_path: "mini-redis",
          position: { filename: "src/server.rs", line: 15, column: 10 },
        },
      ],
      security_signals: [
        {
          category: "unsafe-code",
          severity: "medium",
          purl: "pkg:cargo/tokio@1.35.0",
          position: { filename: "src/server.rs", line: 20, column: 1 },
        },
      ],
      call_graph: {
        mode: "static",
        nodes: [
          {
            id: "n1",
            name: "main",
            package_path: "mini-redis",
            purl: "pkg:cargo/mini-redis",
            position: { filename: "src/main.rs", line: 5, column: 1 },
            kind: "function",
          },
          {
            id: "n2",
            name: "run",
            package_path: "mini-redis",
            purl: "pkg:cargo/mini-redis",
            position: { filename: "src/server.rs", line: 10, column: 1 },
            kind: "function",
          },
        ],
        edges: [
          {
            source_id: "n1",
            target_id: "n2",
            source_name: "main",
            target_name: "run",
            sourcePurl: "pkg:cargo/mini-redis",
            targetPurl: "pkg:cargo/mini-redis",
            purls: ["pkg:cargo/mini-redis"],
            call_type: "static",
            position: { filename: "src/main.rs", line: 6, column: 5 },
          },
        ],
      },
      data_flow: {
        mode: "security",
        nodes: [
          {
            id: "s1",
            kind: "source",
            name: "env",
            purl: "pkg:cargo/mini-redis",
            position: { filename: "src/main.rs", line: 10, column: 5 },
            category: "environment",
          },
          {
            id: "k1",
            kind: "sink",
            name: "execute",
            purl: "pkg:cargo/mini-redis",
            position: { filename: "src/db.rs", line: 20, column: 5 },
            category: "sql",
          },
        ],
        slices: [
          {
            source_id: "s1",
            sink_id: "k1",
            node_ids: ["s1", "k1"],
            sourcePurl: "pkg:cargo/mini-redis",
            targetPurl: "pkg:cargo/mini-redis",
            purls: ["pkg:cargo/mini-redis"],
            source_category: "environment",
            sink_category: "sql",
            rule_name: "SQL_INJECTION",
          },
        ],
      },
      crypto: {
        components: [
          {
            algorithm: "SHA-256",
            kind: "hash",
            provider: "sha2",
            operation: "digest",
            symbol: "sha2::Sha256",
            purl: "pkg:cargo/sha2@0.10.8",
            position: { filename: "src/crypto.rs", line: 5, column: 1 },
          },
        ],
        materials: [
          {
            kind: "key",
            name: "secret_key",
            function: "init_crypto",
            confidence: "high",
            position: { filename: "src/crypto.rs", line: 10, column: 1 },
          },
        ],
        findings: [
          {
            category: "weak-crypto",
            severity: "high",
            purl: "pkg:cargo/md5@0.7.0",
            position: { filename: "src/legacy.rs", line: 2, column: 1 },
          },
        ],
      },
      stats: {
        package_count: 1,
        file_count: 3,
        import_count: 1,
        declaration_count: 2,
        usage_count: 1,
        security_signal_count: 1,
        crypto_library_count: 1,
        crypto_component_count: 1,
        crypto_finding_count: 1,
        call_graph_node_count: 2,
        call_graph_edge_count: 1,
        data_flow_node_count: 2,
        data_flow_edge_count: 1,
        data_flow_slice_count: 1,
      },
    };

    const evidence = collectRusiEvidence(report, [
      { purl: "pkg:cargo/mini-redis" },
      { purl: "pkg:cargo/tokio@1.35.0" },
      { purl: "pkg:cargo/sha2@0.10.8" },
      { purl: "pkg:cargo/md5@0.7.0" },
    ]);

    // Metadata
    assert.ok(
      evidence.metadataProperties.some(
        (p) => p.name === "cdx:rusi:backend" && p.value === "stable",
      ),
    );
    assert.ok(
      evidence.metadataProperties.some(
        (p) => p.name === "cdx:rusi:dataFlowSliceCount" && p.value === "1",
      ),
    );

    // Imports & Usages
    assert.deepStrictEqual(
      Array.from(evidence.purlLocationMap["pkg:cargo/tokio@1.35.0"]).sort(),
      ["src/server.rs#10", "src/server.rs#15"],
    );
    assert.ok(
      evidence.componentPropertiesMap["pkg:cargo/tokio@1.35.0"].some(
        (p) =>
          p.name === "cdx:rusi:importPath" &&
          p.value === "tokio::net::TcpListener",
      ),
    );

    // Security Signals
    assert.ok(
      evidence.componentPropertiesMap["pkg:cargo/tokio@1.35.0"].some(
        (p) =>
          p.name === "cdx:rusi:securitySignalCategory" &&
          p.value === "unsafe-code",
      ),
    );

    // Call Graph & Data Flow
    assert.ok(evidence.dataFlowFrames["pkg:cargo/mini-redis"].length > 0);
    assert.ok(
      evidence.componentPropertiesMap["pkg:cargo/mini-redis"].some(
        (p) =>
          p.name === "cdx:rusi:dataFlowCategories" &&
          p.value === "environment->sql",
      ),
    );

    // Crypto
    const algoComp = evidence.cryptoComponents.find(
      (c) => c.name === "SHA-256",
    );
    assert.ok(algoComp);
    assert.strictEqual(algoComp.type, "cryptographic-asset");
    assert.ok(
      algoComp.properties.some(
        (p) => p.name === "cdx:rusi:crypto:provider" && p.value === "sha2",
      ),
    );

    const matComp = evidence.cryptoComponents.find(
      (c) => c.name === "secret_key",
    );
    assert.ok(matComp);
    assert.strictEqual(
      matComp.cryptoProperties.assetType,
      "related-crypto-material",
    );

    assert.ok(
      evidence.componentPropertiesMap["pkg:cargo/md5@0.7.0"]?.some(
        (p) =>
          p.name === "cdx:rusi:cryptoFindingCategory" &&
          p.value === "weak-crypto",
      ),
    );
  });

  it("spawns rusi with expected arguments and shell disabled", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    const { runRusiAnalysis } = await esmock("./rusi.js", {
      "./plugins.js": { resolvePluginBinary: sinon.stub().returns("rusi") },
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
      runRusiAnalysis("/tmp/project", "/tmp/out.json", {
        rusiBackend: "compiler",
        rusiToolchain: "nightly",
        rusiCallgraph: "static",
        rusiDataflow: "security",
      }),
      true,
    );

    sinon.assert.calledOnce(safeSpawnSync);
    const args = safeSpawnSync.firstCall.args[1];
    assert.strictEqual(args[0], "analyze");
    assert.ok(args.includes("--backend"));
    assert.ok(args.includes("compiler"));
    assert.ok(args.includes("--toolchain"));
    assert.ok(args.includes("nightly"));
    assert.strictEqual(safeSpawnSync.firstCall.args[2].shell, false);
  });

  it("runs optional rusi data-flow E2E smoke test when the binary is available", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-rusi-e2e-"));
    const outputFile = join(projectDir, "rusi.json");
    try {
      writeFileSync(
        join(projectDir, "Cargo.toml"),
        `[package]
name = "rusi-test"
version = "0.1.0"
edition = "2021"

[dependencies]
`,
      );
      mkdirSync(join(projectDir, "src"));
      writeFileSync(
        join(projectDir, "src", "main.rs"),
        `fn main() {
    println!("Hello, world!");
}
`,
      );
      if (
        !runRusiAnalysis(projectDir, outputFile, {
          rusiDataflow: "security",
        }) ||
        !existsSync(outputFile)
      ) {
        return;
      }
      const report = readRusiJsonFile(outputFile);
      assert.ok(report?.stats);
      const evidence = collectRusiEvidence(report, [
        { purl: "pkg:cargo/rusi-test" },
      ]);
      assert.ok(
        evidence.metadataProperties.some(
          (property) => property.name === "cdx:rusi:dataFlowMode",
        ),
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

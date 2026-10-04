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
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  analyzeRusiProject,
  collectRusiEvidence,
  isRusiRustLanguage,
  readRusiJsonFile,
  runRusiAnalysis,
} from "./rusi.js";

// rusi reports always declare this schema_version prefix; a report-0.1 JSON
// carries the full call_graph + data_flow that downstream tools consume.
const RUSI_SCHEMA_PREFIX = "https://appthreat.github.io/rusi/schema/report-";

describe("rusi helpers", () => {
  it("recognizes Rust language aliases", () => {
    assert.strictEqual(isRusiRustLanguage("rust"), true);
    assert.strictEqual(isRusiRustLanguage("rs"), true);
    assert.strictEqual(isRusiRustLanguage("rust-lang"), true);
    assert.strictEqual(isRusiRustLanguage("RUST"), true);
    assert.strictEqual(isRusiRustLanguage("java"), false);
    assert.strictEqual(isRusiRustLanguage("go"), false);
  });

  it("labels the backend rusi actually used, not the one requested", () => {
    const backendProps = (report) =>
      collectRusiEvidence(report, [])
        .metadataProperties.filter(
          (p) => p.name.endsWith("Backend") || p.name === "cdx:rusi:backend",
        )
        .map((p) => `${p.name}=${p.value}`);
    const capability = {
      kind: "backend-capability",
      message: "compiler backend capability detection",
    };
    const collected = {
      kind: "compiler-source-evidence",
      message: "collected compiler source evidence",
    };
    // Fallbacks seen in real reports: the older stub diagnostic, a wrapper
    // build failure, and missing rustc-dev components.
    for (const kind of ["backend", "backend-error", "backend-unsupported"]) {
      assert.deepStrictEqual(
        backendProps({
          options: { backend: "compiler" },
          diagnostics: [capability, { kind, message: "fell back" }],
        }),
        ["cdx:rusi:backend=stable", "cdx:rusi:requestedBackend=compiler"],
      );
    }
    // A native interop backend-error does not undo collected compiler evidence.
    assert.deepStrictEqual(
      backendProps({
        options: { backend: "compiler" },
        diagnostics: [
          capability,
          collected,
          { kind: "backend-error", message: "native interop failed" },
        ],
      }),
      ["cdx:rusi:backend=compiler"],
    );
    assert.deepStrictEqual(backendProps({ options: { backend: "stable" } }), [
      "cdx:rusi:backend=stable",
    ]);
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
          {
            // BLAKE3 has no OID in data/crypto-oid.json; emitting it as an
            // algorithm asset would fail schema validation.
            algorithm: "BLAKE3",
            kind: "hash",
            provider: "blake3",
            operation: "digest",
            purl: "pkg:cargo/blake3@1.5.0",
            position: { filename: "src/crypto.rs", line: 9, column: 1 },
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
    // Algorithm assets carry the OID the schema requires.
    assert.strictEqual(algoComp.cryptoProperties.oid, "2.16.840.1.101.3.4.2.1");
    assert.ok(
      algoComp.properties.some(
        (p) => p.name === "cdx:rusi:crypto:provider" && p.value === "sha2",
      ),
    );
    // An algorithm the OID table cannot name is skipped entirely.
    assert.ok(!evidence.cryptoComponents.some((c) => c.name === "BLAKE3"));

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
      "../inventory/plugins.js": {
        resolvePluginBinary: sinon.stub().returns("rusi"),
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

  it("resolves a doubled directory against the working directory for rusi", async () => {
    // depscan launches cdxgen with cwd set to the project while forwarding a
    // repo-root-relative source path; a plain resolve joins the two into a
    // directory that does not exist. runRusiAnalysis must pass the working
    // directory (a cargo project) to the plugin instead.
    const projectDir = realpathSync(
      mkdtempSync(join(tmpdir(), "cdxgen-rusi-cwd-")),
    );
    writeFileSync(join(projectDir, "Cargo.toml"), "[package]\n");
    const previousCwd = process.cwd();
    process.chdir(projectDir);
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    try {
      const { runRusiAnalysis } = await esmock("./rusi.js", {
        "../inventory/plugins.js": {
          resolvePluginBinary: sinon.stub().returns("rusi"),
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
        runRusiAnalysis("test/data/rusi/repos/reachable-app", "/tmp/out.json", {
          rusiDataflow: "security",
        }),
        true,
      );
      const args = safeSpawnSync.firstCall.args[1];
      assert.strictEqual(args[args.indexOf("--dir") + 1], projectDir);
      assert.strictEqual(safeSpawnSync.firstCall.args[2].cwd, projectDir);
    } finally {
      process.chdir(previousCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("reports a failed analysis as an analysis failure, not an installation problem", async () => {
    const safeSpawnSync = sinon
      .stub()
      .returns({ status: 2, stderr: "nope", error: undefined });
    const { runRusiAnalysis } = await esmock("./rusi.js", {
      "../inventory/plugins.js": {
        resolvePluginBinary: sinon.stub().returns("rusi"),
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
    const errorSpy = sinon.spy(console, "error");
    try {
      assert.strictEqual(
        runRusiAnalysis("/tmp/project", "/tmp/out.json", {}),
        false,
      );
    } finally {
      errorSpy.restore();
    }
    const messages = errorSpy.getCalls().map((c) => c.args.join(" "));
    assert.ok(
      messages.some((m) => m.includes("rusi analysis")),
      `expected an analysis failure message, got ${JSON.stringify(messages)}`,
    );
    assert.ok(
      messages.some(
        (m) => m.includes("/tmp/project") && m.includes("exit status 2"),
      ),
      `expected the directory and exit status in the message, got ${JSON.stringify(messages)}`,
    );
    assert.ok(
      !messages.some((m) => m.includes("installed successfully")),
      "an analysis failure must not be reported as an installation problem",
    );
  });

  it("reports a spawn error as an installation problem and honors fail-on-error", async () => {
    const safeSpawnSync = sinon
      .stub()
      .returns({ status: null, error: new Error("spawn ENOENT") });
    const { runRusiAnalysis } = await esmock("./rusi.js", {
      "../inventory/plugins.js": {
        resolvePluginBinary: sinon.stub().returns("rusi"),
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
        runRusiAnalysis("/tmp/project", "/tmp/out.json", {
          failOnError: true,
        }),
        false,
      );
    } finally {
      errorSpy.restore();
      exitStub.restore();
    }
    const messages = errorSpy.getCalls().map((c) => c.args.join(" "));
    assert.ok(
      messages.some((m) => m.includes("could not be executed")),
      `expected a spawn failure message, got ${JSON.stringify(messages)}`,
    );
    assert.ok(
      messages.some((m) => m.includes("installed successfully")),
      "a spawn error is the one failure class that IS an installation problem",
    );
    sinon.assert.calledOnceWithExactly(exitStub, 1);
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

  it("persists the raw rusi report to semanticsSlicesFile when provided", async () => {
    // Under --profile research, evinse passes --semantics-slices-file to rusi;
    // analyzeRusiProject must persist the FULL raw report there (call graph +
    // data-flow slices) instead of writing it to a throwaway temp dir.
    const durableDir = mkdtempSync(join(tmpdir(), "cdxgen-rusi-durable-"));
    const durablePath = join(durableDir, "rust-semantics.slices.json");
    const mkdtempSpy = sinon.spy((...args) => mkdtempSync(...args));
    const rmSpy = sinon.spy((...args) => rmSync(...args));
    const syntheticReport = {
      schema_version: `${RUSI_SCHEMA_PREFIX}0.1`,
      tool: { name: "rusi", version: "2.5.2" },
      call_graph: {
        mode: "static",
        nodes: [{ id: "n1", name: "main" }],
        edges: [],
      },
      data_flow: { mode: "security", nodes: [], edges: [], slices: [] },
      stats: { file_count: 1 },
    };
    // Stub the rusi spawn to write the synthetic report to --out and succeed.
    const safeSpawnSync = sinon.stub().callsFake((_executable, args) => {
      writeFileSync(
        args[args.indexOf("--out") + 1],
        JSON.stringify(syntheticReport),
      );
      return { status: 0, stdout: "", stderr: "" };
    });
    const { analyzeRusiProject: mockedAnalyze } = await esmock("./rusi.js", {
      "../inventory/plugins.js": {
        resolvePluginBinary: sinon.stub().returns("rusi"),
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
    assert.strictEqual(report?.schema_version, syntheticReport.schema_version);
    assert.ok(report?.call_graph, "returned report must carry call_graph");
    assert.ok(report?.data_flow, "returned report must carry data_flow");
    // the durable file persists on disk with the full report
    assert.ok(existsSync(durablePath), "durable report file must persist");
    const persisted = JSON.parse(readFileSync(durablePath, "utf-8"));
    assert.ok(persisted.call_graph, "persisted report must carry call_graph");
    assert.ok(persisted.data_flow, "persisted report must carry data_flow");
    assert.ok(
      persisted.schema_version.startsWith(RUSI_SCHEMA_PREFIX),
      "persisted report must declare a report-* schema_version",
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
      schema_version: `${RUSI_SCHEMA_PREFIX}0.1`,
      tool: { name: "rusi", version: "2.5.2" },
      call_graph: { mode: "static", nodes: [], edges: [] },
      data_flow: { mode: "security", nodes: [], edges: [], slices: [] },
    };
    const safeSpawnSync = sinon.stub().callsFake((_executable, args) => {
      writeFileSync(
        args[args.indexOf("--out") + 1],
        JSON.stringify(syntheticReport),
      );
      return { status: 0, stdout: "", stderr: "" };
    });
    const { analyzeRusiProject: mockedAnalyze } = await esmock("./rusi.js", {
      "../inventory/plugins.js": {
        resolvePluginBinary: sinon.stub().returns("rusi"),
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
    assert.strictEqual(report?.schema_version, syntheticReport.schema_version);
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

  it("persists a report-0.1 JSON with call_graph and data_flow end-to-end (requires rusi)", () => {
    // E2E persistence smoke test through the real rusi binary. Skips silently
    // when the binary is unavailable (CI without the plugin).
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-rusi-persist-e2e-"));
    const durablePath = join(projectDir, "rust-semantics.slices.json");
    try {
      writeFileSync(
        join(projectDir, "Cargo.toml"),
        `[package]
name = "rusi-persist-test"
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
      const report = analyzeRusiProject(projectDir, {
        semanticsSlicesFile: durablePath,
        profile: "research",
      });
      if (!report) {
        // rusi binary unavailable -- skip (mirrors the existing E2E smoke test)
        return;
      }
      assert.ok(existsSync(durablePath), "durable report must persist");
      const persisted = JSON.parse(readFileSync(durablePath, "utf-8"));
      assert.ok(
        persisted.schema_version?.startsWith(RUSI_SCHEMA_PREFIX),
        "persisted report must declare a report-* schema_version",
      );
      assert.ok(persisted.call_graph, "persisted report must carry call_graph");
      assert.ok(persisted.data_flow, "persisted report must carry data_flow");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

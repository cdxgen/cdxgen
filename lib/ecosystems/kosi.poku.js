import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  collectKosiApiEndpoints,
  collectKosiEvidence,
  collectKosiServices,
  isKosiKotlinLanguage,
  kosiDisabled,
  kosiWorkspaceComponent,
  mergeKosiEvidence,
} from "./kosi.js";

// The BOM side of the join: cdxgen resolves Kotlin dependencies to maven
// purls, while kosi — which reads an OFFLINE classpath and never runs the
// build — names the same jars pkg:generic/<file>@<version>. Every join in
// this module has to bridge those two namings by name.
const components = [
  {
    name: "kotlin-sample-app",
    purl: "pkg:maven/com.example/kotlin-sample-app@1.0.0?type=jar",
  },
  {
    name: "timber",
    purl: "pkg:maven/com.jakewharton.timber/timber@5.0.1?type=jar",
  },
];

const workspacePurl = "pkg:generic/kotlin-sample-app@unspecified";
const timberPurl = "pkg:generic/timber-5.0.1@unspecified";

function propertyValues(map, purl, name) {
  return (map[purl] || [])
    .filter((property) => property.name === name)
    .map((property) => property.value);
}

describe("kosi helpers", () => {
  it("recognizes Kotlin language aliases", () => {
    assert.strictEqual(isKosiKotlinLanguage("kotlin"), true);
    assert.strictEqual(isKosiKotlinLanguage("kt"), true);
    assert.strictEqual(isKosiKotlinLanguage("KOTLIN"), true);
    assert.strictEqual(isKosiKotlinLanguage("java"), false);
    assert.strictEqual(isKosiKotlinLanguage(undefined), false);
  });

  it("is disabled by CDXGEN_KOSI_DISABLE, and only by its documented values", () => {
    const previous = process.env.CDXGEN_KOSI_DISABLE;
    try {
      for (const value of ["1", "true", "all", "TRUE"]) {
        process.env.CDXGEN_KOSI_DISABLE = value;
        assert.strictEqual(
          kosiDisabled(),
          true,
          `expected ${value} to disable kosi`,
        );
      }
      for (const value of ["0", "false", ""]) {
        process.env.CDXGEN_KOSI_DISABLE = value;
        assert.strictEqual(
          kosiDisabled(),
          false,
          `expected ${value} to leave kosi enabled`,
        );
      }
    } finally {
      if (previous === undefined) {
        delete process.env.CDXGEN_KOSI_DISABLE;
      } else {
        process.env.CDXGEN_KOSI_DISABLE = previous;
      }
    }
  });

  it("joins a workspace-local crypto flow to the project component", () => {
    // The regression this test exists for: crypto-flow was the one evidence
    // kind that resolved purls by EXACT match while the other four used the
    // name fallback, so a `hardcoded-secret -> crypto-asset` flow — always
    // workspace-local, hence always a pkg:generic purl — attached to
    // nothing, and the end-to-end gate failed on `no crypto-flow evidence`.
    const report = {
      crypto: {
        materials: [{ name: "apiKey", kind: "secret", function: "loadConfig" }],
      },
      dataFlow: {
        slices: [
          {
            sourceCategory: "hardcoded-secret",
            sinkCategory: "crypto-asset",
            purls: [workspacePurl],
          },
        ],
      },
    };
    const evidence = collectKosiEvidence(report, components);
    assert.deepStrictEqual(
      propertyValues(
        evidence.componentPropertiesMap,
        "pkg:maven/com.example/kotlin-sample-app@1.0.0?type=jar",
        "cdx:kosi:cryptoFlow",
      ),
      ["hardcoded-secret->crypto-asset"],
    );
    assert.strictEqual(evidence.cryptoComponents.length, 1);
    assert.strictEqual(
      evidence.cryptoComponents[0].cryptoProperties.assetType,
      "related-crypto-material",
    );
  });

  // P24: kosi's per-slice frames[] — the named hops — become the callstack
  // evidence, preferred over the node-derived walk. Every hop names its
  // FUNCTION (the node walk could only name registers), and the role rides
  // the frame's module field so a consumer can tell a dispatch hop from a
  // move.
  it("builds the callstack from kosi's named frames when the report carries them", () => {
    const report = {
      dataFlow: {
        nodes: [
          {
            id: "dfn-1",
            kind: "source",
            name: "kotlin.io.readLine",
            filePath: "src/main/kotlin/App.kt",
            modulePath: ".",
            position: { line: 3, column: 1 },
          },
          {
            id: "dfn-2",
            kind: "sink",
            name: "java.lang.Runtime.exec",
            filePath: "src/main/kotlin/Repo.kt",
            modulePath: ".",
            position: { line: 9, column: 1 },
          },
        ],
        slices: [
          {
            purls: [workspacePurl],
            nodeIds: ["dfn-1", "dfn-2"],
            sourceId: "dfn-1",
            sinkId: "dfn-2",
            sourceCategory: "untrusted-input",
            sinkCategory: "process-exec",
            pathKind: "complete",
            frames: [
              {
                function: "App.handle",
                file: "src/main/kotlin/App.kt",
                line: 3,
                role: "source",
              },
              {
                function: "Repo.query",
                file: "src/main/kotlin/Repo.kt",
                line: 7,
                role: "dispatch",
                dispatchWidth: 3,
                dispatchNarrowedBy: "single-impl",
              },
              {
                function: "Repo.query",
                file: "src/main/kotlin/Repo.kt",
                line: 9,
                role: "sink",
              },
            ],
          },
        ],
      },
    };
    const evidence = collectKosiEvidence(report, components);
    const callstacks =
      evidence.dataFlowFrames[
        "pkg:maven/com.example/kotlin-sample-app@1.0.0?type=jar"
      ] || [];
    assert.strictEqual(callstacks.length, 1, "one callstack per slice");
    const frames = callstacks[0];
    assert.strictEqual(frames.length, 3);
    assert.deepStrictEqual(
      frames.map((frame) => frame.function),
      ["App.handle", "Repo.query", "Repo.query"],
      "every hop names its function",
    );
    assert.deepStrictEqual(
      frames.map((frame) => frame.module),
      ["source", "dispatch", "sink"],
      "the hop role rides the module field",
    );
    assert.strictEqual(frames[1].line, 7);
    assert.strictEqual(frames[1].fullFilename, "src/main/kotlin/Repo.kt");
  });

  it("falls back to the node-derived callstack when frames[] is absent", () => {
    const report = {
      dataFlow: {
        nodes: [
          {
            id: "dfn-1",
            kind: "source",
            name: "kotlin.io.readLine",
            filePath: "src/main/kotlin/App.kt",
            position: { line: 3, column: 1 },
          },
        ],
        slices: [
          {
            purls: [workspacePurl],
            nodeIds: ["dfn-1"],
            sourceId: "dfn-1",
            sinkId: "dfn-1",
          },
        ],
      },
    };
    const evidence = collectKosiEvidence(report, components);
    const callstacks =
      evidence.dataFlowFrames[
        "pkg:maven/com.example/kotlin-sample-app@1.0.0?type=jar"
      ] || [];
    assert.strictEqual(callstacks.length, 1);
    assert.strictEqual(callstacks[0][0].function, "kotlin.io.readLine");
  });

  it("joins an offline pkg:generic jar purl to its resolved maven component", () => {
    const report = {
      usages: [
        {
          purl: timberPurl,
          position: { filename: "src/main/kotlin/App.kt", line: 12, column: 3 },
        },
      ],
    };
    const evidence = collectKosiEvidence(report, components);
    assert.deepStrictEqual(
      Array.from(
        evidence.purlLocationMap[
          "pkg:maven/com.jakewharton.timber/timber@5.0.1?type=jar"
        ] || [],
      ),
      ["src/main/kotlin/App.kt#12"],
    );
  });

  it("invents no purl for a dependency the BOM does not carry", () => {
    const report = {
      usages: [
        {
          purl: "pkg:generic/not-in-the-bom-1.0@unspecified",
          position: { filename: "src/main/kotlin/App.kt", line: 1 },
        },
      ],
    };
    const evidence = collectKosiEvidence(report, components);
    assert.deepStrictEqual(Object.keys(evidence.purlLocationMap), []);
  });

  it("merges the reachable pass without duplicating what the all pass found", () => {
    const report = {
      usages: [
        {
          purl: timberPurl,
          position: { filename: "src/main/kotlin/App.kt", line: 12 },
        },
      ],
    };
    const all = collectKosiEvidence(report, components);
    const merged = mergeKosiEvidence(
      all,
      collectKosiEvidence(report, components),
    );
    const maven = "pkg:maven/com.jakewharton.timber/timber@5.0.1?type=jar";
    assert.strictEqual(merged.purlLocationMap[maven].size, 1);
    assert.strictEqual(merged.cryptoComponents.length, 0);
  });

  // R144: this assertion is why the reachable pass is worth running. Its
  // slices are the all pass's intersected with call-graph reachability, so
  // every key it carries is one the all pass already has and the merge's
  // unions cannot add anything — the second full `--backend resolved --deps`
  // analysis contributed nothing at all until the reachability it computes
  // was recorded. Without the stamp below this test cannot tell a run that
  // did the second analysis from one that skipped it, which is exactly the
  // state it was in.
  it("records reachability, the only thing the second pass knows that the first does not", () => {
    const report = {
      usages: [
        {
          purl: timberPurl,
          position: { filename: "src/main/kotlin/App.kt", line: 12 },
        },
      ],
    };
    const maven = "pkg:maven/com.jakewharton.timber/timber@5.0.1?type=jar";

    const withReachable = mergeKosiEvidence(
      collectKosiEvidence(report, components),
      collectKosiEvidence(report, components),
    );
    assert.deepStrictEqual(
      propertyValues(
        withReachable.componentPropertiesMap,
        maven,
        "cdx:kosi:reachableFromRoots",
      ),
      ["true"],
    );

    // A component the all pass found and the reachable pass did not is
    // evidence that exists and is NOT root-reachable: it must not be
    // stamped, or the property means "kosi saw this" and nothing more.
    const withoutReachable = mergeKosiEvidence(
      collectKosiEvidence(report, components),
      undefined,
    );
    assert.deepStrictEqual(
      propertyValues(
        withoutReachable.componentPropertiesMap,
        maven,
        "cdx:kosi:reachableFromRoots",
      ),
      [],
    );
  });

  it("carries services[] rows through, skipping rows without an id or name", () => {
    const servicesMap = collectKosiServices(
      {
        services: [
          {
            id: "svc-1",
            name: "orders",
            endpoints: ["/orders", "/orders/{id}"],
          },
          { id: "svc-2" },
          { name: "no-id" },
        ],
      },
      {},
    );
    assert.deepStrictEqual(Object.keys(servicesMap), ["svc-1"]);
    assert.deepStrictEqual(Array.from(servicesMap["svc-1"].endpoints).sort(), [
      "/orders",
      "/orders/{id}",
    ]);
  });

  it("attaches every call site of a service, and the function it sits in", () => {
    // kosi's services[] carries ONE position for the service; its urls[]
    // carries a row per call site with the enclosing symbol. A service
    // reached from two places has two occurrences only if both are read.
    const servicesMap = collectKosiServices(
      {
        services: [
          {
            id: "svc-1",
            name: "api.example.com",
            endpoints: ["https://api.example.com/v1/"],
            position: {
              filename: "src/main/kotlin/Calls.kt",
              line: 52,
              column: 41,
            },
          },
        ],
        urls: [
          {
            url: "https://api.example.com/v1/",
            raw: "https://api.example.com/v1/",
            filePath: "src/main/kotlin/Calls.kt",
            position: {
              filename: "src/main/kotlin/Calls.kt",
              line: 52,
              column: 41,
            },
            enclosingSymbol: "app.Orders.fetch",
            resolution: "literal",
          },
          {
            url: "https://api.example.com/v1/",
            raw: "https://api.example.com/v1/",
            filePath: "src/main/kotlin/Retry.kt",
            position: {
              filename: "src/main/kotlin/Retry.kt",
              line: 9,
              column: 5,
            },
            enclosingSymbol: "app.Retry.again",
            resolution: "config",
          },
        ],
      },
      {},
    );
    const service = servicesMap["svc-1"];
    assert.deepStrictEqual(
      service.evidence.occurrences.map((o) => o.location.path).sort(),
      ["src/main/kotlin/Calls.kt", "src/main/kotlin/Retry.kt"],
    );
    // The service's own position and the first url row are the SAME call
    // site and must not be counted twice.
    assert.strictEqual(service.evidence.occurrences.length, 2);
    assert.deepStrictEqual(
      service.properties
        .filter((p) => p.name === "cdx:kosi:service:enclosingSymbol")
        .map((p) => p.value)
        .sort(),
      ["app.Orders.fetch", "app.Retry.again"],
    );
    assert.deepStrictEqual(
      service.properties
        .filter((p) => p.name === "cdx:kosi:service:location")
        .map((p) => p.value)
        .sort(),
      ["src/main/kotlin/Calls.kt:52:41", "src/main/kotlin/Retry.kt:9:5"],
    );
  });

  it("reads the trust boundary kosi actually publishes", () => {
    // kosi emits the HYPHENATED CycloneDX key. Reading `xTrustBoundary`
    // asked for a property that is never present, so every kosi service lost
    // the flag.
    const servicesMap = collectKosiServices(
      {
        services: [
          {
            id: "svc-1",
            name: "orders",
            endpoints: ["/orders"],
            "x-trust-boundary": true,
          },
          {
            id: "svc-2",
            name: "internal",
            endpoints: ["/internal"],
            "x-trust-boundary": false,
          },
          {
            id: "svc-3",
            name: "unknown",
            endpoints: ["/u"],
            "x-trust-boundary": null,
          },
        ],
      },
      {},
    );
    assert.strictEqual(servicesMap["svc-1"]["x-trust-boundary"], true);
    // FALSE is a stated fact and must survive; only null/absent stays unset.
    assert.strictEqual(servicesMap["svc-2"]["x-trust-boundary"], false);
    assert.strictEqual(
      typeof servicesMap["svc-3"]["x-trust-boundary"],
      "undefined",
    );
  });

  it("carries kosi's security signals onto the component they name", () => {
    const evidence = collectKosiEvidence(
      {
        securitySignals: [
          {
            code: "native-interop",
            message: "JNI seam",
            symbol: "app.NativeBridge.load",
            purl: components[0].purl,
            filePath: "src/main/kotlin/Native.kt",
            position: { filename: "src/main/kotlin/Native.kt", line: 29 },
          },
          {
            // A cinterop .def file carries NO purl: it is not a module
            // source. It must still be counted, or a real finding vanishes
            // between the report and the BOM.
            code: "native-interop",
            message: "cinterop definition",
            purl: "",
            filePath: "src/nativeInterop/cinterop/hash.def",
          },
        ],
      },
      components,
    );
    assert.deepStrictEqual(
      propertyValues(
        evidence.componentPropertiesMap,
        components[0].purl,
        "cdx:kosi:securitySignalCode",
      ),
      ["native-interop"],
    );
    assert.deepStrictEqual(
      propertyValues(
        evidence.componentPropertiesMap,
        components[0].purl,
        "cdx:kosi:securitySignalSeverity",
      ),
      ["info"],
    );
    assert.ok(
      Array.from(evidence.purlLocationMap[components[0].purl]).includes(
        "src/main/kotlin/Native.kt#29",
      ),
    );
    assert.ok(
      evidence.metadataProperties.some(
        (p) => p.name === "cdx:kosi:securitySignalCount" && p.value === "2",
      ),
    );
  });

  it("returns empty evidence for an empty report rather than throwing", () => {
    const evidence = collectKosiEvidence({}, components);
    assert.deepStrictEqual(evidence.purlLocationMap, {});
    assert.deepStrictEqual(evidence.componentPropertiesMap, {});
    assert.deepStrictEqual(evidence.cryptoComponents, []);
  });

  it("carries kosi's inbound endpoints — and their authentication — into services", () => {
    // kosi computes consumes/produces/authentication per route; before this
    // they stopped at the report. An endpoint with NO declared
    // authentication leaves `authenticated` undefined: kosi's empty list
    // means "nothing declared here", not "this route is open".
    const servicesMap = collectKosiApiEndpoints(
      {
        apiEndpoints: [
          {
            id: "ep-000001",
            framework: "ktor",
            httpMethod: ["GET"],
            pathTemplate: "/orders/{id}",
            consumes: [],
            produces: ["application/json"],
            authentication: ["basic"],
            handlerCanonicalName: "app.Orders.byId",
          },
          {
            id: "ep-000002",
            framework: "ktor",
            httpMethod: ["GET"],
            pathTemplate: "/health",
            consumes: [],
            produces: [],
            authentication: [],
            handlerCanonicalName: "app.Health.check",
          },
          { id: "ep-000003", framework: "ktor" },
        ],
      },
      {},
    );
    assert.deepStrictEqual(Object.keys(servicesMap).sort(), [
      "service-health-get",
      "service-orders{id}-get",
    ]);
    const orders = servicesMap["service-orders{id}-get"];
    assert.deepStrictEqual(Array.from(orders.endpoints), ["/orders/{id}"]);
    assert.strictEqual(orders.authenticated, true);
    assert.strictEqual(orders.xTrustBoundary, true);
    assert.deepStrictEqual(
      orders.properties
        .filter((p) => p.name === "cdx:kosi:endpoint:authentication")
        .map((p) => p.value),
      ["basic"],
    );
    assert.deepStrictEqual(
      orders.properties
        .filter((p) => p.name === "cdx:kosi:endpoint:produces")
        .map((p) => p.value),
      ["application/json"],
    );
    const health = servicesMap["service-health-get"];
    assert.strictEqual(health.authenticated, undefined);
    assert.strictEqual(health.xTrustBoundary, undefined);
  });

  it("merges a kosi endpoint into a service another detector already found", () => {
    // detectServicesFromOpenAPI names its entries the same way, so a spec
    // and a kosi run over one route converge instead of duplicating it.
    const servicesMap = {
      "service-orders-get": {
        endpoints: new Set(["/orders"]),
        authenticated: undefined,
        xTrustBoundary: undefined,
        properties: [{ name: "cdx:service:httpMethod", value: "GET" }],
      },
    };
    collectKosiApiEndpoints(
      {
        apiEndpoints: [
          {
            framework: "spring",
            httpMethod: ["GET"],
            pathTemplate: "/orders",
            authentication: ["role(ADMIN)"],
          },
        ],
      },
      servicesMap,
    );
    assert.deepStrictEqual(Object.keys(servicesMap), ["service-orders-get"]);
    assert.strictEqual(servicesMap["service-orders-get"].authenticated, true);
    assert.strictEqual(
      servicesMap["service-orders-get"].properties.filter(
        (p) => p.name === "cdx:service:httpMethod",
      ).length,
      1,
    );
  });

  // P31: kosi says per endpoint whether it READ the code behind it. An
  // unsubstantiated endpoint (a manifest component whose class is not among
  // the analysed declarations) used to become an ordinary SaaSBOM service
  // indistinguishable from a fully-analysed one — the caveat stopped at the
  // report. It now rides the service as a property; the endpoint itself is
  // still published, because the manifest is real.
  it("stamps the unsubstantiated caveat on an endpoint kosi did not read", () => {
    const servicesMap = collectKosiApiEndpoints(
      {
        apiEndpoints: [
          {
            id: "ep-000026",
            framework: "android",
            foundBy: "manifest",
            httpMethod: [],
            pathTemplate: "SettingsActivity",
            handlerCanonicalName: "",
            substantiated: false,
          },
          {
            id: "ep-000001",
            framework: "ktor",
            httpMethod: ["GET"],
            pathTemplate: "/orders",
            substantiated: true,
          },
        ],
      },
      {},
    );
    const unread = servicesMap["service-SettingsActivity-all"];
    assert.ok(unread, "the unread endpoint is still published as a service");
    assert.deepStrictEqual(
      unread.properties
        .filter((p) => p.name === "cdx:kosi:endpoint:substantiated")
        .map((p) => p.value),
      ["false"],
    );
    // Absence keeps meaning "read": a substantiated endpoint carries no
    // positive property, so the caveat stays a signal rather than noise.
    const read = servicesMap["service-orders-get"];
    assert.deepStrictEqual(
      read.properties.filter((p) =>
        p.name.startsWith("cdx:kosi:endpoint:substantiated"),
      ),
      [],
    );
  });

  it("does not stamp the caveat for reports from binaries predating substantiated", () => {
    // Old kosi binaries omit the field entirely; undefined is not false.
    const servicesMap = collectKosiApiEndpoints(
      {
        apiEndpoints: [
          {
            framework: "android",
            httpMethod: [],
            pathTemplate: "LegacyActivity",
          },
        ],
      },
      {},
    );
    assert.deepStrictEqual(
      servicesMap["service-LegacyActivity-all"].properties.filter((p) =>
        p.name.startsWith("cdx:kosi:endpoint:substantiated"),
      ),
      [],
    );
  });

  // P31: run-level degradations (coverage gaps, budget trips, unread
  // endpoints) used to vanish at the join, so a BOM from a half-read
  // repository looked exactly like one from a fully-read repository. Every
  // kosi diagnostic is now counted on the metadata component, and the
  // source-coverage numbers publish WITH their denominators.
  it("carries kosi's run-level degradations onto the BOM metadata", () => {
    const report = {
      schemaVersion: "kosi/1",
      diagnostics: [
        // Per-file entries aggregate into one population per code.
        { code: "resolution-errors", severity: "warning", count: 10 },
        { code: "resolution-errors", severity: "warning", count: 7 },
        { code: "endpoint-unsubstantiated", severity: "warning", count: 5 },
        // An entry without a count is one event, not zero.
        { code: "no-sources", severity: "warning" },
      ],
      stats: {
        sourceCoverage: {
          discovered: 12,
          present: 1039,
          testPresent: 651,
          ratio: 0.01,
          nonTestRatio: 0.03,
        },
      },
    };
    const evidence = collectKosiEvidence(report, components);
    const values = (name) =>
      evidence.metadataProperties
        .filter((p) => p.name === name)
        .map((p) => p.value);
    assert.deepStrictEqual(values("cdx:kosi:diagnostic:resolution-errors"), [
      "17",
    ]);
    assert.deepStrictEqual(
      values("cdx:kosi:diagnostic:endpoint-unsubstantiated"),
      ["5"],
    );
    assert.deepStrictEqual(values("cdx:kosi:diagnostic:no-sources"), ["1"]);
    assert.deepStrictEqual(values("cdx:kosi:sourceCoverageDiscovered"), ["12"]);
    assert.deepStrictEqual(values("cdx:kosi:sourceCoveragePresent"), ["1039"]);
    assert.deepStrictEqual(values("cdx:kosi:sourceCoverageTestPresent"), [
      "651",
    ]);
    assert.deepStrictEqual(values("cdx:kosi:sourceCoverageRatio"), ["0.01"]);
    assert.deepStrictEqual(values("cdx:kosi:sourceCoverageNonTestRatio"), [
      "0.03",
    ]);
  });

  // `degraded` is the one field kosi sets when it does not trust its own
  // counts. A native binary that found no JDK resolves every `java.*`
  // symbol to nothing and still exits 0 with a full-looking report, so the
  // counts arrive here looking exactly like a complete run's; the tag is
  // what tells them apart, and dropping it would publish the wrong number
  // with no caveat at all.
  it("publishes the degraded tag, and omits it when the run was clean", () => {
    const degraded = collectKosiEvidence(
      { schemaVersion: "kosi/1", stats: { degraded: "no-jdk" } },
      components,
    );
    assert.deepStrictEqual(
      degraded.metadataProperties
        .filter((p) => p.name === "cdx:kosi:degraded")
        .map((p) => p.value),
      ["no-jdk"],
    );
    const clean = collectKosiEvidence(
      { schemaVersion: "kosi/1", stats: { degraded: null } },
      components,
    );
    assert.strictEqual(
      clean.metadataProperties.some((p) => p.name === "cdx:kosi:degraded"),
      false,
      "a clean run must not carry an empty degradation tag",
    );
  });

  // A count alone cannot say whether a piece of the analysis is ABSENT or
  // merely imperfect: `callgraph-failed` means the call graph is not in the
  // report at all, `resolution-errors` means the run completed with partial
  // typing. Published as bare counts the warning looks like the bigger
  // problem, because its number is larger.
  it("names the diagnostics that were errors, not just their counts", () => {
    const evidence = collectKosiEvidence(
      {
        schemaVersion: "kosi/1",
        diagnostics: [
          { code: "resolution-errors", severity: "warning", count: 284 },
          { code: "callgraph-failed", severity: "error" },
          { code: "unreadable-source", severity: "error", count: 2 },
        ],
        stats: {},
      },
      components,
    );
    const value = (name) =>
      evidence.metadataProperties.find((p) => p.name === name)?.value;
    assert.strictEqual(
      value("cdx:kosi:diagnosticErrors"),
      "callgraph-failed,unreadable-source",
    );
    assert.strictEqual(value("cdx:kosi:diagnostic:callgraph-failed"), "1");
    assert.strictEqual(value("cdx:kosi:diagnostic:resolution-errors"), "284");
  });

  it("claims no errors when every diagnostic is a warning", () => {
    const evidence = collectKosiEvidence(
      {
        schemaVersion: "kosi/1",
        diagnostics: [
          { code: "classpath-partial", severity: "warning", count: 72 },
        ],
        stats: {},
      },
      components,
    );
    assert.deepStrictEqual(
      evidence.metadataProperties.filter(
        (p) => p.name === "cdx:kosi:diagnosticErrors",
      ),
      [],
    );
  });

  it("claims no degradation for a clean report", () => {
    const evidence = collectKosiEvidence(
      { schemaVersion: "kosi/1", stats: {} },
      components,
    );
    assert.deepStrictEqual(
      evidence.metadataProperties.filter((p) =>
        p.name.startsWith("cdx:kosi:diagnostic:"),
      ),
      [],
    );
    assert.deepStrictEqual(
      evidence.metadataProperties.filter((p) =>
        p.name.startsWith("cdx:kosi:sourceCoverage"),
      ),
      [],
    );
  });
});

describe("kosiWorkspaceComponent()", () => {
  it("rebuilds the purl when the module name carries Gradle quote literals", () => {
    // KotlinGoat regression: kosi echoes the settings file's quoted
    // rootProject.name into modules[].name and modules[].purl, and the
    // quoted purl failed CycloneDX validation at metadata.component.purl.
    const component = kosiWorkspaceComponent({
      name: "'KotlinGoat'",
      purl: "pkg:generic/'KotlinGoat'@unspecified",
      modulePath: ".",
    });
    assert.ok(component);
    assert.strictEqual(component.name, "KotlinGoat");
    assert.strictEqual(component.purl, "pkg:generic/KotlinGoat@unspecified");
    assert.strictEqual(component["bom-ref"], component.purl);
  });

  it("keeps a reported purl that already parses", () => {
    const component = kosiWorkspaceComponent({
      name: "sample-app",
      purl: "pkg:maven/com.example/sample-app@1.0.0",
      modulePath: ".",
    });
    assert.ok(component);
    assert.strictEqual(
      component.purl,
      "pkg:maven/com.example/sample-app@1.0.0",
    );
  });

  it("reads the version through the purl, not the text after @", () => {
    const component = kosiWorkspaceComponent({
      name: "sample-app",
      purl: "pkg:maven/com.example/sample-app@1.0.0%2Bbuild.3?type=jar",
      modulePath: ".",
    });
    assert.strictEqual(component.version, "1.0.0+build.3");
    assert.strictEqual(
      component.purl,
      "pkg:maven/com.example/sample-app@1.0.0%2Bbuild.3?type=jar",
    );
    assert.strictEqual(
      component["bom-ref"],
      "pkg:maven/com.example/sample-app@1.0.0+build.3?type=jar",
    );
  });

  it("returns no anchor when the purl cannot be salvaged", () => {
    assert.strictEqual(kosiWorkspaceComponent(undefined), undefined);
    assert.strictEqual(kosiWorkspaceComponent({ name: "app" }), undefined);
    assert.strictEqual(
      kosiWorkspaceComponent({ name: "", purl: "not a purl" }),
      undefined,
    );
  });

  it("resolves a doubled directory against the working directory for kosi", async () => {
    // depscan launches cdxgen with cwd set to the project while forwarding a
    // repo-root-relative source path; a plain resolve joins the two into a
    // directory that does not exist. analyzeKosiProject must pass the working
    // directory (the Kotlin project) to the plugin instead.
    const projectDir = realpathSync(
      mkdtempSync(join(tmpdir(), "cdxgen-kosi-cwd-")),
    );
    writeFileSync(join(projectDir, "pom.xml"), "<project></project>\n");
    const previousCwd = process.cwd();
    process.chdir(projectDir);
    const report = { schema_version: "kosi-report-0.1", call_graph: {} };
    const safeSpawnSync = sinon.stub().callsFake((_cmd, args) => {
      const outputFile = args[args.indexOf("--out") + 1];
      writeFileSync(outputFile, JSON.stringify(report));
      return { status: 0 };
    });
    try {
      const { analyzeKosiProject: mockedAnalyze } = await esmock("./kosi.js", {
        "../inventory/plugins.js": {
          resolvePluginBinary: sinon.stub().returns("kosi"),
        },
        "../core/activity.js": {
          DEBUG_MODE: false,
          readEnvironmentVariable: () => undefined,
        },
        "../core/fs.js": {
          getTmpDir: sinon.stub().returns(tmpdir()),
          safeExistsSync: (p) => p.endsWith(".json"),
          safeMkdtempSync: (prefix) => mkdtempSync(prefix),
          safeRmSync: (dir, opts) => rmSync(dir, opts),
          safeSpawnSync,
        },
      });
      const reports = mockedAnalyze("test/data/kotlin/repos/sample-app", {});
      assert.ok(reports?.report, "expected the all-pass report to be parsed");
      sinon.assert.calledTwice(safeSpawnSync);
      for (const call of safeSpawnSync.getCalls()) {
        const args = call.args[1];
        assert.strictEqual(args[args.indexOf("--dir") + 1], projectDir);
        assert.strictEqual(call.args[2].cwd, projectDir);
      }
    } finally {
      process.chdir(previousCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

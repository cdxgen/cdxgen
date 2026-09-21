import { assert, describe, it } from "poku";

import {
  collectKosiApiEndpoints,
  collectKosiEvidence,
  collectKosiServices,
  isKosiKotlinLanguage,
  kosiDisabled,
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

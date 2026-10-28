import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  applyDosaiReachabilityEvidence,
  collectDosaiDataFlowFrames,
  collectDosaiPurlEvidence,
  collectDosaiServiceComponents,
  collectDosaiServicesFromMethods,
  maxDosaiMethodCalls,
  persistDosaiSemanticsReport,
  readDosaiDataFlowReport,
  readDosaiMethodsReport,
} from "./dosai.js";
import { addEvidenceForDotnet } from "./evidenceUtils.js";

// Every report below is larger than this, so it takes the trimmed path.
const TRIMMED = { maxTextBytes: 0 };

const components = () => [
  { name: "Newtonsoft.Json", purl: "pkg:nuget/Newtonsoft.Json@13.0.3" },
  { name: "Serilog", purl: "pkg:nuget/Serilog@3.1.1" },
];

const edge = (id, extra = {}) => ({
  Id: id,
  SourceId: `App.Program.Main():void#${id}`,
  TargetId: `Newtonsoft.Json.JsonConvert.SerializeObject(object):string#${id}`,
  CallLocation: { FileName: "Program.cs", LineNumber: 12, ColumnNumber: 9 },
  Path: `src/App/${id}/Program.cs`,
  FileName: "Program.cs",
  CalledMethodName: `SerializeObject${id}`,
  TargetName: `SerializeObject${id}`,
  ...extra,
});

const node = (id) => ({
  Id: id,
  Name: `Method ${id} with "quotes" and ü`,
  ClassName: `Class${id}`,
  Namespace: "App",
  Module: "Dosai.SourceAnalysis.CSharp.dll",
  Path: `src/App/${id}.cs`,
  FileName: `${id}.cs`,
  LineNumber: 7,
  ColumnNumber: 3,
});

// Shaped like dosai's methods report, with the sections cdxgen never reads and
// graph entries nothing references alongside the ones it does.
const methodsReport = {
  Metadata: { Tool: "Dosai", SchemaVersion: "5.1.0" },
  Dependencies: [
    {
      Name: "JsonConvert",
      Namespace: "Newtonsoft.Json",
      Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
      Path: "src/App/Program.cs",
      FileName: "Program.cs",
      LineNumber: 3,
    },
  ],
  Methods: Array.from({ length: 50 }, (_, i) => ({
    Name: `Unused${i}`,
    Path: "src/App/Unused.cs",
  })),
  MethodCalls: [
    {
      Module: "Serilog.dll",
      Path: "src/App/Logging.cs",
      LineNumber: 21,
      ClassName: "Log",
      CalledMethod: "Information",
    },
    ...Array.from({ length: 30 }, (_, i) => ({
      Module: "Dosai.SourceAnalysis.CSharp.dll",
      Path: "src/App/Internal.cs",
      LineNumber: i + 1,
      ClassName: "Internal",
      CalledMethod: `Call${i}`,
    })),
  ],
  AssemblyInformation: [{ Name: "Serilog", Version: "3.1.1" }],
  Properties: [{ Name: "Unused" }],
  CallGraph: {
    Edges: [edge("e1"), edge("e2"), edge("e3"), edge("e4")],
    Nodes: [node("n1"), node("n2"), node("n3"), node("n4")],
  },
  Reachability: Array.from({ length: 20 }, (_, i) => ({ NodeId: `n${i}` })),
  PackageReachability: [
    {
      Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
      ReachabilityKind: "Reachable",
      Confidence: "High",
      EvidenceKinds: ["CallGraph"],
      ConfidenceReasons: ["called from Program.cs"],
      EdgeIds: ["e1", "e3"],
      NodeIds: ["n2"],
    },
  ],
  Services: [
    {
      Id: "app:catalogdb",
      Name: "catalogdb",
      Group: "App",
      Direction: "outbound",
    },
  ],
  ApiEndpoints: [
    {
      HttpMethod: "GET",
      Route: "/items/{id}",
      Path: "/items/{id}",
      FilePath: "src/App/ItemsController.cs",
      LineNumber: 30,
    },
  ],
  AiComponents: [],
  Diagnostics: [],
};

const dataFlowReport = {
  Metadata: { Tool: "Dosai", SchemaVersion: "5.1.0", Kind: "dataflows" },
  EntryPoints: [{ Id: "ep1" }],
  Nodes: [
    { Id: "d1", Path: "src/App/A.cs", Name: "Read", LineNumber: 4 },
    { Id: "d2", Path: "src/App/B.cs", Name: "Write", LineNumber: 8 },
    { Id: "d3", Path: "src/App/C.cs", Name: "Unused", LineNumber: 9 },
    { Id: "d4", Path: "src/App/D.cs", Name: "Sink", LineNumber: 2 },
  ],
  Edges: [{ Source: "d1", Target: "d2" }],
  Slices: [
    {
      Id: "s1",
      NodeIds: ["d1", "d2"],
      SourcePurl: "pkg:nuget/Newtonsoft.Json@13.0.3",
    },
  ],
  PackageReachability: [{ Purl: "pkg:nuget/Serilog@3.1.1", NodeIds: ["d4"] }],
  MethodSummaries: [{ Method: "Unused" }],
};

const withReports = (callback) => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-large-"));
  try {
    const methodsFile = join(dir, "deps.slices.json");
    const dataFlowFile = join(dir, "dataflows.json");
    // Pretty-printed, as some dosai builds write it.
    writeFileSync(methodsFile, JSON.stringify(methodsReport, null, 2));
    writeFileSync(dataFlowFile, JSON.stringify(dataFlowReport));
    return callback({ dir, methodsFile, dataFlowFile });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const keepPackageDllCalls = (methodCall) =>
  methodCall?.Module === "Serilog.dll";

describe("readDosaiMethodsReport()", () => {
  it("parses a report that fits in one string whole", () => {
    withReports(({ methodsFile }) => {
      assert.deepStrictEqual(
        readDosaiMethodsReport(methodsFile, {
          keepMethodCall: keepPackageDllCalls,
        }),
        methodsReport,
      );
    });
  });

  it("keeps only what cdxgen reads from a report too large to parse whole", () => {
    withReports(({ methodsFile }) => {
      const report = readDosaiMethodsReport(methodsFile, {
        ...TRIMMED,
        keepMethodCall: keepPackageDllCalls,
      });
      assert.deepStrictEqual(Object.keys(report).sort(), [
        "AiComponents",
        "ApiEndpoints",
        "AssemblyInformation",
        "CallGraph",
        "Dependencies",
        "Metadata",
        "MethodCalls",
        "PackageReachability",
        "Services",
      ]);
      assert.deepStrictEqual(
        report.CallGraph.Edges.map((entry) => entry.Id),
        ["e1", "e3"],
      );
      assert.deepStrictEqual(
        report.CallGraph.Nodes.map((entry) => entry.Id),
        ["n2"],
      );
      assert.deepStrictEqual(report.MethodCalls, [
        methodsReport.MethodCalls[0],
      ]);
      assert.deepStrictEqual(
        report.PackageReachability,
        methodsReport.PackageReachability,
      );
    });
  });

  it("drops MethodCalls from a large report when no caller asks for them", () => {
    withReports(({ methodsFile }) => {
      const report = readDosaiMethodsReport(methodsFile, TRIMMED);
      assert.strictEqual(report.MethodCalls, undefined);
      assert.ok(report.CallGraph);
    });
  });

  it("reads only the requested sections of a large report", () => {
    withReports(({ methodsFile }) => {
      assert.deepStrictEqual(
        readDosaiMethodsReport(methodsFile, {
          ...TRIMMED,
          sections: ["Metadata", "Services", "ApiEndpoints"],
        }),
        {
          Metadata: methodsReport.Metadata,
          Services: methodsReport.Services,
          ApiEndpoints: methodsReport.ApiEndpoints,
        },
      );
    });
  });

  it("gives the same SBOM evidence as the whole report", () => {
    withReports(({ methodsFile }) => {
      const whole = readDosaiMethodsReport(methodsFile);
      const trimmed = readDosaiMethodsReport(methodsFile, TRIMMED);
      assert.deepStrictEqual(
        collectDosaiPurlEvidence(trimmed, components()),
        collectDosaiPurlEvidence(whole, components()),
      );
      assert.ok(
        collectDosaiPurlEvidence(trimmed, components()).purlLocationMap[
          "pkg:nuget/Newtonsoft.Json@13.0.3"
        ]?.has("src/App/n2.cs#7"),
      );
      const wholeComponents = components();
      const trimmedComponents = components();
      applyDosaiReachabilityEvidence(whole, wholeComponents);
      applyDosaiReachabilityEvidence(trimmed, trimmedComponents);
      assert.deepStrictEqual(trimmedComponents, wholeComponents);
      assert.deepStrictEqual(
        collectDosaiServicesFromMethods(
          trimmed,
          collectDosaiServiceComponents(trimmed, {}),
        ),
        collectDosaiServicesFromMethods(
          whole,
          collectDosaiServiceComponents(whole, {}),
        ),
      );
    });
  });

  it("returns undefined for a missing or malformed report", () => {
    withReports(({ dir }) => {
      const truncated = join(dir, "truncated.json");
      writeFileSync(truncated, JSON.stringify(methodsReport).slice(0, -40));
      assert.strictEqual(readDosaiMethodsReport(truncated), undefined);
      assert.strictEqual(readDosaiMethodsReport(truncated, TRIMMED), undefined);
      assert.strictEqual(
        readDosaiMethodsReport(join(dir, "missing.json"), TRIMMED),
        undefined,
      );
    });
  });
});

describe("readDosaiDataFlowReport()", () => {
  it("keeps the nodes that slices and package reachability reference", () => {
    withReports(({ dataFlowFile }) => {
      const whole = readDosaiDataFlowReport(dataFlowFile);
      const trimmed = readDosaiDataFlowReport(dataFlowFile, TRIMMED);
      assert.deepStrictEqual(whole, dataFlowReport);
      assert.deepStrictEqual(
        trimmed.Nodes.map((entry) => entry.Id),
        ["d1", "d2", "d4"],
      );
      assert.strictEqual(trimmed.MethodSummaries, undefined);
      assert.deepStrictEqual(
        collectDosaiDataFlowFrames(trimmed, components()),
        collectDosaiDataFlowFrames(whole, components()),
      );
    });
  });
});

describe("persistDosaiSemanticsReport() with large reports", () => {
  const expectedCombined = {
    Metadata: dataFlowReport.Metadata,
    methods: methodsReport,
    dataflows: dataFlowReport,
  };

  it("copies the native files when the reports were trimmed", () => {
    withReports(({ dir, methodsFile, dataFlowFile }) => {
      const semanticsSlicesFile = join(dir, "semantics.slices.json");
      const persisted = persistDosaiSemanticsReport(
        { semanticsSlicesFile },
        readDosaiMethodsReport(methodsFile, TRIMMED),
        readDosaiDataFlowReport(dataFlowFile, TRIMMED),
      );
      assert.strictEqual(persisted, semanticsSlicesFile);
      assert.deepStrictEqual(
        JSON.parse(readFileSync(semanticsSlicesFile, "utf-8")),
        expectedCombined,
      );
    });
  });

  it("serialises an in-memory part next to a trimmed one", () => {
    withReports(({ dir, methodsFile }) => {
      const semanticsSlicesFile = join(dir, "semantics.slices.json");
      persistDosaiSemanticsReport(
        { semanticsSlicesFile },
        readDosaiMethodsReport(methodsFile, TRIMMED),
        undefined,
      );
      assert.deepStrictEqual(
        JSON.parse(readFileSync(semanticsSlicesFile, "utf-8")),
        {
          Metadata: methodsReport.Metadata,
          methods: methodsReport,
          dataflows: {},
        },
      );
    });
  });

  it("writes in parts when the whole reports are too large for one string", () => {
    withReports(({ dir, methodsFile, dataFlowFile }) => {
      const semanticsSlicesFile = join(dir, "semantics.slices.json");
      const methods = readDosaiMethodsReport(methodsFile);
      const dataflows = readDosaiDataFlowReport(dataFlowFile);
      const stringify = sinon.stub(JSON, "stringify");
      try {
        stringify.callThrough();
        stringify.onFirstCall().throws(new RangeError("Invalid string length"));
        persistDosaiSemanticsReport(
          { semanticsSlicesFile },
          methods,
          dataflows,
        );
      } finally {
        stringify.restore();
      }
      assert.deepStrictEqual(
        JSON.parse(readFileSync(semanticsSlicesFile, "utf-8")),
        expectedCombined,
      );
    });
  });
});

// A report whose MethodCalls rows are the fat rows dosai writes, with repeats
// of the same call site and rows nothing keeps.
const fatCallsReport = () => ({
  Metadata: { Tool: "Dosai", SchemaVersion: "5.1.0" },
  MethodCalls: [
    {
      Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
      Module: "Newtonsoft.Json.dll",
      Path: "src/Generated.cs",
      FileName: "Generated.cs",
      LineNumber: 13,
      ClassName: "JsonConvert",
      CalledMethod: "SerializeObject",
      Assembly: "Newtonsoft.Json, Version=13.0.0.0",
      Arguments: ["System.Object"],
      ArgumentExpressions: ["payload"],
      CallType: "MethodCall",
      SourceId: "Fixture.Generated.Run():System.String",
      TargetId:
        "Newtonsoft.Json.JsonConvert.SerializeObject(System.Object):System.String",
      CallerMethod: "Run",
      IsInternal: false,
      Evidence: [{ Kind: "SourceRoslynDirect" }],
    },
    // The same call site, reached twice more.
    {
      Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
      Module: "Newtonsoft.Json.dll",
      Path: "src/Generated.cs",
      FileName: "Generated.cs",
      LineNumber: 13,
      ClassName: "JsonConvert",
      CalledMethod: "SerializeObject",
      Arguments: ["System.String"],
      CallerMethod: "Other",
    },
    {
      Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
      Module: "Newtonsoft.Json.dll",
      Path: "src/Generated.cs",
      FileName: "Generated.cs",
      LineNumber: 13,
      ClassName: "JsonConvert",
      CalledMethod: "SerializeObject",
      Arguments: [],
    },
    // A second call site of the same package.
    {
      Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
      Module: "Newtonsoft.Json.dll",
      Path: "src/Other.cs",
      FileName: "Other.cs",
      LineNumber: 4,
      ClassName: "JsonConvert",
      CalledMethod: "ParseJson",
      CallerMethod: "Run",
    },
    // A row no caller keeps.
    {
      Module: "Fixture.dll",
      Path: "src/Generated.cs",
      LineNumber: 1,
      ClassName: "Generated",
      CalledMethod: "Run",
    },
  ],
});

const withFatCalls = (callback) => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-fat-calls-"));
  try {
    const methodsFile = join(dir, "deps.slices.json");
    writeFileSync(methodsFile, JSON.stringify(fatCallsReport(), null, 2));
    return callback({ dir, methodsFile });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const keepPackageCalls = (methodCall) =>
  methodCall?.Purl === "pkg:nuget/Newtonsoft.Json@13.0.3";

const aggregatedRows = [
  {
    Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
    Module: "Newtonsoft.Json.dll",
    Path: "src/Generated.cs",
    FileName: "Generated.cs",
    LineNumber: 13,
    ClassName: "JsonConvert",
    CalledMethod: "SerializeObject",
    CallCount: 3,
  },
  {
    Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
    Module: "Newtonsoft.Json.dll",
    Path: "src/Other.cs",
    FileName: "Other.cs",
    LineNumber: 4,
    ClassName: "JsonConvert",
    CalledMethod: "ParseJson",
  },
];

describe("readDosaiMethodsReport() MethodCalls aggregation", () => {
  it("aggregates repeats and keeps only the fields cdxgen reads", () => {
    withFatCalls(({ methodsFile }) => {
      // A report parsed whole keeps every row, as it always has, reduced to
      // the fields cdxgen reads.
      const whole = readDosaiMethodsReport(methodsFile);
      assert.deepStrictEqual(whole.MethodCalls, [
        {
          Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
          Module: "Newtonsoft.Json.dll",
          Path: "src/Generated.cs",
          FileName: "Generated.cs",
          LineNumber: 13,
          ClassName: "JsonConvert",
          CalledMethod: "SerializeObject",
          CallCount: 3,
        },
        {
          Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
          Module: "Newtonsoft.Json.dll",
          Path: "src/Other.cs",
          FileName: "Other.cs",
          LineNumber: 4,
          ClassName: "JsonConvert",
          CalledMethod: "ParseJson",
        },
        {
          Module: "Fixture.dll",
          Path: "src/Generated.cs",
          LineNumber: 1,
          ClassName: "Generated",
          CalledMethod: "Run",
        },
      ]);
      // From a report too large to parse whole, the caller's predicate
      // chooses the rows first.
      const trimmed = readDosaiMethodsReport(methodsFile, {
        ...TRIMMED,
        keepMethodCall: keepPackageCalls,
      });
      assert.deepStrictEqual(trimmed.MethodCalls, aggregatedRows);
    });
  });

  it("caps distinct rows with a warning naming the escape hatch", () => {
    withFatCalls(({ methodsFile }) => {
      const warnings = [];
      const warn = sinon
        .stub(console, "warn")
        .callsFake((m) => warnings.push(m));
      try {
        const report = readDosaiMethodsReport(methodsFile, {
          ...TRIMMED,
          keepMethodCall: keepPackageCalls,
          maxMethodCalls: 1,
        });
        assert.deepStrictEqual(report.MethodCalls, [aggregatedRows[0]]);
      } finally {
        warn.restore();
      }
      assert.deepStrictEqual(warnings.length, 1);
      assert.match(warnings[0], /CDXGEN_DOSAI_MAX_METHOD_CALLS/);
      assert.match(warnings[0], /deps\.slices\.json/);
    });
  });

  it("still builds the same occurrence evidence from the aggregated rows", () => {
    withFatCalls(({ methodsFile }) => {
      const pkgList = [
        {
          name: "Newtonsoft.Json",
          purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
          properties: [],
        },
      ];
      const enriched = addEvidenceForDotnet(pkgList, methodsFile, {
        srcPath: "/tmp/fixture",
      });
      const component = enriched.find(
        (entry) => entry.purl === "pkg:nuget/Newtonsoft.Json@13.0.3",
      );
      const occurrences =
        component?.evidence?.occurrences?.map(
          (o) => `${o.location}#${o.line}`,
        ) || [];
      assert.deepStrictEqual(occurrences.sort(), [
        "src/Generated.cs#13",
        "src/Other.cs#4",
      ]);
    });
  });
});

describe("maxDosaiMethodCalls()", () => {
  it("reads the override and falls back to the default", () => {
    const saved = process.env.CDXGEN_DOSAI_MAX_METHOD_CALLS;
    try {
      delete process.env.CDXGEN_DOSAI_MAX_METHOD_CALLS;
      assert.strictEqual(maxDosaiMethodCalls(), 1_000_000);
      process.env.CDXGEN_DOSAI_MAX_METHOD_CALLS = "250000";
      assert.strictEqual(maxDosaiMethodCalls(), 250000);
      process.env.CDXGEN_DOSAI_MAX_METHOD_CALLS = "bogus";
      assert.strictEqual(maxDosaiMethodCalls(), 1_000_000);
      process.env.CDXGEN_DOSAI_MAX_METHOD_CALLS = "0";
      assert.strictEqual(maxDosaiMethodCalls(), 1_000_000);
    } finally {
      if (saved === undefined) {
        delete process.env.CDXGEN_DOSAI_MAX_METHOD_CALLS;
      } else {
        process.env.CDXGEN_DOSAI_MAX_METHOD_CALLS = saved;
      }
    }
  });
});

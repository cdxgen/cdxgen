import { assert, describe, it } from "poku";

import {
  convertOSQueryResults,
  createOccurrenceEvidence,
  formatOccurrenceEvidence,
  parseOccurrenceEvidenceLocation,
} from "./evidenceUtils.js";

describe("evidence utils", () => {
  it("creates occurrence evidence with structured line details", () => {
    assert.deepStrictEqual(
      createOccurrenceEvidence("src/index.js", {
        line: 14,
        offset: 3,
        symbol: "node:crypto.createHash",
      }),
      {
        location: "src/index.js",
        line: 14,
        offset: 3,
        symbol: "node:crypto.createHash",
      },
    );
  });

  it("parses hash-style line locations", () => {
    assert.deepStrictEqual(parseOccurrenceEvidenceLocation("src/index.js#27"), {
      location: "src/index.js",
      line: 27,
    });
  });

  it("parses colon-style line and offset locations", () => {
    assert.deepStrictEqual(
      parseOccurrenceEvidenceLocation("src/index.js:29:7"),
      {
        location: "src/index.js",
        line: 29,
        offset: 7,
      },
    );
  });

  it("formats structured occurrence evidence for display", () => {
    assert.strictEqual(
      formatOccurrenceEvidence({
        location: "src/index.js",
        line: 12,
        offset: 1,
      }),
      "src/index.js:12:1",
    );
  });
});

// Restored from the retired lib/helpers/core-misc-b.poku.js, which was
// deleted along with its module during the v13 layer reorganisation even though
// the functions under test only moved.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  addEvidenceForDotnet,
  attachIdentityTools,
  extractToolRefs,
} from "./evidenceUtils.js";

it("addEvidenceForDotnet() initializes evidence before adding occurrences", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-dotnet-evidence-"));
  const slicesFile = path.join(tempDir, "dosai.json");
  try {
    writeFileSync(
      slicesFile,
      JSON.stringify({
        Dependencies: [
          {
            Module: "Example.dll",
            Path: "src/Program.cs",
            LineNumber: 42,
          },
        ],
      }),
    );
    const pkgList = addEvidenceForDotnet(
      [
        {
          name: "Example",
          purl: "pkg:nuget/Example@1.0.0",
          properties: [{ name: "internal:PackageFiles", value: "Example.dll" }],
        },
      ],
      slicesFile,
    );
    assert.deepStrictEqual(pkgList[0].evidence?.occurrences, [
      {
        location: "src/Program.cs",
        line: 42,
      },
    ]);
    assert.strictEqual(pkgList[0].scope, "required");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("addEvidenceForDotnet() ignores unreadable dosai JSON", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-dotnet-bad-json-"));
  const slicesFile = path.join(tempDir, "dosai.json");
  try {
    writeFileSync(slicesFile, "");
    const inputPkgList = [
      {
        name: "Example",
        purl: "pkg:nuget/Example@1.0.0",
        properties: [{ name: "internal:PackageFiles", value: "Example.dll" }],
      },
    ];
    const pkgList = addEvidenceForDotnet(inputPkgList, slicesFile);

    assert.strictEqual(pkgList, inputPkgList);
    assert.strictEqual(pkgList[0].evidence, undefined);
    assert.strictEqual(pkgList[0].scope, undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("addEvidenceForDotnet() consumes dosai v3 PackageReachability", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-dotnet-reachability-"),
  );
  const slicesFile = path.join(tempDir, "dosai.json");
  try {
    writeFileSync(
      slicesFile,
      JSON.stringify({
        CallGraph: {
          Edges: [
            {
              Id: "e1",
              FileName: "Controllers/EpisodesController.cs",
              LineNumber: 17,
              CalledMethodName: "System.Text.Json.JsonSerializer.Deserialize",
            },
          ],
          Nodes: [
            {
              Id: "n1",
              FileName: "System.Text.Json.dll",
              LineNumber: 0,
              ClassName: "JsonSerializer",
              Name: "Deserialize",
            },
          ],
        },
        PackageReachability: [
          {
            Purl: "pkg:nuget/System.Text.Json",
            EdgeIds: ["e1"],
            NodeIds: ["n1"],
            SourceLocations: [
              {
                Path: "Controllers/Parser.cs",
                FileName: "Parser.cs",
                LineNumber: 42,
                ColumnNumber: 13,
                Kind: "CallGraphEdge",
              },
              {
                Path: "System.Text.Json.dll",
                FileName: "System.Text.Json.dll",
                LineNumber: 1,
                Kind: "CallGraphNode",
              },
            ],
          },
        ],
      }),
    );
    const pkgList = addEvidenceForDotnet(
      [
        {
          name: "System.Text.Json",
          purl: "pkg:nuget/System.Text.Json@10.0.0",
          properties: [],
        },
      ],
      slicesFile,
    );

    assert.deepStrictEqual(pkgList[0].evidence?.occurrences, [
      {
        location: "Controllers/Parser.cs",
        line: 42,
      },
    ]);
    assert.ok(
      pkgList[0].evidence.identity.methods.some(
        (method) =>
          method.technique === "source-code-analysis" &&
          method.value === "Controllers/Parser.cs#42",
      ),
    );
    assert.ok(
      pkgList[0].properties.some(
        (property) =>
          property.name === "internal:CalledMethods" &&
          property.value.includes(
            "System.Text.Json.JsonSerializer.Deserialize",
          ),
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("addEvidenceForDotnet() propagates PackageReachability confidence to component properties", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-dotnet-reachability-confidence-"),
  );
  const slicesFile = path.join(tempDir, "dosai.json");
  try {
    writeFileSync(
      slicesFile,
      JSON.stringify({
        PackageReachability: [
          {
            Purl: "pkg:nuget/Newtonsoft.Json@12.0.3",
            ReachabilityKind: "ExternalCallGraphNode",
            Confidence: "Low",
            EvidenceKinds: ["SourceUnresolved"],
            ConfidenceReasons: [
              "Reachability is inferred from heuristic or unresolved evidence.",
              "Package assemblies were not available for semantic binding; reachability inferred from unresolved call sites. Restoring or building the tree raises this confidence.",
            ],
          },
        ],
      }),
    );
    const pkgList = addEvidenceForDotnet(
      [
        {
          name: "Newtonsoft.Json",
          purl: "pkg:nuget/Newtonsoft.Json@12.0.3",
          properties: [],
        },
      ],
      slicesFile,
    );

    const properties = Object.fromEntries(
      pkgList[0].properties.map((p) => [p.name, p.value]),
    );
    assert.strictEqual(
      properties["cdx:dosai:reachability:kind"],
      "ExternalCallGraphNode",
    );
    assert.strictEqual(properties["cdx:dosai:reachability:confidence"], "Low");
    assert.strictEqual(
      properties["cdx:dosai:reachability:evidence"],
      "SourceUnresolved",
    );
    assert.ok(
      properties["cdx:dosai:reachability:reasons"].includes(
        "Package assemblies were not available for semantic binding",
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("addEvidenceForDotnet() keeps PackageReachability fallback evidence source-only", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-dotnet-source-fallback-"),
  );
  const slicesFile = path.join(tempDir, "dosai.json");
  try {
    writeFileSync(
      slicesFile,
      JSON.stringify({
        CallGraph: {
          Edges: [
            {
              Id: "e1",
              FileName: "System.Text.Json.dll",
              LineNumber: 12,
              CalledMethodName: "System.Text.Json.JsonSerializer.Deserialize",
              CallLocation: {
                FileName: "Program.fs",
                LineNumber: 8,
              },
            },
            {
              Id: "e2",
              FileName: "Controllers/EpisodesController.cs",
              LineNumber: 17,
              CalledMethodName: "System.Text.Json.JsonSerializer.Serialize",
            },
          ],
        },
        PackageReachability: [
          {
            Purl: "pkg:nuget/System.Text.Json",
            EdgeIds: ["e1", "e2"],
          },
        ],
      }),
    );
    const pkgList = addEvidenceForDotnet(
      [
        {
          name: "System.Text.Json",
          purl: "pkg:nuget/System.Text.Json@10.0.0",
          properties: [],
        },
      ],
      slicesFile,
    );

    assert.deepStrictEqual(pkgList[0].evidence?.occurrences, [
      {
        location: "Controllers/EpisodesController.cs",
        line: 17,
      },
      {
        location: "Program.fs",
        line: 8,
      },
    ]);
    assert.ok(!JSON.stringify(pkgList[0].evidence).includes(".dll"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("addEvidenceForDotnet() preserves additional identity entries", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-dotnet-identity-array-"),
  );
  const slicesFile = path.join(tempDir, "dosai.json");
  try {
    writeFileSync(
      slicesFile,
      JSON.stringify({
        Dependencies: [
          {
            Path: "Program.cs",
            FileName: "Program.cs",
            Name: "System.Text.Json",
            Purl: "pkg:nuget/System.Text.Json",
            LineNumber: 12,
          },
        ],
      }),
    );
    const pkgList = addEvidenceForDotnet(
      [
        {
          name: "System.Text.Json",
          purl: "pkg:nuget/System.Text.Json@10.0.0",
          evidence: {
            identity: [
              {
                field: "name",
                confidence: 0.8,
                methods: [
                  { technique: "filename", value: "packages.lock.json" },
                ],
              },
              {
                field: "purl",
                confidence: 1,
                methods: [
                  {
                    technique: "manifest-analysis",
                    value: "packages.lock.json",
                  },
                ],
              },
            ],
          },
          properties: [],
        },
      ],
      slicesFile,
    );

    assert.strictEqual(pkgList[0].evidence.identity.length, 2);
    assert.strictEqual(pkgList[0].evidence.identity[0].field, "name");
    assert.ok(
      pkgList[0].evidence.identity[1].methods.some(
        (method) =>
          method.technique === "source-code-analysis" &&
          method.value === "Program.cs#12",
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("addEvidenceForDotnet() consumes dosai Dependencies with purls", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-dotnet-vb-deps-"));
  const slicesFile = path.join(tempDir, "dosai.json");
  try {
    writeFileSync(
      slicesFile,
      JSON.stringify({
        Dependencies: [
          {
            Path: "Program.vb",
            FileName: "Program.vb",
            Name: "Newtonsoft.Json",
            Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
            LineNumber: 4,
            ColumnNumber: 9,
          },
        ],
      }),
    );
    const pkgList = addEvidenceForDotnet(
      [
        {
          name: "Newtonsoft.Json",
          purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
          properties: [],
        },
      ],
      slicesFile,
    );

    assert.deepStrictEqual(pkgList[0].evidence?.occurrences, [
      {
        location: "Program.vb",
        line: 4,
      },
    ]);
    assert.ok(
      pkgList[0].properties.some(
        (property) =>
          property.name === "internal:ImportedModules" &&
          property.value.includes("Newtonsoft.Json"),
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("extractToolRefs collects unique bom-refs from metadata.tools", () => {
  assert.deepStrictEqual(
    extractToolRefs(
      {
        components: [
          { name: "trivy", "bom-ref": "pkg:generic/trivy@0.1.0" },
          { name: "trivy", "bom-ref": "pkg:generic/trivy@0.1.0" },
          { name: "cdxgen" },
        ],
        services: [{ name: "blint", "bom-ref": "urn:tool:blint" }],
      },
      (tool) => tool.name !== "cdxgen",
    ),
    ["pkg:generic/trivy@0.1.0", "urn:tool:blint"],
  );
});

it("extractToolRefs derives and persists bom-refs for external tools", () => {
  const tools = {
    components: [
      {
        group: "aquasecurity",
        name: "trivy",
        version: "dev",
      },
    ],
  };
  assert.deepStrictEqual(extractToolRefs(tools), [
    "pkg:generic/aquasecurity/trivy@dev",
  ]);
  assert.strictEqual(
    tools.components[0]["bom-ref"],
    "pkg:generic/aquasecurity/trivy@dev",
  );
});

it("attachIdentityTools adds tool references to object and array identities", () => {
  const subjects = [
    {
      evidence: {
        identity: {
          field: "purl",
          tools: ["pkg:generic/existing-tool@1.0.0"],
        },
      },
    },
    {
      evidence: {
        identity: [
          { field: "purl" },
          { field: "hash", tools: ["urn:tool:hash"] },
        ],
      },
    },
  ];
  attachIdentityTools(subjects, [
    "pkg:generic/existing-tool@1.0.0",
    "pkg:generic/trivy@0.1.0",
  ]);
  assert.deepStrictEqual(subjects[0].evidence.identity.tools, [
    "pkg:generic/existing-tool@1.0.0",
    "pkg:generic/trivy@0.1.0",
  ]);
  assert.deepStrictEqual(subjects[1].evidence.identity[0].tools, [
    "pkg:generic/existing-tool@1.0.0",
    "pkg:generic/trivy@0.1.0",
  ]);
  assert.deepStrictEqual(subjects[1].evidence.identity[1].tools, [
    "urn:tool:hash",
    "pkg:generic/existing-tool@1.0.0",
    "pkg:generic/trivy@0.1.0",
  ]);
});

describe("osquery result enhancement", () => {
  const queryObj = { purlType: "deb", name: "dev packages" };
  const results = [{ name: "libssl-dev", version: "3.0.2" }];

  it("calls the injected package lister and records what it provides", () => {
    let calledWith;
    const pkgList = convertOSQueryResults(
      "os_packages",
      queryObj,
      results,
      true,
      {
        deb: (name) => {
          calledWith = name;
          return ["/usr/lib/libssl.so"];
        },
      },
    );
    // Asserting the lister ran, not merely that the call did not throw: the
    // previous shape skipped it silently whenever it was not forwarded, which
    // produced components with no PkgProvides and no error.
    assert.strictEqual(calledWith, "libssl-dev");
    assert.ok(
      pkgList[0].properties.some(
        (p) =>
          p.name === "internal:PkgProvides" && p.value === "/usr/lib/libssl.so",
      ),
    );
  });

  it("throws when enhancement is requested without any listers", () => {
    assert.throws(
      () => convertOSQueryResults("os_packages", queryObj, results, true),
      /no osPackageListers were injected/,
    );
  });

  it("needs no listers when enhancement is not requested", () => {
    const pkgList = convertOSQueryResults(
      "os_packages",
      queryObj,
      results,
      false,
    );
    assert.ok(
      !pkgList[0].properties.some((p) => p.name === "internal:PkgProvides"),
    );
  });
});

it("addEvidenceForDotnet() gives the same evidence from a report too large to parse whole", async () => {
  // Issue 1033: dotnet/efcore produces a 1.9 GB dosai slice. The mocked limit
  // sends this small one down the same streamed path.
  const { default: esmock } = await import("esmock");
  const { default: sinon } = await import("sinon");
  const largeJson = await import("../parsers/largeJson.js");
  const indexJsonObject = sinon.spy(largeJson.indexJsonObject);
  const { addEvidenceForDotnet: addEvidenceForLargeDotnet } = await esmock(
    "./evidenceUtils.js",
    {},
    { "../parsers/largeJson.js": { MAX_JSON_TEXT_BYTES: 0, indexJsonObject } },
  );
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-dotnet-large-"));
  const slicesFile = path.join(tempDir, "dosai.json");
  const packages = () => [
    {
      name: "Serilog",
      purl: "pkg:nuget/Serilog@3.1.1",
      properties: [{ name: "internal:PackageFiles", value: "Serilog.dll" }],
    },
    { name: "Polly", purl: "pkg:nuget/Polly", properties: [] },
  ];
  try {
    writeFileSync(
      slicesFile,
      JSON.stringify({
        Metadata: { Tool: "Dosai", SchemaVersion: "5.1.0" },
        Dependencies: [
          {
            Purl: "pkg:nuget/Serilog@3.1.1",
            Name: "Log",
            Path: "src/Program.cs",
            FileName: "Program.cs",
            LineNumber: 2,
          },
        ],
        Methods: Array.from({ length: 40 }, (_, i) => ({ Name: `M${i}` })),
        MethodCalls: [
          {
            Module: "Serilog.dll",
            Path: "src/Logging.cs",
            LineNumber: 9,
            ClassName: "Log",
            CalledMethod: "Information",
          },
          {
            Module: "Dosai.SourceAnalysis.CSharp.dll",
            Path: "src/Internal.cs",
            LineNumber: 4,
            ClassName: "Internal",
            CalledMethod: "Run",
          },
        ],
        AssemblyInformation: [{ Name: "Polly", Version: "8.4.0" }],
        CallGraph: {
          Edges: [
            {
              Id: "e1",
              Path: "src/Retry.cs",
              FileName: "Retry.cs",
              LineNumber: 17,
              CalledMethodName: "Polly.Policy.Handle",
            },
            { Id: "e2", Path: "src/Other.cs", FileName: "Other.cs" },
          ],
          Nodes: [
            { Id: "n1", ClassName: "Policy", Name: "Handle" },
            { Id: "n2", ClassName: "Unrelated", Name: "Other" },
          ],
        },
        PackageReachability: [
          {
            Purl: "pkg:nuget/Polly",
            ReachabilityKind: "Reachable",
            Confidence: "Medium",
            EdgeIds: ["e1"],
            NodeIds: ["n1"],
          },
        ],
      }),
    );
    const whole = addEvidenceForDotnet(packages(), slicesFile);
    const streamed = addEvidenceForLargeDotnet(packages(), slicesFile);
    sinon.assert.calledOnceWithExactly(
      indexJsonObject,
      slicesFile,
      sinon.match.object,
    );
    assert.deepStrictEqual(streamed, whole);
    assert.deepStrictEqual(
      streamed[0].evidence.occurrences.map((o) => `${o.location}#${o.line}`),
      ["src/Logging.cs#9", "src/Program.cs#2"],
    );
    // An assembly's version is not its package's version, so the assembly
    // information does not fill in the versionless Polly component.
    assert.strictEqual(streamed[1].version, undefined);
    assert.strictEqual(streamed[1].purl, "pkg:nuget/Polly");
    assert.deepStrictEqual(streamed[1].evidence.occurrences, [
      { location: "src/Retry.cs", line: 17 },
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("addEvidenceForDotnet() gives a DLL two versions ship to the version of the caller's project", () => {
  // Two projects restore two versions of Moq; both ship Moq.dll.
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-dotnet-dll-"));
  const slicesFile = path.join(tempDir, "dosai.json");
  try {
    for (const project of ["A", "B"]) {
      mkdirSync(path.join(tempDir, "src", project, "obj"), { recursive: true });
      writeFileSync(
        path.join(tempDir, "src", project, "obj", "project.assets.json"),
        "{}",
      );
    }
    const packages = () => [
      {
        name: "Moq",
        version: "4.18.4",
        purl: "pkg:nuget/Moq@4.18.4",
        properties: [
          { name: "internal:PackageFiles", value: "Moq.dll" },
          {
            name: "internal:SrcFile",
            value: path.join(tempDir, "src", "A", "obj", "project.assets.json"),
          },
        ],
      },
      {
        name: "Moq",
        version: "4.20.69",
        purl: "pkg:nuget/Moq@4.20.69",
        properties: [
          { name: "internal:PackageFiles", value: "Moq.dll" },
          {
            name: "internal:SrcFile",
            value: path.join(tempDir, "src", "B", "obj", "project.assets.json"),
          },
        ],
      },
    ];
    writeFileSync(
      slicesFile,
      JSON.stringify({
        MethodCalls: [
          {
            Module: "Moq.dll",
            Path: "src/A/Tests.cs",
            LineNumber: 3,
            ClassName: "Mock",
            CalledMethod: "Setup",
          },
          {
            Module: "Moq.dll",
            Path: "src/B/Tests.cs",
            LineNumber: 7,
            ClassName: "Mock",
            CalledMethod: "Verify",
          },
          // In no project: neither version can claim it
          {
            Module: "Moq.dll",
            Path: "Shared.cs",
            LineNumber: 1,
            ClassName: "Mock",
            CalledMethod: "Of",
          },
        ],
        // dosai's purl for the B project's restore wins over the DLL name
        Dependencies: [
          {
            Purl: "pkg:nuget/Moq@4.20.69",
            Module: "Moq.dll",
            Path: "src/A/Shim.cs",
            LineNumber: 11,
            Name: "It",
          },
        ],
        CallGraph: {
          Edges: [],
          Nodes: [
            {
              Id: "lib",
              FileName: "Moq.dll",
              ClassName: "MockRepository",
              Name: "Create",
            },
          ],
        },
        PackageReachability: [
          {
            Purl: "pkg:nuget/Moq",
            ReachabilityKind: "ImportedOnly",
            SourceLocations: [{ Path: "src/A/Tests.cs", LineNumber: 3 }],
            // A frame inside the package follows the fact's own version
            NodeIds: ["lib"],
          },
          {
            Purl: "pkg:nuget/Moq@4.18.4",
            ReachabilityKind: "Reachable",
          },
        ],
      }),
    );
    const [a, b] = addEvidenceForDotnet(packages(), slicesFile, {
      srcPath: tempDir,
    });
    const locations = (pkg) =>
      pkg.evidence.occurrences.map((o) => `${o.location}#${o.line}`).sort();
    assert.deepStrictEqual(locations(a), ["src/A/Tests.cs#3"]);
    assert.deepStrictEqual(locations(b), [
      "src/A/Shim.cs#11",
      "src/B/Tests.cs#7",
    ]);
    const kindOf = (pkg) =>
      pkg.properties.find((p) => p.name === "cdx:dosai:reachability:kind")
        ?.value;
    // The fact naming the exact purl wins over the versionless one
    assert.strictEqual(kindOf(a), "Reachable");
    assert.strictEqual(kindOf(b), undefined);
    const modulesOf = (pkg) =>
      pkg.properties.find((p) => p.name === "internal:ImportedModules")?.value;
    assert.ok(modulesOf(a).includes("MockRepository"));
    assert.ok(!modulesOf(b).includes("MockRepository"));
    // Without the scanned directory the relative call sites settle nothing
    const unresolved = addEvidenceForDotnet(packages(), slicesFile);
    assert.deepStrictEqual(locations(unresolved[1]), ["src/A/Shim.cs#11"]);
    assert.strictEqual(unresolved[0].evidence?.occurrences, undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("addEvidenceForDotnet() gives a framework purl's calls to the package that ships the DLL", () => {
  // dosai names a System.* assembly it cannot map to a package with the
  // framework purl pkg:nuget/System.Runtime, as it does when the tree has a
  // lock file but no restore output. The purl names no component, so the DLL
  // the package lists in internal:PackageFiles still says whose call it is.
  // Issue 4441 is fixed by leaving build-time DLLs out of that list, not by
  // dropping this fallback.
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-dotnet-framework-purl-"),
  );
  const slicesFile = path.join(tempDir, "dosai.json");
  try {
    writeFileSync(
      slicesFile,
      JSON.stringify({
        Dependencies: [
          {
            Purl: "pkg:nuget/System.Runtime",
            Module: "System.Data.SQLite.dll",
            Namespace: "System.Data.SQLite",
            Name: "SQLiteConnection",
            Path: "App/Db.cs",
            FileName: "Db.cs",
            LineNumber: 1,
          },
        ],
        MethodCalls: [
          {
            Purl: "pkg:nuget/System.Runtime",
            Module: "System.Data.SQLite.dll",
            Path: "App/Db.cs",
            LineNumber: 7,
            ClassName: "SQLiteConnection",
            CalledMethod: "Open",
          },
          {
            // A framework call into a DLL no component lists
            Purl: "pkg:nuget/System.Runtime",
            Module: "System.Formats.Asn1.dll",
            Path: "App/Db.cs",
            LineNumber: 9,
            ClassName: "AsnWriter",
            CalledMethod: "WriteInteger",
          },
        ],
      }),
    );
    const pkgList = addEvidenceForDotnet(
      [
        {
          name: "System.Data.SQLite.Core",
          purl: "pkg:nuget/System.Data.SQLite.Core@1.0.118",
          properties: [
            {
              name: "internal:PackageFiles",
              value: "System.Data.SQLite.dll",
            },
          ],
        },
      ],
      slicesFile,
    );
    const locations = pkgList[0].evidence.occurrences.map(
      (occurrence) => `${occurrence.location}#${occurrence.line}`,
    );
    assert.deepStrictEqual(locations.sort(), ["App/Db.cs#1", "App/Db.cs#7"]);
    const methods = pkgList[0].properties.find(
      (property) => property.name === "internal:CalledMethods",
    );
    assert.ok(methods?.value.includes("Open"));
    assert.ok(!methods?.value.includes("WriteInteger"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

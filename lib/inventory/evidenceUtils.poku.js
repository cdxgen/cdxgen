import { dirname } from "node:path";

import { assert, describe, it } from "poku";

import { toComponent as chromeExtensionComponent } from "../ecosystems/chromextutils.js";
import { toComponent as vscodeExtensionComponent } from "../helpers/vsixutils.js";
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

it("addEvidenceForDotnet() lists a call site dosai 4 or 5 found in source and in IL once", () => {
  // dosai issue 79: a build of the scanned project gives each call a second
  // MethodCalls row from its IL. dosai 5 names the file relative to the scan
  // root like the source row, and leaves Path out when the file has no place
  // in the tree; dosai 4 keeps the PDB's path: absolute for a local build,
  // /_/ for a deterministic one, and on Linux a Windows build's whole path as
  // the file name. A call no sequence point covers names the assembly at an
  // IL offset in both.
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-dotnet-il-calls-"));
  const slicesFile = path.join(tempDir, "dosai.json");
  const call = (fields) => ({
    Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
    Module: "Newtonsoft.Json.dll",
    ClassName: "JsonConvert",
    CalledMethod: "SerializeObject",
    ...fields,
  });
  const program = path.join("src", "App", "Program.cs");
  const sourceRow = call({
    Path: program,
    FileName: "Program.cs",
    LineNumber: 3,
    EvidenceKind: "SourceRoslynDirect",
  });
  const ilRow = (Path, FileName, LineNumber) =>
    call({ Path, FileName, LineNumber, EvidenceKind: "AssemblyIlDirect" });
  const assemblyRow = (Path) =>
    call({
      Path,
      FileName: "Repro.dll",
      LineNumber: 57,
      EvidenceKind: "AssemblyIlDirect",
      CalledMethod: "DeserializeObject",
    });
  const reports = {
    dosai5: [
      sourceRow,
      ilRow(program, "Program.cs", 3),
      ilRow(undefined, "JsonHelpers.cs", 12),
      ilRow(undefined, "Startup.cs", 7),
      assemblyRow(path.join("out", "Repro.dll")),
    ],
    dosai4: [
      sourceRow,
      ilRow(path.join(tempDir, program), "Program.cs", 3),
      ilRow("/_/src/Vendor/JsonHelpers.cs", "JsonHelpers.cs", 12),
      ilRow(
        String.raw`D:\a\repo\src\Startup.cs`,
        String.raw`D:\a\repo\src\Startup.cs`,
        7,
      ),
      assemblyRow(path.join(tempDir, "out", "Repro.dll")),
    ],
  };
  try {
    for (const [version, MethodCalls] of Object.entries(reports)) {
      writeFileSync(slicesFile, JSON.stringify({ MethodCalls }));
      const [pkg] = addEvidenceForDotnet(
        [
          {
            name: "Newtonsoft.Json",
            version: "13.0.3",
            purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
            properties: [],
          },
        ],
        slicesFile,
        { srcPath: tempDir },
      );
      assert.deepStrictEqual(
        pkg.evidence.occurrences,
        [
          { location: "JsonHelpers.cs", line: 12 },
          { location: "Startup.cs", line: 7 },
          { location: program, line: 3 },
        ],
        version,
      );
      // The call without a source location still counts as a use
      const methods = pkg.properties.find(
        (property) => property.name === "internal:CalledMethods",
      );
      assert.ok(methods?.value.includes("DeserializeObject"), version);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("convertOSQueryResults() for OS package rows", () => {
  // The distro is what getDistroInfo() reads from the host's os-release; the
  // tests give it a fixed value so they hold on any operating system.
  const UBUNTU_2404 = {
    purlType: "deb",
    namespace: "ubuntu",
    distroId: "ubuntu-24.04",
    distroName: "noble",
  };
  const ALMALINUX_98 = {
    purlType: "rpm",
    namespace: "almalinux",
    distroId: "almalinux-9.8",
    distroName: "",
  };
  const DEB_PHP_ROW = {
    name: "php8.3-cli",
    version: "8.3.6-0ubuntu0.24.04.13",
    source: "php8.3",
    size: "5752",
    arch: "amd64",
    revision: "0ubuntu0.24.04.13",
    status: "install ok installed",
    maintainer: "Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>",
    section: "php",
    priority: "optional",
    admindir: "/var/lib/dpkg",
  };
  const DEB_EPOCH_ROW = {
    ...DEB_PHP_ROW,
    name: "bsdutils",
    version: "1:2.39.3-9ubuntu6.6",
    source: "util-linux (2.39.3-9ubuntu6.6)",
    revision: "9ubuntu6.6",
    section: "utils",
    priority: "required",
  };
  const RPM_EPOCH_ROW = {
    name: "openssl-libs",
    version: "3.5.8",
    release: "1.el9_8",
    source: "openssl-3.5.8-1.el9_8.src.rpm",
    size: "7490835",
    sha1: "b3b4764c426023090093576f42ca02ea4489b381",
    arch: "x86_64",
    epoch: "1",
    install_time: "1790931855",
    vendor: "AlmaLinux",
    package_group: "Unspecified",
  };
  const RPM_PLAIN_ROW = {
    ...RPM_EPOCH_ROW,
    name: "php-cli",
    version: "8.0.30",
    release: "8.el9_8.alma.1",
    source: "php-8.0.30-8.el9_8.alma.1.src.rpm",
    epoch: "",
  };
  const BREW_QUERY = {
    purlType: "brew",
    componentType: "application",
    query: "SELECT * FROM homebrew_packages;",
  };
  const BREW_FORMULA_ROW = {
    name: "php",
    path: "/opt/homebrew/Cellar/php",
    version: "8.5.11_1",
    type: "formula",
    auto_updates: "",
    app_name: "",
  };
  const BREW_CASK_ROW = {
    name: "android-commandlinetools",
    path: "/opt/homebrew/Caskroom/android-commandlinetools",
    version: "15859902",
    type: "cask",
    auto_updates: "0",
    app_name: "",
  };

  const loadConvert = async (distro) => {
    const { default: esmock } = await import("esmock");
    const { convertOSQueryResults: convert } = await esmock(
      "./evidenceUtils.js",
      {},
      { "./osinfo.js": { getDistroInfo: () => distro } },
    );
    return convert;
  };
  const propertyNames = (component) =>
    component.properties.map((property) => property.name);
  const propertyValue = (component, name) =>
    component.properties.find((property) => property.name === name)?.value;

  it("gives deb rows the purl the container scan gives them, with no subpath", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const [php, bsdutils] = convert(
      "deb_packages",
      { purlType: "deb", query: "select * from deb_packages;" },
      [DEB_PHP_ROW, DEB_EPOCH_ROW],
    );
    assert.strictEqual(
      php.purl,
      "pkg:deb/ubuntu/php8.3-cli@8.3.6-0ubuntu0.24.04.13?arch=amd64&distro=ubuntu-24.04&distro_name=noble",
    );
    assert.strictEqual(php["bom-ref"], decodeURIComponent(php.purl));
    assert.strictEqual(php.version, "8.3.6-0ubuntu0.24.04.13");
    assert.strictEqual(
      bsdutils.purl,
      "pkg:deb/ubuntu/bsdutils@1:2.39.3-9ubuntu6.6?arch=amd64&distro=ubuntu-24.04&distro_name=noble&epoch=1",
    );
    assert.strictEqual(bsdutils.version, "1:2.39.3-9ubuntu6.6");
    for (const component of [php, bsdutils]) {
      assert.ok(!component.purl.includes("#"), component.purl);
      assert.ok(!component["bom-ref"].includes("var/lib/dpkg"));
    }
  });

  it("keeps the source package of a deb as a property and drops the dpkg directory", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const [php, bsdutils] = convert(
      "deb_packages",
      { purlType: "deb", query: "select * from deb_packages;" },
      [DEB_PHP_ROW, DEB_EPOCH_ROW],
    );
    assert.strictEqual(propertyValue(php, "cdx:deb:source"), "php8.3");
    assert.strictEqual(
      propertyValue(bsdutils, "cdx:deb:source"),
      "util-linux (2.39.3-9ubuntu6.6)",
    );
    assert.strictEqual(
      propertyValue(php, "cdx:osquery:category"),
      "deb_packages",
    );
    for (const component of [php, bsdutils]) {
      const names = propertyNames(component);
      assert.ok(!names.includes("admindir"), names.join());
      assert.ok(!names.includes("source"), names.join());
      assert.ok(names.includes("arch"));
      assert.ok(names.includes("maintainer"));
    }
    assert.strictEqual(php.publisher, DEB_PHP_ROW.maintainer);
    assert.strictEqual(php.description, "php");
    assert.strictEqual(php.scope, "optional");
  });

  it("gives rpm rows the release in the version and a non-zero epoch in version and qualifier", async () => {
    const convert = await loadConvert(ALMALINUX_98);
    const [openssl, php] = convert(
      "rpm_packages",
      { purlType: "rpm", query: "select * from rpm_packages;" },
      [RPM_EPOCH_ROW, RPM_PLAIN_ROW],
    );
    assert.strictEqual(
      openssl.purl,
      "pkg:rpm/almalinux/openssl-libs@1:3.5.8-1.el9_8?arch=x86_64&distro=almalinux-9.8&epoch=1",
    );
    assert.strictEqual(openssl.version, "1:3.5.8-1.el9_8");
    assert.strictEqual(openssl["bom-ref"], decodeURIComponent(openssl.purl));
    assert.strictEqual(
      php.purl,
      "pkg:rpm/almalinux/php-cli@8.0.30-8.el9_8.alma.1?arch=x86_64&distro=almalinux-9.8",
    );
    assert.strictEqual(php.version, "8.0.30-8.el9_8.alma.1");
    for (const component of [openssl, php]) {
      assert.ok(!component.purl.includes("#"), component.purl);
      assert.ok(!component.purl.includes("src.rpm"), component.purl);
      assert.ok(!component.purl.includes("distro_name"), component.purl);
    }
  });

  it("emits no source rpm for a key record, whose rpm database says (none)", async () => {
    const convert = await loadConvert(ALMALINUX_98);
    const [key] = convert(
      "rpm_packages",
      { purlType: "rpm", query: "select * from rpm_packages;" },
      [
        {
          name: "gpg-pubkey",
          version: "b86b3716",
          release: "61e69f29",
          source: "(none)",
          epoch: "",
          package_group: "Public Keys",
        },
      ],
    );
    assert.strictEqual(
      key.purl,
      "pkg:rpm/almalinux/gpg-pubkey@b86b3716-61e69f29?distro=almalinux-9.8",
    );
    assert.ok(!propertyNames(key).includes("cdx:rpm:sourceRpm"));
    assert.ok(!propertyNames(key).includes("source"));
  });

  it("keeps the source rpm of an rpm as a property", async () => {
    const convert = await loadConvert(ALMALINUX_98);
    const [openssl] = convert(
      "rpm_packages",
      { purlType: "rpm", query: "select * from rpm_packages;" },
      [RPM_EPOCH_ROW],
    );
    assert.strictEqual(
      propertyValue(openssl, "cdx:rpm:sourceRpm"),
      "openssl-3.5.8-1.el9_8.src.rpm",
    );
    assert.ok(!propertyNames(openssl).includes("source"));
    assert.strictEqual(propertyValue(openssl, "release"), "1.el9_8");
    assert.strictEqual(propertyValue(openssl, "epoch"), "1");
    assert.strictEqual(propertyValue(openssl, "vendor"), "AlmaLinux");
  });

  it("gives Homebrew formulae and casks the brew type, told apart by a property", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const [formula, cask] = convert("homebrew_packages", BREW_QUERY, [
      BREW_FORMULA_ROW,
      BREW_CASK_ROW,
    ]);
    assert.strictEqual(formula.purl, "pkg:brew/php@8.5.11_1");
    assert.strictEqual(formula["bom-ref"], "pkg:brew/php@8.5.11_1");
    assert.strictEqual(cask.purl, "pkg:brew/android-commandlinetools@15859902");
    assert.strictEqual(formula.type, "application");
    assert.strictEqual(propertyValue(formula, "cdx:homebrew:type"), "formula");
    assert.strictEqual(propertyValue(cask, "cdx:homebrew:type"), "cask");
    for (const component of [formula, cask]) {
      assert.ok(!component.purl.startsWith("pkg:swid"), component.purl);
      assert.ok(!component.purl.includes("#"), component.purl);
      assert.ok(!component.purl.includes("?"), component.purl);
      assert.ok(!propertyNames(component).includes("type"));
      assert.strictEqual(
        propertyValue(component, "cdx:osquery:category"),
        "homebrew_packages",
      );
    }
    assert.strictEqual(
      propertyValue(formula, "path"),
      "/opt/homebrew/Cellar/php",
    );
  });

  it("encodes a versioned formula name in the purl and the bom-ref alike", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const [formula] = convert("homebrew_packages", BREW_QUERY, [
      { ...BREW_FORMULA_ROW, name: "php@8.4", version: "8.4.26_1" },
    ]);
    assert.strictEqual(formula.purl, "pkg:brew/php%408.4@8.4.26_1");
    assert.strictEqual(formula["bom-ref"], "pkg:brew/php@8.4@8.4.26_1");
    assert.strictEqual(formula.name, "php@8.4");
  });

  it("omits the purl instead of emitting a null one when the host names no vendor", async () => {
    const convert = await loadConvert({
      purlType: "rpm",
      namespace: "",
      distroId: "",
      distroName: "",
    });
    const [php] = convert(
      "deb_packages",
      { purlType: "deb", query: "select * from deb_packages;" },
      [DEB_PHP_ROW],
    );
    assert.ok(!("purl" in php));
    assert.ok(php["bom-ref"].startsWith("osquery:deb_packages:"));
    assert.strictEqual(php.version, "8.3.6-0ubuntu0.24.04.13");
  });

  it("still runs the package lister of an enhanced OS package row", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    let asked;
    const [php] = convert(
      "deb_packages",
      { purlType: "deb", query: "select * from deb_packages;" },
      [DEB_PHP_ROW],
      true,
      {
        deb: (name) => {
          asked = name;
          return ["/usr/bin/php8.3"];
        },
      },
    );
    assert.strictEqual(asked, "php8.3-cli");
    assert.strictEqual(
      propertyValue(php, "internal:PkgProvides"),
      "/usr/bin/php8.3",
    );
  });

  it("leaves the categories that are not OS packages as they were", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    // An app keeps the path of its row as the subpath of its purl.
    const [app] = convert(
      "apps",
      { purlType: "swid", componentType: "application" },
      [
        {
          name: "Safari",
          version: "17.1",
          path: "/Applications/Safari.app",
          bundle_version: "19617",
        },
      ],
    );
    assert.strictEqual(
      app.purl,
      "pkg:swid/Safari@17.1?tag_id=Safari#Applications/Safari.app",
    );
    // A bare `source` column of a pypi row is still a property of that name.
    const [pypi] = convert("python_packages", { purlType: "pypi" }, [
      {
        name: "requests",
        version: "2.31.0",
        path: "/usr/lib/python3/dist-packages/requests",
        source: "pip",
      },
    ]);
    assert.strictEqual(propertyValue(pypi, "source"), "pip");
    assert.strictEqual(
      propertyValue(pypi, "cdx:osquery:category"),
      "python_packages",
    );
  });

  it("names an npm or pypi package by what it is, and records where it is as an occurrence", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const npmPath =
      "/Users/alice/.nvm/versions/node/v20.20.2/lib/node_modules/npm/node_modules/abbrev/package.json";
    const [npm] = convert("npm_packages", { purlType: "npm" }, [
      {
        name: "abbrev",
        version: "2.0.0",
        path: npmPath,
        directory: "/Users/alice/.nvm/versions/node/v20.20.2/lib/",
      },
    ]);
    assert.strictEqual(npm.purl, "pkg:npm/abbrev@2.0.0");
    assert.strictEqual(npm["bom-ref"], "pkg:npm/abbrev@2.0.0");
    assert.deepStrictEqual(npm.evidence, {
      occurrences: [{ location: npmPath }],
    });
    // The path stays a property: trust enrichment reads it.
    assert.strictEqual(propertyValue(npm, "path"), npmPath);
    const pypiPath = "/usr/lib/python3/dist-packages/requests-2.31.0.dist-info";
    const [pypi] = convert("python_packages", { purlType: "pypi" }, [
      {
        name: "requests",
        version: "2.31.0",
        path: pypiPath,
        directory: "/usr/lib/python3/dist-packages",
      },
    ]);
    assert.strictEqual(pypi.purl, "pkg:pypi/requests@2.31.0");
    assert.strictEqual(pypi["bom-ref"], "pkg:pypi/requests@2.31.0");
    assert.deepStrictEqual(pypi.evidence, {
      occurrences: [{ location: pypiPath }],
    });
  });

  it("gives a scoped npm package its scope as the namespace", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const [sdk] = convert("npm_packages", { purlType: "npm" }, [
      {
        name: "@anthropic-ai/sdk",
        version: "0.91.1",
        path: "/opt/homebrew/lib/node_modules/@anthropic-ai/sdk/package.json",
      },
    ]);
    assert.strictEqual(sdk.group, "@anthropic-ai");
    assert.strictEqual(sdk.name, "sdk");
    assert.strictEqual(sdk.purl, "pkg:npm/%40anthropic-ai/sdk@0.91.1");
    assert.strictEqual(sdk["bom-ref"], "pkg:npm/@anthropic-ai/sdk@0.91.1");
  });

  it("lists a package found at several paths once, with each path as an occurrence", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const under = (prefix) =>
      `${prefix}/lib/node_modules/npm/node_modules/abbrev/package.json`;
    const components = convert("npm_packages", { purlType: "npm" }, [
      {
        name: "abbrev",
        version: "2.0.0",
        path: under("/home/alice/.nvm/versions/node/v24.22.1"),
      },
      { name: "abbrev", version: "1.1.1", path: under("/usr") },
      {
        name: "abbrev",
        version: "2.0.0",
        path: under("/home/alice/.nvm/versions/node/v20.20.2"),
      },
    ]);
    assert.deepStrictEqual(
      components.map((component) => component["bom-ref"]),
      ["pkg:npm/abbrev@2.0.0", "pkg:npm/abbrev@1.1.1"],
    );
    assert.deepStrictEqual(components[0].evidence.occurrences, [
      { location: under("/home/alice/.nvm/versions/node/v20.20.2") },
      { location: under("/home/alice/.nvm/versions/node/v24.22.1") },
    ]);
    assert.deepStrictEqual(
      components[0].properties
        .filter((property) => property.name === "path")
        .map((property) => property.value)
        .sort(),
      [
        under("/home/alice/.nvm/versions/node/v20.20.2"),
        under("/home/alice/.nvm/versions/node/v24.22.1"),
      ],
    );
    assert.strictEqual(
      components[0].properties.filter(
        (property) => property.name === "cdx:osquery:category",
      ).length,
      1,
    );
  });
});

describe("convertOSQueryResults() for the osquery 5.24.0 tables", () => {
  const ARCH = {
    purlType: "alpm",
    namespace: "arch",
    distroId: "arch-20261018.0.612668",
    distroName: "",
  };
  const UBUNTU_2404 = {
    purlType: "deb",
    namespace: "ubuntu",
    distroId: "ubuntu-24.04",
    distroName: "noble",
  };
  // Rows as osquery 5.24.0 returns them in archlinux:latest.
  const PACMAN_ZLIB = {
    arch: "x86_64",
    build_time: "1791808009",
    dbpath: "/var/lib/pacman",
    description:
      "Compression library implementing the deflate compression method found in gzip and PKZIP",
    groups: "",
    install_reason: "dependency",
    install_time: "1792281600",
    licenses: "Zlib",
    name: "zlib",
    packager: "David Runge <dvzrv@archlinux.org>",
    size: "232676",
    source: "zlib",
    url: "https://www.zlib.net/",
    validation: "pgp",
    version: "1:1.3.2-4",
  };
  const PACMAN_GLIBC = {
    ...PACMAN_ZLIB,
    description: "GNU C Library",
    licenses: "GPL-2.0-or-later,LGPL-2.1-or-later",
    name: "glibc",
    packager: "Frederik Schwan <freswa@archlinux.org>",
    source: "glibc",
    url: "https://www.gnu.org/software/libc",
    version: "2.44+r50+g1848099f063e-1",
  };
  // Rows as osquery 5.24.0 returns them from the fixture trees of an
  // ubuntu:24.04 container; snapd cannot run there.
  const SNAP_HELLO = {
    architectures: "arm64",
    base: "core22",
    channel: "",
    confinement: "strict",
    description: "GNU hello prints a friendly greeting.",
    grade: "stable",
    license: "GPL-3.0",
    name: "hello",
    revision: "42",
    snap_id: "",
    summary: 'GNU Hello, the "hello world" snap',
    type: "app",
    version: "2.10",
  };
  // The row the flatpak_packages query selects: the application ID as `name`,
  // the AppStream name as `display_name`.
  const FLATPAK_CALCULATOR = {
    arch: "aarch64",
    branch: "stable",
    commit_hash:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    description: "",
    developer_name: "The GNOME Project",
    display_name: "Calculator",
    homepage: "https://apps.gnome.org/Calculator/",
    installation: "system",
    license: "GPL-3.0-or-later",
    name: "org.gnome.Calculator",
    origin: "flathub",
    runtime: "org.gnome.Platform/aarch64/48",
    summary: "Perform arithmetic, scientific or financial calculations",
    type: "app",
    version: "48.1",
  };
  const PACMAN_QUERY = {
    purlType: "alpm",
    query: "select * from pacman_packages;",
  };
  const SNAP_QUERY = { purlType: "snap", componentType: "application" };
  const FLATPAK_QUERY = { purlType: "flatpak", componentType: "application" };

  const loadConvert = async (distro, hostPlatform) => {
    const { default: esmock } = await import("esmock");
    const { convertOSQueryResults: convert } = await esmock(
      "./evidenceUtils.js",
      hostPlatform ? { "node:os": { platform: () => hostPlatform } } : {},
      { "./osinfo.js": { getDistroInfo: () => distro } },
    );
    return convert;
  };
  const propertyNames = (component) =>
    component.properties.map((property) => property.name);
  const propertyValue = (component, name) =>
    component.properties.find((property) => property.name === name)?.value;

  it("names pacman rows as the alpm type does, with the licences and home page of the package", async () => {
    const convert = await loadConvert(ARCH);
    const [zlib, glibc] = convert("pacman_packages", PACMAN_QUERY, [
      PACMAN_ZLIB,
      PACMAN_GLIBC,
    ]);
    assert.strictEqual(zlib.purl, "pkg:alpm/arch/zlib@1:1.3.2-4?arch=x86_64");
    assert.strictEqual(
      zlib["bom-ref"],
      "pkg:alpm/arch/zlib@1:1.3.2-4?arch=x86_64",
    );
    assert.strictEqual(zlib.version, "1:1.3.2-4");
    assert.strictEqual(zlib.publisher, "David Runge <dvzrv@archlinux.org>");
    assert.deepStrictEqual(zlib.licenses, [{ license: { id: "Zlib" } }]);
    assert.deepStrictEqual(zlib.externalReferences, [
      { type: "website", url: "https://www.zlib.net/" },
    ]);
    assert.strictEqual(
      glibc.purl,
      "pkg:alpm/arch/glibc@2.44%2Br50%2Bg1848099f063e-1?arch=x86_64",
    );
    assert.deepStrictEqual(glibc.licenses, [
      { license: { id: "GPL-2.0-or-later" } },
      { license: { id: "LGPL-2.1-or-later" } },
    ]);
    assert.strictEqual(propertyValue(glibc, "cdx:alpm:pkgbase"), "glibc");
    assert.strictEqual(propertyValue(glibc, "install_reason"), "dependency");
    for (const component of [zlib, glibc]) {
      const names = propertyNames(component);
      for (const dropped of ["dbpath", "licenses", "url", "source"]) {
        assert.ok(!names.includes(dropped), `${dropped}: ${names.join()}`);
      }
      assert.ok(!component.purl.includes("#"), component.purl);
    }
  });

  it("joins a pacman licence list that holds an expression into one expression", async () => {
    const convert = await loadConvert(ARCH);
    const [headers, custom] = convert("pacman_packages", PACMAN_QUERY, [
      {
        ...PACMAN_ZLIB,
        name: "linux-api-headers",
        licenses: "GPL-2.0-only WITH Linux-syscall-note,MIT",
        url: "ftp://ftp.kernel.org/pub/linux",
      },
      {
        ...PACMAN_ZLIB,
        name: "ca-certificates-utils",
        licenses: "custom:none",
      },
    ]);
    assert.deepStrictEqual(headers.licenses, [
      { expression: "(GPL-2.0-only WITH Linux-syscall-note) AND MIT" },
    ]);
    assert.ok(!("externalReferences" in headers));
    assert.deepStrictEqual(custom.licenses, [
      { license: { name: "custom:none" } },
    ]);
  });

  it("matches a package to GTFOBins by its name, never by the words of its description", async () => {
    const convert = await loadConvert(ARCH, "linux");
    const [zlib, tar] = convert("pacman_packages", PACMAN_QUERY, [
      PACMAN_ZLIB,
      {
        ...PACMAN_ZLIB,
        name: "tar",
        description: "Utility used to store, backup, and transport files",
        source: "tar",
        version: "1.35-2",
      },
    ]);
    assert.ok(
      !propertyNames(zlib).includes("cdx:gtfobins:matched"),
      "gzip in the description of zlib is not a use of gzip",
    );
    assert.strictEqual(propertyValue(tar, "cdx:gtfobins:matched"), "true");
    assert.strictEqual(propertyValue(tar, "cdx:gtfobins:matchFields"), "name");
  });

  it("names snaps by name and version, with the snap columns under cdx:snap", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const [hello] = convert("snap_packages", SNAP_QUERY, [SNAP_HELLO]);
    assert.strictEqual(hello.purl, "pkg:snap/hello@2.10");
    assert.strictEqual(hello.type, "application");
    assert.strictEqual(hello.description, SNAP_HELLO.description);
    assert.deepStrictEqual(hello.licenses, [{ license: { id: "GPL-3.0" } }]);
    assert.strictEqual(propertyValue(hello, "cdx:snap:type"), "app");
    assert.strictEqual(propertyValue(hello, "cdx:snap:revision"), "42");
    assert.strictEqual(propertyValue(hello, "cdx:snap:confinement"), "strict");
    assert.strictEqual(propertyValue(hello, "base"), "core22");
    const names = propertyNames(hello);
    for (const renamed of ["type", "revision", "confinement", "license"]) {
      assert.ok(!names.includes(renamed), `${renamed}: ${names.join()}`);
    }
    // An empty column, here the channel without state.json, is left out.
    assert.ok(!names.includes("cdx:snap:channel"));
  });

  it("names a flatpak by its application ID and keeps its display name", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const [calculator, platform] = convert("flatpak_packages", FLATPAK_QUERY, [
      FLATPAK_CALCULATOR,
      {
        ...FLATPAK_CALCULATOR,
        name: "org.gnome.Platform",
        display_name: "",
        version: "",
        branch: "48",
        type: "runtime",
        runtime: "",
        homepage: "",
        license: "",
      },
    ]);
    assert.strictEqual(
      calculator.purl,
      "pkg:flatpak/org.gnome.Calculator@48.1?arch=aarch64&branch=stable",
    );
    assert.strictEqual(calculator.name, "org.gnome.Calculator");
    assert.strictEqual(calculator.publisher, "The GNOME Project");
    assert.strictEqual(calculator.description, FLATPAK_CALCULATOR.summary);
    assert.deepStrictEqual(calculator.licenses, [
      { license: { id: "GPL-3.0-or-later" } },
    ]);
    assert.deepStrictEqual(calculator.externalReferences, [
      { type: "website", url: "https://apps.gnome.org/Calculator/" },
    ]);
    for (const [name, value] of [
      ["cdx:flatpak:displayName", "Calculator"],
      ["cdx:flatpak:commit", FLATPAK_CALCULATOR.commit_hash],
      ["cdx:flatpak:origin", "flathub"],
      ["cdx:flatpak:installation", "system"],
      ["cdx:flatpak:type", "app"],
      ["cdx:flatpak:runtime", "org.gnome.Platform/aarch64/48"],
    ]) {
      assert.strictEqual(propertyValue(calculator, name), value, name);
    }
    assert.strictEqual(
      platform.purl,
      "pkg:flatpak/org.gnome.Platform?arch=aarch64&branch=48",
    );
    assert.strictEqual(propertyValue(platform, "cdx:flatpak:type"), "runtime");
  });

  it("lists every Cellar version of a Linuxbrew formula", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const components = convert(
      "homebrew_packages",
      { purlType: "brew", componentType: "application" },
      [
        {
          app_name: "",
          auto_updates: "",
          name: "jq",
          path: "/home/linuxbrew/.linuxbrew/Cellar/jq",
          type: "formula",
          version: "1.7.1_1",
        },
        {
          app_name: "",
          auto_updates: "",
          name: "jq",
          path: "/home/linuxbrew/.linuxbrew/Cellar/jq",
          type: "formula",
          version: "1.8.1",
        },
      ],
    );
    assert.deepStrictEqual(
      components.map((component) => component.purl),
      ["pkg:brew/jq@1.7.1_1", "pkg:brew/jq@1.8.1"],
    );
  });

  it("names a MacPorts port as port installed does", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const [openssl, gtk] = convert(
      "macports_packages",
      { purlType: "macports", componentType: "application" },
      [
        {
          name: "openssl3",
          version: "3.6.0",
          revision: "0",
          variants: "",
          requested: "0",
          arch: "arm64",
          date: "1792281600",
        },
        {
          name: "gtk3",
          version: "3.24.43",
          revision: "2",
          variants: "+quartz+universal",
          requested: "1",
          arch: "arm64 x86_64",
          date: "1792281600",
        },
      ],
    );
    assert.strictEqual(openssl.purl, "pkg:macports/openssl3@3.6.0_0");
    assert.strictEqual(openssl.version, "3.6.0_0");
    assert.strictEqual(propertyValue(openssl, "cdx:macports:requested"), "0");
    assert.strictEqual(gtk.purl, "pkg:macports/gtk3@3.24.43_2");
    assert.strictEqual(
      propertyValue(gtk, "cdx:macports:variants"),
      "+quartz+universal",
    );
    assert.ok(!propertyNames(gtk).includes("variants"));
  });

  it("keeps the real .appex path of a Safari extension as its subpath", async () => {
    const convert = await loadConvert(UBUNTU_2404);
    const [bitwarden] = convert(
      "safari_extensions",
      { purlType: "swid", componentType: "application" },
      [
        {
          identifier: "com.bitwarden.desktop.safari",
          name: "Bitwarden",
          path: "/Applications/Bitwarden.app/Contents/PlugIns/safari.appex",
          version: "2026.9.0",
        },
      ],
    );
    assert.strictEqual(
      bitwarden.purl,
      "pkg:swid/Bitwarden@2026.9.0?tag_id=Bitwarden#Applications/Bitwarden.app/Contents/PlugIns/safari.appex",
    );
  });
});

describe("convertOSQueryResults() for ai_agent_skills", () => {
  const SHA_A =
    "8ff20e7702d9b5655f68159741dc404b919417ddabd08c2aac620171480993c6";
  const SHA_B =
    "5fd97a9719ad48e8730b5e5ca6c38839d660f7399581ade33c1b761ab24003ce";
  const SKILLS_QUERY = { purlType: "generic", componentType: "file" };
  // A row as the ai_agent_skills query returns it in an ubuntu:24.04 container.
  const USER_SKILL = {
    agent: "claude",
    allowed_tools: "Read, Bash(python3 *)",
    compatibility: "",
    description: "Fill and merge PDF forms.",
    directory: "/root/.claude/skills/pdf-tools",
    license: "Apache-2.0",
    name: "pdf-tools",
    path: "/root/.claude/skills/pdf-tools/SKILL.md",
    resource_count: "1",
    scope: "user",
    script_count: "1",
    sha256: SHA_A,
    uid: "0",
    username: "root",
    version: "1.2.0",
  };
  const propertyValue = (component, name) =>
    component.properties.find((property) => property.name === name)?.value;

  it("describes a skill as the ai-skill project scan does, with no purl and its hash", () => {
    const [skill] = convertOSQueryResults("ai_agent_skills", SKILLS_QUERY, [
      USER_SKILL,
    ]);
    assert.strictEqual(skill.type, "file");
    assert.strictEqual(skill.name, "pdf-tools");
    assert.strictEqual(skill.version, "1.2.0");
    assert.ok(!("purl" in skill));
    assert.strictEqual(
      skill["bom-ref"],
      `osquery:ai_agent_skills:file:pdf-tools@1.2.0[sha256=${SHA_A}]`,
    );
    assert.deepStrictEqual(skill.hashes, [{ alg: "SHA-256", content: SHA_A }]);
    assert.deepStrictEqual(skill.licenses, [{ license: { id: "Apache-2.0" } }]);
    assert.deepStrictEqual(skill.evidence, {
      occurrences: [{ location: USER_SKILL.path }],
    });
    for (const [name, value] of [
      ["cdx:osquery:category", "ai_agent_skills"],
      ["cdx:file:kind", "skill-file"],
      ["cdx:agent:inventorySource", "osquery"],
      ["cdx:skill:name", "pdf-tools"],
      ["cdx:skill:description", "Fill and merge PDF forms."],
      ["cdx:skill:license", "Apache-2.0"],
      ["cdx:skill:agent", "claude"],
      ["cdx:skill:scope", "user"],
      ["cdx:skill:allowedTools", "Read, Bash(python3 *)"],
      ["cdx:skill:resourceCount", "1"],
      ["cdx:skill:scriptCount", "1"],
      ["cdx:skill:hasScripts", "true"],
      ["cdx:skill:specValid", "true"],
      ["username", "root"],
    ]) {
      assert.strictEqual(propertyValue(skill, name), value, name);
    }
    assert.ok(!propertyValue(skill, "cdx:skill:compatibility"));
  });

  it("lists the same skill found under several roots once, with an occurrence for each", () => {
    const marketplace =
      "/home/alice/.claude/plugins/marketplaces/acme/skills/pdf-tools/SKILL.md";
    const cache =
      "/home/alice/.claude/plugins/cache/acme/1.0.0/skills/pdf-tools/SKILL.md";
    const components = convertOSQueryResults("ai_agent_skills", SKILLS_QUERY, [
      {
        ...USER_SKILL,
        scope: "plugin",
        path: marketplace,
        directory: dirname(marketplace),
      },
      {
        ...USER_SKILL,
        scope: "plugin",
        path: cache,
        directory: dirname(cache),
      },
      {
        ...USER_SKILL,
        sha256: SHA_B,
        path: "/root/.agents/skills/pdf-tools/SKILL.md",
      },
    ]);
    assert.strictEqual(components.length, 2);
    assert.deepStrictEqual(components[0].evidence.occurrences, [
      { location: cache },
      { location: marketplace },
    ]);
    for (const component of components) {
      assert.ok(!component["bom-ref"].includes("/home/"), component["bom-ref"]);
      assert.ok(!component["bom-ref"].includes("/root/"), component["bom-ref"]);
    }
  });

  it("names a skill whose frontmatter osquery could not read after its directory", () => {
    const [skill] = convertOSQueryResults("ai_agent_skills", SKILLS_QUERY, [
      {
        ...USER_SKILL,
        name: "",
        description: "",
        license: "Complete terms in LICENSE.txt",
        version: "",
        directory: "/Users/alice/.agents/skills/poet",
        path: "/Users/alice/.agents/skills/poet/SKILL.md",
        script_count: "0",
      },
    ]);
    assert.strictEqual(skill.name, "poet");
    assert.strictEqual(
      skill["bom-ref"],
      `osquery:ai_agent_skills:file:poet@unknown[sha256=${SHA_A}]`,
    );
    // A licence that is not an SPDX id stays a property only.
    assert.ok(!("licenses" in skill));
    assert.strictEqual(
      propertyValue(skill, "cdx:skill:license"),
      "Complete terms in LICENSE.txt",
    );
    assert.strictEqual(propertyValue(skill, "cdx:skill:specValid"), "false");
    assert.ok(!propertyValue(skill, "cdx:skill:hasScripts"));
    assert.ok(!propertyValue(skill, "cdx:skill:name"));
  });

  it("keeps a system-wide skill, which has no owning user", () => {
    const [skill] = convertOSQueryResults("ai_agent_skills", SKILLS_QUERY, [
      {
        agent: "codex",
        allowed_tools: "",
        compatibility: "",
        description: "Org policy",
        directory: "/etc/codex/skills/org-policy",
        license: "",
        name: "org-policy",
        path: "/etc/codex/skills/org-policy/SKILL.md",
        resource_count: "0",
        scope: "system",
        script_count: "0",
        sha256: SHA_B,
        uid: "",
        username: "",
        version: "",
      },
    ]);
    assert.strictEqual(propertyValue(skill, "cdx:skill:scope"), "system");
    assert.strictEqual(propertyValue(skill, "cdx:skill:agent"), "codex");
    assert.ok(!propertyValue(skill, "username"));
  });

  it("falls back to the agent and scope when osquery could not hash the SKILL.md", () => {
    const [skill] = convertOSQueryResults("ai_agent_skills", SKILLS_QUERY, [
      { ...USER_SKILL, sha256: "" },
    ]);
    assert.strictEqual(
      skill["bom-ref"],
      "osquery:ai_agent_skills:file:pdf-tools@1.2.0[scope=claude/user]",
    );
    assert.ok(!("hashes" in skill));
  });
});

describe("convertOSQueryResults() for gpu_info, chrome_search_engines and BitLocker", () => {
  const propertyValue = (component, name) =>
    component.properties.find((property) => property.name === name)?.value;

  it("lists a GPU as a device with its driver version, keyed on its device id", () => {
    const GPU_QUERY = { purlType: "swid", componentType: "device" };
    // The Apple Silicon row, with the version and publisher the query aliases.
    const [apple] = convertOSQueryResults("gpu_info", GPU_QUERY, [
      {
        cores: "20",
        device_id: "GPUintegrated",
        driver: "AGXAcceleratorG16X",
        driver_version: "",
        metal_support: "metal4",
        model: "Apple M4 Pro",
        model_id: "gpu,t6040",
        name: "Apple M4 Pro",
        pci_class_id: "",
        pci_slot: "",
        publisher: "Apple",
        vendor: "Apple",
        vendor_id: "0x106b",
        version: "",
        vram: "",
      },
    ]);
    assert.strictEqual(apple.type, "device");
    assert.ok(!("purl" in apple));
    assert.strictEqual(apple.publisher, "Apple");
    assert.strictEqual(apple.version, "");
    assert.strictEqual(
      apple["bom-ref"],
      "osquery:gpu_info:device:Apple+M4+Pro@unknown[device_id=GPUintegrated]",
    );
    const [nvidia, second] = convertOSQueryResults("gpu_info", GPU_QUERY, [
      {
        device_id: "GPU0000:01:00.0",
        driver: "nvidia",
        driver_version: "580.95.05",
        name: "NVIDIA L4",
        pci_slot: "0000:01:00.0",
        publisher: "NVIDIA Corporation",
        vendor: "NVIDIA Corporation",
        version: "580.95.05",
        vram: "24152899584",
      },
      {
        device_id: "GPU0000:02:00.0",
        driver: "nvidia",
        driver_version: "580.95.05",
        name: "NVIDIA L4",
        pci_slot: "0000:02:00.0",
        publisher: "NVIDIA Corporation",
        vendor: "NVIDIA Corporation",
        version: "580.95.05",
      },
    ]);
    assert.strictEqual(nvidia.version, "580.95.05");
    assert.strictEqual(propertyValue(nvidia, "driver"), "nvidia");
    // Two cards of one model are two devices.
    assert.notStrictEqual(nvidia["bom-ref"], second["bom-ref"]);
  });

  it("gives every browser profile's default search engine its own bom-ref, without a home path", () => {
    const rows = ["Default", "Profile 1"].map((profile) => ({
      browser_type: "chrome",
      keyword: "google.com",
      label: `chrome/501/${profile}`,
      name: "Google",
      profile,
      profile_path: `/Users/alice/Library/Application Support/Google/Chrome/${profile}`,
      uid: "501",
      url: "{google:baseURL}search?q={searchTerms}",
    }));
    const [first, second] = convertOSQueryResults(
      "chrome_search_engines",
      { purlType: "swid", componentType: "data" },
      rows,
    );
    assert.notStrictEqual(first["bom-ref"], second["bom-ref"]);
    for (const component of [first, second]) {
      assert.ok(!("purl" in component));
      assert.ok(
        !component["bom-ref"].includes("/Users/"),
        component["bom-ref"],
      );
    }
    assert.strictEqual(
      first["bom-ref"],
      "osquery:chrome_search_engines:data:Google@unknown[label=chrome/501/Default]",
    );
  });

  it("keeps the BitLocker protector types", () => {
    const [drive] = convertOSQueryResults(
      "windows_bitlocker_info",
      { purlType: "swid", componentType: "data" },
      [
        {
          name: "\\\\?\\Volume{0c5bdfdd-4c8e-4b6a-9d5a-2d6d9e2e0b1a}\\",
          version: "C:",
          description: "XTS_AES_128",
          protection_status: "1",
          protector_types: "TPM,NUMERIC_PASSWORD",
        },
      ],
    );
    assert.strictEqual(
      propertyValue(drive, "protector_types"),
      "TPM,NUMERIC_PASSWORD",
    );
  });
});

describe("convertOSQueryResults() for firefox_addons", () => {
  const FIREFOX_QUERY = { purlType: "swid", componentType: "application" };
  // Rows as osquery 5.24.0 gives them for add-ons side-loaded into a Firefox
  // 158 profile; a source_url, creator or path that is JSON null reads "null".
  const UBLOCK_ROW = {
    active: "1",
    autoupdate: "1",
    creator: "Raymond Hill & contributors",
    description: "Finally, an efficient blocker. Easy on CPU and memory.",
    disabled: "0",
    identifier: "uBlock0@raymondhill.net",
    location: "app-profile",
    name: "uBlock Origin",
    source_url: "null",
    type: "extension",
    uid: "1001",
    version: "1.75.0",
    visible: "1",
  };
  const xpiIn = (profile, id = UBLOCK_ROW.identifier) =>
    `${profile}/extensions/${id}.xpi`;
  const ALICE = "/home/alice/.config/mozilla/firefox/i12ra927.default-release";
  const ALICE_WORK = "/home/alice/.config/mozilla/firefox/x7y8z9w0.work";
  const BOB = "/home/bob/.mozilla/firefox/k3j2h1g0.default-release";
  const values = (component, name) =>
    component.properties
      .filter((property) => property.name === name)
      .map((property) => property.value)
      .sort();

  it("names an add-on by its ID, with each profile it is installed in as an occurrence", () => {
    const components = convertOSQueryResults("firefox_addons", FIREFOX_QUERY, [
      { ...UBLOCK_ROW, path: xpiIn(ALICE) },
      {
        ...UBLOCK_ROW,
        uid: "1002",
        active: "0",
        disabled: "1",
        path: xpiIn(BOB),
      },
      { ...UBLOCK_ROW, version: "1.74.0", path: xpiIn(ALICE_WORK) },
    ]);
    assert.deepStrictEqual(
      components.map((component) => component.purl),
      [
        "pkg:swid/uBlock%2BOrigin@1.75.0?tag_id=uBlock0%40raymondhill.net",
        "pkg:swid/uBlock%2BOrigin@1.74.0?tag_id=uBlock0%40raymondhill.net",
      ],
    );
    const [current, older] = components;
    assert.strictEqual(
      current["bom-ref"],
      "pkg:swid/uBlock+Origin@1.75.0?tag_id=uBlock0@raymondhill.net",
    );
    assert.deepStrictEqual(current.evidence.occurrences, [
      { location: xpiIn(ALICE) },
      { location: xpiIn(BOB) },
    ]);
    assert.deepStrictEqual(older.evidence.occurrences, [
      { location: xpiIn(ALICE_WORK) },
    ]);
    // What differs from one profile to another is kept, once for each value.
    assert.deepStrictEqual(values(current, "path"), [xpiIn(ALICE), xpiIn(BOB)]);
    assert.deepStrictEqual(values(current, "active"), ["0", "1"]);
    assert.deepStrictEqual(values(current, "uid"), ["1001", "1002"]);
    assert.deepStrictEqual(values(current, "cdx:osquery:category"), [
      "firefox_addons",
    ]);
    for (const component of components) {
      assert.ok(!component.purl.includes("home"), component.purl);
      assert.ok(!component["bom-ref"].includes("home"), component["bom-ref"]);
    }
  });

  it("keeps add-ons that share a name apart, and gives a GUID ID as a lower-case tag_id", () => {
    const components = convertOSQueryResults("firefox_addons", FIREFOX_QUERY, [
      {
        ...UBLOCK_ROW,
        name: "Dark Mode",
        identifier: "{3B6F2A41-9C0D-4E8F-A1B2-C3D4E5F60718}",
        version: "0.5.2",
        path: xpiIn(ALICE, "{3B6F2A41-9C0D-4E8F-A1B2-C3D4E5F60718}"),
      },
      {
        ...UBLOCK_ROW,
        name: "Dark Mode",
        identifier: "dark-mode@example.org",
        version: "0.5.2",
        path: xpiIn(ALICE, "dark-mode@example.org"),
      },
    ]);
    assert.deepStrictEqual(
      components.map((component) => component.purl),
      [
        "pkg:swid/Dark%2BMode@0.5.2?tag_id=3b6f2a41-9c0d-4e8f-a1b2-c3d4e5f60718",
        "pkg:swid/Dark%2BMode@0.5.2?tag_id=dark-mode%40example.org",
      ],
    );
    // The ID as Firefox gives it stays a property.
    assert.deepStrictEqual(values(components[0], "identifier"), [
      "{3B6F2A41-9C0D-4E8F-A1B2-C3D4E5F60718}",
    ]);
  });

  it("lists a built-in add-on, which has no path, without an occurrence", () => {
    const [autofill, theme] = convertOSQueryResults(
      "firefox_addons",
      FIREFOX_QUERY,
      [
        {
          ...UBLOCK_ROW,
          creator: "null",
          description: "",
          identifier: "formautofill@mozilla.org",
          location: "app-builtin-addons",
          name: "Form Autofill",
          path: "",
          version: "1.0.1",
        },
        {
          ...UBLOCK_ROW,
          creator: "Mozilla",
          description:
            "Follow the operating system setting for buttons, menus, and windows.",
          identifier: "default-theme@mozilla.org",
          location: "app-builtin",
          name: "System theme — auto",
          path: "null",
          type: "theme",
          version: "1.4.2",
        },
      ],
    );
    assert.strictEqual(
      autofill.purl,
      "pkg:swid/Form%2BAutofill@1.0.1?tag_id=formautofill%40mozilla.org",
    );
    assert.strictEqual(
      theme.purl,
      "pkg:swid/System%2Btheme%2B%E2%80%94%2Bauto@1.4.2?tag_id=default-theme%40mozilla.org",
    );
    assert.strictEqual(autofill.evidence, undefined);
    assert.strictEqual(theme.evidence, undefined);
    assert.deepStrictEqual(values(theme, "path"), []);
  });
});

describe("convertOSQueryResults() for chrome_extensions and vscode_extensions", () => {
  const CHROME_QUERY = {
    purlType: "chrome-extension",
    componentType: "application",
  };
  const VSCODE_QUERY = {
    purlType: "vscode-extension",
    componentType: "application",
  };
  const values = (component, name) =>
    component.properties
      .filter((property) => property.name === name)
      .map((property) => property.value)
      .sort();
  const locations = (component) =>
    component.evidence.occurrences.map((occurrence) => occurrence.location);
  const assertNoHomePath = (components) => {
    for (const component of components) {
      const identity = `${component.purl} ${component["bom-ref"]}`;
      assert.ok(!/Users\/|home\//.test(identity), identity);
    }
  };

  // A row as osquery 5.24.0 gives it on macOS for an extension Chrome installs
  // in every profile.
  const PAYMENTS_ROW = {
    author: "",
    browser_type: "chrome",
    current_locale: "",
    default_locale: "en",
    description: "Chrome Web Store Payments",
    from_webstore: "true",
    identifier: "nmmhkkegccagdldgiimedpiccmgmieda",
    install_time: "",
    install_timestamp: "0",
    manifest_hash:
      "5dbdf0ed368be287abaff83d639b760fa5d7dc8a28e92387773b4fd3e1ba4f19",
    name: "Chrome Web Store Payments",
    optional_permissions: "",
    persistent: "0",
    referenced: "1",
    referenced_identifier: "nmmhkkegccagdldgiimedpiccmgmieda",
    state: "",
    uid: "501",
    update_url: "https://clients2.google.com/service/update2/crx",
    version: "1.0.0.6",
  };
  const CHROME = "/Users/alice/Library/Application Support/Google/Chrome";
  const inProfile = (row, profileDir, profile) => ({
    ...row,
    profile,
    profile_path: `${CHROME}/${profileDir}`,
    path: `${CHROME}/${profileDir}/Extensions/${row.identifier}/${row.version}_0`,
  });

  it("names a Chromium extension by its ID, with each profile it is installed in as an occurrence", () => {
    const docs = {
      ...PAYMENTS_ROW,
      description:
        "Edit, create, and view your documents, spreadsheets, and presentations — all without internet access.",
      identifier: "ghbmnnjooekpmoecnnnilnnbdlolhkhi",
      name: "Google Docs Offline",
      referenced_identifier: "ghbmnnjooekpmoecnnnilnnbdlolhkhi",
      version: "1.111.1",
    };
    const components = convertOSQueryResults(
      "chrome_extensions",
      CHROME_QUERY,
      [
        inProfile(PAYMENTS_ROW, "Default", "Your Chrome"),
        inProfile(PAYMENTS_ROW, "Profile 1", "Work"),
        inProfile(docs, "Default", "Your Chrome"),
      ],
    );
    assert.deepStrictEqual(
      components.map((component) => component.purl),
      [
        "pkg:chrome-extension/nmmhkkegccagdldgiimedpiccmgmieda@1.0.0.6",
        "pkg:chrome-extension/ghbmnnjooekpmoecnnnilnnbdlolhkhi@1.111.1",
      ],
    );
    const [payments] = components;
    // The name, purl and bom-ref -t chrome-extension gives the extension.
    const scanned = chromeExtensionComponent({
      extensionId: "nmmhkkegccagdldgiimedpiccmgmieda",
      version: "1.0.0.6",
    });
    assert.strictEqual(payments.name, scanned.name);
    assert.strictEqual(payments.purl, scanned.purl);
    assert.strictEqual(payments["bom-ref"], scanned["bom-ref"]);
    const paths = [
      `${CHROME}/Default/Extensions/nmmhkkegccagdldgiimedpiccmgmieda/1.0.0.6_0`,
      `${CHROME}/Profile 1/Extensions/nmmhkkegccagdldgiimedpiccmgmieda/1.0.0.6_0`,
    ];
    assert.deepStrictEqual(locations(payments), paths);
    assert.deepStrictEqual(values(payments, "path"), paths);
    assert.deepStrictEqual(values(payments, "profile"), [
      "Work",
      "Your Chrome",
    ]);
    assert.deepStrictEqual(values(payments, "name"), [
      "Chrome Web Store Payments",
    ]);
    assertNoHomePath(components);
  });

  it("takes the ID the profile gives when osquery computes none, and keeps the path out of a bom-ref without a purl", () => {
    const [unpacked, unreadable] = convertOSQueryResults(
      "chrome_extensions",
      CHROME_QUERY,
      [
        {
          ...inProfile(PAYMENTS_ROW, "Default", "Your Chrome"),
          from_webstore: "false",
          identifier: "",
          name: "Tab Notes",
          path: "/Users/alice/src/tab-notes",
          referenced_identifier: "kfhgpbcnmjlhgpefoeidnkpadkblcdmo",
          version: "0.3",
        },
        {
          ...inProfile(PAYMENTS_ROW, "Default", "Your Chrome"),
          identifier: "",
          name: "Broken",
          path: "/Users/alice/src/broken",
          referenced_identifier: "",
          version: "0.1",
        },
      ],
    );
    assert.strictEqual(
      unpacked.purl,
      "pkg:chrome-extension/kfhgpbcnmjlhgpefoeidnkpadkblcdmo@0.3",
    );
    // A display name is no extension ID, so this one has no purl.
    assert.strictEqual(unreadable.purl, undefined);
    assert.strictEqual(
      unreadable["bom-ref"],
      "osquery:chrome_extensions:application:broken@0.1[uid=501]",
    );
    assert.deepStrictEqual(locations(unreadable), ["/Users/alice/src/broken"]);
  });

  // Rows as osquery 5.24.0 gives them for extensions code-server installed
  // from Open VSX, into its own folder and into the one VSCodium uses.
  const YAML_ROW = {
    installed_at: "1792752077131",
    name: "redhat.vscode-yaml",
    prerelease: "0",
    publisher: "Red Hat",
    publisher_id: "1deab481-4801-4170-8a64-801999f5ee73",
    uuid: "2061917f-f76a-458a-8da9-f162de22b97e",
    version: "2.0.0",
  };
  const RUST_ANALYZER_ROW = {
    installed_at: "1792752074894",
    name: "rust-lang.rust-analyzer",
    prerelease: "0",
    publisher: "rust-lang",
    publisher_id: "cb14a7a7-a188-40bd-a953-e0a20757c5dd",
    uuid: "06574cb4-e5dc-4631-8174-a543a4533621",
    version: "0.3.3089",
  };
  const installed = (row, uid, home, folder, edition, platform) => ({
    ...row,
    uid,
    vscode_edition: edition,
    path: `${home}/${folder}/extensions/${row.name}-${row.version}-${platform}`,
  });
  const CODE_SERVER = ".local/share/code-server";

  it("names a VS Code extension by its publisher and name, as -t vscode-extension does, with each install as an occurrence", () => {
    const yamlPaths = [
      `/home/alice/${CODE_SERVER}/extensions/redhat.vscode-yaml-2.0.0-universal`,
      "/home/alice/.vscode-oss/extensions/redhat.vscode-yaml-2.0.0-universal",
      `/home/bob/${CODE_SERVER}/extensions/redhat.vscode-yaml-2.0.0-universal`,
    ];
    const components = convertOSQueryResults(
      "vscode_extensions",
      VSCODE_QUERY,
      [
        installed(
          YAML_ROW,
          "1001",
          "/home/alice",
          CODE_SERVER,
          "code_server",
          "universal",
        ),
        installed(
          RUST_ANALYZER_ROW,
          "1001",
          "/home/alice",
          CODE_SERVER,
          "code_server",
          "linux-arm64",
        ),
        installed(
          YAML_ROW,
          "1001",
          "/home/alice",
          ".vscode-oss",
          "vscodium",
          "universal",
        ),
        installed(
          YAML_ROW,
          "1002",
          "/home/bob",
          CODE_SERVER,
          "code_server",
          "universal",
        ),
      ],
    );
    assert.deepStrictEqual(
      components.map((component) => component.purl),
      [
        "pkg:vscode-extension/redhat/vscode-yaml@2.0.0",
        "pkg:vscode-extension/rust-lang/rust-analyzer@0.3.3089",
      ],
    );
    const [yaml] = components;
    // The purl and bom-ref -t vscode-extension gives the extension, from the
    // publisher and name of its package.json.
    const scanned = vscodeExtensionComponent({
      publisher: "redhat",
      name: "vscode-yaml",
      version: "2.0.0",
    });
    assert.strictEqual(yaml.purl, scanned.purl);
    assert.strictEqual(yaml["bom-ref"], scanned["bom-ref"]);
    assert.strictEqual(yaml.group, "redhat");
    assert.strictEqual(yaml.name, "vscode-yaml");
    assert.strictEqual(yaml.publisher, "Red Hat");
    assert.deepStrictEqual(locations(yaml), yamlPaths);
    assert.deepStrictEqual(values(yaml, "path"), yamlPaths);
    assert.deepStrictEqual(values(yaml, "vscode_edition"), [
      "code_server",
      "vscodium",
    ]);
    assert.deepStrictEqual(values(yaml, "uid"), ["1001", "1002"]);
    assertNoHomePath(components);
  });
});

describe("convertApkPackages()", () => {
  const ALPINE_324 = {
    purlType: "apk",
    namespace: "alpine",
    distroId: "alpine-3.24.3",
    distroName: "alpine-3.24",
  };
  const WOLFI = {
    purlType: "apk",
    namespace: "wolfi",
    distroId: "wolfi-20230201",
    distroName: "",
  };
  const PHP84 = {
    name: "php84",
    version: "8.4.27-r0",
    arch: "x86_64",
    origin: "php84",
    maintainer: "A Maintainer <maintainer@example.org>",
    license: "PHP-3.01 BSD-3-Clause LGPL-2.0-or-later MIT Zend-2.0",
    url: "https://www.php.net/",
    description: "The PHP84 language runtime engine",
    fileCount: 1,
    files: [],
  };
  const loadConvertApk = async (distro) => {
    const { default: esmock } = await import("esmock");
    const { convertApkPackages } = await esmock(
      "./evidenceUtils.js",
      {},
      { "./osinfo.js": { getDistroInfo: () => distro } },
    );
    return convertApkPackages;
  };
  const propertyValue = (component, name) =>
    component.properties.find((property) => property.name === name)?.value;

  it("gives a package the purl the container scan gives an Alpine package", async () => {
    const convert = await loadConvertApk(ALPINE_324);
    const [php] = convert([PHP84]);
    assert.strictEqual(
      php.purl,
      "pkg:apk/alpine/php84@8.4.27-r0?arch=x86_64&distro=alpine-3.24.3&distro_name=alpine-3.24",
    );
    assert.strictEqual(php["bom-ref"], decodeURIComponent(php.purl));
    assert.strictEqual(php.name, "php84");
    assert.strictEqual(php.version, "8.4.27-r0");
    assert.ok(!php.purl.includes("#"), php.purl);
  });

  it("gives a Wolfi package the vendor of the host", async () => {
    const convert = await loadConvertApk(WOLFI);
    const [pkg] = convert([
      { ...PHP84, name: "wolfi-baselayout", version: "20230201-r30" },
    ]);
    assert.strictEqual(
      pkg.purl,
      "pkg:apk/wolfi/wolfi-baselayout@20230201-r30?arch=x86_64&distro=wolfi-20230201",
    );
  });

  it("tags the components with the apk_packages category and keeps what the row says", async () => {
    const convert = await loadConvertApk(ALPINE_324);
    const [php] = convert([PHP84]);
    assert.strictEqual(
      propertyValue(php, "cdx:osquery:category"),
      "apk_packages",
    );
    assert.strictEqual(propertyValue(php, "cdx:apk:origin"), "php84");
    assert.strictEqual(propertyValue(php, "arch"), "x86_64");
    assert.strictEqual(php.description, "The PHP84 language runtime engine");
    assert.strictEqual(php.publisher, "A Maintainer <maintainer@example.org>");
    const names = php.properties.map((property) => property.name);
    // The licence and the URL are CycloneDX fields, not properties.
    assert.ok(!names.includes("license"), names.join());
    assert.ok(!names.includes("url"), names.join());
    assert.ok(!names.includes("origin"), names.join());
    assert.ok(!names.includes("files"), names.join());
    assert.ok(!names.includes("fileCount"), names.join());
  });

  it("turns the licence list of a package into licenses, by SPDX id where it has one", async () => {
    const convert = await loadConvertApk(ALPINE_324);
    const [php] = convert([PHP84]);
    assert.deepStrictEqual(php.licenses, [
      { license: { id: "PHP-3.01" } },
      { license: { id: "BSD-3-Clause" } },
      { license: { id: "LGPL-2.0-or-later" } },
      { license: { id: "MIT" } },
      { license: { id: "Zend-2.0" } },
    ]);
    const [single] = convert([{ ...PHP84, license: "MIT" }]);
    assert.deepStrictEqual(single.licenses, [{ license: { id: "MIT" } }]);
    const [mixed] = convert([{ ...PHP84, license: "mit custom:Acme-EULA" }]);
    assert.deepStrictEqual(mixed.licenses, [
      { license: { id: "MIT" } },
      { license: { name: "custom:Acme-EULA" } },
    ]);
  });

  it("keeps an SPDX expression as one expression", async () => {
    const convert = await loadConvertApk(ALPINE_324);
    const [pkg] = convert([{ ...PHP84, license: "GPL-2.0-only AND MIT" }]);
    assert.deepStrictEqual(pkg.licenses, [
      { expression: "GPL-2.0-only AND MIT" },
    ]);
  });

  it("names a licence it cannot map instead of dropping it", async () => {
    const convert = await loadConvertApk(ALPINE_324);
    const [pkg] = convert([{ ...PHP84, license: "custom:Acme-EULA" }]);
    assert.deepStrictEqual(pkg.licenses, [
      { license: { name: "custom:Acme-EULA" } },
    ]);
  });

  it("emits no licenses for a package that declares none", async () => {
    const convert = await loadConvertApk(WOLFI);
    const { license: _license, ...withoutLicense } = PHP84;
    const [pkg] = convert([withoutLicense]);
    assert.ok(!("licenses" in pkg));
  });

  it("references the home page of a package without credentials, query or fragment", async () => {
    const convert = await loadConvertApk(ALPINE_324);
    const [php] = convert([PHP84]);
    assert.deepStrictEqual(php.externalReferences, [
      { type: "website", url: "https://www.php.net/" },
    ]);
    const [dirty] = convert([
      {
        ...PHP84,
        url: "https://user:secret@example.org/p?token=abc&x=1#frag",
      },
    ]);
    assert.deepStrictEqual(dirty.externalReferences, [
      { type: "website", url: "https://example.org/p" },
    ]);
    assert.ok(!JSON.stringify(dirty).includes("secret"));
    assert.ok(!JSON.stringify(dirty).includes("token=abc"));
  });

  it("references nothing that is not an http(s) URL", async () => {
    const convert = await loadConvertApk(ALPINE_324);
    for (const url of [
      "",
      undefined,
      "ftp://example.org/x",
      "javascript:alert(1)",
      "git@github.com:foo/bar.git",
      "not a url",
    ]) {
      const [pkg] = convert([{ ...PHP84, url }]);
      assert.ok(!("externalReferences" in pkg), `${url}`);
    }
  });

  it("matches a package against GTFOBins by its name only, as deb and rpm rows are", async () => {
    // GTFOBins looks at the description of a row too, and an apk description is
    // free text: "Alpine base dir structure" is no use of the alpine mail client.
    const { default: esmock } = await import("esmock");
    const { convertApkPackages } = await esmock(
      "./evidenceUtils.js",
      { "node:os": { platform: () => "linux" } },
      { "./osinfo.js": { getDistroInfo: () => ALPINE_324 } },
    );
    const [baselayout, php] = convertApkPackages([
      {
        ...PHP84,
        name: "alpine-baselayout",
        description: "Alpine base dir structure and init scripts",
      },
      PHP84,
    ]);
    const names = (component) =>
      component.properties.map((property) => property.name);
    assert.ok(
      !names(baselayout).some((name) => name.startsWith("cdx:gtfobins:")),
      names(baselayout).join(),
    );
    // The description is still the component's.
    assert.strictEqual(
      baselayout.description,
      "Alpine base dir structure and init scripts",
    );
    // A package whose name is a GTFOBins binary still matches by that name.
    const gtfobinsFields = php.properties.find(
      (property) => property.name === "cdx:gtfobins:matchFields",
    )?.value;
    assert.ok(
      gtfobinsFields === undefined || gtfobinsFields === "name",
      gtfobinsFields,
    );
  });

  it("converts every package and leaves out none", async () => {
    const convert = await loadConvertApk(ALPINE_324);
    const components = convert([
      PHP84,
      { ...PHP84, name: "php84-common", description: undefined },
    ]);
    assert.deepStrictEqual(
      components.map((component) => component.name),
      ["php84", "php84-common"],
    );
    assert.deepStrictEqual(convert([]), []);
  });

  it("builds a component without an architecture qualifier when the record has no architecture", async () => {
    const convert = await loadConvertApk(ALPINE_324);
    const [pkg] = convert([{ ...PHP84, arch: undefined }]);
    assert.strictEqual(
      pkg.purl,
      "pkg:apk/alpine/php84@8.4.27-r0?distro=alpine-3.24.3&distro_name=alpine-3.24",
    );
  });
});

describe("convertOSQueryResults() for chocolatey_packages", () => {
  it("names each package by a purl and keeps its .nuspec as an occurrence", () => {
    const queryObj = {
      query: "SELECT * FROM chocolatey_packages;",
      description: "List all chocolatey_packages.",
      purlType: "chocolatey",
    };
    const rows = [
      {
        name: "ruby",
        version: "3.4.10.1",
        summary: "Ruby",
        author: "Yukihiro Matsumoto",
        license: "https://www.ruby-lang.org/en/about/license.txt",
        path: "C:\\ProgramData\\chocolatey\\lib\\ruby\\ruby.nuspec",
      },
      {
        name: "ruby.install",
        version: "3.4.10.1",
        path: "C:\\ProgramData\\chocolatey\\lib\\ruby.install\\ruby.install.nuspec",
      },
    ];
    const components = convertOSQueryResults(
      "chocolatey_packages",
      queryObj,
      rows,
    );
    assert.deepStrictEqual(
      components.map((component) => component.purl),
      ["pkg:chocolatey/ruby@3.4.10.1", "pkg:chocolatey/ruby.install@3.4.10.1"],
    );
    assert.deepStrictEqual(
      components[0].evidence.occurrences.map(
        (occurrence) => occurrence.location,
      ),
      ["C:\\ProgramData\\chocolatey\\lib\\ruby\\ruby.nuspec"],
    );
  });
});

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  buildPurlAliasMap,
  collectDosaiDataFlowFrames,
  collectDosaiPurlEvidence,
  collectDosaiServicesFromMethods,
  isDosaiDotnetLanguage,
  normalizeDosaiServiceMap,
  resolveComponentPurl,
} from "./dosai.js";

describe("dosai helpers", () => {
  it("recognizes C#, VB.NET, and F# language aliases", () => {
    for (const language of [
      "csharp",
      "dotnet",
      "vb",
      "vbnet",
      "visualbasic",
      "f#",
      "fs",
      "fsharp",
    ]) {
      assert.strictEqual(isDosaiDotnetLanguage(language), true);
    }
  });

  it("matches versionless dosai purls to cdxgen component purls", () => {
    const components = [{ purl: "pkg:nuget/System.Text.Json@10.0.0" }];
    const aliases = buildPurlAliasMap(components);

    assert.strictEqual(
      resolveComponentPurl("pkg:nuget/System.Text.Json", aliases),
      "pkg:nuget/System.Text.Json@10.0.0",
    );
  });

  it("collects package occurrence evidence from dosai PackageReachability", () => {
    const methodsSlice = {
      CallGraph: {
        Edges: [
          {
            Id: "e1",
            FileName: "System.Text.Json.dll",
            LineNumber: 12,
            CalledMethodName: "System.Text.Json.JsonSerializer.Deserialize",
            TargetName: "Deserialize",
          },
        ],
        Nodes: [
          {
            Id: "n1",
            FileName: "Program.cs",
            LineNumber: 10,
            ClassName: "Program",
            Name: "Main",
          },
          {
            Id: "n2",
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
          NodeIds: ["n1", "n2"],
          SourceLocations: [
            {
              Path: "Controllers/Parser.cs",
              FileName: "Parser.cs",
              LineNumber: 42,
              ColumnNumber: 13,
              Kind: "CallGraphEdge",
            },
          ],
        },
      ],
    };
    const retMap = collectDosaiPurlEvidence(methodsSlice, [
      { purl: "pkg:nuget/System.Text.Json@10.0.0" },
    ]);

    assert.deepStrictEqual(
      Array.from(
        retMap.purlLocationMap["pkg:nuget/System.Text.Json@10.0.0"],
      ).sort(),
      ["Controllers/Parser.cs#42"],
    );
    assert.ok(
      retMap.purlMethodsMap["pkg:nuget/System.Text.Json@10.0.0"].has(
        "System.Text.Json.JsonSerializer.Deserialize",
      ),
    );
  });

  it("keeps PackageReachability fallback occurrence evidence source-only", () => {
    const retMap = collectDosaiPurlEvidence(
      {
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
      },
      [{ purl: "pkg:nuget/System.Text.Json@10.0.0" }],
    );

    assert.deepStrictEqual(
      Array.from(retMap.purlLocationMap["pkg:nuget/System.Text.Json@10.0.0"]),
      ["Program.fs#8", "Controllers/EpisodesController.cs#17"],
    );
    assert.ok(
      !Array.from(
        retMap.purlLocationMap["pkg:nuget/System.Text.Json@10.0.0"],
      ).some((location) => location.includes(".dll")),
    );
  });

  it("collects package occurrence evidence from dosai Dependencies with purls", () => {
    const retMap = collectDosaiPurlEvidence(
      {
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
      },
      [{ purl: "pkg:nuget/Newtonsoft.Json@13.0.3" }],
    );

    assert.deepStrictEqual(
      Array.from(retMap.purlLocationMap["pkg:nuget/Newtonsoft.Json@13.0.3"]),
      ["Program.vb#4"],
    );
    assert.ok(
      retMap.purlModulesMap["pkg:nuget/Newtonsoft.Json@13.0.3"].has(
        "Newtonsoft.Json",
      ),
    );
  });

  it("collects package occurrence evidence from dosai R file Dependencies", () => {
    const retMap = collectDosaiPurlEvidence(
      {
        Dependencies: [
          {
            Path: "dependencyImports.R",
            FileName: "dependencyImports.R",
            Name: "Newtonsoft.Json",
            Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
            LineNumber: 1,
            ColumnNumber: 1,
          },
        ],
        PackageReachability: [
          {
            Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
            SourceLocations: [
              {
                Path: "dependencyImports.R",
                FileName: "dependencyImports.R",
                LineNumber: 1,
                Kind: "Dependency",
              },
            ],
          },
        ],
      },
      [{ purl: "pkg:nuget/Newtonsoft.Json@13.0.3" }],
    );

    assert.deepStrictEqual(
      Array.from(retMap.purlLocationMap["pkg:nuget/Newtonsoft.Json@13.0.3"]),
      ["dependencyImports.R#1"],
    );
  });

  it("builds CycloneDX services from dosai ApiEndpoints without raw policy names", () => {
    const servicesMap = collectDosaiServicesFromMethods({
      ApiEndpoints: [
        {
          Route: "/api/podcasts?sig=secret",
          FileName: "EpisodesController.cs",
          Path: "Controllers/EpisodesController.cs",
          ClassName: "EpisodesController",
          MethodName: "Get",
          HttpMethod: "GET",
          EndpointKind: "Attribute",
          AuthorizationRequired: true,
          AuthorizationPolicies: ["InternalPolicyName"],
          Roles: ["Admin"],
          AllowAnonymous: false,
          LineNumber: 42,
          ColumnNumber: 9,
        },
      ],
    });
    const services = normalizeDosaiServiceMap(servicesMap);

    assert.strictEqual(services.length, 1);
    assert.deepStrictEqual(services[0].endpoints, ["/api/podcasts"]);
    assert.strictEqual(services[0].authenticated, true);
    assert.ok(
      services[0].properties.some(
        (property) =>
          property.name === "cdx:dosai:authorizationPolicyCount" &&
          property.value === "1",
      ),
    );
    assert.ok(!JSON.stringify(services[0]).includes("InternalPolicyName"));
  });

  it("collects callstack frames from dosai data-flow slices", () => {
    const frames = collectDosaiDataFlowFrames(
      {
        Nodes: [
          {
            Id: "dfn1",
            Path: "Controllers/EpisodesController.cs",
            Namespace: "Podcast.Api",
            ClassName: "EpisodesController",
            MethodName: "Get",
            LineNumber: 12,
            ColumnNumber: 5,
          },
          {
            Id: "dfn2",
            Path: "Services/JsonLoader.cs",
            Namespace: "Podcast.Api",
            ClassName: "JsonLoader",
            MethodName: "Load",
            LineNumber: 20,
            ColumnNumber: 9,
          },
        ],
        Slices: [
          {
            NodeIds: ["dfn1", "dfn2"],
            Purls: ["pkg:nuget/System.Text.Json"],
          },
        ],
      },
      [{ purl: "pkg:nuget/System.Text.Json@10.0.0" }],
    );

    assert.strictEqual(frames["pkg:nuget/System.Text.Json@10.0.0"].length, 1);
    assert.strictEqual(
      frames["pkg:nuget/System.Text.Json@10.0.0"][0][1].function,
      "Load",
    );
  });

  it("rejects unsafe dosai command inputs before spawning", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    const { runDosaiCommand } = await esmock("./dosai.js", {
      "./plugins.js": { resolvePluginBinary: sinon.stub().returns("dosai") },
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
      runDosaiCommand("methods;rm -rf /", "/tmp/project", "/tmp/out.json"),
      false,
    );
    assert.strictEqual(
      runDosaiCommand("methods", "/tmp/project\n--bad", "/tmp/out.json"),
      false,
    );
    sinon.assert.notCalled(safeSpawnSync);
  });

  it("spawns dosai with argument arrays and shell disabled", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    const { runDosaiCommand } = await esmock("./dosai.js", {
      "./plugins.js": { resolvePluginBinary: sinon.stub().returns("dosai") },
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
      runDosaiCommand("dataflows", "/tmp/project", "/tmp/out.json", {
        dataFlowPatterns: "/tmp/patterns.json",
        patternPacks: "/tmp/packs",
      }),
      true,
    );
    sinon.assert.calledOnce(safeSpawnSync);
    assert.strictEqual(safeSpawnSync.firstCall.args[0], "dosai");
    assert.ok(Array.isArray(safeSpawnSync.firstCall.args[1]));
    assert.strictEqual(safeSpawnSync.firstCall.args[2].shell, false);
  });
});

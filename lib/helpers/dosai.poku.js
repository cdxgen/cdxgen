import { assert, describe, it } from "poku";

import {
  buildPurlAliasMap,
  collectDosaiDataFlowFrames,
  collectDosaiPurlEvidence,
  collectDosaiServicesFromMethods,
  normalizeDosaiServiceMap,
  resolveComponentPurl,
} from "./dosai.js";

describe("dosai helpers", () => {
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
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { fullFormats } from "ajv-formats/dist/formats.js";
import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  applyDosaiReachabilityEvidence,
  buildPurlAliasMap,
  collectDosaiAiComponents,
  collectDosaiDataFlowFrames,
  collectDosaiPurlEvidence,
  collectDosaiServiceComponents,
  collectDosaiServicesFromMethods,
  dosaiDotnetRequirement,
  dosaiDotnetRequirementAdvice,
  dosaiDotnetRequirementDetail,
  dosaiRunStopReason,
  dosaiRunTimedOut,
  dosaiSlicesFileIsFresh,
  isDosaiDotnetLanguage,
  normalizeDosaiServiceMap,
  persistDosaiSemanticsReport,
  resolveComponentPurl,
} from "./dosai.js";

describe("dosai helpers", () => {
  it("recognizes C#, VB.NET, and F# language aliases", () => {
    for (const language of [
      "csharp",
      "dotnet",
      "dotnet8",
      "dotnet9",
      "dotnet10",
      "dotnet11",
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

  // A Windows dosai report names source files with backslashes; the occurrence
  // keys use forward slashes so the same place is one occurrence whatever
  // spelled it (issue 4726).
  it("keys occurrences with forward slashes whatever separator the report uses", () => {
    const retMap = collectDosaiPurlEvidence(
      {
        PackageReachability: [
          {
            Purl: "pkg:nuget/System.Text.Json",
            SourceLocations: [
              {
                Path: "Controllers\\Parser.cs",
                FileName: "Parser.cs",
                LineNumber: 42,
                ColumnNumber: 13,
                Kind: "CallGraphEdge",
              },
            ],
          },
        ],
      },
      [{ purl: "pkg:nuget/System.Text.Json@10.0.0" }],
    );
    assert.deepStrictEqual(
      Array.from(retMap.purlLocationMap["pkg:nuget/System.Text.Json@10.0.0"]),
      ["Controllers/Parser.cs#42"],
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

  it("applyDosaiReachabilityEvidence propagates confidence facts to matching components", () => {
    const components = [
      { purl: "pkg:nuget/Newtonsoft.Json@12.0.3" },
      { purl: "pkg:nuget/Unrelated@1.0.0" },
    ];
    const methodsSlice = {
      PackageReachability: [
        {
          // dosai purls are frequently versionless; the alias map resolves them.
          Purl: "pkg:nuget/Newtonsoft.Json",
          ReachabilityKind: "ExternalCallGraphNode",
          Confidence: "Low",
          EvidenceKinds: ["SourceUnresolved"],
          ConfidenceReasons: [
            "Package URL is supported by dependency/import metadata.",
            "Package assemblies were not available for semantic binding.",
          ],
        },
      ],
    };

    const enriched = applyDosaiReachabilityEvidence(methodsSlice, components);

    assert.strictEqual(enriched, 1);
    const properties = Object.fromEntries(
      components[0].properties.map((p) => [p.name, p.value]),
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
        "Package assemblies were not available for semantic binding.",
      ),
    );
    // The unmatched component is untouched.
    assert.strictEqual(components[1].properties, undefined);
  });

  it("applyDosaiReachabilityEvidence does not stack duplicate properties on re-runs", () => {
    const component = { purl: "pkg:nuget/Example@1.0.0" };
    const methodsSlice = {
      PackageReachability: [
        {
          Purl: "pkg:nuget/Example@1.0.0",
          ReachabilityKind: "Dependency",
          Confidence: "High",
        },
      ],
    };

    applyDosaiReachabilityEvidence(methodsSlice, [component]);
    applyDosaiReachabilityEvidence(methodsSlice, [component]);

    const kindProperties = component.properties.filter(
      (p) => p.name === "cdx:dosai:reachability:kind",
    );
    assert.strictEqual(kindProperties.length, 1);
    // Empty facts are not emitted as empty properties.
    assert.strictEqual(
      component.properties.some(
        (p) => p.name === "cdx:dosai:reachability:evidence",
      ),
      false,
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

  it("percent-encodes ASP.NET route templates so endpoints stay iri-references", () => {
    const servicesMap = collectDosaiServicesFromMethods({
      ApiEndpoints: [
        {
          Route: "api/[controller]/{id}",
          ClassName: "PodcastsController",
          MethodName: "Get",
          HttpMethod: "GET",
        },
      ],
    });
    const services = normalizeDosaiServiceMap(servicesMap);

    assert.deepStrictEqual(services[0].endpoints, [
      "api/%5Bcontroller%5D/%7Bid%7D",
    ]);
    assert.ok(!/[[\]{}]/.test(services[0].endpoints[0]));
  });

  // normalizeDosaiServiceMap is where every evinse collector's services become
  // services[], so it encodes the templates the other collectors keep readable.
  it("percent-encodes every collector's endpoints into URI references", () => {
    const services = normalizeDosaiServiceMap({
      // OpenAPI (test/data/openapi/openapi-spec.json)
      "service-communityapiv2communityposts{postId}-get": {
        endpoints: new Set(["/community/api/v2/community/posts/{postId}"]),
        properties: [{ name: "cdx:service:httpMethod", value: "get" }],
      },
      // kosi apiEndpoints[].pathTemplate
      "service-orders{id}-get": {
        name: "service-orders{id}-get",
        endpoints: new Set(["/orders/{id}"]),
        properties: [],
      },
      // scalasem (test/data/scalasem/services-jvm.json), an unnamed segment
      "service-orders{}-get": {
        name: "service-orders{}-get",
        endpoints: new Set(["/orders/{}"]),
        properties: [],
      },
      // golem and dosai already encode; encoding again must not change them,
      // and the same route spelled both ways is one endpoint
      "service|server|example.com/app|gin": {
        name: "gin",
        endpoints: new Set(["/users/%7Bid%7D", "/users/{id}"]),
        properties: [],
      },
      // an outbound URL keeps its IPv6 host and query
      "service|external|http|[::1]:9000": {
        name: "[::1]:9000",
        endpoints: new Set(["http://[::1]:9000/metrics?since={t}", 7, ""]),
        properties: [],
      },
    });
    const endpoints = Object.fromEntries(
      services.map((service) => [service.name, service.endpoints]),
    );
    assert.deepStrictEqual(endpoints, {
      "service-communityapiv2communityposts{postId}-get": [
        "/community/api/v2/community/posts/%7BpostId%7D",
      ],
      "service-orders{id}-get": ["/orders/%7Bid%7D"],
      "service-orders{}-get": ["/orders/%7B%7D"],
      gin: ["/users/%7Bid%7D"],
      "[::1]:9000": ["http://[::1]:9000/metrics?since=%7Bt%7D"],
    });
    for (const endpoint of services.flatMap((service) => service.endpoints)) {
      assert.ok(fullFormats["uri-reference"].test(endpoint), endpoint);
    }
  });

  it("collects dosai 4.0 Services[] with bom-refs, operations, trust zones, and data", () => {
    const servicesMap = collectDosaiServiceComponents({
      Metadata: { SchemaVersion: "4.0.0" },
      Services: [
        {
          Id: "svc:grpc:Server.examples.Counter/CounterService",
          Name: "CounterService",
          Group: "Server.examples.Counter",
          ServiceKind: "grpc",
          Direction: "inbound",
          Framework: "grpc",
          Authenticated: false,
          TrustZone: "public",
          CrossesTrustBoundary: true,
          Endpoints: [],
          Operations: [
            {
              Id: "op:svc:grpc:Server.examples.Counter/CounterService#/count.Counter/Increment",
              Name: "Increment",
              Path: "/count.Counter/Increment",
              StreamingMode: "unary",
            },
          ],
          Data: [
            {
              Flow: "inbound",
              Classification: "pii",
              Name: "CounterRequest",
              Description: "Carries member name",
              Source: ["client"],
              Destination: ["CounterService"],
            },
            { Flow: "inbound", Classification: null },
          ],
          AuthenticationSchemes: ["JwtBearer"],
          AuthorizationPolicies: ["ScopePolicy"],
          Roles: ["Counter.Admin"],
          AllowAnonymous: false,
          Tags: ["finding:test-tag"],
          Location: {
            Path: "Server/CounterService.cs",
            LineNumber: 14,
            ColumnNumber: 22,
          },
        },
      ],
    });
    const services = normalizeDosaiServiceMap(servicesMap);

    assert.strictEqual(services.length, 1);
    const service = services[0];
    assert.strictEqual(
      service["bom-ref"],
      "svc:grpc:Server.examples.Counter/CounterService",
    );
    assert.strictEqual(service.trustZone, "public");
    assert.strictEqual(service["x-trust-boundary"], true);
    assert.deepStrictEqual(service.endpoints, ["/count.Counter/Increment"]);
    assert.ok(
      service.properties.some(
        (property) =>
          property.name === "cdx:service:httpMethod" ||
          property.name === "cdx:dosai:operationCount",
      ),
    );
    assert.ok(
      service.properties.some(
        (property) =>
          property.name === "cdx:dosai:operationCount" &&
          property.value === "1",
      ),
    );
    assert.ok(
      service.properties.some(
        (property) =>
          property.name === "cdx:dosai:authScheme" &&
          property.value === "JwtBearer",
      ),
    );
    assert.ok(
      !JSON.stringify(service).includes("ScopePolicy") &&
        !JSON.stringify(service).includes("Counter.Admin"),
    );
    assert.deepStrictEqual(service.data, [
      {
        classification: "pii",
        flow: "inbound",
        name: "CounterRequest",
        description: "Carries member name",
        source: ["client"],
        destination: ["CounterService"],
      },
    ]);
    assert.deepStrictEqual(service.evidence.occurrences, [
      { location: { path: "Server/CounterService.cs", line: 14, column: 22 } },
    ]);
  });

  it("keeps provider-owned ApiEndpoints out of duplicate services under schema 4.0.0", () => {
    const servicesMap = collectDosaiServiceComponents(
      {
        Metadata: { SchemaVersion: "4.0.0" },
        Services: [
          {
            Id: "svc:aspnetcore-mvc:MyApp.Controllers/Podcasts",
            Name: "Podcasts",
            ServiceKind: "http",
            Direction: "inbound",
            Framework: "aspnetcore-mvc",
            Endpoints: ["/api/Podcasts"],
          },
        ],
      },
      {},
    );
    collectDosaiServicesFromMethods(
      {
        Metadata: { SchemaVersion: "4.0.0" },
        ApiEndpoints: [
          {
            Route: "api/[controller]",
            Path: "/api/Podcasts",
            FilePath: "Controllers/PodcastsController.cs",
            FileName: "PodcastsController.cs",
            ClassName: "PodcastsController",
            MethodName: "Get",
            HttpMethod: "GET",
            ServiceId: "svc:aspnetcore-mvc:MyApp.Controllers/Podcasts",
            LineNumber: 30,
          },
        ],
      },
      servicesMap,
    );
    const services = normalizeDosaiServiceMap(servicesMap);

    assert.strictEqual(services.length, 1);
    assert.deepStrictEqual(services[0].endpoints, ["/api/Podcasts"].sort());
    assert.strictEqual(services[0].name, "Podcasts");
    // Owned endpoints still contribute their method and auth metadata to the
    // owner's properties instead of being skipped.
    assert.ok(
      services[0].properties.some(
        (property) =>
          property.name === "cdx:service:httpMethod" &&
          property.value === "GET",
      ),
    );
    assert.ok(
      services[0].properties.some(
        (property) =>
          property.name === "internal:SrcFile" &&
          property.value === "Controllers/PodcastsController.cs",
      ),
    );
  });

  it("accumulates occurrences and later-entry facts across duplicate Services[] entries", () => {
    const servicesMap = collectDosaiServiceComponents({
      Metadata: { SchemaVersion: "4.0.0" },
      Services: [
        {
          Id: "svc:ai-inference:MyApp.Copilot/Summarizer",
          Name: "Summarizer",
          ServiceKind: "ai-inference",
          Direction: "inbound",
          Framework: "llm-sdk",
          Authenticated: false,
          Location: { Path: "Copilot/Summarizer.cs", LineNumber: 20 },
        },
        {
          Id: "svc:ai-inference:MyApp.Copilot/Summarizer",
          Name: "Summarizer",
          ServiceKind: "ai-inference",
          Direction: "outbound",
          Framework: "llm-sdk",
          Provider: "openai",
          TrustZone: "external",
          Location: { Path: "Copilot/SummarizerClient.cs", LineNumber: 48 },
        },
      ],
    });
    const services = normalizeDosaiServiceMap(servicesMap);

    assert.strictEqual(services.length, 1);
    const service = services[0];
    // A service implemented across call sites keeps every occurrence.
    assert.deepStrictEqual(
      service.evidence.occurrences.map(
        (occurrence) => occurrence.location.path,
      ),
      ["Copilot/Summarizer.cs", "Copilot/SummarizerClient.cs"],
    );
    // The outbound provider arrives on the second entry; it must still win.
    assert.deepStrictEqual(service.provider, { name: "openai" });
    assert.strictEqual(service.trustZone, "external");
    // services[].evidence is stripped below CycloneDX 2.0, so the call sites
    // must also survive as location properties.
    assert.deepStrictEqual(
      service.properties
        .filter((property) => property.name === "cdx:dosai:location")
        .map((property) => property.value),
      ["Copilot/Summarizer.cs:20:0", "Copilot/SummarizerClient.cs:48:0"],
    );
  });

  it("prefers resolved Path over Route only for schema 4.0.0 slices", () => {
    const modernMap = collectDosaiServicesFromMethods({
      Metadata: { SchemaVersion: "4.0.0" },
      ApiEndpoints: [
        {
          Route: "api/[controller]",
          Path: "/api/Podcasts",
          FilePath: "Controllers/PodcastsController.cs",
          FileName: "PodcastsController.cs",
          ClassName: "PodcastsController",
          MethodName: "Get",
          LineNumber: 30,
          ColumnNumber: 9,
        },
      ],
    });
    const modernServices = normalizeDosaiServiceMap(modernMap);
    assert.deepStrictEqual(modernServices[0].endpoints, ["/api/Podcasts"]);
    assert.ok(
      modernServices[0].properties.some(
        (property) =>
          property.name === "cdx:service:pathTemplate" &&
          property.value === "api/[controller]",
      ),
    );
    assert.ok(
      modernServices[0].properties.some(
        (property) =>
          property.name === "internal:SrcFile" &&
          property.value === "Controllers/PodcastsController.cs",
      ),
    );
    assert.ok(
      modernServices[0].properties.some(
        (property) =>
          property.name === "cdx:dosai:location" &&
          property.value.startsWith("Controllers/PodcastsController.cs:"),
      ),
    );

    // In 3.3.0 slices `Path` is the source file path, not a route.
    const legacyMap = collectDosaiServicesFromMethods({
      Metadata: { SchemaVersion: "3.3.0" },
      ApiEndpoints: [
        {
          Route: "api/[controller]",
          Path: "Controllers/PodcastsController.cs",
          FileName: "PodcastsController.cs",
          ClassName: "PodcastsController",
          MethodName: "Get",
        },
      ],
    });
    const legacyServices = normalizeDosaiServiceMap(legacyMap);
    assert.deepStrictEqual(legacyServices[0].endpoints, [
      "api/%5Bcontroller%5D",
    ]);
    assert.ok(
      !legacyServices[0].properties.some(
        (property) =>
          property.name === "internal:SrcFile" &&
          property.value.includes("/api/"),
      ),
    );
  });

  it("resolves the model creator from the model name, not the client provider", () => {
    const cases = [
      // [provider, model name, expected manufacturer]
      ["openai", "gpt-4o", { name: "OpenAI" }],
      // An OpenAI-compatible client pointed at another server.
      ["openai", "llama3.2", undefined],
      ["OpenAI", "claude-3-5-sonnet", undefined],
      ["anthropic", "claude-3-5-sonnet", { name: "Anthropic" }],
      // A single-catalogue API owns every model it serves.
      ["Mistral", "m", { name: "Mistral AI" }],
      ["gemini", "gemini-1.5-pro", { name: "Google" }],
      // Hosting and routing providers keep the creator the name names.
      ["azure-openai", "gpt-4o", { name: "OpenAI" }],
      ["groq", "mixtral-8x7b-32768", { name: "Mistral AI" }],
      ["groq", "m", undefined],
      ["openrouter", "m", undefined],
      ["aws-bedrock", "m", undefined],
      // Local runtimes serve tags anyone can create.
      ["ollama", "llama3.2", undefined],
      ["local", "llama-3-8b.gguf", undefined],
    ];
    const components = collectDosaiAiComponents({
      AiComponents: cases.map(([provider, name], index) => ({
        Id: `ai:model:${index}`,
        Kind: "model",
        Name: name,
        Provider: provider,
      })),
    });
    cases.forEach(([provider, name, expected], index) => {
      const model = components.find(
        (component) => component["bom-ref"] === `ai:model:${index}`,
      );
      assert.deepStrictEqual(
        model.manufacturer,
        expected,
        `${provider} ${name}`,
      );
      // No Hub purl, so nothing supplied the model as an artifact.
      assert.strictEqual(model.supplier, undefined, `${provider} ${name}`);
      // The provider stays visible as a property either way.
      assert.ok(
        model.properties.some(
          (property) =>
            property.name === "cdx:ai:provider" && property.value === provider,
        ),
      );
    });
  });

  it("records the Hugging Face namespace of a dosai model purl as its supplier", () => {
    const [hubModel, creatorModel, repackagedModel] = collectDosaiAiComponents({
      AiComponents: [
        {
          Id: "ai:model:hub",
          Kind: "model",
          Name: "phi-3-mini",
          Provider: "local",
          Purl: "pkg:huggingface/microsoft/phi-3-mini",
        },
        {
          Id: "ai:model:creator",
          Kind: "model",
          Name: "Llama-3.1-8B",
          Provider: "huggingface",
          Purl: "pkg:huggingface/meta-llama/Llama-3.1-8B",
        },
        {
          Id: "ai:model:repackaged",
          Kind: "model",
          Name: "Llama-2-7B-Chat-GGUF",
          Provider: "huggingface",
          Purl: "pkg:huggingface/TheBloke/Llama-2-7B-Chat-GGUF",
        },
      ],
    });
    assert.deepStrictEqual(hubModel.supplier, {
      name: "microsoft",
      url: ["https://huggingface.co/microsoft"],
    });
    assert.strictEqual(hubModel.manufacturer, undefined);
    assert.deepStrictEqual(creatorModel.supplier, {
      name: "meta-llama",
      url: ["https://huggingface.co/meta-llama"],
    });
    assert.deepStrictEqual(creatorModel.manufacturer, { name: "Meta" });
    // A re-packager supplies the model but did not create it.
    assert.strictEqual(repackagedModel.supplier.name, "TheBloke");
    assert.strictEqual(repackagedModel.manufacturer, undefined);
  });

  it("maps dosai 4.0 AiComponents[] to model and data components", () => {
    const components = collectDosaiAiComponents({
      AiComponents: [
        {
          Id: "ai:model:openai/gpt-4o",
          Kind: "model",
          Name: "gpt-4o",
          Provider: "openai",
          Deployment: "remote",
          Task: "chat-completion",
          InputFormats: ["text"],
          OutputFormats: ["text"],
        },
        {
          Id: "ai:model:local/phi-3.gguf",
          Kind: "model",
          Name: "phi-3.gguf",
          Provider: "local",
          Deployment: "local",
          FilePath: "models/phi-3.gguf",
          Sha256: "a".repeat(64),
        },
        {
          Id: "ai:prompt:local/system-prompt",
          Kind: "prompt",
          Name: "system-prompt",
          PromptText: "You are a helpful assistant",
        },
        {
          Id: "ai:tool:mcp/weather",
          Kind: "tool",
          Name: "weather",
          Provider: "mcp",
          ToolSchema: '{"type":"object"}',
        },
        {
          Id: "ai:guardrail:local/content-filter",
          Kind: "guardrail",
          Name: "content-filter",
          Provider: "local",
        },
        { Id: "", Name: "dropped" },
      ],
    });

    const model = components.find(
      (component) => component["bom-ref"] === "ai:model:openai/gpt-4o",
    );
    assert.strictEqual(model.type, "machine-learning-model");
    assert.strictEqual(model.modelCard.modelParameters.task, "chat-completion");
    assert.deepStrictEqual(model.modelCard.modelParameters.inputs, [
      { format: "text" },
    ]);
    assert.deepStrictEqual(model.manufacturer, { name: "OpenAI" });
    assert.strictEqual(model.supplier, undefined);

    const localModel = components.find(
      (component) => component["bom-ref"] === "ai:model:local/phi-3.gguf",
    );
    // A local runtime is not the creator of the model it loads.
    assert.strictEqual(localModel.manufacturer, undefined);
    assert.strictEqual(localModel.supplier, undefined);
    assert.deepStrictEqual(localModel.hashes, [
      { alg: "SHA-256", content: "a".repeat(64) },
    ]);
    assert.ok(
      localModel.properties.some(
        (property) => property.name === "cdx:ai:modelFile",
      ),
    );

    const prompt = components.find(
      (component) => component["bom-ref"] === "ai:prompt:local/system-prompt",
    );
    assert.strictEqual(prompt.type, "data");

    const tool = components.find(
      (component) => component["bom-ref"] === "ai:tool:mcp/weather",
    );
    assert.ok(
      tool.properties.some((property) => property.name === "cdx:ai:toolSchema"),
    );

    const guardrail = components.find(
      (component) =>
        component["bom-ref"] === "ai:guardrail:local/content-filter",
    );
    assert.strictEqual(guardrail.type, "data");
    assert.strictEqual(components.length, 5);
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

  it("skips the durable dosai report gracefully when serialization fails", async () => {
    const safeWriteSync = sinon
      .stub()
      .throws(new RangeError("Invalid string length"));
    const recordDegradation = sinon.stub();
    const { persistDosaiSemanticsReport } = await esmock("./dosai.js", {
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns("/tmp"),
        safeExistsSync: sinon.stub().returns(true),
        safeMkdtempSync: sinon.stub(),
        safeRmSync: sinon.stub(),
        safeSpawnSync: sinon.stub(),
        safeWriteSync,
      },
      "../core/buildLedger.js": { recordDegradation },
    });

    const durablePath = persistDosaiSemanticsReport(
      { semanticsSlicesFile: "/tmp/semantics.slices.json" },
      { ApiEndpoints: [{ Route: "/api/podcasts" }] },
      { Slices: [] },
    );

    assert.strictEqual(durablePath, undefined);
    assert.strictEqual(safeWriteSync.callCount, 1);
    sinon.assert.calledOnce(recordDegradation);
    const [kind, detail] = recordDegradation.firstCall.args;
    assert.strictEqual(kind, "dosai.semantics.persist-failed");
    assert.strictEqual(detail.impact, "none");
  });

  it("rejects unsafe dosai command inputs before spawning", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    const { runDosaiCommand } = await esmock("./dosai.js", {
      "./plugins.js": {
        resolvePluginBinary: sinon.stub().returns("dosai"),
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
      runDosaiCommand("methods;rm -rf /", "/tmp/project", "/tmp/out.json"),
      false,
    );
    assert.strictEqual(
      runDosaiCommand("methods", "/tmp/project\n--bad", "/tmp/out.json"),
      false,
    );
    assert.strictEqual(
      runDosaiCommand("methods", "/tmp/project", "/tmp/out.json", {
        dosaiCommand: "dosai;touch /tmp/pwned",
      }),
      false,
    );
    sinon.assert.notCalled(safeSpawnSync);
  });

  it("spawns dosai with argument arrays and shell disabled", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    const { runDosaiCommand } = await esmock("./dosai.js", {
      "./plugins.js": {
        resolvePluginBinary: sinon.stub().returns("dosai"),
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

  it("recognises a dosai run stopped by the spawn timeout", () => {
    assert.strictEqual(
      dosaiRunTimedOut({ status: null, error: { code: "ETIMEDOUT" } }),
      true,
    );
    assert.strictEqual(dosaiRunTimedOut({ status: 1 }), false);
    assert.strictEqual(dosaiRunTimedOut({ status: 0 }), false);
    assert.strictEqual(dosaiRunTimedOut({}), false);
    assert.strictEqual(dosaiRunTimedOut(undefined), false);
  });

  it("tells why a dosai run was stopped", () => {
    assert.strictEqual(
      dosaiRunStopReason({
        status: null,
        signal: "SIGTERM",
        error: { code: "ETIMEDOUT" },
      }),
      "timeout",
    );
    assert.strictEqual(
      dosaiRunStopReason({
        status: null,
        signal: "SIGTERM",
        error: { code: "ENOBUFS" },
      }),
      "buffer",
    );
    assert.strictEqual(
      dosaiRunStopReason({ status: null, signal: "SIGKILL" }),
      "signal",
    );
    assert.strictEqual(dosaiRunStopReason({ status: 1 }), undefined);
    assert.strictEqual(
      dosaiRunStopReason({ status: null, error: { code: "ENOENT" } }),
      undefined,
    );
    assert.strictEqual(dosaiRunStopReason(undefined), undefined);
  });

  for (const [label, spawnResult, messagePattern] of [
    [
      "the spawn timeout",
      { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } },
      /dosai did not finish within .*CDXGEN_TIMEOUT_MS/,
    ],
    [
      "the output buffer limit",
      { status: null, signal: "SIGTERM", error: { code: "ENOBUFS" } },
      /CDXGEN_MAX_BUFFER/,
    ],
    ["a signal", { status: null, signal: "SIGKILL" }, /stopped by SIGKILL/],
  ]) {
    it(`reports a dosai run stopped by ${label}, reaps it, and drops its half-written output`, async () => {
      const safeSpawnSync = sinon.stub().returns({ pid: 4242, ...spawnResult });
      const safeRmSync = sinon.stub();
      const reapProcessTree = sinon.stub().returns([]);
      const { dosaiRunWasStopped, runDosaiCommand } = await esmock(
        "./dosai.js",
        {
          "./plugins.js": {
            resolvePluginBinary: sinon.stub().returns("dosai"),
          },
          "../core/activity.js": { DEBUG_MODE: false },
          "../core/fs.js": {
            getTmpDir: sinon.stub().returns("/tmp"),
            safeExistsSync: sinon.stub().returns(true),
            safeMkdtempSync: sinon.stub(),
            safeRmSync,
            safeSpawnSync,
          },
          "../core/processTree.js": {
            formatDuration: sinon.stub().returns("20 minutes"),
            reapProcessTree,
          },
        },
      );
      const warn = sinon.stub(console, "warn");
      try {
        assert.strictEqual(
          runDosaiCommand("methods", "/tmp/project", "/tmp/out.json"),
          false,
        );
      } finally {
        warn.restore();
      }
      sinon.assert.calledOnce(safeSpawnSync);
      // The run reads as stopped, not as any other dosai failure, and names
      // what to change (issue 4438).
      sinon.assert.calledOnce(warn);
      assert.match(warn.firstCall.args[0], messagePattern);
      // Whatever it started is stopped too, on the platforms that need it.
      sinon.assert.calledOnce(reapProcessTree);
      assert.strictEqual(reapProcessTree.firstCall.args[0], 4242);
      assert.strictEqual(reapProcessTree.firstCall.args[3], "dosai");
      // A stopped dosai can leave its output half written behind.
      sinon.assert.calledOnce(safeRmSync);
      assert.strictEqual(
        safeRmSync.firstCall.args[0],
        resolve("/tmp/out.json"),
      );
      // Callers can tell, so they add no advice meant for other failures.
      assert.strictEqual(dosaiRunWasStopped("/tmp/out.json"), true);
      assert.strictEqual(dosaiRunWasStopped("/tmp/other.json"), false);
    });
  }

  it("does not treat a failed dosai run as stopped", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 1, stderr: "boom" });
    const safeRmSync = sinon.stub();
    const { dosaiRunWasStopped, runDosaiCommand } = await esmock("./dosai.js", {
      "./plugins.js": {
        resolvePluginBinary: sinon.stub().returns("dosai"),
      },
      "../core/activity.js": { DEBUG_MODE: false },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns("/tmp"),
        safeExistsSync: sinon.stub().returns(false),
        safeMkdtempSync: sinon.stub(),
        safeRmSync,
        safeSpawnSync,
      },
    });
    assert.strictEqual(
      runDosaiCommand("methods", "/tmp/project", "/tmp/out.json"),
      false,
    );
    sinon.assert.notCalled(safeRmSync);
    assert.strictEqual(dosaiRunWasStopped("/tmp/out.json"), false);
  });

  it("forwards cdxgen exclude globs to dosai and warns about unsupported ones", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    const { runDosaiCommand } = await esmock("./dosai.js", {
      "./plugins.js": {
        resolvePluginBinary: sinon.stub().returns("dosai"),
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
    const warn = sinon.stub(console, "warn");
    const exclude = [
      "BuildOutput/**",
      " **/*.Designer.cs ",
      "!keep",
      "",
      "a\nb",
      42,
    ];
    try {
      for (const command of ["methods", "crypto"]) {
        assert.strictEqual(
          runDosaiCommand(command, "/tmp/project", "/tmp/out.json", {
            exclude,
          }),
          true,
        );
      }
    } finally {
      warn.restore();
    }
    sinon.assert.calledTwice(safeSpawnSync);
    const args = safeSpawnSync.firstCall.args[1];
    assert.deepStrictEqual(args.slice(5), [
      "--exclude",
      "**/BuildOutput/**",
      "--exclude",
      "**/*.Designer.cs",
    ]);
    // The same unsupported pattern is reported once per run, not per dosai call.
    sinon.assert.calledOnce(warn);
    assert.match(warn.firstCall.args[0], /!keep/);
  });

  it("translates cdxgen exclude globs the way the atom evidence filter reads them", async () => {
    const { toDosaiExcludePatterns } = await import("./dosai.js");
    const root = resolve(tmpdir(), "cdxgen-dosai-exclude-root");
    const translate = (patterns) => toDosaiExcludePatterns(patterns, root);
    const posixRoot = root.replace(/\\/g, "/");

    // Relative patterns match at any depth, as they do for atom slices.
    assert.deepStrictEqual(
      translate([
        "node_modules",
        "*.Designer.cs",
        "bin/",
        "./src/Legacy",
        "**/test/**",
      ]).patterns,
      [
        "**/node_modules",
        "**/*.Designer.cs",
        "**/bin/",
        "**/src/Legacy",
        "**/test/**",
      ],
    );
    // Brace groups, later groups, numeric ranges, and comma lists expand.
    assert.deepStrictEqual(
      translate([
        "{BuildOutput,out/{x64,x86}}/**",
        "{a}{b,c}",
        "gen{1..3}",
        "src/{Gen,}/**",
        "one,two",
      ]).patterns,
      [
        "**/BuildOutput/**",
        "**/out/x64/**",
        "**/out/x86/**",
        "**/gen1",
        "**/gen2",
        "**/gen3",
        "**/src/Gen/**",
        "**/src/**",
        "**/one",
        "**/two",
      ],
    );
    // A group minimatch leaves literal, and shell metacharacters, are skipped.
    const shellStyle = ["$", "{x,y}"].join("");
    const literal = translate(["lib/{only}/**", shellStyle, "a;rm", "`x`"]);
    assert.deepStrictEqual(literal.patterns, []);
    assert.deepStrictEqual(literal.skipped, [
      "lib/{only}/**",
      shellStyle,
      "a;rm",
      "`x`",
    ]);
    // Absolute paths under the root are anchored; others are skipped.
    const absolute = translate([
      `${posixRoot}/BuildOutput/**`,
      `${posixRoot}/Vendor.dll`,
      "/elsewhere/**",
      posixRoot,
    ]);
    assert.deepStrictEqual(absolute.patterns, [
      "/BuildOutput/**",
      "/Vendor.dll",
    ]);
    assert.deepStrictEqual(absolute.skipped, ["/elsewhere/**", posixRoot]);
    // Syntax dosai cannot express is reported instead of passed on as a literal.
    const unsupported = translate([
      "Gen/[AB]*.cs",
      "@(Gen)/**",
      "!keep/**",
      "a/../BuildOutput/**",
      "Gen/\\*.cs",
      "{a,[b]}/**",
    ]);
    assert.deepStrictEqual(unsupported.patterns, ["**/a/**"]);
    assert.deepStrictEqual(unsupported.skipped, [
      "Gen/[AB]*.cs",
      "@(Gen)/**",
      "!keep/**",
      "a/../BuildOutput/**",
      "Gen/\\*.cs",
      "[b]/**",
    ]);
    // A backslash that is not an escape is a Windows separator.
    assert.deepStrictEqual(
      translate(["BuildOutput\\x64\\Generated"]).patterns,
      ["**/BuildOutput/x64/Generated"],
    );
    // Duplicates collapse and non-string input is ignored.
    assert.deepStrictEqual(
      translate(["Gen/**", "./Gen/**", 1, null]).patterns,
      ["**/Gen/**"],
    );
    assert.deepStrictEqual(translate(undefined).patterns, []);
  });

  it("caps the number of exclude patterns passed to dosai", async () => {
    const { toDosaiExcludePatterns } = await import("./dosai.js");
    const excludes = Array.from({ length: 300 }, (_, i) => `dir${i}/**`);
    const result = toDosaiExcludePatterns(excludes, resolve(tmpdir()));
    assert.strictEqual(result.patterns.length, 256);
    assert.strictEqual(result.truncated, 44);
    // A range too large to expand stays literal and is reported, not sent.
    assert.deepStrictEqual(
      toDosaiExcludePatterns(["x{1..300}"], resolve(tmpdir())).skipped,
      ["x{1..300}"],
    );
  });

  it("reruns dosai without exclude when the build does not support it", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    safeSpawnSync.onFirstCall().returns({
      status: 1,
      stderr: "Unrecognized command or argument '--exclude'.",
    });
    const { runDosaiCommand } = await esmock("./dosai.js", {
      "./plugins.js": {
        resolvePluginBinary: sinon.stub().returns("dosai"),
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
    const warn = sinon.stub(console, "warn");
    try {
      assert.strictEqual(
        runDosaiCommand("crypto", "/tmp/project", "/tmp/out.json", {
          exclude: ["BuildOutput/**"],
        }),
        true,
      );
    } finally {
      warn.restore();
    }
    sinon.assert.calledTwice(safeSpawnSync);
    assert.ok(safeSpawnSync.firstCall.args[1].includes("--exclude"));
    assert.ok(!safeSpawnSync.secondCall.args[1].includes("--exclude"));
    sinon.assert.calledOnce(warn);
    // Later calls with the same binary skip the doomed first attempt.
    assert.strictEqual(
      runDosaiCommand("methods", "/tmp/project", "/tmp/out.json", {
        exclude: ["BuildOutput/**"],
      }),
      true,
    );
    sinon.assert.calledThrice(safeSpawnSync);
    assert.ok(!safeSpawnSync.thirdCall.args[1].includes("--exclude"));
  });

  it("does not rerun dosai when an excluded run fails for another reason", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 1, stderr: "boom" });
    const { runDosaiCommand } = await esmock("./dosai.js", {
      "./plugins.js": {
        resolvePluginBinary: sinon.stub().returns("dosai"),
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
      runDosaiCommand("dataflows", "/tmp/project", "/tmp/out.json", {
        exclude: ["BuildOutput/**"],
      }),
      false,
    );
    sinon.assert.calledOnce(safeSpawnSync);
  });

  it("always asks crypto for no data-flow graph and methods only for the sections a caller names", async () => {
    const safeSpawnSync = sinon.stub().returns({ status: 0 });
    const { runDosaiCommand, dosaiMethodsSectionsArgument } = await esmock(
      "./dosai.js",
      {
        "./plugins.js": {
          resolvePluginBinary: sinon.stub().returns("dosai"),
        },
        "../core/activity.js": { DEBUG_MODE: false },
        "../core/fs.js": {
          getTmpDir: sinon.stub().returns("/tmp"),
          safeExistsSync: sinon.stub().returns(true),
          safeMkdtempSync: sinon.stub(),
          safeRmSync: sinon.stub(),
          safeSpawnSync,
        },
      },
    );
    const sections = dosaiMethodsSectionsArgument();
    assert.strictEqual(
      sections,
      "Metadata,Dependencies,MethodCalls,AssemblyInformation,CallGraph,PackageReachability,Services,ApiEndpoints,AiComponents",
    );
    assert.strictEqual(
      runDosaiCommand("crypto", "/tmp/project", "/tmp/out.json"),
      true,
    );
    assert.deepStrictEqual(safeSpawnSync.firstCall.args[1], [
      "crypto",
      "--path",
      resolve("/tmp/project"),
      "--o",
      resolve("/tmp/out.json"),
      "--format",
      "dosai",
      "--crypto-dataflows",
      "none",
    ]);
    assert.strictEqual(
      runDosaiCommand("methods", "/tmp/project", "/tmp/out.json", {
        dosaiMethodsSections: sections,
      }),
      true,
    );
    assert.deepStrictEqual(safeSpawnSync.secondCall.args[1], [
      "methods",
      "--path",
      resolve("/tmp/project"),
      "--o",
      resolve("/tmp/out.json"),
      "--sections",
      sections,
    ]);
    // Without dosaiMethodsSections the methods report stays full: evinse's
    // usages run passes no sections because it persists what it reads.
    assert.strictEqual(
      runDosaiCommand("methods", "/tmp/project", "/tmp/out.json"),
      true,
    );
    assert.deepStrictEqual(safeSpawnSync.thirdCall.args[1], [
      "methods",
      "--path",
      resolve("/tmp/project"),
      "--o",
      resolve("/tmp/out.json"),
    ]);
    // A value that is not a list of plain section names never reaches the
    // command line: the report stays full instead.
    for (const unsafe of [
      "Metadata;CallGraph",
      "Metadata,Call Graph",
      "Metadata,",
      "--o,x",
      "Metadata\nCallGraph",
      ["Metadata"],
    ]) {
      safeSpawnSync.resetHistory();
      assert.strictEqual(
        runDosaiCommand("methods", "/tmp/project", "/tmp/out.json", {
          dosaiMethodsSections: unsafe,
        }),
        true,
      );
      assert.ok(
        !safeSpawnSync.firstCall.args[1].includes("--sections"),
        `${JSON.stringify(unsafe)} must not be passed to dosai`,
      );
    }
  });

  it("reruns without every optional flag dosai rejected, and remembers them per executable", async () => {
    // dosai 4.1.0 prints one Unrecognized line per unknown token and one for
    // its value; --exclude and a size-only flag must both go in one retry,
    // the exclude loss warns, and later calls skip them without trying. Each
    // case uses its own executable because the memo is per executable.
    const rejection = (flag) =>
      `Unrecognized command or argument '${flag}'.\n` +
      `Unrecognized command or argument 'value-of-${flag.slice(2)}'.\n`;
    const safeSpawnSync = sinon.stub();
    safeSpawnSync
      .onCall(0)
      .returns({ status: 1, stderr: rejection("--sections") });
    safeSpawnSync.onCall(1).returns({ status: 0 });
    safeSpawnSync
      .onCall(2)
      .returns({ status: 1, stderr: rejection("--crypto-dataflows") });
    safeSpawnSync.onCall(3).returns({ status: 0 });
    safeSpawnSync.onCall(4).returns({
      status: 1,
      stderr: rejection("--sections") + rejection("--exclude"),
    });
    safeSpawnSync.onCall(5).returns({ status: 0 });
    const { runDosaiCommand } = await esmock("./dosai.js", {
      "./plugins.js": {
        resolvePluginBinary: sinon.stub().returns("dosai"),
      },
      "../core/activity.js": { DEBUG_MODE: true },
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns("/tmp"),
        safeExistsSync: sinon.stub().returns(true),
        safeMkdtempSync: sinon.stub(),
        safeRmSync: sinon.stub(),
        safeSpawnSync,
      },
    });
    const debug = sinon.stub(console, "log");
    const warn = sinon.stub(console, "warn");
    try {
      // --sections alone.
      assert.strictEqual(
        runDosaiCommand("methods", "/tmp/project", "/tmp/out.json", {
          dosaiCommand: "/tmp/dosai-sections",
          dosaiMethodsSections: "Metadata,CallGraph",
        }),
        true,
      );
      // --crypto-dataflows alone.
      assert.strictEqual(
        runDosaiCommand("crypto", "/tmp/project", "/tmp/out.json", {
          dosaiCommand: "/tmp/dosai-crypto",
        }),
        true,
      );
      // --exclude together with a size flag: both rejected in one run, one
      // retry drops both.
      assert.strictEqual(
        runDosaiCommand("methods", "/tmp/project", "/tmp/out.json", {
          dosaiCommand: "/tmp/dosai-both",
          dosaiMethodsSections: "Metadata,CallGraph",
          exclude: ["BuildOutput/**"],
        }),
        true,
      );
    } finally {
      debug.restore();
      warn.restore();
    }
    // One retry per rejected run, never more: six calls for three runs.
    assert.strictEqual(safeSpawnSync.callCount, 6);
    const sectionsRetry = safeSpawnSync.getCall(1).args[1];
    assert.ok(!sectionsRetry.includes("--sections"));
    const cryptoRetry = safeSpawnSync.getCall(3).args[1];
    assert.ok(!cryptoRetry.includes("--crypto-dataflows"));
    const bothRetry = safeSpawnSync.getCall(5).args[1];
    assert.ok(!bothRetry.includes("--sections"));
    assert.ok(!bothRetry.includes("--exclude"));
    // The memo: the next call of the same binary passes none of them and
    // still runs only once. The per-call rejection behaviors must go so the
    // fresh call count starts from a plain successful stub.
    safeSpawnSync.resetHistory();
    safeSpawnSync.resetBehavior();
    safeSpawnSync.returns({ status: 0 });
    assert.strictEqual(
      runDosaiCommand("methods", "/tmp/project", "/tmp/out.json", {
        dosaiCommand: "/tmp/dosai-both",
        dosaiMethodsSections: "Metadata,CallGraph",
        exclude: ["BuildOutput/**"],
      }),
      true,
    );
    sinon.assert.calledOnce(safeSpawnSync);
    const memoCall = safeSpawnSync.firstCall.args[1];
    assert.ok(!memoCall.includes("--sections"));
    assert.ok(!memoCall.includes("--exclude"));
    // Dropping --exclude changes what dosai analyses, so it warns; the
    // size-only flags are a debug line.
    sinon.assert.calledOnce(warn);
    assert.match(warn.firstCall.args[0], /does not support --exclude/);
    const debugLines = debug
      .getCalls()
      .map((call) => call.args.join(" "))
      .join("\n");
    assert.match(
      debugLines,
      /Retrying without the optional dosai flag\(s\) it rejected: --sections/,
    );
  });

  it("does not rerun dosai when a rejected token is not an optional flag of this run", async () => {
    const safeSpawnSync = sinon.stub().returns({
      status: 1,
      stderr: "Unrecognized command or argument '--path'.",
    });
    const { runDosaiCommand } = await esmock("./dosai.js", {
      "./plugins.js": {
        resolvePluginBinary: sinon.stub().returns("dosai"),
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
      runDosaiCommand("methods", "/tmp/project", "/tmp/out.json", {
        dosaiMethodsSections: "Metadata,CallGraph",
      }),
      false,
    );
    sinon.assert.calledOnce(safeSpawnSync);
  });

  // A shell script stands in for dosai, and runDosaiCommand spawns without a
  // shell, which Windows cannot do for a script.
  (process.platform === "win32" ? it.skip : it)(
    "records the call of a dosai build that accepts the optional flags",
    async () => {
      // Positive control for the rejection tests above: a real executable that
      // accepts the flags writes the output file, which proves the spawn path
      // and the flag wiring run at all, not only against stubs.
      const runDir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-accept-"));
      try {
        const fakeDosai = join(runDir, "dosai-accepts-flags");
        writeFileSync(
          fakeDosai,
          [
            "#!/bin/sh",
            "# fake dosai that records its arguments and writes a report",
            'echo "$@" > "$0.args"',
            'out=""',
            'prev=""',
            'for arg in "$@"; do',
            '  if [ "$prev" = "--o" ]; then out="$arg"; fi',
            '  prev="$arg"',
            "done",
            `printf '{"Metadata":{"Tool":"Dosai","OmittedSections":["Methods"]}}' > "$out"`,
            "exit 0",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        const { runDosaiCommand } = await import("./dosai.js");
        const outputFile = join(runDir, "methods.json");
        assert.strictEqual(
          runDosaiCommand("methods", runDir, outputFile, {
            dosaiCommand: fakeDosai,
            dosaiMethodsSections: "Metadata,CallGraph",
          }),
          true,
        );
        assert.strictEqual(
          readFileSync(`${fakeDosai}.args`, "utf-8").trim(),
          `methods --path ${runDir} --o ${outputFile} --sections Metadata,CallGraph`,
        );
        assert.match(
          readFileSync(outputFile, "utf-8"),
          /"OmittedSections":\["Methods"\]/,
        );
      } finally {
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  );

  it("reads what a report file omitted from its Metadata alone", async () => {
    const { dosaiReportFileOmittedSections, dosaiSectionsCdxgenReads } =
      await import("./dosai.js");
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-omitted-"));
    try {
      // Cut off after Metadata: only the head of the file may be read.
      const trimmed = join(dir, "trimmed.json");
      writeFileSync(
        trimmed,
        '{"Metadata":{"Tool":"Dosai","OmittedSections":["Methods","MethodCalls"]},"CallGraph":{"Nodes":[',
      );
      assert.deepStrictEqual(dosaiReportFileOmittedSections(trimmed), [
        "Methods",
        "MethodCalls",
      ]);
      const full = join(dir, "full.json");
      writeFileSync(full, '{"Metadata":{"Tool":"Dosai"},"Methods":[]}');
      assert.deepStrictEqual(dosaiReportFileOmittedSections(full), []);
      assert.deepStrictEqual(
        dosaiReportFileOmittedSections(join(dir, "missing.json")),
        [],
      );
      const broken = join(dir, "broken.json");
      writeFileSync(broken, '{"Metadata":{"Tool":');
      assert.deepStrictEqual(dosaiReportFileOmittedSections(broken), []);
      // Only MethodCalls is an input of cdxgen's evidence.
      assert.deepStrictEqual(
        dosaiSectionsCdxgenReads(["Methods", "MethodCalls", "DeadCode"]),
        ["MethodCalls"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers whether a scan runs evidence analysis, and what a report omitted", async () => {
    const { runsEvidenceAnalysis, dosaiOmittedSections } = await import(
      "./dosai.js"
    );
    // --include-crypto alone runs evinse too, which is the whole point of the
    // shared helper: testing evidence alone would trim a report the scan then
    // needs full.
    assert.strictEqual(runsEvidenceAnalysis({}), false);
    assert.strictEqual(runsEvidenceAnalysis({ evidence: true }), true);
    assert.strictEqual(runsEvidenceAnalysis({ includeCrypto: true }), true);
    assert.strictEqual(
      runsEvidenceAnalysis({ evidence: true, includeCrypto: true }),
      true,
    );
    assert.strictEqual(runsEvidenceAnalysis(undefined), false);
    // A dosai v4 report has no OmittedSections and counts as full.
    assert.deepStrictEqual(
      dosaiOmittedSections({ Metadata: { Tool: "Dosai" } }),
      [],
    );
    assert.deepStrictEqual(dosaiOmittedSections(undefined), []);
    assert.deepStrictEqual(
      dosaiOmittedSections({
        Metadata: { OmittedSections: ["Methods", "Reachability"] },
      }),
      ["Methods", "Reachability"],
    );
  });

  it("persists the combined native dosai report to semanticsSlicesFile when provided", () => {
    // Under --profile research, evinse passes --semantics-slices-file to the
    // dosai branch; persistDosaiSemanticsReport must write the FULL combined
    // native report {Metadata, methods, dataflows} there and keep it, so
    // downstream tools (depscan) read it as the source of truth. The
    // intermediate methods/dataflows slice files are owned by evinse's
    // createSlice; this helper only persists the combined report.
    const durableDir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-durable-"));
    const durablePath = join(durableDir, "dotnet-semantics.slices.json");
    const methodsSlice = {
      Metadata: {
        SchemaVersion: "3.3.0",
        AnalyzerVersion: "3.0.5.0",
        Tool: "Dosai",
      },
      CallGraph: { Nodes: [], Edges: [] },
      ApiEndpoints: [],
      PackageReachability: [
        {
          Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
          Reachable: true,
          ReachabilityKind: "Dependency",
          Confidence: "Low",
          SourceLocations: [],
        },
      ],
    };
    const dataFlowSlice = {
      Metadata: {
        SchemaVersion: "3.3.0",
        AnalyzerVersion: "3.0.5.0",
        Tool: "Dosai",
      },
      Nodes: [],
      Edges: [],
      Slices: [
        {
          Id: "dfs1",
          SinkPurl: "pkg:nuget/Newtonsoft.Json",
          Purls: ["pkg:nuget/Newtonsoft.Json"],
        },
      ],
      PackageReachability: [
        {
          Purl: "pkg:nuget/Newtonsoft.Json",
          Reachable: true,
          ReachabilityKind: "DataFlowNode",
          Confidence: "High",
          SourceLocations: [
            { Path: "Program.cs", FileName: "Program.cs", LineNumber: 10 },
          ],
        },
      ],
    };
    try {
      const persisted = persistDosaiSemanticsReport(
        { semanticsSlicesFile: durablePath },
        methodsSlice,
        dataFlowSlice,
      );
      // the durable file persists on disk with the combined native report
      assert.strictEqual(persisted, durablePath);
      assert.ok(existsSync(durablePath), "durable report file must persist");
      const report = JSON.parse(readFileSync(durablePath, "utf-8"));
      // native PascalCase Metadata (taken from the richest data-flow slice)
      assert.strictEqual(report.Metadata?.Tool, "Dosai");
      assert.strictEqual(report.Metadata?.SchemaVersion, "3.3.0");
      assert.ok(report.methods, "persisted report must carry methods");
      assert.ok(report.dataflows, "persisted report must carry dataflows");
      assert.ok(
        report.dataflows.PackageReachability?.length,
        "persisted dataflows must carry PackageReachability",
      );
      assert.ok(
        report.dataflows.Slices?.length,
        "persisted dataflows must carry Slices",
      );
    } finally {
      rmSync(durableDir, { recursive: true, force: true });
    }
  });

  it("persistDosaiSemanticsReport returns undefined and writes nothing when both slices are empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-empty-"));
    const durablePath = join(dir, "dotnet-semantics.slices.json");
    try {
      const result = persistDosaiSemanticsReport(
        { semanticsSlicesFile: durablePath },
        {},
        undefined,
      );
      assert.strictEqual(result, undefined);
      assert.ok(
        !existsSync(durablePath),
        "no report should be written when both slices are empty",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persistDosaiSemanticsReport still writes a trimmed methods report and records the degradation", async () => {
    // A user-supplied usages slice written with --sections is the user's
    // choice: evinse still persists it, but the ledger says what is missing
    // because downstream tools read this file as the complete native report.
    const { getLedgerEvents, resetLedgerEvents } = await import(
      "../core/buildLedger.js"
    );
    const savedIntrospect = process.env.CDXGEN_INTROSPECT;
    process.env.CDXGEN_INTROSPECT = "true";
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-trimmed-persist-"));
    const durablePath = join(dir, "dotnet-semantics.slices.json");
    const trimmedMethodsSlice = {
      Metadata: {
        SchemaVersion: "5.1.0",
        Tool: "Dosai",
        OmittedSections: ["Methods", "Reachability", "DeadCode"],
      },
      CallGraph: { Nodes: [], Edges: [] },
    };
    try {
      resetLedgerEvents();
      const persisted = persistDosaiSemanticsReport(
        { semanticsSlicesFile: durablePath },
        trimmedMethodsSlice,
        undefined,
      );
      assert.strictEqual(persisted, durablePath);
      assert.ok(existsSync(durablePath), "the partial report is still written");
      const report = JSON.parse(readFileSync(durablePath, "utf-8"));
      assert.deepStrictEqual(report.methods, trimmedMethodsSlice);
      const degradation = getLedgerEvents().find(
        (event) => event.remediationId === "dosai.semantics.trimmed-report",
      );
      assert.ok(degradation, "a trimmed persisted report must be recorded");
      assert.match(degradation.detail, /Methods, Reachability, DeadCode/);
    } finally {
      if (savedIntrospect === undefined) {
        delete process.env.CDXGEN_INTROSPECT;
      } else {
        process.env.CDXGEN_INTROSPECT = savedIntrospect;
      }
      resetLedgerEvents();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persistDosaiSemanticsReport writes nothing when no path is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-none-"));
    try {
      const result = persistDosaiSemanticsReport(
        { semanticsSlicesFile: undefined },
        { Metadata: { Tool: "Dosai" } },
        { Metadata: { Tool: "Dosai" } },
      );
      assert.strictEqual(result, undefined);
      // nothing was written anywhere under the temp dir
      assert.strictEqual(readdirSync(dir).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dosai purls of a package the BOM holds in several versions (dosai#72)", () => {
  // Two projects restore two versions of Moq. A third keeps its restore output
  // in an artifacts layout, outside the project directory.
  const fixture = () => {
    const srcPath = mkdtempSync(join(tmpdir(), "cdxgen-dosai-versions-"));
    const write = (relativePath, text) => {
      const file = join(srcPath, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    };
    write("src/A/A.csproj", "<Project />");
    write("src/A/obj/project.assets.json", "{}");
    write("src/B/B.csproj", "<Project />");
    write("src/B/packages.lock.json", "{}");
    write("src/C/C.csproj", "<Project />");
    write(
      "artifacts/obj/C/project.assets.json",
      JSON.stringify({
        project: {
          restore: { projectPath: join(srcPath, "src", "C", "C.csproj") },
        },
      }),
    );
    // A BOM records manifests relative to the scanned directory
    const srcFile = (value) => [{ name: "internal:SrcFile", value }];
    const components = [
      {
        purl: "pkg:nuget/Moq@4.18.4",
        properties: srcFile("src/A/obj/project.assets.json"),
      },
      {
        purl: "pkg:nuget/Moq@4.20.69",
        properties: srcFile("src/B/packages.lock.json"),
      },
      {
        purl: "pkg:nuget/Moq@4.16.0",
        properties: srcFile("artifacts/obj/C/project.assets.json"),
      },
      { purl: "pkg:nuget/Serilog@3.1.1", properties: [] },
    ];
    return { srcPath, components };
  };

  it("matches by exact purl, then version, then the project of the record's file", () => {
    const { srcPath, components } = fixture();
    try {
      const aliases = buildPurlAliasMap(components, { srcPath });
      assert.strictEqual(
        resolveComponentPurl("pkg:nuget/Moq@4.20.69", aliases),
        "pkg:nuget/Moq@4.20.69",
      );
      // Ids compare case-insensitively
      assert.strictEqual(
        resolveComponentPurl("pkg:nuget/moq@4.18.4", aliases),
        "pkg:nuget/Moq@4.18.4",
      );
      // A versionless purl names no version: the file's project does
      assert.strictEqual(
        resolveComponentPurl("pkg:nuget/Moq", aliases, "src/A/Tests.cs#3"),
        "pkg:nuget/Moq@4.18.4",
      );
      assert.strictEqual(
        resolveComponentPurl("pkg:nuget/Moq", aliases, "src/B/Tests.cs"),
        "pkg:nuget/Moq@4.20.69",
      );
      // A version the BOM lacks is settled the same way
      assert.strictEqual(
        resolveComponentPurl("pkg:nuget/Moq@4.0.0", aliases, "src/B/Tests.cs"),
        "pkg:nuget/Moq@4.20.69",
      );
      // The artifacts layout's assets file names its project
      assert.strictEqual(
        resolveComponentPurl("pkg:nuget/Moq", aliases, "src/C/Program.cs#9"),
        "pkg:nuget/Moq@4.16.0",
      );
      // Nothing settles it: no version rather than the first one listed
      assert.strictEqual(
        resolveComponentPurl("pkg:nuget/Moq", aliases),
        undefined,
      );
      assert.strictEqual(
        resolveComponentPurl("pkg:nuget/Moq", aliases, "tools/Other.cs"),
        undefined,
      );
      // One version in the BOM is that version
      assert.strictEqual(
        resolveComponentPurl("pkg:nuget/Serilog", aliases),
        "pkg:nuget/Serilog@3.1.1",
      );
      // Whole names only: no prefix or last-segment aliasing
      assert.strictEqual(
        resolveComponentPurl("pkg:nuget/Moq.AutoMock", aliases),
        "pkg:nuget/Moq.AutoMock",
      );
    } finally {
      rmSync(srcPath, { recursive: true, force: true });
    }
  });

  it("attaches each reachability fact to the version of its own project, exact facts first", () => {
    const { srcPath, components } = fixture();
    try {
      const methodsSlice = {
        CallGraph: {
          Edges: [
            {
              Id: "e1",
              Path: "src/A/Tests.cs",
              FileName: "Tests.cs",
              LineNumber: 5,
            },
          ],
          Nodes: [],
        },
        PackageReachability: [
          // An unrestored project's versionless purl, spanning two projects
          {
            Purl: "pkg:nuget/Moq",
            ReachabilityKind: "ImportedOnly",
            Confidence: "Low",
            EdgeIds: ["e1"],
            SourceLocations: [
              { Path: "src/B/Tests.cs", FileName: "Tests.cs", LineNumber: 8 },
            ],
          },
          {
            Purl: "pkg:nuget/Moq@4.20.69",
            ReachabilityKind: "Reachable",
            Confidence: "High",
          },
        ],
      };
      const enriched = applyDosaiReachabilityEvidence(
        methodsSlice,
        components,
        {
          srcPath,
        },
      );
      assert.strictEqual(enriched, 2);
      const kindOf = (purl) =>
        components
          .find((component) => component.purl === purl)
          .properties?.find((p) => p.name === "cdx:dosai:reachability:kind")
          ?.value;
      // The fact naming B's exact purl wins over the versionless one
      assert.strictEqual(kindOf("pkg:nuget/Moq@4.20.69"), "Reachable");
      assert.strictEqual(kindOf("pkg:nuget/Moq@4.18.4"), "ImportedOnly");
      // The project nobody's location points at is left alone
      assert.strictEqual(kindOf("pkg:nuget/Moq@4.16.0"), undefined);
    } finally {
      rmSync(srcPath, { recursive: true, force: true });
    }
  });

  it("collects occurrences and data-flow frames per project", () => {
    const { srcPath, components } = fixture();
    try {
      const evidence = collectDosaiPurlEvidence(
        {
          Dependencies: [
            { Purl: "pkg:nuget/Moq", Path: "src/A/Tests.cs", LineNumber: 3 },
            { Purl: "pkg:nuget/Moq", Path: "src/B/Tests.cs", LineNumber: 4 },
            { Purl: "pkg:nuget/Moq", Path: "Shared.cs", LineNumber: 5 },
          ],
        },
        components,
        { srcPath },
      );
      assert.deepStrictEqual(
        [...evidence.purlLocationMap["pkg:nuget/Moq@4.18.4"]],
        ["src/A/Tests.cs#3"],
      );
      assert.deepStrictEqual(
        [...evidence.purlLocationMap["pkg:nuget/Moq@4.20.69"]],
        ["src/B/Tests.cs#4"],
      );
      // A file outside every project is not given to any version
      assert.strictEqual(evidence.purlLocationMap["pkg:nuget/Moq"], undefined);
      // Frames inside the package name no source file: they belong to the
      // version the fact's own locations settled, and to none when those span
      // two projects.
      const library = collectDosaiPurlEvidence(
        {
          CallGraph: {
            Edges: [],
            Nodes: [
              {
                Id: "lib1",
                FileName: "Moq.dll",
                ClassName: "Mock",
                Name: "Setup",
              },
              {
                Id: "lib2",
                FileName: "Moq.dll",
                ClassName: "It",
                Name: "IsAny",
              },
            ],
          },
          PackageReachability: [
            {
              Purl: "pkg:nuget/Moq",
              SourceLocations: [{ Path: "src/B/Tests.cs", LineNumber: 8 }],
              NodeIds: ["lib1"],
            },
            {
              Purl: "pkg:nuget/Moq",
              SourceLocations: [
                { Path: "src/A/Tests.cs", LineNumber: 2 },
                { Path: "src/B/Other.cs", LineNumber: 4 },
              ],
              NodeIds: ["lib2"],
            },
          ],
        },
        components,
        { srcPath },
      );
      assert.deepStrictEqual(
        [...library.purlModulesMap["pkg:nuget/Moq@4.20.69"]],
        ["Mock"],
      );
      assert.strictEqual(
        library.purlModulesMap["pkg:nuget/Moq@4.18.4"],
        undefined,
      );
      const frames = collectDosaiDataFlowFrames(
        {
          Nodes: [
            // A frame without a source file is skipped
            { Id: "n0", FileName: "<unknown>", Name: "Lambda" },
            { Id: "n1", Path: "src/C/Program.cs", LineNumber: 9, Name: "Main" },
            { Id: "n2", Path: "src/B/Tests.cs", LineNumber: 2, Name: "Run" },
          ],
          Slices: [
            { SourcePurl: "pkg:nuget/Moq", NodeIds: ["n0", "n1", "n2"] },
          ],
        },
        components,
        { srcPath },
      );
      assert.deepStrictEqual(Object.keys(frames), ["pkg:nuget/Moq@4.16.0"]);
    } finally {
      rmSync(srcPath, { recursive: true, force: true });
    }
  });
});

describe("dosai launch failures and tool attribution", () => {
  // What the .NET host prints when the installed runtime is older than the
  // one dosai targets, and when it finds no .NET at all.
  const runtimeTooOld =
    "You must install or update .NET to run this application.\n\nApp: /opt/dosai/dosai\nArchitecture: arm64\nFramework: 'Microsoft.NETCore.App', version '11.0.0-rc.2.26504.105' (arm64)\n.NET location: /usr/share/dotnet\n\nThe following frameworks were found:\n  10.0.13 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]\n";
  const noDotnet =
    "You must install .NET to run this application.\n\nApp: /opt/dosai/dosai\nArchitecture: arm64\nApp host version: 11.0.0-rc.2.26504.105\n.NET location: Not found\n";

  const manifestComponent = {
    type: "application",
    name: "dosai",
    version: "4.1.0",
    description: "Dotnet Source and Assembly Inspector",
    purl: "pkg:github/owasp-dep-scan/dosai@4.1.0",
    "bom-ref": "pkg:github/owasp-dep-scan/dosai@4.1.0",
    licenses: [{ license: { id: "MIT" } }],
    externalReferences: [
      { type: "vcs", url: "https://github.com/owasp-dep-scan/dosai" },
    ],
    properties: [
      {
        name: "internal:binary_path",
        value: "plugins/dosai/dosai-linux-amd64",
      },
    ],
    hashes: [{ alg: "SHA-256", content: "74a218d2" }],
  };

  const loadDosai = async (env, spawn) =>
    esmock("./dosai.js", {
      "./plugins.js": {
        resolvePluginBinary: () =>
          env.DOSAI_CMD || "/plugins/dosai/dosai-linux-amd64",
      },
      "../core/activity.js": {
        DEBUG_MODE: false,
        readEnvironmentVariable: (name) => env[name],
      },
      "../core/fs.js": {
        getTmpDir: () => "/tmp",
        safeExistsSync: () => true,
        safeMkdtempSync: sinon.stub(),
        safeRmSync: sinon.stub(),
        safeSpawnSync: spawn,
      },
    });

  it("reads the .NET runtime dosai needs from the host's launch failure", () => {
    assert.deepStrictEqual(
      dosaiDotnetRequirement({
        status: 150,
        stdout: "",
        stderr: runtimeTooOld,
      }),
      { version: "11.0.0-rc.2.26504.105", major: "11" },
    );
    assert.deepStrictEqual(dosaiDotnetRequirement(noDotnet), {
      version: undefined,
      major: "11",
    });
    assert.strictEqual(
      dosaiDotnetRequirement({ status: 1, stderr: "Unhandled exception." }),
      undefined,
    );
    assert.strictEqual(dosaiDotnetRequirement(undefined), undefined);
    assert.strictEqual(
      dosaiDotnetRequirementDetail(dosaiDotnetRequirement(runtimeTooOld)),
      "dosai needs the .NET runtime 11.0.0-rc.2.26504.105 or newer, which is not installed",
    );
    assert.strictEqual(
      dosaiDotnetRequirementDetail(dosaiDotnetRequirement(noDotnet)),
      "dosai needs the .NET 11 runtime, and no .NET installation was found",
    );
    assert.match(
      dosaiDotnetRequirementDetail({}),
      /could not start because the \.NET runtime it needs is not installed/,
    );
    assert.match(
      dosaiDotnetRequirementAdvice({ major: "11" }),
      /^Install the \.NET 11 runtime or SDK from .* set DOSAI_CMD to its path\.$/,
    );
    assert.match(
      dosaiDotnetRequirementAdvice(undefined),
      /^Install the \.NET runtime or SDK from /,
    );
  });

  it("names the missing .NET runtime once per scan and marks the failure as reported", async () => {
    const spawn = sinon
      .stub()
      .returns({ status: 150, stdout: "", stderr: runtimeTooOld });
    const recordDegradation = sinon.stub();
    const { dosaiFailureReported, dosaiRunWasStopped, runDosaiCommand } =
      await esmock("./dosai.js", {
        "./plugins.js": { resolvePluginBinary: () => "/opt/dosai/dosai" },
        "../core/activity.js": { DEBUG_MODE: false },
        "../core/buildLedger.js": { recordDegradation },
        "../core/fs.js": {
          getTmpDir: () => "/tmp",
          safeExistsSync: () => true,
          safeMkdtempSync: sinon.stub(),
          safeRmSync: sinon.stub(),
          safeSpawnSync: spawn,
        },
      });
    const warn = sinon.stub(console, "warn");
    const log = sinon.stub(console, "log");
    try {
      for (const command of ["methods", "dataflows", "crypto"]) {
        assert.strictEqual(
          runDosaiCommand(command, "/tmp/project", `/tmp/${command}.json`),
          false,
        );
      }
      // Any other failure is not one the warning explained
      spawn.returns({ status: 1, stdout: "", stderr: "Unhandled exception." });
      assert.strictEqual(
        runDosaiCommand("methods", "/tmp/project", "/tmp/other.json"),
        false,
      );
      // A run that writes its output clears the earlier failure
      spawn.returns({ status: 0 });
      assert.strictEqual(
        runDosaiCommand("crypto", "/tmp/project", "/tmp/crypto.json"),
        true,
      );
    } finally {
      warn.restore();
      log.restore();
    }
    sinon.assert.calledOnce(warn);
    assert.match(
      warn.firstCall.args[0],
      /^WARNING: dosai needs the \.NET runtime 11\.0\.0-rc\.2\.26504\.105 or newer, which is not installed, so dosai could not run/,
    );
    assert.match(warn.firstCall.args[0], /Install the \.NET 11 runtime or SDK/);
    assert.match(warn.firstCall.args[0], /DOSAI_CMD/);
    sinon.assert.notCalled(log);
    sinon.assert.calledThrice(recordDegradation);
    const [kind, fields] = recordDegradation.firstCall.args;
    assert.strictEqual(kind, "dotnet.sdk.missing");
    assert.match(fields.detail, /\.NET runtime 11\.0\.0-rc\.2\.26504\.105/);
    assert.strictEqual(dosaiFailureReported("/tmp/methods.json"), true);
    assert.strictEqual(dosaiFailureReported("/tmp/dataflows.json"), true);
    assert.strictEqual(dosaiRunWasStopped("/tmp/methods.json"), false);
    assert.strictEqual(dosaiFailureReported("/tmp/other.json"), false);
    assert.strictEqual(dosaiFailureReported("/tmp/crypto.json"), false);
  });

  it("does not repeat a launch failure the pregen check already reported", async () => {
    const spawn = sinon
      .stub()
      .returns({ status: 131, stdout: "", stderr: noDotnet });
    const {
      dosaiFailureReported,
      markDosaiLaunchFailureReported,
      runDosaiCommand,
    } = await loadDosai({ DOSAI_CMD: "/opt/dosai/dosai" }, spawn);
    markDosaiLaunchFailureReported("/opt/dosai/dosai");
    const warn = sinon.stub(console, "warn");
    try {
      assert.strictEqual(
        runDosaiCommand("methods", "/tmp/project", "/tmp/methods.json"),
        false,
      );
    } finally {
      warn.restore();
    }
    sinon.assert.notCalled(warn);
    assert.strictEqual(dosaiFailureReported("/tmp/methods.json"), true);
  });

  it("names the dosai that wrote a report, with the version that binary reports", async () => {
    const env = {};
    const versionOutput = {
      "/opt/dosai/dosai":
        "5.0.0-rc.2+e42b205365fe0ae8936574b73dbbbb1c75acf1a9\n",
      "/plugins/dosai/dosai-linux-amd64":
        "4.1.0+3a42f24aa9b1b5ccfebc911ddff1d17aa2e94226\r\n",
    };
    const spawn = sinon
      .stub()
      .callsFake((executable, args) =>
        args[0] === "--version"
          ? { status: 0, stdout: versionOutput[executable] }
          : { status: 0 },
      );
    const { dosaiToolComponents, runDosaiCommand } = await loadDosai(
      env,
      spawn,
    );
    const rcReport = {
      Metadata: { Tool: "Dosai", AnalyzerVersion: "5.0.0.0" },
    };

    // A DOSAI_CMD build is recorded as itself, without the bundled binary's
    // hashes, path or attestation
    env.DOSAI_CMD = "/opt/dosai/dosai";
    assert.ok(runDosaiCommand("methods", "/tmp/project", "/tmp/override.json"));
    assert.deepStrictEqual(
      dosaiToolComponents("/tmp/override.json", rcReport, manifestComponent),
      [
        {
          type: "application",
          name: "dosai",
          version: "5.0.0-rc.2",
          description: "Dotnet Source and Assembly Inspector",
          purl: "pkg:github/owasp-dep-scan/dosai@5.0.0-rc.2",
          "bom-ref": "pkg:github/owasp-dep-scan/dosai@5.0.0-rc.2",
          licenses: [{ license: { id: "MIT" } }],
          externalReferences: [
            { type: "vcs", url: "https://github.com/owasp-dep-scan/dosai" },
          ],
        },
      ],
    );

    // The bundled binary at the manifest's version is the manifest component
    delete env.DOSAI_CMD;
    assert.ok(runDosaiCommand("methods", "/tmp/project", "/tmp/bundled.json"));
    assert.deepStrictEqual(
      dosaiToolComponents(
        "/tmp/bundled.json",
        { Metadata: { Tool: "Dosai", AnalyzerVersion: "4.1.0.0" } },
        manifestComponent,
      ),
      [manifestComponent],
    );

    // Each executable is asked for its version once
    assert.strictEqual(
      spawn.getCalls().filter((call) => call.args[1][0] === "--version").length,
      2,
    );
  });

  it("lists no dosai for a run that failed, and credits a reused report to the dosai that wrote it", async () => {
    const env = { DOSAI_CMD: "/opt/dosai/dosai" };
    const spawn = sinon.stub().callsFake((_executable, args) => {
      if (args[0] === "--version") {
        return { status: 0, stdout: "5.0.0-rc.2+e42b205\n" };
      }
      return env.runFails
        ? { status: 150, stdout: "", stderr: runtimeTooOld }
        : { status: 0 };
    });
    const { dosaiToolComponents, runDosaiCommand } = await loadDosai(
      env,
      spawn,
    );
    const warn = sinon.stub(console, "warn");
    try {
      env.runFails = true;
      assert.strictEqual(
        runDosaiCommand("methods", "/tmp/project", "/tmp/failed.json"),
        false,
      );
    } finally {
      warn.restore();
    }
    assert.deepStrictEqual(
      dosaiToolComponents("/tmp/failed.json", undefined, manifestComponent),
      [],
    );

    // A report left by an older dosai names that dosai, not the configured one
    const [older] = dosaiToolComponents(
      "/tmp/reused-410.json",
      { Metadata: { Tool: "Dosai", AnalyzerVersion: "4.1.0.0" } },
      manifestComponent,
    );
    assert.strictEqual(older.version, "4.1.0");
    assert.strictEqual(older.purl, "pkg:github/owasp-dep-scan/dosai@4.1.0");
    assert.strictEqual(older.hashes, undefined);

    // A report of the configured dosai's own release names its prerelease
    const [own] = dosaiToolComponents(
      "/tmp/reused-5.json",
      { Metadata: { Tool: "Dosai", AnalyzerVersion: "5.0.0.0" } },
      manifestComponent,
    );
    assert.strictEqual(own.version, "5.0.0-rc.2");

    // A file without dosai Metadata names no tool
    assert.deepStrictEqual(
      dosaiToolComponents("/tmp/other.json", { Dependencies: [] }),
      [],
    );
  });

  it("falls back to the version a report records when the binary reports none", async () => {
    const spawn = sinon
      .stub()
      .callsFake((_executable, args) =>
        args[0] === "--version"
          ? { status: 0, stdout: "dosai\n" }
          : { status: 0 },
      );
    const { dosaiToolComponents, runDosaiCommand } = await loadDosai(
      { DOSAI_CMD: "/opt/dosai/dosai" },
      spawn,
    );
    assert.ok(runDosaiCommand("methods", "/tmp/project", "/tmp/methods.json"));
    const [fromReport] = dosaiToolComponents("/tmp/methods.json", {
      Metadata: { Tool: "Dosai", AnalyzerVersion: "5.0.0.0" },
    });
    assert.strictEqual(fromReport.version, "5.0.0");
    const [unversioned] = dosaiToolComponents("/tmp/methods.json");
    assert.strictEqual(unversioned.version, undefined);
    assert.strictEqual(unversioned.purl, "pkg:github/owasp-dep-scan/dosai");
  });
});

describe("dosaiSlicesFileIsFresh()", () => {
  const futureTime = (offsetMs = 60_000) => new Date(Date.now() + offsetMs);

  const writeSource = (dir, name, content = "// source\n") => {
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
  };

  const writeSlice = (dir) => {
    const slicesFile = join(dir, "deps.slices.json");
    writeFileSync(slicesFile, JSON.stringify({ Metadata: { Tool: "Dosai" } }));
    return slicesFile;
  };

  it("is fresh when the slice is newer than every source it describes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-fresh-"));
    try {
      writeSource(dir, "Program.cs", "class Program { }");
      writeSource(dir, "Catalog.csproj", '<Project Sdk="Microsoft.NET.Sdk" />');
      writeSource(dir, "Directory.Build.props", "<Project />");
      const slicesFile = writeSlice(dir);
      assert.strictEqual(dosaiSlicesFileIsFresh(slicesFile, dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is stale when a source is newer than the slice", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-stale-"));
    try {
      writeSource(dir, "Program.cs", "class Program { }");
      const slicesFile = writeSlice(dir);
      // Each of these is a file dosai reads, so any one becoming newer than
      // the slice means the slice may hold occurrences the tree no longer
      // has (issue 4675).
      for (const name of [
        "Program.cs",
        "Catalog.csproj",
        "Directory.Build.props",
        "Directory.Build.targets",
        "Index.razor",
        "Home.cshtml",
        "packages.config",
        "Utility.vb",
        "Module.fs",
      ]) {
        writeSource(dir, name);
        const newer = futureTime();
        utimesSync(join(dir, name), newer, newer);
        assert.strictEqual(
          dosaiSlicesFileIsFresh(slicesFile, dir),
          false,
          `a newer ${name} must make the slice stale`,
        );
        // Older than the slice again, so the next file starts from fresh.
        const older = new Date(Date.now() - 60_000);
        utimesSync(join(dir, name), older, older);
        assert.strictEqual(dosaiSlicesFileIsFresh(slicesFile, dir), true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is stale when the slice or its mtime cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-missing-"));
    try {
      writeSource(dir, "Program.cs", "class Program { }");
      assert.strictEqual(
        dosaiSlicesFileIsFresh(join(dir, "absent.slices.json"), dir),
        false,
      );
      assert.strictEqual(dosaiSlicesFileIsFresh(undefined, dir), false);
      assert.strictEqual(dosaiSlicesFileIsFresh("/no/such/file", dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is fresh when the slice mtime equals the newest source mtime", () => {
    // A slice cdxgen writes in the same run as the scan lands on the same
    // clock as the sources it was made from; equal counts as fresh so the
    // evinse leg of one run still reuses what createCsharpBom wrote.
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-equal-"));
    try {
      writeSource(dir, "Program.cs", "class Program { }");
      const slicesFile = writeSlice(dir);
      const same = new Date();
      utimesSync(slicesFile, same, same);
      utimesSync(join(dir, "Program.cs"), same, same);
      assert.strictEqual(dosaiSlicesFileIsFresh(slicesFile, dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores excluded paths when comparing mtimes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-excluded-"));
    try {
      writeSource(dir, "Program.cs", "class Program { }");
      const slicesFile = writeSlice(dir);
      mkdirSync(join(dir, "Vendor"));
      const vendored = writeSource(join(dir, "Vendor"), "New.cs");
      const newer = futureTime();
      utimesSync(vendored, newer, newer);
      assert.strictEqual(
        dosaiSlicesFileIsFresh(slicesFile, dir),
        false,
        "the vendored source counts while nothing excludes it",
      );
      assert.strictEqual(
        dosaiSlicesFileIsFresh(slicesFile, dir, { exclude: ["Vendor/**"] }),
        true,
        "an excluded directory must not make the slice stale",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores build output and dependency directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-dosai-skipdirs-"));
    try {
      writeSource(dir, "Program.cs", "class Program { }");
      const slicesFile = writeSlice(dir);
      // dosai's own walk skips bin and obj (build output), node_modules
      // (dependency folder), and .git (version control), so a build or a
      // checkout update between scans cannot make a slice stale.
      for (const subdir of ["bin", "obj", "node_modules", ".git"]) {
        mkdirSync(join(dir, subdir));
        const file = writeSource(join(dir, subdir), "Generated.cs");
        const newer = futureTime();
        utimesSync(file, newer, newer);
        assert.strictEqual(
          dosaiSlicesFileIsFresh(slicesFile, dir),
          true,
          `a newer ${subdir}/Generated.cs must not make the slice stale`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  dosaiRunStopReason,
  dosaiRunTimedOut,
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

    const localModel = components.find(
      (component) => component["bom-ref"] === "ai:model:local/phi-3.gguf",
    );
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

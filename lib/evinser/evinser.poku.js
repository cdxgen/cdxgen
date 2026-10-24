import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fullFormats } from "ajv-formats/dist/formats.js";
import { assert, it } from "poku";

import { normalizeDosaiServiceMap } from "../inventory/dosai.js";
import {
  collectGoServices,
  constructServiceName,
  detectServicesFromOpenAPI,
  detectServicesFromUsages,
  extractEndpoints,
  initFromSbom,
  loadReusableSemanticsSlice,
  mergeAnalyzerMetadataProperties,
  parseSemanticSlices,
  readNamespaceMap,
  sliceFileOption,
} from "./evinser.js";

it("Service detection test", () => {
  const usageSlice = JSON.parse(
    readFileSync("./test/data/usages.json", { encoding: "utf-8" }),
  );
  const objectSlices = usageSlice.objectSlices;
  const servicesMap = {};
  for (const slice of objectSlices) {
    detectServicesFromUsages("java", slice, servicesMap);
    assert.ok(servicesMap);
    const serviceName = constructServiceName("java", slice);
    assert.ok(serviceName);
  }
});

// services[].endpoints is an iri-reference. The OpenAPI and usage detectors
// keep route templates readable; normalizeDosaiServiceMap, which turns every
// evinse service map into services[], percent-encodes them.
it("writes OpenAPI and usage-slice endpoints as URI references", () => {
  const openapiServices = {};
  detectServicesFromOpenAPI(
    "java",
    "./test/data/openapi/openapi-spec.json",
    openapiServices,
  );
  assert.ok(
    openapiServices[
      "service-communityapiv2communityposts{postId}-get"
    ].endpoints.has("/community/api/v2/community/posts/{postId}"),
  );
  const usageServices = {};
  const usageSlice = JSON.parse(
    readFileSync("./test/data/usages.json", { encoding: "utf-8" }),
  );
  for (const slice of usageSlice.objectSlices) {
    detectServicesFromUsages("java", slice, usageServices);
  }
  assert.ok(Object.keys(usageServices).length);
  const services = normalizeDosaiServiceMap({
    ...openapiServices,
    ...usageServices,
  });
  const endpoints = services.flatMap((service) => service.endpoints);
  assert.ok(
    endpoints.includes("/community/api/v2/community/posts/%7BpostId%7D"),
  );
  assert.ok(endpoints.includes("/identity/api/v2/admin/videos/%7Bvideo_id%7D"));
  for (const endpoint of endpoints) {
    assert.ok(fullFormats["uri-reference"].test(endpoint), endpoint);
    assert.ok(!/[{}\s<>]/.test(endpoint), endpoint);
  }
});

it("extract endpoints test", () => {
  assert.deepStrictEqual(
    extractEndpoints("java", '@GetMapping(value = { "/", "/home" })'),
    ["/", "/home"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "java",
      '@PostMapping(value = "/issue", consumes = MediaType.APPLICATION_XML_VALUE)',
    ),
    ["/issue"],
  );
  assert.deepStrictEqual(extractEndpoints("java", '@GetMapping("/token")'), [
    "/token",
  ]);
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      'router.use("/api/v2/users",userRoutes.routes(),userRoutes.allowedMethods())',
    ),
    ["/api/v2/users"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use('/encryptionkeys', serveIndexMiddleware, serveIndex('encryptionkeys', { icons: true, view: 'details' }))",
    ),
    ["/encryptionkeys"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use(express.static(path.resolve('frontend/dist/frontend')))",
    ),
    ["frontend/dist/frontend"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use('/ftp(?!/quarantine)/:file', fileServer())",
    ),
    ["/ftp(?!/quarantine)/:file"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use('/rest/basket/:id', security.isAuthorized())",
    ),
    ["/rest/basket/:id"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.get(['/.well-known/security.txt', '/security.txt'], verify.accessControlChallenges())",
    ),
    ["/.well-known/security.txt", "/security.txt"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      'router.post("/convert",async(ctx:Context):Promise<void>=>{constparameters=ctx.request.body;constbatchClient=newBatchClient({region:"us-west-1"});constcommand=newSubmitJobCommand({jobName:parameters?.jobName,jobQueue:"FOO-ARN",jobDefinition:"BAR-ARN",parameters,});try{constobjectsOutput=awaitbatchClient.send(command);ctx.response.body=objectsOutput;}catch(err){//Poorexceptionhandlingctx.response.body=err;}})',
    ),
    ["/convert"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "java",
      '@RequestMapping(path = "/{name}", method = RequestMethod.GET)',
    ),
    ["/{name}"],
  );
  assert.deepStrictEqual(
    extractEndpoints("java", "@RequestMapping(method = RequestMethod.POST)"),
    [],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "java",
      '@RequestMapping(value = "/{accountName}", method = RequestMethod.GET)',
    ),
    ["/{accountName}"],
  );
});

it("parseSemanticSlices", () => {
  const semanticsSlice = JSON.parse(
    readFileSync("./test/data/swiftsem/semantics.slices.json", {
      encoding: "utf-8",
    }),
  );
  const bomJson = JSON.parse(
    readFileSync("./test/data/swiftsem/bom-hakit.json", {
      encoding: "utf-8",
    }),
  );
  const retMap = parseSemanticSlices(
    "swift",
    bomJson.components,
    semanticsSlice,
  );
  assert.ok(retMap);
});

it("parseSemanticSlices attributes Swift usages through resolved module references", () => {
  // Created by cdxgen from a real build of a package that depends on
  // swift-argument-parser, SWXMLHash, and Yams
  const semanticsSlice = JSON.parse(
    readFileSync("./test/data/swiftsem/semantics-swift-argparser-demo.json", {
      encoding: "utf-8",
    }),
  );
  const { components } = JSON.parse(
    readFileSync("./test/data/swiftsem/bom-argparser-demo-components.json", {
      encoding: "utf-8",
    }),
  );
  const retMap = parseSemanticSlices("swift", components, semanticsSlice);
  const main = "/src/argparser-demo/Sources/argparser-demo/main.swift";
  // swift-argument-parser provides the ArgumentParser module: the import, the
  // ParsableCommand conformance, and the @Option property wrapper
  assert.deepStrictEqual(
    retMap.purlLocationMap[
      "pkg:swift/github.com/apple/swift-argument-parser@1.8.2"
    ],
    [`${main}#1`, `${main}#6`, `${main}#7`],
  );
  assert.deepStrictEqual(
    retMap.purlLocationMap["pkg:swift/github.com/drmohundro/SWXMLHash@7.0.2"],
    [`${main}#12`, `${main}#13`, `${main}#2`],
  );
  // Packages match by repository location, so a different version in the
  // SBOM still resolves; `dump(object:)` is on line 15
  assert.deepStrictEqual(
    retMap.purlLocationMap["pkg:swift/github.com/jpsim/Yams@5.4.0"],
    [`${main}#15`, `${main}#3`],
  );
  // The root package has no purl and gets no evidence
  assert.strictEqual(Object.keys(retMap.purlLocationMap).length, 3);
  // A same-named fork the build did not use gets nothing
  const fork = parseSemanticSlices(
    "swift",
    [{ name: "Yams", purl: "pkg:swift/github.com/someone/Yams@1.0.0" }],
    semanticsSlice,
  );
  assert.deepStrictEqual(fork.purlLocationMap, {});
});

it("parseSemanticSlices tolerates slices without swift symbols", () => {
  // A semantics file from another analyzer (dosai/rusi/golem shape) must not
  // crash the swift evidence flow
  const retMap = parseSemanticSlices(
    "swift",
    [{ name: "Yams", purl: "pkg:swift/github.com/jpsim/Yams@5.4.0" }],
    { Metadata: {}, methods: [], dataflows: [] },
  );
  assert.deepStrictEqual(retMap.purlLocationMap, {});
});

it("loadReusableSemanticsSlice only reuses slices of this project", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "evinse-semantics-"));
  try {
    const bomFile = join(tempDir, "bom.json");
    const slicesFile = join(tempDir, "semantics.slices.json");
    const swiftSlice = readFileSync(
      "./test/data/swiftsem/semantics-swift-argparser-demo.json",
      { encoding: "utf-8" },
    );
    writeFileSync(bomFile, "{}");
    const past = new Date(Date.now() - 60_000);
    utimesSync(bomFile, past, past);
    writeFileSync(slicesFile, swiftSlice);
    // Same project, newer than the SBOM
    assert.ok(
      loadReusableSemanticsSlice(
        "swift",
        slicesFile,
        bomFile,
        "/src/argparser-demo",
      ),
    );
    // Another project's slice left behind in the working directory
    assert.strictEqual(
      loadReusableSemanticsSlice("swift", slicesFile, bomFile, "/src/other"),
      undefined,
    );
    // Older than the SBOM that cdxgen --evidence just wrote
    utimesSync(slicesFile, new Date(past - 60_000), new Date(past - 60_000));
    assert.strictEqual(
      loadReusableSemanticsSlice(
        "swift",
        slicesFile,
        bomFile,
        "/src/argparser-demo",
      ),
      undefined,
    );
    // A dosai report under the default file name is not a swift slice
    writeFileSync(
      slicesFile,
      JSON.stringify({ Metadata: { padding: "x".repeat(2048) }, methods: [] }),
    );
    assert.strictEqual(
      loadReusableSemanticsSlice("swift", slicesFile, bomFile, tempDir),
      undefined,
    );
    // Scala reports belong to the scalasem analyzer, which checks its own;
    // the generic reuse never takes one.
    mkdirSync(join(tempDir, "src", "main", "scala"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "main", "scala", "App.scala"),
      "object App",
    );
    writeFileSync(
      slicesFile,
      JSON.stringify({
        "src/main/scala/App.scala": {
          usedTypes: ["cats.effect.IO"],
          padding: "x".repeat(2048),
        },
      }),
    );
    assert.strictEqual(
      loadReusableSemanticsSlice("scala", slicesFile, bomFile, tempDir),
      undefined,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("names the slice-file option every slice type reads", () => {
  // The CLI declares these flags; yargs camel-cases them before evinse sees
  // them, so a hyphenated slice type has to be camel-cased to match.
  const declared = new Set([
    "usagesSlicesFile",
    "dataFlowSlicesFile",
    "reachablesSlicesFile",
    "semanticsSlicesFile",
  ]);
  for (const sliceType of ["usages", "data-flow", "reachables", "semantics"]) {
    assert.ok(
      declared.has(sliceFileOption(sliceType)),
      `${sliceType} resolves to ${sliceFileOption(sliceType)}, which no CLI flag provides`,
    );
  }
  assert.strictEqual(sliceFileOption("data-flow"), "dataFlowSlicesFile");
});

it("replaces an earlier analyzer run's metadata instead of appending", () => {
  const component = {
    name: "app",
    properties: [
      { name: "cdx:rusi:backend", value: "stable" },
      { name: "cdx:rusi:requestedBackend", value: "compiler" },
      { name: "cdx:rusi:dataFlowCategories", value: "env->process-exec" },
      { name: "cdx:golem:toolVersion", value: "1.0.0" },
      { name: "SrcFile", value: "Cargo.toml" },
    ],
  };
  mergeAnalyzerMetadataProperties(component, [
    { name: "cdx:rusi:backend", value: "compiler" },
    { name: "cdx:rusi:dataFlowCategories", value: "param-0->network-request" },
  ]);
  assert.deepStrictEqual(
    component.properties.map((p) => `${p.name}=${p.value}`),
    [
      "cdx:golem:toolVersion=1.0.0",
      "SrcFile=Cargo.toml",
      "cdx:rusi:backend=compiler",
      "cdx:rusi:dataFlowCategories=param-0->network-request",
    ],
  );
});

it("leaves metadata untouched when an analyzer run emits nothing", () => {
  const component = {
    properties: [{ name: "cdx:rusi:backend", value: "stable" }],
  };
  mergeAnalyzerMetadataProperties(component, []);
  mergeAnalyzerMetadataProperties(undefined, [
    { name: "cdx:rusi:backend", value: "compiler" },
  ]);
  assert.deepStrictEqual(component.properties, [
    { name: "cdx:rusi:backend", value: "stable" },
  ]);
});

it("seeds C imports from the symbols the C/C++ collector records", () => {
  const components = [
    {
      name: "zlib1g-dev",
      purl: "pkg:deb/debian/zlib1g-dev@1.3",
      evidence: { identity: { field: "purl", confidence: 0.8 } },
      properties: [
        { name: "internal:ImportedSymbols", value: "deflate|inflate" },
      ],
    },
  ];
  assert.deepStrictEqual(initFromSbom(components, "c").purlImportsMap, {
    "pkg:deb/debian/zlib1g-dev@1.3": ["deflate", "inflate"],
  });
  // other languages keep reading internal:ImportedModules only
  assert.deepStrictEqual(initFromSbom(components, "java").purlImportsMap, {});
});

it("turns a C include's imported symbols into usages of the component that provides it", async () => {
  const { seedCImportsFromIncludes, parseObjectSlices } = await import(
    "./evinser.js"
  );
  const dir = mkdtempSync(join(tmpdir(), "evinse-c-includes-"));
  try {
    mkdirSync(join(dir, "third_party", "zlib"), { recursive: true });
    writeFileSync(join(dir, "third_party", "zlib", "zlib.h"), "");
    const zlib = {
      name: "zlib",
      purl: "pkg:github/madler/zlib@v1.3.1",
      evidence: { identity: { field: "purl", confidence: 0.6 } },
      properties: [{ name: "cdx:cmake:sourceDir", value: "third_party/zlib" }],
    };
    const usageSlice = {
      objectSlices: [
        {
          code: '#include "zlib.h"',
          fullName: "zlib.h",
          signature: "zlib.h",
          fileName: "src/main.c",
          lineNumber: 1,
          resolvedPath: join(dir, "third_party", "zlib", "zlib.h"),
          importedSymbols: ["deflate"],
          usages: [],
        },
        {
          code: "",
          fullName: "main",
          signature: "int(void)",
          fileName: "src/main.c",
          lineNumber: 3,
          usages: [
            {
              targetObj: {
                name: "deflate",
                typeFullName: "int",
                resolvedMethod: "deflate",
                isExternal: true,
                label: "CALL",
                lineNumber: 5,
              },
              definedBy: {
                name: "deflate",
                typeFullName: "int",
                resolvedMethod: "deflate",
                isExternal: true,
                label: "CALL",
                lineNumber: 5,
              },
              invokedCalls: [],
              argToCalls: [
                {
                  callName: "deflate",
                  resolvedMethod: "deflate",
                  isExternal: true,
                  lineNumber: 5,
                },
              ],
            },
          ],
        },
      ],
    };
    const purlImportsMap = seedCImportsFromIncludes(
      usageSlice,
      [zlib],
      dir,
      {},
    );
    assert.deepStrictEqual(purlImportsMap[zlib.purl], ["deflate"]);
    const { purlLocationMap } = await parseObjectSlices(
      "c",
      usageSlice,
      undefined,
      {},
      {},
      purlImportsMap,
    );
    assert.ok(
      [...(purlLocationMap[zlib.purl] || [])].some((l) =>
        l.startsWith("src/main.c#5"),
      ),
      JSON.stringify([...(purlLocationMap[zlib.purl] || [])]),
    );
    // a component the slices show no call to (code inside the project, such
    // as a vendored library) is used where its header is included
    const { attributeCIncludes } = await import("./evinser.js");
    mkdirSync(join(dir, "vendor", "json"), { recursive: true });
    writeFileSync(join(dir, "vendor", "json", "json.h"), "");
    const json = {
      name: "json",
      purl: "pkg:generic/json#vendor/json",
      evidence: { identity: { field: "name", confidence: 0.4 } },
      properties: [{ name: "cdx:vendored:path", value: "vendor/json" }],
    };
    const withVendored = {
      objectSlices: [
        ...usageSlice.objectSlices,
        {
          code: '#include "json.h"',
          fullName: "json.h",
          signature: "json.h",
          fileName: "src/main.c",
          lineNumber: 2,
          resolvedPath: join(dir, "vendor", "json", "json.h"),
          importedSymbols: ["json_parse"],
          usages: [],
        },
      ],
    };
    const attributed = attributeCIncludes(withVendored, [zlib, json], dir);
    assert.deepStrictEqual(
      [...attributed.symbols.get(json.purl)],
      ["json_parse"],
    );
    assert.deepStrictEqual(
      [...attributed.locations.get(json.purl)],
      ["src/main.c#2"],
    );
    assert.deepStrictEqual(
      [...attributed.locations.get(zlib.purl)],
      ["src/main.c#1"],
    );
    // a report from an atom that names no resolved file changes nothing
    const old = {
      objectSlices: usageSlice.objectSlices.map(
        ({ resolvedPath, importedSymbols, ...rest }) => rest,
      ),
    };
    assert.deepStrictEqual(seedCImportsFromIncludes(old, [zlib], dir, {}), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("readNamespaceMap prefers the map written next to the input BOM", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-ns-map-"));
  try {
    const projectDir = join(root, "src");
    const outDir = join(root, "out");
    mkdirSync(projectDir);
    mkdirSync(outDir);
    const mapping = {
      "pkg:maven/org.ex/lib@1.0?type=jar": {
        jarFile: "/cache/lib-1.0.jar",
        namespaces: ["org.ex.Lib"],
      },
    };
    // cdxgen writes <output>.map next to the BOM, not into the project.
    writeFileSync(join(outDir, "bom.json.map"), JSON.stringify(mapping));
    assert.deepStrictEqual(
      readNamespaceMap(projectDir, { input: join(outDir, "bom.json") }),
      mapping,
    );
    // The project directory is still the fallback.
    assert.strictEqual(readNamespaceMap(projectDir, {}), undefined);
    writeFileSync(join(projectDir, "bom.json.map"), JSON.stringify(mapping));
    assert.deepStrictEqual(readNamespaceMap(projectDir), mapping);
    // An empty or unreadable map is ignored.
    writeFileSync(join(outDir, "empty.json.map"), "{}");
    writeFileSync(join(outDir, "broken.json.map"), "{not json");
    assert.deepStrictEqual(
      readNamespaceMap(projectDir, { input: join(outDir, "empty.json") }),
      mapping,
    );
    assert.deepStrictEqual(
      readNamespaceMap(projectDir, { input: join(outDir, "broken.json") }),
      mapping,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// #4498 — the Go evidence path collects services from the golem report and
// merges an OpenAPI document over them: the spec --openapi-spec-file names,
// or the openapi.json an earlier `atom-tools convert -t go` left in the repo.
it("collectGoServices merges golem services with a repo OpenAPI spec", () => {
  const root = mkdtempSync(join(tmpdir(), "evinser-go-services-"));
  try {
    const golemReport = {
      services: [
        {
          id: "service|server|example.com/app|gin",
          name: "gin",
          kind: "server",
          endpoints: [
            {
              method: "GET",
              path: "/api/users/:id",
              properties: { framework: "gin" },
            },
          ],
        },
      ],
    };
    writeFileSync(
      join(root, "openapi.json"),
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "app", version: "1.0.0" },
        paths: {
          "/api/users": { post: { operationId: "createUser" } },
        },
      }),
    );
    const servicesMap = collectGoServices(golemReport, root, {});
    const names = Object.keys(servicesMap).sort();
    assert.deepStrictEqual(names, [
      "service-apiusers-post",
      "service|server|example.com/app|gin",
    ]);
    const gin = servicesMap["service|server|example.com/app|gin"];
    assert.deepStrictEqual(Array.from(gin.endpoints), ["/api/users/%7Bid%7D"]);
    const openapiService = servicesMap["service-apiusers-post"];
    assert.deepStrictEqual(Array.from(openapiService.endpoints), [
      "/api/users",
    ]);
    assert.ok(
      openapiService.properties.some(
        (p) => p.name === "cdx:service:httpMethod" && p.value === "post",
      ),
    );
    assert.ok(
      openapiService.properties.some(
        (p) => p.name === "internal:operationId" && p.value === "createUser",
      ),
    );

    // Without an openapi.json the golem services stand alone, and a missing
    // report is not an error either.
    const bareDir = join(root, "bare");
    mkdirSync(bareDir);
    const onlyGolem = collectGoServices(golemReport, bareDir, {});
    assert.deepStrictEqual(Object.keys(onlyGolem), [
      "service|server|example.com/app|gin",
    ]);
    assert.deepStrictEqual(collectGoServices(undefined, bareDir, {}), {});

    // --openapi-spec-file names a different file than the default.
    writeFileSync(
      join(bareDir, "spec.yaml-nested.json"),
      JSON.stringify({
        paths: { "/healthz": { get: {} } },
      }),
    );
    const named = collectGoServices(undefined, bareDir, {
      openapiSpecFile: "spec.yaml-nested.json",
    });
    assert.deepStrictEqual(Object.keys(named), ["service-healthz-get"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// A golem report file holding JSON null used to crash evinse -l go.
it("collectGoServices treats a null golem report as no services", () => {
  const root = mkdtempSync(join(tmpdir(), "evinser-go-null-"));
  try {
    assert.deepStrictEqual(collectGoServices(null, root, {}), {});
    assert.deepStrictEqual(collectGoServices({ services: null }, root, {}), {});
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// Services golem 4.1.1 reported for a Go 1.22 ServeMux, a net/http listener
// and hard-coded outbound URLs; evinse writes the endpoints into the BOM.
it("collectGoServices keeps only safe, routable endpoints", () => {
  const root = mkdtempSync(join(tmpdir(), "evinser-go-routes-"));
  try {
    const servicesMap = collectGoServices(
      {
        services: [
          {
            id: "service|external|https|admin.example.com",
            name: "admin.example.com",
            kind: "external",
            scheme: "https",
            host: "admin.example.com",
            packagePath: "example.com/urls",
            endpoints: [
              {
                path: "/panel;jsessionid=ABC123",
                url: "https://admin.example.com/panel;jsessionid=ABC123",
              },
            ],
          },
          {
            id: "service|external|https|hooks.slack.com",
            name: "hooks.slack.com",
            kind: "external",
            scheme: "https",
            host: "hooks.slack.com",
            packagePath: "example.com/urls2",
            endpoints: [
              {
                path: "/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX",
                url: "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX",
              },
            ],
          },
          {
            id: "service|server|example.com/nethttp|:8080",
            name: ":8080",
            kind: "server",
            scheme: "http",
            host: ":8080",
            packagePath: "example.com/nethttp",
            endpoints: [
              {
                path: ":8080",
                properties: { framework: "net/http", handler: "mux" },
              },
            ],
          },
          {
            id: "service|server|example.com/nethttp|net/http",
            name: "net/http",
            kind: "server",
            scheme: null,
            host: null,
            packagePath: "example.com/nethttp",
            endpoints: [
              {
                path: "/GET /items/{id}",
                properties: { framework: "net/http", handler: "items" },
              },
              {
                path: "/GET /exact/{$}",
                properties: { framework: "net/http", handler: "items" },
              },
              {
                path: "/GET example.com/hosted2/{id}",
                properties: { framework: "net/http", handler: "items" },
              },
            ],
          },
        ],
      },
      root,
      {},
    );
    const endpoints = (id) => Array.from(servicesMap[id].endpoints);
    assert.deepStrictEqual(
      endpoints("service|external|https|admin.example.com"),
      ["https://admin.example.com/panel"],
    );
    assert.deepStrictEqual(
      endpoints("service|external|https|hooks.slack.com"),
      ["https://hooks.slack.com/services"],
    );
    assert.deepStrictEqual(
      endpoints("service|server|example.com/nethttp|:8080"),
      [],
    );
    const mux = servicesMap["service|server|example.com/nethttp|net/http"];
    assert.deepStrictEqual(Array.from(mux.endpoints), [
      "/items/%7Bid%7D",
      "/exact/",
      "/hosted2/%7Bid%7D",
    ]);
    assert.deepStrictEqual(
      mux.properties
        .filter((p) =>
          ["cdx:service:httpMethod", "cdx:golem:service:host"].includes(p.name),
        )
        .map((p) => `${p.name}=${p.value}`),
      ["cdx:service:httpMethod=get", "cdx:golem:service:host=example.com"],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it("attributes JavaScript usages by module, not by bare symbol", async () => {
  const { parseSliceUsages, jsPackageOfModule } = await import("./evinser.js");
  const purlImportsMap = {
    "pkg:npm/semver@7.6.0": ["semver", "parse", "clean"],
    "pkg:npm/%40babel/parser@8.0.7": ["@babel/parser", "parse"],
    "pkg:npm/%40scope/pkg@1.0.0": ["@scope/pkg/sub"],
    "pkg:npm/ngy-cookie@1.0.0": ["ngy-cookie", "CookieService"],
    "pkg:npm/%40angular/core@19.0.0": ["@angular/core", "inject"],
    "pkg:npm/%40cdxgen/cdx-purl@1.0.0": ["@cdxgen/cdx-purl", "Purl"],
  };
  const purlLocationMap = {};
  const call = (line, module, symbol, extra = {}) => ({
    callName: symbol,
    resolvedMethod: `${module}:${symbol}`,
    paramTypes: [],
    returnType: "ANY",
    isExternal: true,
    lineNumber: line,
    columnNumber: 1,
    code: symbol,
    module,
    symbol,
    ...extra,
  });
  const slice = {
    fileName: "lib/a.js",
    usages: [
      // @babel/parser's parse: semver also exports a `parse`, and must not get it
      {
        targetObj: { name: "ast", typeFullName: "ANY", label: "LOCAL" },
        invokedCalls: [],
        argToCalls: [call(473, "@babel/parser", "parse", { position: -1 })],
      },
      // a subpath folds to its package; node builtins and project files are no packages
      {
        targetObj: { name: "x", typeFullName: "ANY", label: "LOCAL" },
        invokedCalls: [
          call(10, "@scope/pkg/sub", "f"),
          call(11, "node:fs", "readFile"),
        ],
        argToCalls: [],
      },
      // an import binding: every call it takes part in is a use of its module
      {
        targetObj: {
          name: "CookieService",
          typeFullName: "ANY",
          label: "LOCAL",
        },
        definedBy: {
          name: "require",
          typeFullName: "ANY",
          resolvedMethod: null,
          lineNumber: 6,
          label: "CALL",
          code: 'require("ngy-cookie").CookieService',
          module: "ngy-cookie",
          symbol: "CookieService",
        },
        invokedCalls: [call(46, "@angular/core", "inject")],
        argToCalls: [],
      },
      // a value returned by a package call is not a use of the package wherever it goes
      {
        targetObj: { name: "s", typeFullName: "ANY", label: "LOCAL" },
        definedBy: {
          name: "toString",
          typeFullName: "ANY",
          resolvedMethod: "@cdxgen/cdx-purl:Purl:toString",
          lineNumber: 20,
          label: "CALL",
          module: "@cdxgen/cdx-purl",
          symbol: "Purl.toString",
        },
        invokedCalls: [
          {
            callName: "decodeURIComponent",
            resolvedMethod: "__ecma.decodeURIComponent",
            paramTypes: [],
            returnType: "ANY",
            isExternal: true,
            lineNumber: 21,
          },
        ],
        argToCalls: [],
      },
    ],
  };
  await parseSliceUsages("js", {}, slice, {}, purlLocationMap, purlImportsMap);
  const at = (purl) => [...(purlLocationMap[purl] || [])].sort();
  assert.deepStrictEqual(at("pkg:npm/%40babel/parser@8.0.7"), ["lib/a.js#473"]);
  assert.deepStrictEqual(at("pkg:npm/semver@7.6.0"), []);
  assert.deepStrictEqual(at("pkg:npm/%40scope/pkg@1.0.0"), ["lib/a.js#10"]);
  assert.deepStrictEqual(at("pkg:npm/ngy-cookie@1.0.0"), [
    "lib/a.js#46",
    "lib/a.js#6",
  ]);
  assert.deepStrictEqual(at("pkg:npm/%40angular/core@19.0.0"), ["lib/a.js#46"]);
  assert.deepStrictEqual(at("pkg:npm/%40cdxgen/cdx-purl@1.0.0"), [
    "lib/a.js#20",
  ]);
  assert.strictEqual(jsPackageOfModule("lodash/fp"), "lodash");
  assert.strictEqual(jsPackageOfModule("fs"), undefined);
  assert.strictEqual(jsPackageOfModule("./local.js"), undefined);
});

it("adds every location of a matched type, not only the first", async () => {
  const { parseSliceUsages } = await import("./evinser.js");
  const purlLocationMap = {};
  const slice = {
    fileName: "app/main.py",
    usages: [
      {
        targetObj: { name: "s", typeFullName: "ANY", label: "LOCAL" },
        invokedCalls: [5, 9].map((line) => ({
          callName: "get",
          resolvedMethod: "requests.get",
          paramTypes: [],
          returnType: "ANY",
          isExternal: true,
          lineNumber: line,
        })),
        argToCalls: [],
      },
    ],
  };
  await parseSliceUsages("python", {}, slice, {}, purlLocationMap, {
    "pkg:pypi/requests@2.32.0": ["requests"],
  });
  assert.deepStrictEqual(
    [...purlLocationMap["pkg:pypi/requests@2.32.0"]].sort(),
    ["app/main.py#5", "app/main.py#9"],
  );
});

it("reads the field types of user defined types", async () => {
  const { parseSliceUsages } = await import("./evinser.js");
  const purlLocationMap = {};
  const udt = {
    name: "app.main.Client",
    fileName: "app/main.py",
    fields: [
      { name: "session", typeFullName: "requests.Session", lineNumber: 4 },
    ],
    procedures: [],
  };
  await parseSliceUsages("python", {}, udt, {}, purlLocationMap, {
    "pkg:pypi/requests@2.32.0": ["requests"],
  });
  assert.deepStrictEqual(
    [...purlLocationMap["pkg:pypi/requests@2.32.0"]],
    ["app/main.py#4"],
  );
});

it("does not mistake type names for object prototype members", async () => {
  const { parseSliceUsages } = await import("./evinser.js");
  const slice = {
    fileName: "lib/a.js",
    usages: [
      {
        targetObj: { name: "x", typeFullName: "ANY", label: "LOCAL" },
        invokedCalls: ["constructor", "toString", "hasOwnProperty"].map(
          (n, i) => ({
            callName: n,
            resolvedMethod: n,
            paramTypes: [],
            returnType: "ANY",
            isExternal: true,
            lineNumber: i + 1,
          }),
        ),
        argToCalls: [],
      },
    ],
  };
  await parseSliceUsages("js", {}, slice, {}, {}, { "pkg:npm/x@1.0.0": ["x"] });
});

it("reads JavaScript routes from the code field", () => {
  const route = 'app.get("/users/:id", (req, res) => {})';
  const slice = (entry) => ({
    fullName: "server.js::program",
    fileName: "server.js",
    usages: [
      {
        targetObj: {
          name: "app",
          typeFullName: "express:Express",
          label: "LOCAL",
        },
        invokedCalls: [entry],
      },
    ],
  });
  const fromCode = {};
  detectServicesFromUsages(
    "js",
    slice({
      callName: "get",
      resolvedMethod: "express:Express:get",
      code: route,
      lineNumber: 3,
    }),
    fromCode,
  );
  const fromResolved = {};
  detectServicesFromUsages(
    "js",
    slice({ callName: "get", resolvedMethod: route, lineNumber: 3 }),
    fromResolved,
  );
  const endpoints = (m) =>
    Object.values(m)
      .flatMap((s) => [...s.endpoints])
      .sort();
  assert.ok(endpoints(fromResolved).length > 0);
  assert.deepStrictEqual(endpoints(fromCode), endpoints(fromResolved));
});

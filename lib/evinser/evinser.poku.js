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

import { assert, it } from "poku";

import {
  constructServiceName,
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

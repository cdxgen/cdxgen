import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import { defaultEvidenceLanguage, mergeServiceDefinitions } from "./evinser.js";
import { findPurlLocations } from "./scalasem.js";

const jwtComponent = {
  purl: "pkg:maven/com.github.jwt-scala/jwt-core@11.0.4?repository_url=https:%2F%2Frepo1.maven.org%2Fmaven2&type=jar",
  properties: [
    {
      name: "internal:Namespaces",
      value: "jwt.core.JwtClaim\njwt.core.JwtHeader",
    },
  ],
};

it("findPurlLocations maps used types to component purls", () => {
  const semanticsSlice = {
    "src/main/scala/App.scala": {
      sourceFile: "src/main/scala/App.scala",
      usedTypes: ["jwt.core.JwtClaim", "jwt.core.Unknown"],
    },
  };
  const retMap = findPurlLocations([jwtComponent], semanticsSlice);
  assert.deepStrictEqual(retMap.purlLocationMap[jwtComponent.purl], [
    "src/main/scala/App.scala",
  ]);
  // Non-scala entries and the config key are ignored
  assert.deepStrictEqual(
    findPurlLocations([jwtComponent], { config: { routes: [] } }),
    { purlLocationMap: {} },
  );
});

it("the scala report is persisted to the absolute semantics slices file", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-scala-slice-"));
  const outerDir = mkdtempSync(join(tmpdir(), "cdxgen-scala-outer-"));
  const absoluteFile = join(outerDir, "custom-semantics.json");
  const bomFile = join(projectDir, "bom.json");
  writeFileSync(
    bomFile,
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: 1.5,
      components: [],
    }),
  );
  const atomUtils = await import("../inventory/atomUtils.js");
  const executeAtom = sinon.stub().returns(undefined);
  const { analyzeProject } = await esmock(
    "./evinser.js",
    {},
    {
      "../inventory/atomUtils.js": {
        ...atomUtils,
        executeAtom,
      },
    },
  );
  try {
    const stub = join(outerDir, "scalasem-stub.js");
    writeFileSync(
      stub,
      `require("node:fs").writeFileSync(process.argv[3], JSON.stringify({_meta: {schemaVersion: "scalasem/2", projectPath: process.argv[2]}, config: {routes: []}, modules: []}));`,
    );
    const retMap = await analyzeProject(undefined, {
      _: [projectDir],
      language: "scala",
      input: bomFile,
      output: join(outerDir, "bom.evinse.json"),
      semanticsSlicesFile: absoluteFile,
      scalasemCommand: stub,
    });
    assert.strictEqual(retMap.semanticsSlicesFile, absoluteFile);
    assert.ok(existsSync(absoluteFile), "the report was not persisted");
    // atom is never part of the scala path
    assert.ok(!executeAtom.called, "atom was invoked for scala");
    assert.strictEqual(retMap.atomFile, undefined);
    assert.strictEqual(retMap.usagesSlicesFile, undefined);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outerDir, { recursive: true, force: true });
  }
});

it("openapi services and semantics locations survive without atom", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-scala-ev-"));
  mkdirSync(join(projectDir, "src", "main", "scala"), { recursive: true });
  writeFileSync(
    join(projectDir, "src", "main", "scala", "App.scala"),
    "object App",
  );
  const bomFile = join(projectDir, "bom.json");
  const component = {
    ...jwtComponent,
    evidence: {
      occurrences: [{ location: "src/main/scala/App.scala", line: 7 }],
    },
  };
  writeFileSync(
    bomFile,
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: 1.5,
      components: [component],
    }),
  );
  const semanticsSlicesFile = join(projectDir, "semantics.slices.json");
  const slice = {
    "src/main/scala/App.scala": {
      sourceFile: "src/main/scala/App.scala",
      usedTypes: ["jwt.core.JwtClaim"],
    },
  };
  slice.padding = "x".repeat(2048);
  writeFileSync(semanticsSlicesFile, JSON.stringify(slice));
  const openapiFile = join(projectDir, "scala-openapi.json");
  writeFileSync(
    openapiFile,
    JSON.stringify({
      paths: {
        "/accounts/{id}": {
          get: { operationId: "getAccount" },
        },
      },
    }),
  );
  try {
    const atomUtils = await import("../inventory/atomUtils.js");
    const executeAtom = sinon.stub().returns(undefined);
    const stub = join(projectDir, "scalasem-stub.js");
    writeFileSync(
      stub,
      `require("node:fs").writeFileSync(process.argv[3], JSON.stringify({_meta: {schemaVersion: "scalasem/2", projectPath: process.argv[2]}, config: {routes: []}, modules: []}));`,
    );
    const { analyzeProject } = await esmock(
      "./evinser.js",
      {},
      {
        "../inventory/atomUtils.js": {
          ...atomUtils,
          executeAtom,
        },
      },
    );
    const retMap = await analyzeProject(
      {},
      {
        _: [projectDir],
        language: "sbt",
        input: bomFile,
        output: join(projectDir, "bom.evinse.json"),
        semanticsSlicesFile,
        openapiSpecFile: "scala-openapi.json",
        scalasemCommand: stub,
      },
    );
    // The seeded occurrence and the version 1 slice location are merged
    const locations = retMap.purlLocationMap[component.purl];
    assert.ok(
      locations.has("src/main/scala/App.scala#7"),
      `seeded occurrence lost: ${[...locations]}`,
    );
    assert.ok(
      locations.has("src/main/scala/App.scala"),
      `semantics location lost: ${[...locations]}`,
    );
    // Services were detected from the OpenAPI spec although the report has
    // none, and atom stayed out of it
    const serviceNames = Object.keys(retMap.servicesMap);
    assert.strictEqual(serviceNames.length, 1, `${serviceNames} not detected`);
    assert.ok(serviceNames[0].startsWith("service-accounts"));
    assert.ok(!executeAtom.called, "atom was invoked for scala");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

it("a plain --evidence run over a Scala build takes the Scala path", () => {
  const sbtDir = mkdtempSync(join(tmpdir(), "cdxgen-scala-default-"));
  const plainDir = mkdtempSync(join(tmpdir(), "cdxgen-plain-default-"));
  try {
    writeFileSync(join(sbtDir, "build.sbt"), "");
    assert.strictEqual(defaultEvidenceLanguage(sbtDir), "scala");
    assert.strictEqual(defaultEvidenceLanguage(plainDir), "java");
  } finally {
    rmSync(sbtDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  }
});

it("a route the report and an OpenAPI spec both name is one service", () => {
  const servicesMap = {
    "service-users{id}-get": {
      endpoints: new Set(["/users/{id}"]),
      properties: [
        { name: "cdx:service:httpMethod", value: "GET" },
        { name: "cdx:scalasem:endpoint:framework", value: "http4s" },
      ],
    },
  };
  mergeServiceDefinitions(servicesMap, {
    "service-users{id}-get": {
      endpoints: new Set(["/users/{id}"]),
      properties: [
        { name: "cdx:service:httpMethod", value: "get" },
        { name: "internal:operationId", value: "getUser" },
      ],
    },
    "service-health-get": { endpoints: new Set(["/health"]), properties: [] },
  });
  assert.deepStrictEqual(Object.keys(servicesMap).sort(), [
    "service-health-get",
    "service-users{id}-get",
  ]);
  const merged = servicesMap["service-users{id}-get"];
  assert.deepStrictEqual(
    merged.properties.map((property) => property.name),
    [
      "cdx:service:httpMethod",
      "cdx:scalasem:endpoint:framework",
      "internal:operationId",
    ],
  );
});

it("the scala path reads the slices and the OpenAPI spec the user passes", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-scala-user-"));
  const component = {
    purl: "pkg:maven/com.example/lib@1.0.0",
    "bom-ref": "pkg:maven/com.example/lib@1.0.0",
  };
  const bomFile = join(projectDir, "bom.json");
  writeFileSync(
    bomFile,
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: 1.6,
      components: [component],
    }),
  );
  const report = JSON.parse(
    readFileSync(
      join("test", "data", "scalasem", "services-jvm.json"),
      "utf-8",
    ),
  );
  report._meta.projectPath = projectDir;
  const stub = join(projectDir, "scalasem-stub.js");
  writeFileSync(
    stub,
    `require("node:fs").writeFileSync(process.argv[3], ${JSON.stringify(JSON.stringify(report))});`,
  );
  const reachablesFile = join(projectDir, "user-reachables.json");
  writeFileSync(
    reachablesFile,
    JSON.stringify({
      reachables: [
        {
          purls: [component.purl],
          flows: [
            {
              parentFileName: "src/main/scala/App.scala",
              parentPackageName: "demo",
              parentClassName: "demo.App",
              parentMethodName: "main",
              lineNumber: 3,
              code: "Lib.call()",
              tags: "",
            },
            {
              parentFileName: "src/main/scala/App.scala",
              parentPackageName: "demo",
              parentClassName: "demo.App",
              parentMethodName: "run",
              lineNumber: 9,
              code: "Lib.call()",
              tags: "",
            },
          ],
        },
      ],
      padding: "x".repeat(2048),
    }),
  );
  const usagesFile = join(projectDir, "user-usages.json");
  writeFileSync(
    usagesFile,
    readFileSync(join("test", "data", "usages.json"), "utf-8"),
  );
  writeFileSync(
    join(projectDir, "openapi.json"),
    JSON.stringify({
      paths: {
        "/cask/hello/{name}": { get: { operationId: "hello" } },
        "/only-in-spec": { post: { operationId: "specOnly" } },
      },
    }),
  );
  const atomUtils = await import("../inventory/atomUtils.js");
  const executeAtom = sinon.stub().returns(undefined);
  const { analyzeProject } = await esmock(
    "./evinser.js",
    {},
    { "../inventory/atomUtils.js": { ...atomUtils, executeAtom } },
  );
  try {
    const retMap = await analyzeProject(
      {},
      {
        _: [projectDir],
        language: "scala",
        input: bomFile,
        output: join(projectDir, "bom.evinse.json"),
        scalasemCommand: stub,
        withReachables: true,
        reachablesSlicesFile: reachablesFile,
        usagesSlicesFile: usagesFile,
        openapiSpecFile: "openapi.json",
      },
    );
    assert.ok(!executeAtom.called, "atom was invoked for scala");
    assert.strictEqual(retMap.usagesSlicesFile, usagesFile);
    assert.strictEqual(retMap.reachablesSlicesFile, reachablesFile);
    assert.ok(retMap.dataFlowFrames[component.purl]?.length, "no user frames");
    // The report's route and the spec's route are one service; the spec's
    // own route is added, whatever the report found.
    const hello = retMap.servicesMap["service-caskhello{name}-get"];
    assert.ok(hello, Object.keys(retMap.servicesMap).join(","));
    assert.ok(
      hello.properties.some(
        (property) => property.name === "cdx:scalasem:endpoint:framework",
      ),
    );
    assert.ok(retMap.servicesMap["service-only-in-spec-post"]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

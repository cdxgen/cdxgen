import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import { loadReusableSemanticsSlice, parseSemanticSlices } from "./evinser.js";
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

it("scala project types route to the scalasem parser", () => {
  const semanticsSlice = {
    "src/main/scala/App.scala": {
      sourceFile: "src/main/scala/App.scala",
      usedTypes: ["jwt.core.JwtClaim"],
    },
  };
  for (const language of ["scala", "scala3", "sbt", "mill"]) {
    const retMap = parseSemanticSlices(
      language,
      [jwtComponent],
      semanticsSlice,
    );
    assert.ok(
      retMap.purlLocationMap[jwtComponent.purl],
      `${language} did not reach the scalasem parser`,
    );
  }
});

it("scala slices are reused only for the same project and only when fresh", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-scala-reuse-"));
  const otherDir = mkdtempSync(join(tmpdir(), "cdxgen-scala-other-"));
  mkdirSync(join(projectDir, "src", "main", "scala"), { recursive: true });
  writeFileSync(
    join(projectDir, "src", "main", "scala", "App.scala"),
    "object App",
  );
  const bomFile = join(projectDir, "bom.json");
  writeFileSync(bomFile, JSON.stringify({ components: [jwtComponent] }));
  const v1Slice = {
    "src/main/scala/App.scala": {
      sourceFile: "src/main/scala/App.scala",
      usedTypes: ["jwt.core.JwtClaim"],
    },
  };
  // Pad the slice past the 1 KB reuse threshold
  v1Slice.padding = "x".repeat(2048);

  const slicesFile = join(projectDir, "semantics.slices.json");
  writeFileSync(slicesFile, JSON.stringify(v1Slice));
  const otherBomFile = join(otherDir, "bom.json");
  writeFileSync(otherBomFile, JSON.stringify({ components: [jwtComponent] }));

  // A v1 slice whose sources exist under the project is reused
  assert.ok(
    loadReusableSemanticsSlice("scala", slicesFile, bomFile, projectDir),
  );
  // The same slice belongs to no other project
  assert.strictEqual(
    loadReusableSemanticsSlice("scala", slicesFile, otherBomFile, otherDir),
    undefined,
  );

  // A version 2 report carries its project path in _meta
  const padding = "x".repeat(2048);
  const v2Slice = {
    _meta: { schemaVersion: "scalasem/2", projectPath: projectDir },
    "src/main/scala/App.scala": { usedTypes: ["jwt.core.JwtClaim"] },
    padding,
  };
  writeFileSync(slicesFile, JSON.stringify(v2Slice));
  assert.ok(
    loadReusableSemanticsSlice("scala", slicesFile, bomFile, projectDir),
  );
  const v2OtherSlice = {
    _meta: { schemaVersion: "scalasem/2", projectPath: otherDir },
    "src/main/scala/App.scala": { usedTypes: ["jwt.core.JwtClaim"] },
    padding,
  };
  writeFileSync(slicesFile, JSON.stringify(v2OtherSlice));
  assert.strictEqual(
    loadReusableSemanticsSlice("scala", slicesFile, bomFile, projectDir),
    undefined,
  );

  // A slice older than the input SBOM is regenerated
  writeFileSync(slicesFile, JSON.stringify(v1Slice));
  const staleTime = new Date(Date.now() - 60_000);
  utimesSync(slicesFile, staleTime, staleTime);
  assert.strictEqual(
    loadReusableSemanticsSlice("scala", slicesFile, bomFile, projectDir),
    undefined,
  );
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(otherDir, { recursive: true, force: true });
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

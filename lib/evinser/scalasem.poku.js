import {
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

import {
  loadReusableSemanticsSlice,
  parseSemanticSlices,
} from "./evinser.js";
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

it("an absolute semantics slices file keeps its directory", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-scala-slice-"));
  const outerDir = mkdtempSync(join(tmpdir(), "cdxgen-scala-outer-"));
  const absoluteFile = join(outerDir, "custom-semantics.json");
  writeFileSync(absoluteFile, "{}");
  try {
    const atomUtils = await import("../inventory/atomUtils.js");
    const executeAtom = sinon.stub().returns(undefined);
    const { createSlice: mockedCreateSlice } = await esmock(
      "./evinser.js",
      {},
      {
        "../inventory/atomUtils.js": {
          ...atomUtils,
          executeAtom,
        },
      },
    );
    const retMap = await mockedCreateSlice("scala", projectDir, "usages", {
      semanticsSlicesFile: absoluteFile,
    });
    assert.strictEqual(retMap.semanticsSlicesFile, absoluteFile);
    // A bare file name lands in the slice output directory
    const retMapBare = await mockedCreateSlice("scala", projectDir, "usages", {
      semanticsSlicesFile: "semantics.slices.json",
    });
    assert.notStrictEqual(
      retMapBare.semanticsSlicesFile,
      "semantics.slices.json",
    );
    assert.ok(retMapBare.semanticsSlicesFile.endsWith("semantics.slices.json"));
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outerDir, { recursive: true, force: true });
  }
});

it("openapi services and semantics locations survive an empty usages slice", async () => {
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
        semanticsSlicesFile,
        openapiSpecFile: "scala-openapi.json",
      },
    );
    // The seeded occurrence and the semantics location are merged
    const locations = retMap.purlLocationMap[component.purl];
    assert.ok(
      locations.has("src/main/scala/App.scala#7"),
      `seeded occurrence lost: ${[...locations]}`,
    );
    assert.ok(
      locations.has("src/main/scala/App.scala"),
      `semantics location lost: ${[...locations]}`,
    );
    // Services were detected from the OpenAPI spec although the usages slice
    // is empty
    const serviceNames = Object.keys(retMap.servicesMap);
    assert.strictEqual(serviceNames.length, 1, `${serviceNames} not detected`);
    assert.ok(serviceNames[0].startsWith("service-accounts"));
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

it("createSlice() treats the scala build tool types as scala", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-scala-alias-"));
  try {
    const atomUtils = await import("../inventory/atomUtils.js");
    const executeAtom = sinon.stub().returns(undefined);
    const { createSlice: mockedCreateSlice } = await esmock(
      "./evinser.js",
      {},
      {
        "../inventory/atomUtils.js": {
          ...atomUtils,
          executeAtom,
        },
      },
    );
    for (const language of ["sbt", "mill", "scala3"]) {
      const _retMap = await mockedCreateSlice(
        language,
        projectDir,
        "usages",
        {},
      );
      // atom is invoked with the canonical scala language
      assert.ok(executeAtom.called, `atom was not invoked for ${language}`);
      const args = executeAtom.lastCall.args[1];
      assert.ok(args.includes("-l"), "atom language flag missing");
      assert.strictEqual(args[args.indexOf("-l") + 1], "scala");
    }
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

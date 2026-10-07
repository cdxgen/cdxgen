import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

const writeBomFile = (bomFile, components = []) =>
  writeFileSync(
    bomFile,
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: 1.7,
      components,
    }),
  );

const nugetComponent = {
  type: "library",
  name: "Serilog",
  purl: "pkg:nuget/Serilog@3.1.1",
};

const cryptoComponent = {
  type: "cryptographic-asset",
  name: "sha-256",
  "bom-ref": "crypto/algorithm/sha-256@2.16.840.1.101.3.4.2.1",
};

const methodsSlice = (pad = 0) => ({
  Metadata: { Tool: "Dosai", SchemaVersion: "4.0.0" },
  Methods: [],
  Dependencies: [],
  PackageReachability: [],
  CallGraph: { Nodes: [], Edges: [] },
  Services: [],
  AiComponents: [],
  Notes: "x".repeat(pad),
});

const writeMethodsSlice = (slicesFile, pad = 0) =>
  writeFileSync(slicesFile, JSON.stringify(methodsSlice(pad)));

const loadEvinser = (dosaiStubs = {}, cbomutilsStubs = {}) =>
  esmock("./evinser.js", {
    "../inventory/dosai.js": dosaiStubs,
    "../inventory/cbomutils.js": cbomutilsStubs,
  });

describe("evinse options wiring", () => {
  it("forwards exclude and the resolved deps slices file", async () => {
    const { buildEvinseOptions } = await import("./evinser.js");
    const sourceDir = join(tmpdir(), "some-dotnet-project");
    const evinseOptions = buildEvinseOptions(
      {
        projectType: ["dotnet"],
        deep: true,
        exclude: ["Tests/**"],
        depsSlicesFile: "deps.slices.json",
        includeCrypto: true,
        specVersion: 1.7,
      },
      { _: [sourceDir] },
      join(tmpdir(), "bom.cdx.json"),
    );
    assert.deepStrictEqual(evinseOptions.exclude, ["Tests/**"]);
    assert.strictEqual(
      evinseOptions.depsSlicesFile,
      resolve(sourceDir, "deps.slices.json"),
    );
  });
});

describe("defaultEvidenceLanguage() for a run without -t", () => {
  const bomOf = (...purls) => ({
    components: purls.map((purl) => ({ type: "library", purl })),
  });

  it("follows the packages of the generated BOM", async () => {
    const { defaultEvidenceLanguage } = await import("./evinser.js");
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-evidence-lang-"));
    try {
      const npm = (name) => `pkg:npm/${name}@1.0.0`;
      // Java stays the language of any project with Maven packages, however
      // many npm packages its frontend brings
      assert.strictEqual(
        defaultEvidenceLanguage(
          projectDir,
          bomOf(npm("a"), npm("b"), "pkg:maven/org.slf4j/slf4j-api@2.0.17"),
        ),
        "java",
      );
      assert.strictEqual(
        defaultEvidenceLanguage(projectDir, bomOf(npm("a"), npm("b"))),
        "js",
      );
      assert.strictEqual(
        defaultEvidenceLanguage(
          projectDir,
          bomOf(npm("a"), "pkg:pypi/requests@2.32.3", "pkg:pypi/flask@3.1.1"),
        ),
        "python",
      );
      assert.strictEqual(
        defaultEvidenceLanguage(
          projectDir,
          bomOf("pkg:golang/github.com/spf13/cobra@v1.9.1"),
        ),
        "go",
      );
      // Nothing the evidence step can analyse
      assert.strictEqual(
        defaultEvidenceLanguage(projectDir, bomOf()),
        undefined,
      );
      assert.strictEqual(defaultEvidenceLanguage(projectDir), undefined);
      assert.strictEqual(
        defaultEvidenceLanguage(
          projectDir,
          bomOf("pkg:hex/cowboy@2.12.0", "pkg:github/actions/checkout@v4"),
        ),
        undefined,
      );
      // Generic packages are C only when there are C sources
      const genericBom = bomOf("pkg:generic/zlib@1.3.1");
      assert.strictEqual(
        defaultEvidenceLanguage(projectDir, genericBom),
        undefined,
      );
      writeFileSync(
        join(projectDir, "main.c"),
        "int main(void) { return 0; }\n",
      );
      assert.strictEqual(defaultEvidenceLanguage(projectDir, genericBom), "c");
      assert.strictEqual(
        defaultEvidenceLanguage(projectDir, genericBom, {
          exclude: ["**/main.c"],
        }),
        undefined,
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("analyzeProject() dotnet slice reuse", () => {
  it("reuses the deps slice for usages instead of running dosai twice", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-evinse-reuse-"));
    try {
      const depsSlicesFile = join(tmpDir, "deps.slices.json");
      writeMethodsSlice(depsSlicesFile, 2048);
      const bomFile = join(tmpDir, "bom.cdx.json");
      writeBomFile(bomFile, [nugetComponent]);
      const createDosaiMethodsSlice = sinon.stub();
      const { analyzeProject } = await loadEvinser({ createDosaiMethodsSlice });
      const sliceArtefacts = await analyzeProject(
        {},
        {
          _: [tmpDir],
          language: ["dotnet"],
          input: bomFile,
          depsSlicesFile,
        },
      );
      sinon.assert.notCalled(createDosaiMethodsSlice);
      assert.strictEqual(sliceArtefacts.usagesSlicesFile, depsSlicesFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prefers the user's usages slices file over the deps slice", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-evinse-usages-"));
    try {
      const usagesSlicesFile = join(tmpDir, "usages.slices.json");
      writeMethodsSlice(usagesSlicesFile, 2048);
      const depsSlicesFile = join(tmpDir, "deps.slices.json");
      writeMethodsSlice(depsSlicesFile, 2048);
      const bomFile = join(tmpDir, "bom.cdx.json");
      writeBomFile(bomFile, [nugetComponent]);
      const createDosaiMethodsSlice = sinon.stub();
      const { analyzeProject } = await loadEvinser({ createDosaiMethodsSlice });
      const sliceArtefacts = await analyzeProject(
        {},
        {
          _: [tmpDir],
          language: ["dotnet"],
          input: bomFile,
          usagesSlicesFile,
          depsSlicesFile,
        },
      );
      sinon.assert.notCalled(createDosaiMethodsSlice);
      assert.strictEqual(sliceArtefacts.usagesSlicesFile, usagesSlicesFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs dosai methods once with the exclude patterns when no deps slice exists", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-evinse-fresh-"));
    try {
      const bomFile = join(tmpDir, "bom.cdx.json");
      writeBomFile(bomFile, [nugetComponent]);
      const createDosaiMethodsSlice = sinon
        .stub()
        .callsFake((_src, outputFile) => {
          writeMethodsSlice(outputFile);
          return true;
        });
      const { analyzeProject } = await loadEvinser({ createDosaiMethodsSlice });
      const sliceArtefacts = await analyzeProject(
        {},
        {
          _: [tmpDir],
          language: ["dotnet"],
          input: bomFile,
          exclude: ["Tests/**", "Build/**"],
        },
      );
      sinon.assert.calledOnce(createDosaiMethodsSlice);
      assert.deepStrictEqual(
        createDosaiMethodsSlice.firstCall.args[2].exclude,
        ["Tests/**", "Build/**"],
      );
      assert.ok(sliceArtefacts.usagesSlicesFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reruns dosai when the deps slice is too small to be usable", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-evinse-tiny-"));
    try {
      const depsSlicesFile = join(tmpDir, "deps.slices.json");
      writeMethodsSlice(depsSlicesFile);
      const bomFile = join(tmpDir, "bom.cdx.json");
      writeBomFile(bomFile, [nugetComponent]);
      const createDosaiMethodsSlice = sinon
        .stub()
        .callsFake((_src, outputFile) => {
          writeMethodsSlice(outputFile);
          return true;
        });
      const { analyzeProject } = await loadEvinser({ createDosaiMethodsSlice });
      await analyzeProject(
        {},
        {
          _: [tmpDir],
          language: ["dotnet"],
          input: bomFile,
          depsSlicesFile,
        },
      );
      sinon.assert.calledOnce(createDosaiMethodsSlice);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("analyzeProject() dotnet reports too large to parse whole", () => {
  it("keeps the evidence and persists the full native report", async () => {
    // Issue 1033: dotnet/efcore produces a 1.9 GB dosai slice, and reading it
    // with readFileSync threw ERR_STRING_TOO_LONG. The mocked limit sends this
    // small one down the same streamed path.
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-evinse-large-"));
    try {
      const report = {
        // Past usableSlicesFile's 1 KB floor.
        ...methodsSlice(2048),
        Methods: Array.from({ length: 40 }, (_, i) => ({ Name: `M${i}` })),
        CallGraph: {
          Edges: [],
          Nodes: [
            {
              Id: "n1",
              ClassName: "Log",
              Name: "Information",
              Path: "src/Logging.cs",
              FileName: "Logging.cs",
              LineNumber: 9,
            },
            { Id: "n2", ClassName: "Unused", Name: "Other" },
          ],
        },
        PackageReachability: [
          { Purl: "pkg:nuget/Serilog@3.1.1", EdgeIds: [], NodeIds: ["n1"] },
        ],
      };
      const depsSlicesFile = join(tmpDir, "deps.slices.json");
      writeFileSync(depsSlicesFile, JSON.stringify(report));
      const semanticsSlicesFile = join(tmpDir, "semantics.slices.json");
      const bomFile = join(tmpDir, "bom.cdx.json");
      writeBomFile(bomFile, [nugetComponent]);
      const largeJson = await import("../parsers/largeJson.js");
      const indexJsonObject = sinon.spy(largeJson.indexJsonObject);
      // dosai.js is not mocked itself: a partial mock would keep its original
      // imports and bypass the largeJson mock.
      const { analyzeProject } = await esmock(
        "./evinser.js",
        {},
        {
          "../parsers/largeJson.js": {
            MAX_JSON_TEXT_BYTES: 0,
            indexJsonObject,
          },
        },
      );
      const sliceArtefacts = await analyzeProject(
        {},
        {
          _: [tmpDir],
          language: ["dotnet"],
          input: bomFile,
          depsSlicesFile,
          semanticsSlicesFile,
        },
      );
      // Reused rather than sliced again.
      assert.strictEqual(sliceArtefacts.usagesSlicesFile, depsSlicesFile);
      sinon.assert.calledWith(indexJsonObject, depsSlicesFile);
      assert.deepStrictEqual(
        [...sliceArtefacts.purlLocationMap["pkg:nuget/Serilog@3.1.1"]],
        ["src/Logging.cs#9"],
      );
      assert.strictEqual(
        sliceArtefacts.semanticsSlicesFile,
        semanticsSlicesFile,
      );
      assert.deepStrictEqual(
        JSON.parse(readFileSync(semanticsSlicesFile, "utf-8")),
        { Metadata: report.Metadata, methods: report, dataflows: {} },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("createEvinseFile() --annotate with large slices", () => {
  it("skips a slices file too large to embed and keeps the rest", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-evinse-annotate-"));
    const warn = sinon.stub(console, "warn");
    try {
      const bomFile = join(tmpDir, "bom.cdx.json");
      writeFileSync(
        bomFile,
        JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: 1.7,
          serialNumber: "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
          metadata: {
            tools: { components: [{ type: "application", name: "cdxgen" }] },
          },
          components: [nugetComponent],
        }),
      );
      const smallSlices = join(tmpDir, "small.slices.json");
      writeFileSync(smallSlices, '{"Slices":[]}');
      const largeSlices = join(tmpDir, "large.slices.json");
      writeFileSync(largeSlices, JSON.stringify(methodsSlice(4096)));
      const { createEvinseFile } = await esmock(
        "./evinser.js",
        {},
        { "../parsers/largeJson.js": { MAX_JSON_TEXT_BYTES: 1024 } },
      );
      const bomJson = await createEvinseFile(
        {
          purlLocationMap: {},
          dataFlowFrames: {},
          usagesSlicesFile: largeSlices,
          dataFlowSlicesFile: smallSlices,
        },
        {
          input: bomFile,
          output: join(tmpDir, "bom.evinse.json"),
          annotate: true,
        },
      );
      assert.deepStrictEqual(
        bomJson.annotations.map((annotation) => annotation.text),
        ['{"Slices":[]}'],
      );
      sinon.assert.calledWith(warn, sinon.match(largeSlices));
    } finally {
      warn.restore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("analyzeProject() dotnet crypto", () => {
  it("does not duplicate crypto components already present in the input BOM", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-evinse-crypto-"));
    try {
      const bomFile = join(tmpDir, "bom.cdx.json");
      const outFile = join(tmpDir, "bom.evinse.json");
      writeFileSync(
        bomFile,
        JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: 1.7,
          metadata: {},
          components: [nugetComponent, cryptoComponent],
        }),
      );
      const newCrypto = {
        ...cryptoComponent,
        name: "aes",
        "bom-ref": "crypto/algorithm/aes@2.16.840.1.101.3.4.1",
      };
      const { createEvinseFile } = await import("./evinser.js");
      const bomJson = await createEvinseFile(
        {
          purlLocationMap: {},
          dataFlowFrames: {},
          cryptoComponents: [{ ...cryptoComponent }, newCrypto],
        },
        { input: bomFile, output: outFile },
      );
      assert.deepStrictEqual(
        bomJson.components
          .filter((comp) => comp.type === "cryptographic-asset")
          .map((comp) => comp["bom-ref"]),
        [cryptoComponent["bom-ref"], newCrypto["bom-ref"]],
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("still collects dosai crypto components during evinse", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-evinse-crypto-new-"));
    try {
      const bomFile = join(tmpDir, "bom.cdx.json");
      writeBomFile(bomFile, [nugetComponent]);
      const collectDosaiCryptoComponents = sinon
        .stub()
        .resolves([{ ...cryptoComponent }]);
      const { analyzeProject } = await loadEvinser(
        {},
        {
          collectDosaiCryptoComponents,
        },
      );
      const sliceArtefacts = await analyzeProject(
        {},
        {
          _: [tmpDir],
          language: ["dotnet"],
          input: bomFile,
          includeCrypto: true,
        },
      );
      sinon.assert.calledOnce(collectDosaiCryptoComponents);
      assert.deepStrictEqual(sliceArtefacts.cryptoComponents, [
        { ...cryptoComponent },
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

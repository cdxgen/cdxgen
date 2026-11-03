import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import {
  dotnetProjectFormulationParser,
  goModuleFormulationParser,
  makefileFormulationParser,
  pythonRequirementsFormulationParser,
} from "./ecosystemFormulationParsers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(
  __dirname,
  "..",
  "..",
  "test",
  "data",
  "formulation-build-inputs",
);

function prop(component, name) {
  return component?.properties?.find((p) => p.name === name)?.value;
}

function parseOne(parser, fileName) {
  const result = parser.parse([path.join(fixtureDir, fileName)]);
  return result.components[0];
}

describe("makefileFormulationParser", () => {
  it("reads targets, includes and variables from a make file", () => {
    const component = parseOne(makefileFormulationParser, "Makefile");
    assert.ok(component, "expected a formulation component");
    assert.strictEqual(component.type, "application");
    assert.strictEqual(component.version, "config");
    assert.strictEqual(prop(component, "cdx:build:tool"), "make");
    const targets = prop(component, "cdx:make:targets").split(", ");
    // The .PHONY special target must be skipped, the docker target kept.
    assert.ok(targets.includes("all"));
    assert.ok(targets.includes("docker-build"));
    assert.ok(!targets.includes(".PHONY"));
    assert.strictEqual(prop(component, "cdx:make:includes"), "extra.mk");
    const variables = prop(component, "cdx:make:variables").split(", ");
    for (const variable of ["CC", "CXX", "CFLAGS"]) {
      assert.ok(variables.includes(variable), `${variable} should be listed`);
    }
    assert.strictEqual(prop(component, "cdx:make:usesDocker"), "true");
    // Variable values stay out of the BOM.
    assert.ok(
      !JSON.stringify(component).includes("-O2"),
      "variable values must not be recorded",
    );
  });

  it("reads project name, languages and counts from CMakeLists.txt", () => {
    const component = parseOne(makefileFormulationParser, "CMakeLists.txt");
    assert.strictEqual(component.name, "demo");
    assert.strictEqual(prop(component, "cdx:build:tool"), "cmake");
    assert.strictEqual(prop(component, "cdx:cmake:minimumVersion"), "3.16");
    assert.strictEqual(prop(component, "cdx:cmake:languages"), "C, CXX");
    assert.strictEqual(prop(component, "cdx:cmake:executableCount"), "1");
    assert.strictEqual(prop(component, "cdx:cmake:libraryCount"), "1");
  });
});

describe("goModuleFormulationParser", () => {
  it("reads the module, toolchain and requirement counts from go.mod", () => {
    const component = parseOne(goModuleFormulationParser, "go.mod");
    assert.strictEqual(component.name, "example.com/formulation-inputs");
    assert.strictEqual(prop(component, "cdx:go:version"), "1.22.2");
    assert.strictEqual(prop(component, "cdx:go:toolchain"), "go1.22.5");
    assert.strictEqual(prop(component, "cdx:go:requireCount"), "2");
    assert.strictEqual(prop(component, "cdx:go:indirectCount"), "1");
  });

  it("skips a file without a module directive", () => {
    const result = goModuleFormulationParser.parse([
      path.join(fixtureDir, "README.md"),
    ]);
    assert.deepStrictEqual(result.components, []);
  });
});

describe("pythonRequirementsFormulationParser", () => {
  it("counts pins and detects hashes in a requirements file", () => {
    const component = parseOne(
      pythonRequirementsFormulationParser,
      "requirements.txt",
    );
    assert.strictEqual(prop(component, "cdx:pip:kind"), "requirements");
    // Comments and the --index-url option line are not pins.
    assert.strictEqual(prop(component, "cdx:pip:pinCount"), "4");
    assert.strictEqual(prop(component, "cdx:pip:hasHashes"), "true");
  });

  it("treats a constraints file as pins only", () => {
    const component = parseOne(
      pythonRequirementsFormulationParser,
      "constraints.txt",
    );
    assert.strictEqual(prop(component, "cdx:pip:kind"), "constraints");
    assert.strictEqual(prop(component, "cdx:pip:pinCount"), "3");
    assert.ok(!prop(component, "cdx:pip:hasHashes"));
  });
});

describe("dotnetProjectFormulationParser", () => {
  it("reads sdk, framework and package counts from an SDK-style csproj", () => {
    const component = parseOne(dotnetProjectFormulationParser, "Demo.csproj");
    assert.strictEqual(component.name, "Demo");
    assert.strictEqual(prop(component, "cdx:build:tool"), "nuget");
    assert.strictEqual(prop(component, "cdx:msbuild:sdk"), "Microsoft.NET.Sdk");
    assert.strictEqual(
      prop(component, "cdx:msbuild:targetFrameworks"),
      "net8.0",
    );
    assert.strictEqual(prop(component, "cdx:msbuild:outputType"), "Exe");
    assert.strictEqual(prop(component, "cdx:msbuild:version"), "1.2.3");
    assert.strictEqual(
      prop(component, "cdx:msbuild:packageReferenceCount"),
      "2",
    );
  });

  it("reads restore facts from project.assets.json", () => {
    const component = parseOne(
      dotnetProjectFormulationParser,
      "project.assets.json",
    );
    assert.strictEqual(component.name, "Demo");
    assert.strictEqual(prop(component, "cdx:nuget:assetsVersion"), "3");
    assert.strictEqual(prop(component, "cdx:nuget:frameworks"), "net8.0");
    assert.strictEqual(prop(component, "cdx:nuget:libraryCount"), "3");
    assert.strictEqual(prop(component, "cdx:nuget:targetCount"), "1");
  });
});

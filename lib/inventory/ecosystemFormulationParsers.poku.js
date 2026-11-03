import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import {
  dotnetProjectFormulationParser,
  goModuleFormulationParser,
  MAX_ASSETS_READ_BYTES,
  MAX_READ_BYTES,
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

// Write files into a fresh temporary directory, run fn with their paths and
// remove the directory afterwards.
function withTempFiles(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "cdxgen-formulation-"));
  try {
    const paths = Object.entries(files).map(([name, content]) => {
      const filePath = path.join(dir, name);
      writeFileSync(filePath, content);
      return filePath;
    });
    return fn(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseText(parser, fileName, content) {
  return withTempFiles(
    { [fileName]: content },
    (paths) => parser.parse(paths).components[0],
  );
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
    // The absolute and parent-relative includes are dropped.
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

  it("tells assignments from rules with indexOf tokenisation", () => {
    const component = parseText(
      makefileFormulationParser,
      "Makefile",
      [
        "SIMPLE := 1",
        "POSIX ::= 2",
        "IMMEDIATE :::= 3",
        "COND ?= 4",
        "APPEND += 5",
        "SHELL_OUT != echo 6",
        "build: SIMPLE=override",
        "release: build",
        "%.o: %.c",
        ".DEFAULT_GOAL := release",
        "$(OUT): build",
        "# commented: target",
        "\techo recipe: not a target",
        "include /etc/site.mk C:\\mk\\win.mk \\\\server\\share\\x.mk ~/x.mk sub/../../up.mk rules/local.mk",
      ].join("\n"),
    );
    assert.deepStrictEqual(
      prop(component, "cdx:make:targets").split(", ").sort(),
      ["build", "release"],
    );
    assert.deepStrictEqual(
      prop(component, "cdx:make:variables").split(", ").sort(),
      ["APPEND", "COND", "IMMEDIATE", "POSIX", "SHELL_OUT", "SIMPLE"],
    );
    assert.strictEqual(prop(component, "cdx:make:includes"), "rules/local.mk");
  });

  it("parses pathological make lines in linear time", () => {
    const longLine = "a".repeat(200 * 1024);
    const spaces = " ".repeat(200 * 1024);
    const started = Date.now();
    const component = parseText(
      makefileFormulationParser,
      "Makefile",
      `${longLine}\n${spaces}\n${spaces}x\nall: demo\n`,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `make parsing took ${elapsed} ms`);
    assert.strictEqual(prop(component, "cdx:make:targets"), "all");
    // The same input through the CMake reader stays fast too.
    const cmakeStarted = Date.now();
    parseText(
      makefileFormulationParser,
      "CMakeLists.txt",
      `project(${spaces}${"project(".repeat(20000)}`,
    );
    assert.ok(Date.now() - cmakeStarted < 1000);
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
    // Two block requirements and one single-line require; the replace,
    // exclude and retract directives are not requirements.
    assert.strictEqual(prop(component, "cdx:go:requireCount"), "3");
    assert.strictEqual(prop(component, "cdx:go:indirectCount"), "1");
  });

  it("counts a single-line require and ignores replace and exclude blocks", () => {
    const component = parseText(
      goModuleFormulationParser,
      "go.mod",
      [
        'module "example.com/quoted"',
        "",
        "go 1.23",
        "",
        "require github.com/x/y v1.2.3 // indirect",
        "require(",
        "\tgithub.com/a/b v0.1.0",
        ")",
        "replace (",
        "\tgithub.com/x/y v1.2.3 => github.com/x/z v1.2.4",
        "\tgithub.com/p/q v1.0.0 => ../q",
        ")",
        "exclude (",
        "\tgithub.com/x/y v1.0.0 // indirect",
        ")",
        "retract [v1.0.0, v1.0.5]",
      ].join("\n"),
    );
    assert.strictEqual(component.name, "example.com/quoted");
    assert.strictEqual(prop(component, "cdx:go:version"), "1.23");
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
    // Comments and the --index-url option line are not requirements, and
    // the certifi lower bound is a requirement but not an exact pin.
    assert.strictEqual(prop(component, "cdx:pip:requirementCount"), "4");
    assert.strictEqual(prop(component, "cdx:pip:pinCount"), "3");
    assert.strictEqual(prop(component, "cdx:pip:unpinnedCount"), "1");
    assert.strictEqual(prop(component, "cdx:pip:hasHashes"), "true");
  });

  it("finds hashes on pip-compile continuation lines", () => {
    const component = parseText(
      pythonRequirementsFormulationParser,
      "requirements.txt",
      [
        "idna==3.7 \\",
        "    --hash=sha256:82fee1fc78add43492d3a1898bfa6d8a904cc97d8427f683ed8e798d07761aa0 \\",
        "    --hash=sha256:028ff3aadf0609c1fd278d8ea3089299412a7a8b9bd005dd08b9f8285bcb5cfc",
        "    # via requests",
        "packaging===24.1",
        "attrs==23.*",
        "six>=1.16,<2",
        "wheel==0.43.0 ; python_version >= '3.8'",
        "pip~=24.0",
        "# a comment line ending in a backslash does not continue \\",
        "flask==3.0.3",
        "requests==2.32.3 \\",
        "    # a comment line ends the continuation",
        "click==8.1.7",
      ].join("\n"),
    );
    assert.strictEqual(prop(component, "cdx:pip:hasHashes"), "true");
    assert.strictEqual(prop(component, "cdx:pip:requirementCount"), "9");
    // idna, packaging, wheel, flask, requests and click are exact pins; the
    // wildcard, the range and the compatible-release specifier are not.
    assert.strictEqual(prop(component, "cdx:pip:pinCount"), "6");
    assert.strictEqual(prop(component, "cdx:pip:unpinnedCount"), "3");
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

describe("bounded reads", () => {
  it("skips build files above the read cap without parsing them", () => {
    const oversize = `module example.com/big\n${"/".repeat(MAX_READ_BYTES)}\n`;
    withTempFiles(
      {
        "go.mod": oversize,
        "requirements.txt": `a==1\n${"#".repeat(MAX_READ_BYTES)}`,
      },
      ([goMod, requirements]) => {
        assert.deepStrictEqual(
          goModuleFormulationParser.parse([goMod]).components,
          [],
        );
        assert.deepStrictEqual(
          pythonRequirementsFormulationParser.parse([requirements]).components,
          [],
        );
      },
    );
  });

  it("skips a project.assets.json above its cap", () => {
    const padding = " ".repeat(MAX_ASSETS_READ_BYTES);
    withTempFiles(
      {
        "project.assets.json": `{"version": 3, "libraries": {}${padding}}`,
      },
      ([assets]) => {
        assert.deepStrictEqual(
          dotnetProjectFormulationParser.parse([assets]).components,
          [],
        );
      },
    );
  });
});

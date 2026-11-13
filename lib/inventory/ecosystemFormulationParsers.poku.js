import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import {
  dotnetProjectFormulationParser,
  formulationSourcePath,
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

  it("parses pathological make and CMake input without stalling", () => {
    const longLine = "a".repeat(200 * 1024);
    const spaces = " ".repeat(200 * 1024);
    // Lines just under the length cap, full of the characters the
    // assignment and rule tokeniser looks for.
    const colons = `${":".repeat(4000)}=`;
    const equals = `X${"=".repeat(4000)}:`;
    const continued = Array(2000).fill("A = b \\").join("\n");
    // The bound only catches super-linear behaviour, which takes minutes on
    // these inputs; it is far above the time any runner needs.
    const started = Date.now();
    const component = parseText(
      makefileFormulationParser,
      "Makefile",
      `${longLine}\n${spaces}\n${spaces}x\n${colons}\n${equals}\n${continued}\n\nall: demo\n`,
    );
    assert.strictEqual(prop(component, "cdx:make:targets"), "all");
    parseText(
      makefileFormulationParser,
      "CMakeLists.txt",
      `project(${spaces}${"project(".repeat(20000)}${"#[[".repeat(20000)}`,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30000, `parsing took ${elapsed} ms`);
  });

  it("keeps values out of targets across continuations and define blocks", () => {
    const component = parseText(
      makefileFormulationParser,
      "Makefile",
      [
        "DOCKER_LOGIN = docker login -u ci \\",
        "    -p s3cr3tP@ss registry.example.com:5000",
        "LDFLAGS = -L/opt/x \\",
        "    -Wl,-rpath,/home/alice/sdk/lib:/home/alice/other",
        "define NETRC",
        "machine github.com login ci-bot password ghp_abcdef0123456789: x",
        "define INNER",
        "nested: body",
        "endef",
        "still-inside: body",
        "endef",
        "override define RECIPE :=",
        "deploy: $(TOKEN)",
        "endef",
        "# a comment that continues \\",
        "commented-out: target",
        "all: build",
      ].join("\n"),
    );
    assert.strictEqual(prop(component, "cdx:make:targets"), "all");
    assert.strictEqual(prop(component, "cdx:make:targetCount"), "1");
    assert.deepStrictEqual(
      prop(component, "cdx:make:variables").split(", ").sort(),
      ["DOCKER_LOGIN", "LDFLAGS", "NETRC", "RECIPE"],
    );
    const text = JSON.stringify(component);
    for (const leaked of ["s3cr3t", "/home/alice", "ghp_", "ci-bot"]) {
      assert.ok(!text.includes(leaked), `${leaked} must not be recorded`);
    }
  });

  it("records only file names from include directives", () => {
    const component = parseText(
      makefileFormulationParser,
      "Makefile",
      [
        '-include $(shell curl -sSfL -u ci-bot:s3cr3tInc -H "X-Api-Key: k3yabc" -o .harness "https://u:p4ss@host/h.mk?sig=zz"; echo .harness)',
        "include rules/local.mk $(DEPS) build/$(ARCH).mk $(DEPS:.o=.d) # a comment with tok3n",
        "sinclude $(wildcard conf/*.mk) conf/site.mk",
        "include tail.mk#note k3ynote.mk",
      ].join("\n"),
    );
    assert.strictEqual(
      prop(component, "cdx:make:includes"),
      "rules/local.mk, $(DEPS), build/$(ARCH).mk, conf/site.mk, tail.mk",
    );
    const text = JSON.stringify(component);
    for (const leaked of [
      "s3cr3t",
      "k3yabc",
      "p4ss",
      "sig=",
      "tok3n",
      "k3ynote",
      "curl",
    ]) {
      assert.ok(!text.includes(leaked), `${leaked} must not be recorded`);
    }
  });

  it("records only single-token, project-relative targets", () => {
    const component = parseText(
      makefileFormulationParser,
      "Makefile",
      [
        "/home/alice/.local/bin/demo: demo",
        "C:\\build\\out.exe: main.obj",
        "C:/build/out.exe: main.obj",
        "~/bin/demo: demo",
        "../outside: demo",
        "-p: demo",
        "a b c: d",
        '"quoted": demo',
        "bin/demo: demo",
        "export CFLAGS = -O2",
        "override LDFLAGS += -s",
        "private export HIDDEN := 1",
        "export",
      ].join("\n"),
    );
    assert.strictEqual(prop(component, "cdx:make:targets"), "bin/demo");
    assert.deepStrictEqual(
      prop(component, "cdx:make:variables").split(", ").sort(),
      ["CFLAGS", "HIDDEN", "LDFLAGS"],
    );
  });

  it("matches CMake commands case-insensitively and ignores comments", () => {
    const legacy = parseText(
      makefileFormulationParser,
      "CMakeLists.txt",
      [
        "CMAKE_MINIMUM_REQUIRED(VERSION 2.8)",
        "PROJECT(legacy C CXX)",
        "ADD_EXECUTABLE(x x.c)",
        "Add_Library(y y.c)",
      ].join("\n"),
    );
    assert.strictEqual(legacy.name, "legacy");
    assert.strictEqual(prop(legacy, "cdx:cmake:minimumVersion"), "2.8");
    assert.strictEqual(prop(legacy, "cdx:cmake:languages"), "C, CXX");
    assert.strictEqual(prop(legacy, "cdx:cmake:executableCount"), "1");
    assert.strictEqual(prop(legacy, "cdx:cmake:libraryCount"), "1");
    const commented = parseText(
      makefileFormulationParser,
      "CMakeLists.txt",
      [
        "# project(oldname) was renamed",
        "#[[ add_executable(ghost ghost.c)",
        "project(ghost) ]]",
        'set(NOTE "# project(quoted) stays a string")',
        "cmake_minimum_required(VERSION 3.20)",
        'project(newname VERSION 1.0 DESCRIPTION "A C helper" LANGUAGES CXX)',
        "add_library(real real.cpp) # add_library(fake)",
      ].join("\n"),
    );
    assert.strictEqual(commented.name, "newname");
    assert.strictEqual(prop(commented, "cdx:cmake:languages"), "CXX");
    assert.strictEqual(prop(commented, "cdx:cmake:executableCount"), "0");
    assert.strictEqual(prop(commented, "cdx:cmake:libraryCount"), "1");
    const keywordsOnly = parseText(
      makefileFormulationParser,
      "CMakeLists.txt",
      'project(plain VERSION 2.0 DESCRIPTION "C and CXX glue")',
    );
    assert.strictEqual(prop(keywordsOnly, "cdx:cmake:languages"), undefined);
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

  it("counts editable installs and direct references as unpinned", () => {
    const component = parseText(
      pythonRequirementsFormulationParser,
      "requirements.txt",
      [
        "-r base.txt",
        "-c constraints.txt",
        "--extra-index-url https://user:tok@host/simple",
        "-e git+https://user:tok@github.com/org/pkg.git#egg=pkg",
        "--editable ./local",
        "-e.",
        "pkg @ https://user:tok@host/pkg-1.0.whl",
        "other@https://host/other.whl?x==1",
        "https://host/bare-1.0.whl?v==2",
        "./local/path",
        "foo==1.0 \\",
        "  --hash=sha256:abc",
        "bar[extra] == 2.0",
        "baz != 1.0",
      ].join("\n"),
    );
    // Three editable installs, four direct references, foo, bar and baz.
    assert.strictEqual(prop(component, "cdx:pip:requirementCount"), "10");
    assert.strictEqual(prop(component, "cdx:pip:pinCount"), "2");
    assert.strictEqual(prop(component, "cdx:pip:unpinnedCount"), "8");
    assert.strictEqual(prop(component, "cdx:pip:hasHashes"), "true");
    assert.ok(!JSON.stringify(component).includes("tok"));
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

describe("dotnetProjectFormulationParser restore edge cases", () => {
  it("records assetsVersion only when it is a string or number", () => {
    const frameworks = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`net${index}.0`, {}]),
    );
    const component = parseText(
      dotnetProjectFormulationParser,
      "project.assets.json",
      JSON.stringify({
        version: { nested: true },
        project: { restore: { projectName: { x: 1 } }, frameworks },
      }),
    );
    assert.strictEqual(prop(component, "cdx:nuget:assetsVersion"), undefined);
    assert.strictEqual(
      prop(component, "cdx:nuget:frameworks").split(", ").length,
      25,
    );
    assert.strictEqual(typeof component.name, "string");
  });
});

describe("source paths and file safety", () => {
  it("records project-relative paths with forward slashes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cdxgen-formulation-"));
    try {
      const nested = path.join(dir, "native", "lib");
      mkdirSync(nested, { recursive: true });
      const makefile = path.join(nested, "Makefile");
      writeFileSync(makefile, "all: build\n");
      const component = makefileFormulationParser.parse(
        [makefile],
        {},
        {
          rootDir: dir,
        },
      ).components[0];
      assert.strictEqual(
        prop(component, "internal:SrcFile"),
        "native/lib/Makefile",
      );
      assert.strictEqual(
        component["bom-ref"],
        "urn:cdxgen:formulation:make:native/lib/Makefile",
      );
      assert.ok(!JSON.stringify(component).includes(dir));
      // Without a root, or for a file outside it, only the name is kept.
      assert.strictEqual(formulationSourcePath(makefile), "Makefile");
      assert.strictEqual(
        formulationSourcePath(makefile, path.join(dir, "elsewhere")),
        "Makefile",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not read a build file that is a symlink", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cdxgen-formulation-"));
    try {
      const outside = path.join(dir, "outside");
      const project = path.join(dir, "project");
      mkdirSync(outside);
      mkdirSync(project);
      const passwd = path.join(outside, "passwd");
      writeFileSync(passwd, "alice:x:501:20::/Users/alice:/bin/zsh\n");
      const link = path.join(project, "Makefile");
      try {
        symlinkSync(passwd, link);
      } catch {
        // Creating symlinks needs a privilege some Windows runners lack;
        // the regular-file check is then exercised by the other tests.
        return;
      }
      for (const rootDir of [project, undefined]) {
        assert.deepStrictEqual(
          makefileFormulationParser.parse([link], {}, { rootDir }).components,
          [],
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

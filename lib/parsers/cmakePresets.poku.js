// biome-ignore-all lint/suspicious/noTemplateCurlyInString: CMake preset macros are written as ${name}
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  evaluatePresetCondition,
  expandPresetMacros,
  parseCmakePresets,
  resolveConfigurePresets,
} from "./cmakePresets.js";

const sourceDir = join("/work", "compiler");

function doc(document, file = join(sourceDir, "CMakePresets.json")) {
  return { file, fileDir: sourceDir, document };
}

function resolveAll(configurePresets, context = {}) {
  return resolveConfigurePresets([doc({ version: 6, configurePresets })], {
    sourceDir,
    sourceParentDir: "/work",
    sourceDirName: "compiler",
    hostSystemName: "Linux",
    pathListSep: ":",
    penv: (name) => ({ HOME: "/home/dev", TOOLS: "/opt/tools" })[name],
    ...context,
  });
}

describe("parseCmakePresets()", () => {
  it("reads the version, includes and configure presets", () => {
    const parsed = parseCmakePresets(
      JSON.stringify({
        version: 4,
        include: ["presets/common.json", 3],
        configurePresets: [{ name: "a" }, { hidden: true }, "b"],
      }),
    );
    assert.strictEqual(parsed.version, 4);
    assert.deepStrictEqual(parsed.include, ["presets/common.json"]);
    assert.deepStrictEqual(
      parsed.configurePresets.map((p) => p.name),
      ["a"],
    );
  });

  it("rejects text that is not a presets document", () => {
    assert.strictEqual(parseCmakePresets("{"), null);
    assert.strictEqual(parseCmakePresets("[]"), null);
    assert.strictEqual(parseCmakePresets(""), null);
    assert.strictEqual(parseCmakePresets(undefined), null);
  });
});

describe("expandPresetMacros()", () => {
  const context = {
    sourceDir,
    sourceParentDir: "/work",
    sourceDirName: "compiler",
    presetName: "linux-gcc",
    generator: "Ninja",
    hostSystemName: "Linux",
    fileDir: join(sourceDir, "presets"),
    pathListSep: ":",
    env: { CC: "gcc", BUILD_ROOT: "/fast/build" },
    penv: (name) => ({ HOME: "/home/dev", CC: "cc" })[name],
  };

  it("expands the source, preset and host macros", () => {
    assert.strictEqual(
      expandPresetMacros(
        "${sourceDir}/build/${presetName}-${hostSystemName}",
        context,
      ),
      `${sourceDir}/build/linux-gcc-Linux`,
    );
    assert.strictEqual(
      expandPresetMacros(
        "${sourceParentDir}|${sourceDirName}|${generator}|${fileDir}|${pathListSep}",
        context,
      ),
      `/work|compiler|Ninja|${join(sourceDir, "presets")}|:`,
    );
  });

  it("reads $env from the preset first and $penv from the process", () => {
    assert.strictEqual(
      expandPresetMacros("$env{CC} $penv{CC} $env{HOME}", context),
      "gcc cc /home/dev",
    );
    assert.strictEqual(expandPresetMacros("$env{MISSING}x", context), "x");
  });

  it("leaves vendor and unknown macros, and lone dollars, as written", () => {
    assert.strictEqual(
      expandPresetMacros("$vendor{x} ${unknown} $ ${dollar}", context),
      "$vendor{x} ${unknown} $ $",
    );
    assert.strictEqual(expandPresetMacros("cost $5", context), "cost $5");
    assert.strictEqual(
      expandPresetMacros("${sourceDir", context),
      "${sourceDir",
    );
  });
});

describe("evaluatePresetCondition()", () => {
  const expand = (v) =>
    v.replace("${hostSystemName}", "Linux").replace("$env{ARCH}", "x86_64");

  it("decides const, equality, list and composite conditions", () => {
    assert.strictEqual(evaluatePresetCondition(undefined, expand), true);
    assert.strictEqual(evaluatePresetCondition(null, expand), true);
    assert.strictEqual(evaluatePresetCondition(false, expand), false);
    assert.strictEqual(
      evaluatePresetCondition({ type: "const", value: false }, expand),
      false,
    );
    assert.strictEqual(
      evaluatePresetCondition(
        { type: "equals", lhs: "${hostSystemName}", rhs: "Linux" },
        expand,
      ),
      true,
    );
    assert.strictEqual(
      evaluatePresetCondition(
        { type: "notEquals", lhs: "${hostSystemName}", rhs: "Linux" },
        expand,
      ),
      false,
    );
    assert.strictEqual(
      evaluatePresetCondition(
        {
          type: "inList",
          string: "${hostSystemName}",
          list: ["Darwin", "Linux"],
        },
        expand,
      ),
      true,
    );
    assert.strictEqual(
      evaluatePresetCondition(
        {
          type: "allOf",
          conditions: [
            { type: "equals", lhs: "$env{ARCH}", rhs: "x86_64" },
            {
              type: "not",
              condition: {
                type: "notInList",
                string: "Linux",
                list: ["Linux"],
              },
            },
          ],
        },
        expand,
      ),
      true,
    );
  });

  it("does not run a repository's regular expressions", () => {
    const matches = { type: "matches", string: "Linux", regex: "^Lin" };
    assert.strictEqual(evaluatePresetCondition(matches, expand), undefined);
    assert.strictEqual(
      evaluatePresetCondition(
        {
          type: "anyOf",
          conditions: [matches, { type: "const", value: true }],
        },
        expand,
      ),
      true,
    );
    assert.strictEqual(
      evaluatePresetCondition(
        {
          type: "allOf",
          conditions: [matches, { type: "const", value: true }],
        },
        expand,
      ),
      undefined,
    );
  });
});

describe("resolveConfigurePresets()", () => {
  it("inherits fields from the first parent that sets them, and drops hidden presets", () => {
    const presets = resolveAll([
      {
        name: "common",
        hidden: true,
        generator: "Ninja",
        displayName: "Common",
        cacheVariables: {
          CMAKE_BUILD_TYPE: "Debug",
          RT_LIBS: "linux_x86_64",
          UNSET_ME: "x",
        },
      },
      {
        name: "clang-env",
        hidden: true,
        generator: "Unix Makefiles",
        environment: { CC: "clang", CXX: "clang++" },
        cacheVariables: { RT_LIBS: "from-second-parent", EXTRA: "on" },
      },
      {
        name: "linux-clang-debug",
        inherits: ["common", "clang-env"],
        binaryDir: "${sourceDir}/build/clang",
        cacheVariables: {
          MACRO_CONF: "linux-clang",
          UNSET_ME: null,
          MSVC: true,
          TYPED: { type: "STRING", value: "typed-value" },
        },
      },
    ]);
    assert.deepStrictEqual(
      presets.map((p) => p.name),
      ["linux-clang-debug"],
    );
    const [p] = presets;
    assert.strictEqual(p.generator, "Ninja");
    assert.strictEqual(p.displayName, undefined);
    assert.strictEqual(p.binaryDir, join(sourceDir, "build", "clang"));
    assert.deepStrictEqual(p.inherits, ["common", "clang-env"]);
    assert.deepStrictEqual(p.environment, { CC: "clang", CXX: "clang++" });
    assert.deepStrictEqual(p.cacheVariables, {
      CMAKE_BUILD_TYPE: "Debug",
      RT_LIBS: "linux_x86_64",
      EXTRA: "on",
      MACRO_CONF: "linux-clang",
      MSVC: "TRUE",
      TYPED: "typed-value",
    });
    assert.strictEqual(p.hasCondition, false);
    assert.strictEqual(p.conditionMet, true);
  });

  it("inherits through several levels and resolves relative build directories", () => {
    const [, , lsp] = resolveAll([
      { name: "base", cacheVariables: { CMAKE_BUILD_TYPE: "Debug" } },
      { name: "clang", inherits: "base", binaryDir: "build/clang" },
      {
        name: "clang-lsp",
        inherits: "clang",
        binaryDir: "out/${presetName}",
        cacheVariables: { CMAKE_EXPORT_COMPILE_COMMANDS: "1" },
      },
    ]);
    assert.strictEqual(lsp.binaryDir, join(sourceDir, "out", "clang-lsp"));
    assert.deepStrictEqual(lsp.cacheVariables, {
      CMAKE_BUILD_TYPE: "Debug",
      CMAKE_EXPORT_COMPILE_COMMANDS: "1",
    });
  });

  it("expands environment chains and the toolchain file", () => {
    const [p] = resolveAll([
      {
        name: "vcpkg",
        environment: {
          VCPKG_ROOT: "$penv{TOOLS}/vcpkg",
          PATH: "$env{VCPKG_ROOT}/bin:$penv{PATH}",
        },
        toolchainFile: "$env{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake",
        cacheVariables: { VCPKG_TARGET_TRIPLET: "x64-linux" },
      },
    ]);
    assert.strictEqual(
      p.toolchainFile,
      "/opt/tools/vcpkg/scripts/buildsystems/vcpkg.cmake",
    );
    assert.strictEqual(p.environment.PATH, "/opt/tools/vcpkg/bin:");
  });

  it("takes the toolchain file from the cache variables too", () => {
    const [p] = resolveAll([
      {
        name: "cross",
        cacheVariables: {
          CMAKE_TOOLCHAIN_FILE: "${sourceDir}/cmake/arm.cmake",
        },
      },
    ]);
    assert.strictEqual(p.toolchainFile, `${sourceDir}/cmake/arm.cmake`);
  });

  it("evaluates conditions, inherited unless the preset sets its own", () => {
    const presets = resolveAll([
      {
        name: "windows-common",
        hidden: true,
        condition: { type: "equals", lhs: "${hostSystemName}", rhs: "Windows" },
      },
      { name: "windows-msvc", inherits: "windows-common" },
      {
        name: "anywhere",
        inherits: "windows-common",
        condition: { type: "const", value: true },
      },
    ]);
    const byName = Object.fromEntries(presets.map((p) => [p.name, p]));
    assert.strictEqual(byName["windows-msvc"].hasCondition, true);
    assert.strictEqual(byName["windows-msvc"].conditionMet, false);
    assert.strictEqual(byName.anywhere.conditionMet, true);
  });

  it("drops presets in an inheritance cycle or with a missing parent", () => {
    const presets = resolveAll([
      { name: "a", inherits: "b" },
      { name: "b", inherits: "a" },
      { name: "orphan", inherits: "nowhere" },
      { name: "fine" },
    ]);
    assert.deepStrictEqual(
      presets.map((p) => p.name),
      ["fine"],
    );
  });

  it("lets a user preset inherit from a project preset", () => {
    const presets = resolveConfigurePresets(
      [
        doc({
          version: 4,
          configurePresets: [
            { name: "project", hidden: true, generator: "Ninja" },
          ],
        }),
        doc(
          {
            version: 4,
            configurePresets: [{ name: "mine", inherits: "project" }],
          },
          join(sourceDir, "CMakeUserPresets.json"),
        ),
      ],
      { sourceDir },
    );
    assert.strictEqual(presets.length, 1);
    assert.strictEqual(presets[0].generator, "Ninja");
    assert.strictEqual(
      presets[0].file,
      join(sourceDir, "CMakeUserPresets.json"),
    );
  });
});

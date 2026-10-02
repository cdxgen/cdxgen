// biome-ignore-all lint/suspicious/noTemplateCurlyInString: CMake preset macros are written as ${name}
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import { isWin } from "../core/paths.js";
import {
  emptyCppBuildContext,
  resolveCppBuildContext,
  trustedCompilerPath,
} from "./cppBuildContext.js";

function write(file, content) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
}

function stub(file, body) {
  write(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/**
 * A configured CMake project: presets modelled on a compiler project's
 * (hidden per-platform templates, per-compiler presets, a Windows-only
 * preset, a vcpkg preset), a build tree with CMake's compiler description,
 * and a compilation database naming a compiler CMake identified, a vendor
 * compiler built on the EDG front end, two compilers inside the project and
 * an MSVC one.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cpp-build-"));
  const tools = mkdtempSync(join(tmpdir(), "cpp-tools-"));
  const marker = join(tools, "ran-inside-project");
  const gcc = stub(join(tools, "gcc"), 'echo "gcc (GCC) 13.2.0"');
  const vendor = stub(
    join(tools, "acme-gcc"),
    [
      'if [ "$1" = "--version" ]; then',
      '  echo "acme-gcc version 4.1.0"',
      '  echo "Based on the Edison Design Group C/C++ Front End"',
      "fi",
    ].join("\n"),
  );
  stub(join(root, "tools", "cc"), `touch "${marker}"`);
  const insideAbsolute = stub(join(root, "tools", "gcc"), `touch "${marker}"`);
  write(join(root, "CMakePresets.json"), {
    version: 3,
    configurePresets: [
      {
        name: "linux-common",
        hidden: true,
        generator: "Ninja",
        cacheVariables: {
          CMAKE_BUILD_TYPE: "Debug",
          CMAKE_C_FLAGS: "-fstack-protector-strong -D_FORTIFY_SOURCE=2",
          CMAKE_EXE_LINKER_FLAGS: "-Wl,-z,relro,-z,now",
        },
      },
      {
        name: "linux-gcc-debug",
        displayName: "GCC debug",
        inherits: "linux-common",
        binaryDir: "${sourceDir}/build/gcc",
        environment: { CC: "gcc", CXX: "g++" },
        cacheVariables: { CMAKE_EXPORT_COMPILE_COMMANDS: "1" },
      },
      {
        name: "windows-msvc",
        generator: "Visual Studio 17 2022",
        binaryDir: "${sourceDir}/build/msvc",
        condition: {
          type: "equals",
          lhs: "${hostSystemName}",
          rhs: "Windows",
        },
      },
      {
        name: "vcpkg",
        binaryDir: "${sourceDir}/build/vcpkg",
        environment: { VCPKG_ROOT: "${sourceDir}/vcpkg" },
        toolchainFile: "$env{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake",
        cacheVariables: {
          VCPKG_TARGET_TRIPLET: "x64-linux",
          CMAKE_CXX_COMPILER: "/usr/local/bin/clang++",
        },
      },
    ],
  });
  const buildDir = join(root, "build", "gcc");
  write(
    join(buildDir, "CMakeCache.txt"),
    [
      "# This is the CMakeCache file.",
      "CMAKE_BUILD_TYPE:STRING=Debug",
      "CMAKE_EXE_LINKER_FLAGS:STRING=-Wl,-z,relro,-z,now",
      "CMAKE_PROJECT_NAME:STATIC=compiler",
    ].join("\n"),
  );
  write(
    join(buildDir, "CMakeFiles", "3.30.2", "CMakeCCompiler.cmake"),
    [
      `set(CMAKE_C_COMPILER "${gcc}")`,
      'set(CMAKE_C_COMPILER_ARG1 "")',
      'set(CMAKE_C_COMPILER_ID "GNU")',
      'set(CMAKE_C_COMPILER_VERSION "13.2.0")',
    ].join("\n"),
  );
  write(join(root, "include", "proj", "api.h"), "int api(void);\n");
  write(join(root, "third_party", "zlib", "zlib.h"), "int z(void);\n");
  write(join(root, "config.h"), "#define X 1\n");
  const unit = (file, command) => ({ directory: buildDir, file, command });
  write(join(buildDir, "compile_commands.json"), [
    unit(
      "../../src/a.c",
      `${gcc} -I../../include -I../../third_party/zlib -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE -c ../../src/a.c`,
    ),
    unit(
      "../../src/b.c",
      `${gcc} -I../../include -D_FORTIFY_SOURCE=2 -fstack-protector-strong -c ../../src/b.c`,
    ),
    unit("../../src/c.cc", `${vendor} -D_FORTIFY_SOURCE=3 -c ../../src/c.cc`),
    unit("../../src/d.c", "./tools/cc -c ../../src/d.c"),
    unit("../../src/e.c", `${insideAbsolute} -c ../../src/e.c`),
    unit(
      "../../src/w.cpp",
      "cl.exe /Iinc /GS /guard:cf /DNDEBUG ../../src/w.cpp",
    ),
  ]);
  const cmakeContext = {
    boundaries: new Map([["third_party/zlib", { kind: "submodule" }]]),
  };
  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  };
  return { root, tools, marker, gcc, vendor, cmakeContext, cleanup };
}

const propsOf = (component) =>
  Object.fromEntries(
    (component?.properties || []).map((p) => [p.name, p.value]),
  );

// the fixtures use shell scripts as compilers
describe("resolveCppBuildContext()", () => {
  if (isWin) {
    return;
  }
  it("lists the configure presets as formulation components", () => {
    const f = fixture();
    try {
      const context = resolveCppBuildContext(f.root, {}, f.cmakeContext);
      const presets = context.formulationComponents.filter(
        (c) => c.type === "data",
      );
      assert.deepStrictEqual(
        presets.map((c) => c.name),
        ["linux-gcc-debug", "windows-msvc", "vcpkg"],
      );
      const gccPreset = presets[0];
      assert.strictEqual(gccPreset["bom-ref"], "cmake-preset:linux-gcc-debug");
      assert.strictEqual(gccPreset.description, "GCC debug");
      assert.deepStrictEqual(propsOf(gccPreset), {
        "cdx:cmake:preset:file": "CMakePresets.json",
        "cdx:cmake:preset:inherits": "linux-common",
        "cdx:cmake:preset:generator": "Ninja",
        "cdx:cmake:preset:binaryDir": "build/gcc",
        "cdx:cmake:preset:buildType": "Debug",
        "cdx:cmake:preset:cCompiler": "gcc",
        "cdx:cmake:preset:cxxCompiler": "g++",
        "cdx:cmake:preset:exportCompileCommands": "true",
        "cdx:cpp:hardening:fortifySource": "2",
        "cdx:cpp:hardening:relro": "full",
        "cdx:cpp:hardening:stackProtector": "strong",
      });
      assert.strictEqual(
        propsOf(presets[1])["cdx:cmake:preset:hostCondition"],
        "unmet",
      );
      assert.deepStrictEqual(propsOf(presets[2]), {
        "cdx:cmake:preset:file": "CMakePresets.json",
        "cdx:cmake:preset:binaryDir": "build/vcpkg",
        "cdx:cmake:preset:cxxCompiler": "clang++",
        "cdx:cmake:preset:toolchainFile":
          "vcpkg/scripts/buildsystems/vcpkg.cmake",
        "cdx:cmake:preset:vcpkg": "true",
        "cdx:cmake:preset:vcpkgTriplet": "x64-linux",
      });
    } finally {
      f.cleanup();
    }
  });

  it("identifies compilers from CMake and by asking them, never running one inside the project", () => {
    const f = fixture();
    try {
      const context = resolveCppBuildContext(f.root, {}, f.cmakeContext);
      const compilers = Object.fromEntries(
        context.formulationComponents
          .filter((c) => c.type === "platform")
          .map((c) => [c["bom-ref"], c]),
      );
      assert.deepStrictEqual(Object.keys(compilers).sort(), [
        "cpp-compiler:edg@4.1.0",
        "cpp-compiler:gcc@13.2.0",
        "cpp-compiler:gcc@unknown",
        "cpp-compiler:msvc@unknown",
      ]);
      assert.deepStrictEqual(propsOf(compilers["cpp-compiler:gcc@13.2.0"]), {
        "cdx:cpp:compiler:family": "gcc",
        "cdx:cpp:compiler:drivers": "gcc",
        "cdx:cpp:compiler:identifiedBy": "cmake",
        "cdx:cpp:compiler:languages": "c",
        "cdx:cpp:compiler:units": "2",
      });
      assert.strictEqual(
        compilers["cpp-compiler:gcc@13.2.0"].version,
        "13.2.0",
      );
      assert.deepStrictEqual(propsOf(compilers["cpp-compiler:edg@4.1.0"]), {
        "cdx:cpp:compiler:family": "edg",
        "cdx:cpp:compiler:drivers": "acme-gcc",
        "cdx:cpp:compiler:identifiedBy": "version-query",
        "cdx:cpp:compiler:languages": "c++",
        "cdx:cpp:compiler:units": "1",
        "cdx:cpp:frontend": "edg",
      });
      // the compilers inside the project are named, not run
      assert.strictEqual(
        propsOf(compilers["cpp-compiler:gcc@unknown"])[
          "cdx:cpp:compiler:identifiedBy"
        ],
        "name",
      );
      assert.strictEqual(
        propsOf(compilers["cpp-compiler:gcc@unknown"])[
          "cdx:cpp:compiler:drivers"
        ],
        "cc,gcc",
      );
      assert.strictEqual(existsSync(f.marker), false);
      assert.strictEqual(
        compilers["cpp-compiler:msvc@unknown"].version,
        undefined,
      );
    } finally {
      f.cleanup();
    }
  });

  it("records the hardening options of the units and of the link", () => {
    const f = fixture();
    try {
      const context = resolveCppBuildContext(f.root, {}, f.cmakeContext);
      assert.deepStrictEqual(
        Object.fromEntries(
          context.parentProperties.map((p) => [p.name, p.value]),
        ),
        {
          "cdx:cmake:buildType": "Debug",
          "cdx:cpp:compileCommands:units": "6",
          "cdx:cpp:hardening:fortifySource": "2",
          "cdx:cpp:hardening:fortifySource:units": "2",
          "cdx:cpp:hardening:msvcBufferSecurityCheck": "on",
          "cdx:cpp:hardening:msvcBufferSecurityCheck:units": "1",
          "cdx:cpp:hardening:msvcControlFlowGuard": "on",
          "cdx:cpp:hardening:msvcControlFlowGuard:units": "1",
          "cdx:cpp:hardening:pie": "on",
          "cdx:cpp:hardening:pie:units": "1",
          "cdx:cpp:hardening:stackProtector": "strong",
          "cdx:cpp:hardening:stackProtector:units": "2",
          "cdx:cpp:hardening:relro": "full",
          "cdx:cpp:hardening:source": "compile-commands,cmake-cache",
        },
      );
    } finally {
      f.cleanup();
    }
  });

  it("tells the project's own headers from its dependencies'", () => {
    const f = fixture();
    try {
      const context = resolveCppBuildContext(f.root, {}, f.cmakeContext);
      assert.deepStrictEqual(context.firstPartyIncludeDirs, [
        join(f.root, "include"),
      ]);
      assert.strictEqual(context.isFirstPartyHeader("proj/api.h"), true);
      assert.strictEqual(context.isFirstPartyHeader("config.h"), true);
      assert.strictEqual(
        context.isFirstPartyHeader(join(f.root, "include", "proj", "api.h")),
        true,
      );
      assert.strictEqual(context.isFirstPartyHeader("zlib.h"), false);
      assert.strictEqual(
        context.isFirstPartyHeader("third_party/zlib/zlib.h"),
        false,
      );
      assert.strictEqual(context.isFirstPartyHeader("stdio.h"), false);
      assert.strictEqual(context.isFirstPartyHeader("../outside.h"), false);
      assert.strictEqual(context.isFirstPartyHeader(""), false);
    } finally {
      f.cleanup();
    }
  });

  it("runs no compiler and reads only an explicit database in secure mode", async () => {
    const f = fixture();
    try {
      const secure = await esmock(
        "./cppBuildContext.js",
        {},
        { "../core/activity.js": { isSecureMode: true } },
      );
      const context = secure.resolveCppBuildContext(f.root, {}, f.cmakeContext);
      const compilers = context.formulationComponents
        .filter((c) => c.type === "platform")
        .map((c) => c["bom-ref"]);
      assert.deepStrictEqual(compilers, ["cpp-compiler:gcc@13.2.0"]);
      assert.strictEqual(context.compileDatabase, undefined);
      const explicit = secure.resolveCppBuildContext(
        f.root,
        { compileCommands: join(f.root, "build", "gcc") },
        f.cmakeContext,
      );
      const identified = explicit.formulationComponents
        .filter((c) => c.type === "platform")
        .map((c) => [
          c["bom-ref"],
          propsOf(c)["cdx:cpp:compiler:identifiedBy"],
        ]);
      assert.deepStrictEqual(Object.fromEntries(identified), {
        "cpp-compiler:gcc@13.2.0": "cmake",
        "cpp-compiler:gcc@unknown": "name",
        "cpp-compiler:msvc@unknown": "name",
      });
      assert.strictEqual(existsSync(f.marker), false);
    } finally {
      f.cleanup();
    }
  });

  it("is empty for a path that is not a directory", () => {
    assert.strictEqual(
      resolveCppBuildContext(join(tmpdir(), "no-such-project-dir")),
      emptyCppBuildContext(),
    );
    assert.strictEqual(emptyCppBuildContext().isFirstPartyHeader("a.h"), false);
  });
});

describe("trustedCompilerPath()", () => {
  if (isWin) {
    return;
  }
  it("accepts executables outside the project only", () => {
    const f = fixture();
    try {
      assert.ok(trustedCompilerPath(f.gcc, f.root).endsWith("gcc"));
      assert.strictEqual(trustedCompilerPath("./tools/cc", f.root), undefined);
      assert.strictEqual(
        trustedCompilerPath(join(f.root, "tools", "gcc"), f.root),
        undefined,
      );
      assert.strictEqual(trustedCompilerPath("", f.root), undefined);
      assert.strictEqual(
        trustedCompilerPath(join(f.tools, "missing"), f.root),
        undefined,
      );
    } finally {
      f.cleanup();
    }
  });
});

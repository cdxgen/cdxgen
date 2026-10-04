import { join, normalize } from "node:path";

import { assert, describe, it } from "poku";

import {
  classifyCompilerBanner,
  compilerFamilyOfName,
  entryArguments,
  hardeningSettings,
  includeDirectories,
  splitPosixCommand,
  splitWindowsCommand,
  summarizeCompileDatabase,
  unitLanguage,
} from "./compileCommands.js";

describe("command line splitting", () => {
  it("follows POSIX shell quoting", () => {
    assert.deepStrictEqual(
      splitPosixCommand(
        `/usr/bin/cc -DNAME="a b" -I'dir with space' -DQ=\\"q\\" -c  src/a.c`,
      ),
      [
        "/usr/bin/cc",
        "-DNAME=a b",
        "-Idir with space",
        '-DQ="q"',
        "-c",
        "src/a.c",
      ],
    );
    assert.deepStrictEqual(splitPosixCommand(`cc "" x`), ["cc", "", "x"]);
  });

  it("follows the Microsoft C runtime's rules for cl and clang-cl", () => {
    assert.deepStrictEqual(
      splitWindowsCommand(
        `"C:\\Program Files\\MSVC\\bin\\cl.exe" /nologo /I"C:\\src\\inc dir" /DX=\\"y\\" C:\\src\\a.cpp`,
      ),
      [
        "C:\\Program Files\\MSVC\\bin\\cl.exe",
        "/nologo",
        "/IC:\\src\\inc dir",
        '/DX="y"',
        "C:\\src\\a.cpp",
      ],
    );
  });

  it("splits a command with the rules of its driver and drops launchers", () => {
    assert.deepStrictEqual(
      entryArguments({ command: "ccache /usr/bin/g++ -c a.cc" }),
      ["/usr/bin/g++", "-c", "a.cc"],
    );
    assert.deepStrictEqual(
      entryArguments({ arguments: ["sccache", "clang", "-c", "a.c"] }),
      ["clang", "-c", "a.c"],
    );
    assert.deepStrictEqual(
      entryArguments({ command: "env CCACHE_DIR=/c cc -c a.c" }),
      ["cc", "-c", "a.c"],
    );
    assert.deepStrictEqual(
      entryArguments({ command: 'cl.exe /I"C:\\x y" a.cpp' }),
      ["cl.exe", "/IC:\\x y", "a.cpp"],
    );
    assert.deepStrictEqual(entryArguments({}), []);
  });
});

describe("compilerFamilyOfName()", () => {
  it("knows the common drivers, prefixed and versioned", () => {
    const families = {
      "/usr/bin/gcc": "gcc",
      "g++-13": "gcc",
      "aarch64-linux-gnu-gcc": "gcc",
      cc: "gcc",
      "c++": "gcc",
      "x86_64-w64-mingw32-c++": "gcc",
      "clang++-17": "clang",
      "C:\\LLVM\\bin\\clang-cl.exe": "clang-cl",
      "cl.exe": "msvc",
      nvcc: "nvcc",
      icpx: "icx",
      icc: "icc",
      "nvc++": "nvhpc",
      cpfe: "edg",
      "/bin/sh": "unknown",
      python3: "unknown",
    };
    for (const [driver, family] of Object.entries(families)) {
      assert.strictEqual(compilerFamilyOfName(driver), family, driver);
    }
  });
});

describe("unitLanguage()", () => {
  it("reads -x, /TP and /TC, the driver, then the extension", () => {
    assert.strictEqual(unitLanguage(["cc", "-x", "c++", "a.h"], "a.h"), "c++");
    assert.strictEqual(unitLanguage(["cc", "-xc", "a.inc"], "a.inc"), "c");
    assert.strictEqual(unitLanguage(["cl", "/TP", "a.c"], "a.c"), "c++");
    assert.strictEqual(unitLanguage(["g++", "a.c"], "a.c"), "c++");
    assert.strictEqual(unitLanguage(["nvcc", "k.cu"], "k.cu"), "cuda");
    assert.strictEqual(unitLanguage(["cc", "a.c"], "a.c"), "c");
    assert.strictEqual(unitLanguage(["cc", "a.cxx"], "a.cxx"), "c++");
    assert.strictEqual(unitLanguage(["cc", "a.s"], "a.s"), "unknown");
  });
});

describe("includeDirectories()", () => {
  it("collects -I, -iquote, -isystem and -idirafter, joined and separate", () => {
    const dir = join("/work", "build");
    assert.deepStrictEqual(
      includeDirectories(
        [
          "cc",
          "-I../include",
          "-I",
          "gen",
          "-iquote",
          "q",
          "-isystem/opt/x/include",
          "-idirafter=late",
          "-c",
          "a.c",
        ],
        dir,
      ),
      [
        normalize(join(dir, "../include")),
        normalize(join(dir, "gen")),
        normalize(join(dir, "q")),
        normalize("/opt/x/include"),
        normalize(join(dir, "late")),
      ],
    );
  });

  it("reads /I and /external:I for MSVC-style drivers only", () => {
    assert.deepStrictEqual(
      includeDirectories(["cl.exe", "/Iinc", "/external:I", "ext"], "/w"),
      [normalize(join("/w", "inc")), normalize(join("/w", "ext"))],
    );
    assert.deepStrictEqual(includeDirectories(["cc", "/Iinc"], "/w"), []);
  });
});

describe("hardeningSettings()", () => {
  it("reads FORTIFY, stack protection, PIE, CET, sanitizers and assertions", () => {
    const settings = hardeningSettings([
      "-O2",
      "-D_FORTIFY_SOURCE=3",
      "-fstack-protector-strong",
      "-fPIE",
      "-fcf-protection=full",
      "-fsanitize=address,undefined",
      "-fno-sanitize=undefined",
      "-D",
      "_GLIBCXX_ASSERTIONS",
      "-fstack-clash-protection",
    ]);
    assert.deepStrictEqual(Object.fromEntries(settings), {
      fortifySource: "3",
      stackProtector: "strong",
      pie: "on",
      cfProtection: "full",
      sanitizers: "address",
      glibcxxAssertions: "on",
      stackClashProtection: "on",
    });
  });

  it("lets a later option override an earlier one", () => {
    const settings = hardeningSettings([
      "-fstack-protector-strong",
      "-fno-stack-protector",
      "-D_FORTIFY_SOURCE=2",
      "-U_FORTIFY_SOURCE",
      "-fPIE",
      "-no-pie",
    ]);
    assert.deepStrictEqual(Object.fromEntries(settings), {
      stackProtector: "off",
      pie: "off",
    });
  });

  it("reads RELRO from linker options", () => {
    assert.strictEqual(
      hardeningSettings(["-Wl,-z,relro,-z,now"]).get("relro"),
      "full",
    );
    assert.strictEqual(
      hardeningSettings(["-z", "relro"]).get("relro"),
      "partial",
    );
    assert.strictEqual(
      hardeningSettings(["-Wl,-zrelro", "-Wl,-z,norelro"]).has("relro"),
      false,
    );
    assert.strictEqual(hardeningSettings(["-Wl,-pie"]).get("pie"), "on");
  });

  it("reads the MSVC buffer security check and Control Flow Guard", () => {
    assert.deepStrictEqual(
      Object.fromEntries(hardeningSettings(["/GS", "/guard:cf", "/DNDEBUG"])),
      { msvcBufferSecurityCheck: "on", msvcControlFlowGuard: "on" },
    );
    assert.strictEqual(
      hardeningSettings(["/GS-"]).get("msvcBufferSecurityCheck"),
      "off",
    );
  });
});

describe("summarizeCompileDatabase()", () => {
  it("counts units per compiler and per hardening value", () => {
    const summary = summarizeCompileDatabase([
      {
        directory: "/w/build",
        file: "/w/src/a.c",
        command: "/usr/bin/gcc -I../include -D_FORTIFY_SOURCE=2 -c ../src/a.c",
      },
      {
        directory: "/w/build",
        file: "/w/src/b.cc",
        arguments: ["ccache", "/usr/bin/g++", "-Igen", "-c", "../src/b.cc"],
      },
      {
        directory: "/w/build",
        file: "/w/src/c.c",
        command: "/usr/bin/gcc -D_FORTIFY_SOURCE=3 -c ../src/c.c",
      },
      {
        directory: "/w/build",
        file: "/w/src/d.c",
        command: "/usr/bin/gcc -D_FORTIFY_SOURCE=2 -c ../src/d.c",
      },
      null,
      { directory: "/w", file: "x.c" },
    ]);
    assert.strictEqual(summary.units, 4);
    const gcc = summary.compilers.get("/usr/bin/gcc");
    assert.strictEqual(gcc.family, "gcc");
    assert.strictEqual(gcc.units, 3);
    assert.deepStrictEqual([...gcc.languages], ["c"]);
    assert.deepStrictEqual(
      [...summary.compilers.get("/usr/bin/g++").languages],
      ["c++"],
    );
    assert.deepStrictEqual(
      Object.fromEntries(summary.hardening.get("fortifySource")),
      { 2: 2, 3: 1 },
    );
    assert.ok(summary.includeDirectories.has(normalize("/w/include")));
    assert.ok(summary.includeDirectories.has(normalize("/w/build/gen")));
  });

  it("is empty for anything that is not a database", () => {
    assert.strictEqual(summarizeCompileDatabase({}).units, 0);
    assert.strictEqual(summarizeCompileDatabase(undefined).compilers.size, 0);
  });
});

describe("classifyCompilerBanner()", () => {
  it("reads the family and version of the common compilers", () => {
    const banners = [
      [
        "gcc (Ubuntu 13.2.0-23ubuntu4) 13.2.0\nCopyright (C) 2023 Free Software Foundation, Inc.",
        "gcc",
        "gcc",
        "13.2.0",
      ],
      ["gcc (GCC) 14.2.1 20240910", "gcc", "gcc", "14.2.1"],
      [
        "Ubuntu clang version 17.0.6 (++20231209124227+6009708b4367-1~exp1~20231209124336.77)\nTarget: x86_64-pc-linux-gnu",
        "gcc",
        "clang",
        "17.0.6",
      ],
      [
        "Apple clang version 15.0.0 (clang-1500.3.9.4)\nTarget: arm64-apple-darwin23.4.0",
        "gcc",
        "apple-clang",
        "15.0.0",
      ],
      [
        "clang version 18.1.8\nTarget: x86_64-pc-windows-msvc",
        "clang-cl",
        "clang-cl",
        "18.1.8",
      ],
      [
        "Microsoft (R) C/C++ Optimizing Compiler Version 19.38.33133 for x64\nCopyright (C) Microsoft Corporation.",
        "msvc",
        "msvc",
        "19.38.33133",
      ],
      [
        "nvcc: NVIDIA (R) Cuda compiler driver\nCuda compilation tools, release 12.3, V12.3.107",
        "nvcc",
        "nvcc",
        "12.3",
      ],
      [
        "Intel(R) oneAPI DPC++/C++ Compiler 2024.0.0 (2024.0.0.20231017)",
        "icx",
        "icx",
        "2024.0.0",
      ],
      ["icc (ICC) 2021.10.0 20230609", "icc", "icc", "2021.10.0"],
    ];
    for (const [banner, nameFamily, family, version] of banners) {
      const result = classifyCompilerBanner(banner, nameFamily);
      assert.strictEqual(result.family, family, banner);
      assert.strictEqual(result.version, version, banner);
      assert.strictEqual(result.edgFrontEnd, false);
    }
  });

  it("recognises a compiler built on the EDG front end", () => {
    const result = classifyCompilerBanner(
      "Edison Design Group C/C++ Front End, version 6.6 (Mar  1 2024 12:00:00)\nCopyright 1988-2024 Edison Design Group, Inc.",
      "edg",
    );
    assert.deepStrictEqual(result, {
      family: "edg",
      version: "6.6",
      edgFrontEnd: true,
    });
    const vendor = classifyCompilerBanner(
      "acme-cc version 4.1.0\nBased on the Edison Design Group C/C++ Front End",
      "gcc",
    );
    assert.strictEqual(vendor.edgFrontEnd, true);
    assert.strictEqual(vendor.version, "4.1.0");
  });
});

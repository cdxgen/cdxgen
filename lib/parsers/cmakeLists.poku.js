import { assert, describe, it } from "poku";

import {
  cmakeFetchDependencies,
  cmakeSetVariables,
  expandCmakeVariables,
  parseCmakeCommands,
} from "./cmakeLists.js";

describe("parseCmakeCommands()", () => {
  it("reads multi-line, mixed-case invocations with quotes, brackets and comments", () => {
    const commands = parseCmakeCommands(`
# a comment with find_package(NotThis)
PROJECT(demo VERSION 1.2 LANGUAGES CXX)
#[[ a bracket comment
find_package(AlsoNotThis)
]]
FetchContent_Declare(
  googletest # trailing comment
  GIT_REPOSITORY "https://github.com/google/googletest.git"
  GIT_TAG        [=[v1.14.0]=]
)
message(STATUS "a (paren) and a \\"quote\\"")
if(WIN32 AND (MSVC OR CLANG))
endif()
`);
    assert.deepStrictEqual(
      commands.map((c) => [c.name, c.args, c.line]),
      [
        ["project", ["demo", "VERSION", "1.2", "LANGUAGES", "CXX"], 3],
        [
          "fetchcontent_declare",
          [
            "googletest",
            "GIT_REPOSITORY",
            "https://github.com/google/googletest.git",
            "GIT_TAG",
            "v1.14.0",
          ],
          7,
        ],
        ["message", ["STATUS", 'a (paren) and a "quote"'], 12],
        ["if", ["WIN32", "AND", "(MSVC", "OR", "CLANG)"], 13],
        ["endif", [], 14],
      ],
    );
  });

  it("returns nothing for empty or non-string input", () => {
    assert.deepStrictEqual(parseCmakeCommands(""), []);
    assert.deepStrictEqual(parseCmakeCommands(undefined), []);
  });
});

describe("CMake variables", () => {
  it("expands simple set() values and leaves unknown references alone", () => {
    const variables = cmakeSetVariables(
      parseCmakeCommands(`
set(FMT_MAJOR 10)
set(FMT_VERSION "\${FMT_MAJOR}.2.1" CACHE STRING "fmt version")
set(LIST_VAR a b c)
`),
    );
    assert.strictEqual(variables.get("FMT_VERSION"), "10.2.1");
    assert.strictEqual(variables.has("LIST_VAR"), false);
    assert.strictEqual(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable references
      expandCmakeVariables("v${FMT_VERSION}-${UNKNOWN}", variables),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable references
      "v10.2.1-${UNKNOWN}",
    );
  });

  it("keeps appending set() calls of an undefined variable linear", () => {
    const appends = Array.from(
      { length: 40 },
      (_, n) => `set(C_FLAGS "\${C_FLAGS} -W${n}")`,
    ).join("\n");
    const variables = cmakeSetVariables(parseCmakeCommands(appends));
    assert.strictEqual(
      variables.get("C_FLAGS"),
      Array.from({ length: 40 }, (_, n) => ` -W${n}`).join(""),
    );
  });

  it("bounds the expansion of a doubling set() chain", () => {
    const doublings = Array.from(
      { length: 40 },
      () => `set(BIG "\${BIG}\${BIG}")`,
    ).join("\n");
    const variables = cmakeSetVariables(
      parseCmakeCommands(`set(BIG x)\n${doublings}`),
    );
    assert.ok(variables.get("BIG").length <= 2 * 65536 + 2);
  });

  it("keeps the text as written when the expansion exceeds the bound", () => {
    const variables = new Map([["A", "x".repeat(100)]]);
    assert.strictEqual(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable references
      expandCmakeVariables("${A}", variables, 100).length,
      100,
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable references
    assert.strictEqual(expandCmakeVariables("${A}", variables, 99), "${A}");
    assert.strictEqual(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable references
      expandCmakeVariables("${A}${A})", variables, 150),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable references
      "${A}${A})",
    );
  });
});

describe("cmakeFetchDependencies()", () => {
  it("reads FetchContent, ExternalProject and CPM dependencies", () => {
    const deps = cmakeFetchDependencies(`
include(FetchContent)
set(JSON_TAG v3.11.3)
FetchContent_Declare(json GIT_REPOSITORY https://github.com/nlohmann/json.git GIT_TAG \${JSON_TAG})
fetchcontent_declare(
  zlib
  URL https://zlib.net/zlib-1.3.1.tar.gz;https://mirror.example/zlib-1.3.1.tar.gz
  URL_HASH SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
)
FetchContent_MakeAvailable(json zlib)
ExternalProject_Add(pthreadpool
  URL https://github.com/Maratyszcza/pthreadpool/archive/4fe0e1e183925bf8cfa6aae24237e724a96479b8.zip
  URL_MD5 0123456789abcdef0123456789abcdef
)
CPMAddPackage("gh:fmtlib/fmt#10.2.1")
CPMAddPackage("gh:gabime/spdlog@1.13.0")
CPMAddPackage(NAME cxxopts GITHUB_REPOSITORY jarro2783/cxxopts VERSION 3.1.1)
CPMAddPackage(NAME doctest GIT_REPOSITORY https://github.com/doctest/doctest.git GIT_TAG v2.4.11)
CPMDeclarePackage(Catch2 GITLAB_REPOSITORY group/catch2 GIT_TAG abc123)
`);
    assert.deepStrictEqual(
      deps.map(({ line: _line, ...rest }) => rest),
      [
        {
          kind: "fetch",
          name: "json",
          gitRepository: "https://github.com/nlohmann/json.git",
          gitTag: "v3.11.3",
          madeAvailable: true,
        },
        {
          kind: "fetch",
          name: "zlib",
          url: "https://zlib.net/zlib-1.3.1.tar.gz",
          urlHash:
            "SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23",
          madeAvailable: true,
        },
        {
          kind: "external-project",
          name: "pthreadpool",
          url: "https://github.com/Maratyszcza/pthreadpool/archive/4fe0e1e183925bf8cfa6aae24237e724a96479b8.zip",
          urlHash: "MD5=0123456789abcdef0123456789abcdef",
          madeAvailable: false,
        },
        {
          kind: "cpm",
          name: "fmt",
          gitRepository: "https://github.com/fmtlib/fmt",
          gitTag: "10.2.1",
          madeAvailable: false,
        },
        {
          kind: "cpm",
          name: "spdlog",
          gitRepository: "https://github.com/gabime/spdlog",
          gitTag: "v1.13.0",
          version: "1.13.0",
          madeAvailable: false,
        },
        {
          kind: "cpm",
          name: "cxxopts",
          gitRepository: "https://github.com/jarro2783/cxxopts",
          gitTag: "v3.1.1",
          version: "3.1.1",
          madeAvailable: false,
        },
        {
          kind: "cpm",
          name: "doctest",
          gitRepository: "https://github.com/doctest/doctest.git",
          gitTag: "v2.4.11",
          madeAvailable: false,
        },
        {
          kind: "cpm",
          name: "Catch2",
          gitRepository: "https://gitlab.com/group/catch2",
          gitTag: "abc123",
          madeAvailable: false,
        },
      ],
    );
  });

  it("keeps an unresolved tag as written and skips nameless declarations", () => {
    const deps = cmakeFetchDependencies(`
FetchContent_Declare(lib GIT_REPOSITORY https://example.com/lib.git GIT_TAG \${LIB_TAG})
FetchContent_Declare()
CPMAddPackage("not-a-shorthand")
`);
    assert.deepStrictEqual(
      deps.map((d) => [d.name, d.gitTag]),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable reference
      [["lib", "${LIB_TAG}"]],
    );
  });
});

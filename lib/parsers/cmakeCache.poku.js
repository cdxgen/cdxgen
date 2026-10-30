import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { strict as assert, describe, it } from "poku";

import {
  parseCmakeCache,
  parseFindPackageVersion,
  resolveCmakeCacheFacts,
} from "./cmakeCache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "..", "test", "data", "cmake-cache");

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: Test data
describe("parseCmakeCache", () => {
  it("parses KEY:TYPE=VALUE entries and ignores comments, blanks, and the header", () => {
    const text = [
      "# This is the CMakeCache file.",
      "// a comment",
      "",
      "CMAKE_PROJECT_NAME:STATIC=sampleapp",
      "CMAKE_PROJECT_VERSION:STATIC=2.4.1",
      "broken-line-without-type",
      "tinyjson_IS_TOP_LEVEL:STATIC=OFF",
    ].join("\n");
    const map = parseCmakeCache(text);
    assert.strictEqual(map.size, 3);
    assert.deepStrictEqual(map.get("CMAKE_PROJECT_NAME"), {
      type: "STATIC",
      value: "sampleapp",
    });
    assert.strictEqual(map.get("CMAKE_PROJECT_VERSION").value, "2.4.1");
    assert.strictEqual(map.get("tinyjson_IS_TOP_LEVEL").value, "OFF");
    assert.ok(!map.has("broken-line-without-type"));
  });

  it("keeps the first occurrence when a key repeats", () => {
    const map = parseCmakeCache("FOO:STATIC=1\nFOO:STATIC=2");
    assert.strictEqual(map.get("FOO").value, "1");
  });

  it("returns an empty map for null/empty input without throwing", () => {
    assert.strictEqual(parseCmakeCache(null).size, 0);
    assert.strictEqual(parseCmakeCache("").size, 0);
  });
});

describe("parseFindPackageVersion", () => {
  it("extracts the version from a multi-bracket ZLIB details value", () => {
    const value =
      "[/usr/lib/x86_64-linux-gnu/libz.so][/usr/include][ ][v1.2.12()]";
    assert.strictEqual(parseFindPackageVersion(value), "1.2.12");
  });

  it("tolerates an empty version without throwing", () => {
    assert.strictEqual(parseFindPackageVersion("[TRUE][v()]"), "");
  });

  it("matches the last [v...] group when several are present", () => {
    assert.strictEqual(parseFindPackageVersion("[a][v1.0()][v2.0()]"), "2.0");
  });

  it("returns null when no [v...] group is present", () => {
    assert.strictEqual(parseFindPackageVersion("[TRUE]"), null);
    assert.strictEqual(parseFindPackageVersion(null), null);
  });
});

describe("resolveCmakeCacheFacts", () => {
  it("resolves ${MYPROJ_VERSION} to 2.4.1 via the already-evaluated CMAKE_PROJECT_VERSION", () => {
    const text = readFileSync(
      join(FIXTURES, "fetchcontent", "CMakeCache.txt"),
      "utf-8",
    );
    const facts = resolveCmakeCacheFacts(parseCmakeCache(text));
    assert.strictEqual(facts.rootProject.name, "sampleapp");
    assert.strictEqual(facts.rootProject.version, "2.4.1");
  });

  it("extracts the ZLIB find_package version as 1.2.12 and an empty Threads version", () => {
    const text = readFileSync(
      join(FIXTURES, "fetchcontent", "CMakeCache.txt"),
      "utf-8",
    );
    const facts = resolveCmakeCacheFacts(parseCmakeCache(text));
    assert.strictEqual(facts.findPackages.get("ZLIB"), "1.2.12");
    assert.strictEqual(facts.findPackages.get("Threads"), "");
  });

  it("marks the root project via IS_TOP_LEVEL=ON among several projects", () => {
    const text = readFileSync(
      join(FIXTURES, "leveldb", "CMakeCache.txt"),
      "utf-8",
    );
    const facts = resolveCmakeCacheFacts(parseCmakeCache(text));
    assert.strictEqual(facts.rootProject.name, "leveldb");
    assert.strictEqual(facts.rootProject.version, "1.23.0");
    const leveldb = facts.projects.get("leveldb");
    assert.ok(leveldb, "leveldb project should be present");
    assert.strictEqual(leveldb.isTopLevel, true);
    assert.strictEqual(leveldb.version, "1.23.0");
  });

  it("identifies a FetchContent dep via FETCHCONTENT_SOURCE_DIR_TINYJSON with kind=fetch", () => {
    const text = readFileSync(
      join(FIXTURES, "fetchcontent", "CMakeCache.txt"),
      "utf-8",
    );
    const facts = resolveCmakeCacheFacts(parseCmakeCache(text));
    const tinyjson = facts.projects.get("tinyjson");
    assert.ok(tinyjson, "tinyjson should be present");
    assert.strictEqual(tinyjson.kind, "fetch");
    assert.ok(
      tinyjson.sourceDir.includes("_deps/tinyjson-src"),
      "sourceDir should point at the fetch source",
    );
    assert.strictEqual(facts.fetchContentBase.includes("_deps"), true);
  });

  it("does not look for <name>_VERSION on subprojects", () => {
    const text = readFileSync(
      join(FIXTURES, "fetchcontent", "CMakeCache.txt"),
      "utf-8",
    );
    const facts = resolveCmakeCacheFacts(parseCmakeCache(text));
    const tinyjson = facts.projects.get("tinyjson");
    assert.strictEqual(
      tinyjson.version,
      undefined,
      "fetched dep version must come from git, not the cache",
    );
  });
});
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: Test data

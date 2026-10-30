import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { strict as assert, describe, test } from "poku";

import {
  buildDependentPurl,
  collapseCmakeVersions,
  parseGitcloneScript,
  parseSubmoduleStatusLine,
  preferFetchedCmakeDependencies,
  readFetchContentGitclone,
  withoutScrapedFetchDependency,
} from "./cmakeResolver.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "..", "test", "data", "cmake-cache");

describe("parseGitcloneScript", () => {
  test("extracts URL and GIT_TAG from the tinyjson gitclone script", () => {
    const text = readFileSync(
      join(FIXTURES, "fetchcontent", "tinyjson-populate-gitclone.cmake"),
      "utf-8",
    );
    const result = parseGitcloneScript(text);
    assert.strictEqual(
      result.url,
      "https://github.com/elementalcow/tinyjson.git",
    );
    assert.strictEqual(result.tag, "v3.11.3");
  });

  test("returns nulls for empty input", () => {
    assert.deepStrictEqual(parseGitcloneScript(""), {
      url: null,
      tag: null,
    });
  });
});

describe("parseSubmoduleStatusLine", () => {
  test("parses an uninitialised submodule (- prefix, no describe)", () => {
    const result = parseSubmoduleStatusLine(
      "-1a54956777ba672764db09a51960056ea042af7e third_party/benchmark",
    );
    assert.strictEqual(result.prefix, "-");
    assert.strictEqual(result.sha, "1a54956777ba672764db09a51960056ea042af7e");
    assert.strictEqual(result.path, "third_party/benchmark");
    assert.strictEqual(result.describe, null);
  });

  test("parses an initialised submodule with a describe tag", () => {
    const result = parseSubmoduleStatusLine(" abc123def path/to/sub (v1.2.3)");
    assert.strictEqual(result.prefix, " ");
    assert.strictEqual(result.sha, "abc123def");
    assert.strictEqual(result.describe, "v1.2.3");
  });

  test("parses a status line whose leading-space prefix was trimmed", () => {
    const result = parseSubmoduleStatusLine(
      "bf585a2789e30585b4e3ce6baf11ef2750b54677 third_party/benchmark (v1.5.2-14-gbf585a2)",
    );
    assert.strictEqual(result.prefix, " ");
    assert.strictEqual(result.sha, "bf585a2789e30585b4e3ce6baf11ef2750b54677");
    assert.strictEqual(result.describe, "v1.5.2-14-gbf585a2");
  });

  test("returns null for empty/invalid input", () => {
    assert.strictEqual(parseSubmoduleStatusLine(""), null);
    assert.strictEqual(parseSubmoduleStatusLine(null), null);
  });
});

describe("readFetchContentGitclone path safety", () => {
  test("refuses a dep name that would escape the build directory", () => {
    for (const depName of [
      "../evil",
      "..",
      "a/../../b",
      "a\\b",
      "sub/dir",
      "",
      null,
    ]) {
      assert.deepStrictEqual(readFetchContentGitclone("/tmp/build", depName), {
        url: null,
        tag: null,
      });
    }
  });
});

describe("buildDependentPurl", () => {
  test("builds a github purl for a github URL", () => {
    const purl = buildDependentPurl(
      "https://github.com/google/benchmark.git",
      "1a54956777ba672764db09a51960056ea042af7e",
    );
    assert.ok(purl);
    assert.ok(purl.startsWith("pkg:github/google/benchmark@"));
    assert.ok(!purl.includes("${"));
    assert.ok(!purl.includes("%24%7B"));
  });

  test("returns null for an unparseable URL", () => {
    assert.strictEqual(buildDependentPurl("not-a-url", "1"), null);
  });
});

describe("collapseCmakeVersions", () => {
  const requirement = (name, version, file) => ({
    name,
    version,
    type: "generic",
    purl: version ? `pkg:generic/${name}@${version}` : `pkg:generic/${name}`,
    "bom-ref": version
      ? `pkg:generic/${name}@${version}`
      : `pkg:generic/${name}`,
    evidence: {
      identity: {
        field: "purl",
        confidence: 0,
        methods: [
          {
            technique: "source-code-analysis",
            confidence: 0.5,
            value: `Filename ${file}`,
          },
        ],
      },
    },
  });

  test("keeps the highest of two find_package requirements", () => {
    const collapsed = collapseCmakeVersions([
      requirement("Boost", "1.54", "CMakeLists.txt"),
      requirement("Boost", "1.64", "sub/CMakeLists.txt"),
    ]);
    assert.strictEqual(collapsed.length, 1);
    assert.strictEqual(collapsed[0].version, "1.64");
    assert.strictEqual(collapsed[0].purl, "pkg:generic/Boost@1.64");
    assert.strictEqual(
      collapsed[0].properties.find(
        (p) => p.name === "cdx:cmake:versionRequirements",
      ).value,
      "1.54|1.64",
    );
  });

  test("orders requirements numerically rather than lexically", () => {
    const collapsed = collapseCmakeVersions([
      requirement("Qt", "5.9", "a.txt"),
      requirement("Qt", "5.10", "b.txt"),
    ]);
    assert.strictEqual(collapsed[0].version, "5.10");
  });

  test("names every file that declared the requirement", () => {
    const collapsed = collapseCmakeVersions([
      requirement("Boost", "1.54", "CMakeLists.txt"),
      requirement("Boost", "1.64", "sub/CMakeLists.txt"),
    ]);
    const values = collapsed[0].evidence.identity.methods.map((m) => m.value);
    assert.deepStrictEqual(values, [
      "Filename CMakeLists.txt",
      "Filename sub/CMakeLists.txt",
    ]);
  });

  test("collapses a versionless duplicate onto the versioned entry", () => {
    const collapsed = collapseCmakeVersions([
      requirement("ZLIB", "", "CMakeLists.txt"),
      requirement("ZLIB", "1.2.13", "sub/CMakeLists.txt"),
    ]);
    assert.strictEqual(collapsed.length, 1);
    assert.strictEqual(collapsed[0].version, "1.2.13");
  });

  test("matches names case-insensitively", () => {
    const collapsed = collapseCmakeVersions([
      requirement("zlib", "1.2.11", "a.txt"),
      requirement("ZLIB", "1.2.13", "b.txt"),
    ]);
    assert.strictEqual(collapsed.length, 1);
    assert.strictEqual(collapsed[0].name, "zlib");
  });

  test("leaves resolved fetch and submodule pins alone", () => {
    const pinned = (version) => ({
      name: "benchmark",
      version,
      type: "library",
      properties: [{ name: "cdx:cmake:depKind", value: "submodule" }],
    });
    const collapsed = collapseCmakeVersions([
      pinned("v1.5.2"),
      pinned("v1.8.0"),
    ]);
    assert.strictEqual(collapsed.length, 2);
  });

  test("leaves a single requirement and its purl untouched", () => {
    const one = requirement("Boost", "1.54", "CMakeLists.txt");
    const collapsed = collapseCmakeVersions([one]);
    assert.deepStrictEqual(collapsed, [one]);
    assert.strictEqual(one.properties, undefined);
  });

  test("returns [] for a missing list", () => {
    assert.deepStrictEqual(collapseCmakeVersions(null), []);
  });
});

describe("configure-time CMake dependencies", () => {
  const fetched = (name, purl, via = "cmake-lists", kind = "fetch") => ({
    name,
    purl,
    properties: [
      { name: "cdx:cmake:depKind", value: kind },
      { name: "cdx:cmake:resolvedVia", value: via },
    ],
  });
  const required = (name) => ({ name, purl: `pkg:generic/${name}` });

  test("keeps the first fetched component of a name and drops a find_package of it", () => {
    const first = fetched("GoogleTest", "pkg:github/google/googletest@v1.14.0");
    const again = fetched("googletest", "pkg:github/google/googletest@v1.14.0");
    const submodule = fetched(
      "googletest",
      "pkg:github/google/googletest@abc",
      "git-submodule",
      "submodule",
    );
    const result = preferFetchedCmakeDependencies([
      required("googletest"),
      first,
      required("zlib"),
      again,
      submodule,
    ]);
    assert.deepStrictEqual(result, [first, required("zlib"), submodule]);
  });

  test("lets a dependency the build tree resolved replace its declaration", () => {
    const declared = fetched("json", "pkg:github/nlohmann/json@v3.11.2");
    const cpm = fetched(
      "fmt",
      "pkg:github/fmtlib/fmt@10.2.1",
      "cmake-lists",
      "cpm",
    );
    const conan = { name: "json", purl: "pkg:conan/json@3.11.2" };
    assert.deepStrictEqual(
      withoutScrapedFetchDependency([declared, cpm, conan], "JSON"),
      [cpm, conan],
    );
  });
});

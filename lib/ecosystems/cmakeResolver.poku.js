import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { strict as assert, describe, test } from "poku";

import {
  buildDependentPurl,
  collapseCmakeVersions,
  collectSubmoduleStatus,
  parseGitcloneScript,
  parseIndexGitlinks,
  preferFetchedCmakeDependencies,
  readFetchContentGitclone,
  toRepoRelative,
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

describe("parseIndexGitlinks", () => {
  test("keeps gitlinks and skips files", () => {
    const output = [
      "100644 4b825dc642cb6eb9a060e54bf8d69288fbee4904 0\tCMakeLists.txt",
      "160000 1a54956777ba672764db09a51960056ea042af7e 0\tthird_party/benchmark",
      "160000 bf585a2789e30585b4e3ce6baf11ef2750b54677 0\tthird party/with space",
      "",
    ].join("\0");
    assert.deepStrictEqual(
      [...parseIndexGitlinks(output).entries()],
      [
        [
          "third_party/benchmark",
          {
            sha: "1a54956777ba672764db09a51960056ea042af7e",
            conflicted: false,
          },
        ],
        [
          "third party/with space",
          {
            sha: "bf585a2789e30585b4e3ce6baf11ef2750b54677",
            conflicted: false,
          },
        ],
      ],
    );
  });

  test("marks a gitlink with only conflict stages", () => {
    const output = [
      "160000 bf585a2789e30585b4e3ce6baf11ef2750b54677 1\tthird_party/c",
      "160000 1a54956777ba672764db09a51960056ea042af7e 2\tthird_party/c",
    ].join("\0");
    assert.deepStrictEqual(parseIndexGitlinks(output).get("third_party/c"), {
      sha: "bf585a2789e30585b4e3ce6baf11ef2750b54677",
      conflicted: true,
    });
  });

  test("returns an empty map for empty or invalid input", () => {
    assert.strictEqual(parseIndexGitlinks("").size, 0);
    assert.strictEqual(parseIndexGitlinks(undefined).size, 0);
    assert.strictEqual(
      parseIndexGitlinks("fatal: not a git repository").size,
      0,
    );
    assert.strictEqual(
      parseIndexGitlinks("160000 not-a-sha 0\tthird_party/x").size,
      0,
    );
  });
});

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

describe("collectSubmoduleStatus", () => {
  const git = (cwd, ...args) => {
    const r = spawnSync(
      "git",
      [
        // no fsmonitor daemon may keep writing into a directory being removed
        "-c",
        "core.fsmonitor=false",
        "-c",
        "maintenance.auto=false",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      { cwd, encoding: "utf-8" },
    );
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const library = (dir, tag) => {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "lib.c"), "int lib;\n");
    git(dir, "add", "lib.c");
    git(dir, "commit", "-q", "-m", "lib");
    if (tag) {
      git(dir, "tag", tag);
    }
    return git(dir, "rev-parse", "HEAD");
  };

  // A directory named "*" cannot be created on Windows.
  (gitAvailable && process.platform !== "win32" ? test : test.skip)(
    "reads pins from the index without running the repository's clean filter",
    () => {
      const root = mkdtempSync(join(tmpdir(), "cdxgen-submodule-status-"));
      try {
        const project = join(root, "project");
        // "vendor/*" as a pathspec also matches the tracked vendor/tracked.c
        const subSha = library(join(project, "vendor", "*"), "v1.2.3");
        git(project, "init", "-q", "-b", "main");
        const tracked = join(project, "vendor", "tracked.c");
        const staged = new Date("2024-01-01T00:00:00Z");
        writeFileSync(tracked, "int tracked;\n");
        utimesSync(tracked, staged, staged);
        git(project, "add", "vendor/tracked.c");
        git(
          project,
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${subSha},vendor/*`,
          "--cacheinfo",
          `160000,${subSha},ext/missing`,
        );
        const marker = join(root, "filter-ran");
        appendFileSync(
          join(project, ".git", "config"),
          `[submodule "lib"]\n\tactive = true\n[core]\n\tcheckStat = minimal\n\ttrustctime = false\n[filter "x"]\n\tclean = "touch '${marker}'; cat"\n`,
        );
        writeFileSync(
          join(project, ".gitmodules"),
          '[submodule "lib"]\n\tpath = vendor/*\n\turl = https://example.com/lib.git\n[submodule "missing"]\n\tpath = ext/missing\n\turl = https://example.com/missing.git\n',
        );
        writeFileSync(
          join(project, ".git", "info", "attributes"),
          "vendor/tracked.c filter=x\n",
        );
        // racily clean: the index is no newer than the tracked file
        utimesSync(join(project, ".git", "index"), staged, staged);

        const status = collectSubmoduleStatus(project);
        assert.ok(!existsSync(marker), "filter.x.clean must not run");
        assert.deepStrictEqual(status.get("vendor/*"), {
          sha: subSha,
          describe: "v1.2.3",
          prefix: " ",
          path: "vendor/*",
        });
        assert.deepStrictEqual(status.get("ext/missing"), {
          sha: subSha,
          describe: null,
          prefix: "-",
          path: "ext/missing",
        });
        assert.strictEqual(status.has("vendor/tracked.c"), false);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  );

  (gitAvailable ? test : test.skip)(
    "names commits as git submodule status does",
    () => {
      const root = mkdtempSync(join(tmpdir(), "cdxgen-submodule-names-"));
      try {
        const project = join(root, "project");
        mkdirSync(project);
        git(project, "init", "-q", "-b", "main");
        const untagged = library(join(project, "untagged"));
        const moved = library(join(project, "moved"), "v2.0.0");
        git(
          project,
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${untagged},untagged`,
          "--cacheinfo",
          `160000,${moved},moved`,
        );
        // a commit checked out after the pin was recorded
        writeFileSync(join(project, "moved", "next.c"), "int next;\n");
        git(join(project, "moved"), "add", "next.c");
        git(join(project, "moved"), "commit", "-q", "-m", "next");
        const movedHead = git(join(project, "moved"), "rev-parse", "HEAD");
        // a broken .git is not taken for the enclosing repository
        mkdirSync(join(project, "broken", ".git"), { recursive: true });
        git(
          project,
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${untagged},broken`,
        );

        const status = collectSubmoduleStatus(project);
        assert.deepStrictEqual(status.get("untagged"), {
          sha: untagged,
          describe: "heads/main",
          prefix: " ",
          path: "untagged",
        });
        const movedStatus = status.get("moved");
        assert.strictEqual(movedStatus.sha, movedHead);
        assert.strictEqual(movedStatus.prefix, "+");
        assert.ok(
          movedStatus.describe.startsWith("v2.0.0-1-g") &&
            movedHead.startsWith(movedStatus.describe.slice(10)),
          movedStatus.describe,
        );
        assert.deepStrictEqual(status.get("broken"), {
          sha: untagged,
          describe: null,
          prefix: "-",
          path: "broken",
        });
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  );
});

describe("toRepoRelative", () => {
  test("keeps a directory whose name starts with two dots", () => {
    const root = join("/", "src", "proj");
    assert.strictEqual(
      toRepoRelative(join(root, "..deps", "zlib"), root),
      "..deps/zlib",
    );
    assert.strictEqual(toRepoRelative(join(root, "a", "b"), root), "a/b");
  });

  test("drops a path outside the scan root", () => {
    const root = join("/", "src", "proj");
    assert.strictEqual(toRepoRelative(join(root, "..", "other"), root), null);
    assert.strictEqual(toRepoRelative(join("/", "src"), root), null);
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

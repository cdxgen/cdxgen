// biome-ignore-all lint/suspicious/noTemplateCurlyInString: CMake preset macros are written as ${name}
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import {
  cmakeBuildDirCandidates,
  hostSystemName,
  isInsideDir,
  readCmakeConfigurePresets,
  readCmakePresetDocuments,
} from "./cmakeBuildDirs.js";

function project(files, dirs = []) {
  const root = mkdtempSync(join(tmpdir(), "cmake-dirs-"));
  for (const d of dirs) {
    mkdirSync(join(root, d), { recursive: true });
  }
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(
      join(root, name),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return root;
}

describe("readCmakePresetDocuments()", () => {
  it("reads the project and user presets and their includes, each once", () => {
    const root = project({
      "CMakePresets.json": {
        version: 6,
        include: ["cmake/presets/common.json", "cmake/presets/common.json"],
        configurePresets: [{ name: "release", inherits: "base" }],
      },
      "cmake/presets/common.json": {
        version: 6,
        include: ["../../CMakePresets.json"],
        configurePresets: [{ name: "base", hidden: true, generator: "Ninja" }],
      },
      "CMakeUserPresets.json": {
        version: 6,
        configurePresets: [{ name: "mine", inherits: "release" }],
      },
    });
    try {
      const docs = readCmakePresetDocuments(root);
      assert.deepStrictEqual(
        docs.map((d) => d.file.slice(root.length + 1).replaceAll("\\", "/")),
        [
          "CMakePresets.json",
          "cmake/presets/common.json",
          "CMakeUserPresets.json",
        ],
      );
      const presets = readCmakeConfigurePresets(root);
      assert.deepStrictEqual(
        presets.map((p) => [p.name, p.generator]),
        [
          ["release", "Ninja"],
          ["mine", "Ninja"],
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores missing, malformed and oversized files", () => {
    const root = project({ "CMakePresets.json": "{ not json" });
    try {
      assert.deepStrictEqual(readCmakePresetDocuments(root), []);
      assert.deepStrictEqual(readCmakeConfigurePresets(root), []);
      assert.deepStrictEqual(
        readCmakePresetDocuments(join(root, "missing")),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cmakeBuildDirCandidates()", () => {
  it("lists the explicit cache directory, preset build directories, then the conventional ones", () => {
    const root = project(
      {
        "CMakePresets.json": {
          version: 3,
          configurePresets: [
            {
              name: "gcc",
              binaryDir: "${sourceDir}/build/gcc",
            },
            { name: "missing", binaryDir: "${sourceDir}/build/not-there" },
          ],
        },
      },
      [
        "build/gcc",
        "build/aaa",
        "build-release",
        "out/build/x64-Debug",
        "builddir",
        "cmake-build-debug",
        "elsewhere/cache",
        "src",
      ],
    );
    try {
      const rel = (dirs) =>
        dirs.map((d) => d.slice(root.length + 1).replaceAll("\\", "/"));
      assert.deepStrictEqual(
        rel(
          cmakeBuildDirCandidates(root, {
            cmakeCache: join(root, "elsewhere", "cache", "CMakeCache.txt"),
          }),
        ),
        [
          "elsewhere/cache",
          "build/gcc",
          "build",
          "build-release",
          "out",
          "builddir",
          "cmake-build-debug",
          "build/aaa",
          "out/build",
          "out/build/x64-Debug",
        ],
      );
      assert.deepStrictEqual(cmakeBuildDirCandidates(join(root, "nope")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps to the project in secure mode", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cmake-outside-"));
    const root = project(
      {
        "CMakePresets.json": {
          version: 3,
          configurePresets: [
            { name: "out-of-tree", binaryDir: outside },
            { name: "in-tree", binaryDir: "${sourceDir}/build/in" },
          ],
        },
      },
      ["build/in"],
    );
    try {
      const secure = await esmock("./cmakeBuildDirs.js", {
        "../core/activity.js": {
          isSecureMode: true,
          readEnvironmentVariable: () => undefined,
        },
      });
      const dirs = secure.cmakeBuildDirCandidates(root, {
        cmakeCache: join(outside, "CMakeCache.txt"),
      });
      assert.ok(!dirs.includes(outside));
      assert.ok(dirs.includes(join(root, "build", "in")));
      const open = cmakeBuildDirCandidates(root);
      assert.strictEqual(open[0], outside);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("helpers", () => {
  it("tells whether a path is inside a directory", () => {
    assert.ok(isInsideDir(join("/a", "b", "c"), join("/a", "b")));
    assert.ok(isInsideDir(join("/a", "b"), join("/a", "b")));
    assert.ok(!isInsideDir(join("/a", "bc"), join("/a", "b")));
    assert.ok(!isInsideDir(join("/a"), join("/a", "b")));
  });

  it("names the host as CMake does", () => {
    assert.ok(
      ["Darwin", "Linux", "Windows"].includes(hostSystemName()) ||
        hostSystemName().length,
    );
  });
});

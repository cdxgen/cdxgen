import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { deflateRawSync } from "node:zlib";

import esmock from "esmock";
import StreamZip from "node-stream-zip";
import { assert, it } from "poku";

import { getAllFiles, safeSpawnSync } from "../ecosystems/utils.js";
import {
  getRecordedActivities,
  isSecureMode,
  resetRecordedActivities,
  setDryRunMode,
} from "./activity.js";
import {
  clearFileDiscoveryCache,
  createUnzipBudget,
  extractZipWithinBudget,
  joinShellCommand,
  safeChmodSync,
  safeCopyFileSync,
  safeRemoveOutputLinkSync,
  safeSpawn,
  safeWriteChunksSync,
  safeWriteSync,
  setDirWalkCacheRoot,
  shellQuoteArgument,
} from "./fs.js";
import { getExecutedTools, resetExecutedTools } from "./toolRegistry.js";

it("safeSpawnSync() resets ANSI color state for host pip warnings", () => {
  const originalConsoleWarn = console.warn;
  const originalContainer = process.env.CDXGEN_IN_CONTAINER;
  const originalNoticeCache = globalThis.__cdxgenNoticeCache;
  const warnings = [];
  delete process.env.CDXGEN_IN_CONTAINER;
  delete globalThis.__cdxgenNoticeCache;
  console.warn = (message) => {
    warnings.push(message);
  };

  try {
    safeSpawnSync("pip-cdxgen-test", ["install"], {});
    assert.strictEqual(warnings.length, 1);
    assert.ok(
      warnings[0].startsWith(
        "\x1b[1;35mNotice: pip/uv install invoked without '--only-binary'.",
      ),
    );
    assert.ok(warnings[0].endsWith("\x1b[0m"));
    assert.ok(!warnings[0].endsWith("\x1b"));
  } finally {
    console.warn = originalConsoleWarn;
    if (originalContainer === undefined) {
      delete process.env.CDXGEN_IN_CONTAINER;
    } else {
      process.env.CDXGEN_IN_CONTAINER = originalContainer;
    }
    if (originalNoticeCache === undefined) {
      delete globalThis.__cdxgenNoticeCache;
    } else {
      globalThis.__cdxgenNoticeCache = originalNoticeCache;
    }
  }
});

it("handles noIgnore option and ignores docs removal", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-no-ignore-test-"));
  const docsDir = path.join(tmpRoot, "docs");
  const nodeModulesDir = path.join(tmpRoot, "node_modules");
  const gitDir = path.join(tmpRoot, ".git");

  mkdirSync(docsDir, { recursive: true });
  mkdirSync(nodeModulesDir, { recursive: true });
  mkdirSync(gitDir, { recursive: true });

  const testFileDocs = path.join(docsDir, "test.txt");
  const testFileNodeModules = path.join(nodeModulesDir, "test.txt");
  const testFileGit = path.join(gitDir, "test.txt");
  const testFileRoot = path.join(tmpRoot, "test.txt");

  writeFileSync(testFileDocs, "docs content");
  writeFileSync(testFileNodeModules, "node_modules content");
  writeFileSync(testFileGit, "git content");
  writeFileSync(testFileRoot, "root content");

  try {
    // 1. By default, docs is NOT ignored anymore because the block was removed.
    // However, .git and node_modules are ignored by default.
    const defaultFiles = getAllFiles(tmpRoot, "**/*.txt");
    assert.ok(defaultFiles.includes(testFileRoot));
    assert.ok(defaultFiles.includes(testFileDocs));
    assert.ok(!defaultFiles.includes(testFileNodeModules));
    assert.ok(!defaultFiles.includes(testFileGit));

    // 2. With noIgnore: true, node_modules and .git are also NOT ignored.
    const allFiles = getAllFiles(tmpRoot, "**/*.txt", { noIgnore: true });
    assert.ok(allFiles.includes(testFileRoot));
    assert.ok(allFiles.includes(testFileDocs));
    assert.ok(allFiles.includes(testFileNodeModules));
    assert.ok(allFiles.includes(testFileGit));
  } finally {
    rmSync(tmpRoot, { force: true, recursive: true });
  }
});

it("intersects the include option with many matched files in linear time", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-include-many-"));
  try {
    for (let dir = 0; dir < 30; dir++) {
      mkdirSync(path.join(tmpRoot, `directory-with-a-long-name-${dir}`));
    }
    for (let i = 0; i < 30000; i++) {
      writeFileSync(
        path.join(
          tmpRoot,
          `directory-with-a-long-name-${i % 30}`,
          `file-number-${i}.txt`,
        ),
        "",
      );
    }
    let started = performance.now();
    const plain = getAllFiles(tmpRoot, "**/*.txt", {});
    const plainMs = performance.now() - started;
    started = performance.now();
    const included = getAllFiles(tmpRoot, "**/*.txt", { include: ["**/*"] });
    const includedMs = performance.now() - started;
    assert.strictEqual(included.length, 30000);
    assert.strictEqual(plain.length, 30000);
    // The include walk is a second, linear pass; the intersection adds little.
    assert.ok(
      includedMs < plainMs * 4 + 500,
      `the include scan took ${includedMs} ms against ${plainMs} ms without it`,
    );
  } finally {
    rmSync(tmpRoot, { force: true, recursive: true });
  }
});

it("keeps only the files the include option also matches", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-include-test-"));
  const docsDir = path.join(tmpRoot, "docs");
  mkdirSync(docsDir, { recursive: true });
  const rootFile = path.join(tmpRoot, "test.txt");
  const docsFile = path.join(docsDir, "test.txt");
  writeFileSync(rootFile, "root content");
  writeFileSync(docsFile, "docs content");
  writeFileSync(path.join(docsDir, "test.md"), "docs content");
  try {
    assert.deepStrictEqual(
      getAllFiles(tmpRoot, "**/*.txt", { include: "docs/**" }),
      [docsFile],
    );
    assert.deepStrictEqual(
      getAllFiles(tmpRoot, "**/*.txt", { include: ["**/*"] }).sort(),
      [docsFile, rootFile].sort(),
    );
    assert.deepStrictEqual(
      getAllFiles(tmpRoot, "**/*.txt", { include: ["**/*.toml"] }),
      [],
    );
  } finally {
    rmSync(tmpRoot, { force: true, recursive: true });
  }
});

it("leaves chen's AST cache out of file searches", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-chen-cache-test-"));
  const cacheDir = path.join(tmpRoot, "src", ".chen");
  mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, "unit.frag");
  const own = path.join(tmpRoot, "src", "own.frag");
  writeFileSync(cached, "cache");
  writeFileSync(own, "source");
  try {
    assert.deepStrictEqual(
      getAllFiles(tmpRoot, "**/*.frag", { includeDot: true }),
      [own],
    );
    assert.ok(
      getAllFiles(tmpRoot, "**/*.frag", { noIgnore: true }).includes(cached),
    );
  } finally {
    rmSync(tmpRoot, { force: true, recursive: true });
  }
});

it("safeSpawnSync() logs container python notices to stdout", () => {
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalContainer = process.env.CDXGEN_IN_CONTAINER;
  const originalNoticeCache = globalThis.__cdxgenNoticeCache;
  const logs = [];
  const warnings = [];
  process.env.CDXGEN_IN_CONTAINER = "true";
  delete globalThis.__cdxgenNoticeCache;
  console.log = (message) => {
    logs.push(message);
  };
  console.warn = (message) => {
    warnings.push(message);
  };

  try {
    safeSpawnSync("python-cdxgen-test", ["-c", "pass"], {});
    safeSpawnSync("python-cdxgen-test", ["-c", "pass"], {});
    assert.strictEqual(logs.length + warnings.length, 1);
    assert.ok(
      [...logs, ...warnings].some((message) =>
        message.includes("Running python command without '-S' argument."),
      ),
    );
  } finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    if (originalContainer === undefined) {
      delete process.env.CDXGEN_IN_CONTAINER;
    } else {
      process.env.CDXGEN_IN_CONTAINER = originalContainer;
    }
    if (originalNoticeCache === undefined) {
      delete globalThis.__cdxgenNoticeCache;
    } else {
      globalThis.__cdxgenNoticeCache = originalNoticeCache;
    }
  }
});

it("shares one directory walk only inside the registered cache root", () => {
  const cacheRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-walk-cached-"));
  const uncachedRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-walk-plain-"));
  try {
    for (const root of [cacheRoot, uncachedRoot]) {
      writeFileSync(path.join(root, "package.json"), "{}");
    }
    setDirWalkCacheRoot(cacheRoot);
    // Both roots are walked once, so each has an entry to serve or to miss.
    assert.deepStrictEqual(getAllFiles(cacheRoot, "**/package.json"), [
      path.join(cacheRoot, "package.json"),
    ]);
    assert.deepStrictEqual(getAllFiles(uncachedRoot, "**/package.json"), [
      path.join(uncachedRoot, "package.json"),
    ]);
    // A build tool writing a manifest part way through a scan is why caching is
    // confined: outside the root the new file has to be found.
    for (const root of [cacheRoot, uncachedRoot]) {
      mkdirSync(path.join(root, "nested"), { recursive: true });
      writeFileSync(path.join(root, "nested", "package.json"), "{}");
    }
    assert.strictEqual(
      getAllFiles(uncachedRoot, "**/package.json").length,
      2,
      "a path outside the cache root must reflect files written during the scan",
    );
    assert.strictEqual(
      getAllFiles(cacheRoot, "**/package.json").length,
      1,
      "a path inside the cache root is served from the walk taken earlier",
    );
    // Leaving the root behind releases the retained entries.
    setDirWalkCacheRoot(undefined);
    assert.strictEqual(getAllFiles(cacheRoot, "**/package.json").length, 2);
  } finally {
    setDirWalkCacheRoot(undefined);
    clearFileDiscoveryCache();
    rmSync(cacheRoot, { force: true, recursive: true });
    rmSync(uncachedRoot, { force: true, recursive: true });
  }
});

it("goes through at most one symbolic link on any path of a file search", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-link-walk-test-"));
  const member = path.join(tmpRoot, "libs", "foo", "package.json");
  mkdirSync(path.dirname(member), { recursive: true });
  for (const dir of ["packages", "x", "y"]) {
    mkdirSync(path.join(tmpRoot, dir));
  }
  writeFileSync(path.join(tmpRoot, "package.json"), "{}");
  writeFileSync(member, "{}");
  try {
    try {
      symlinkSync(
        path.join("..", "libs", "foo"),
        path.join(tmpRoot, "packages", "foo"),
        "dir",
      );
      // Links back into the tree: every one of them is another name for a
      // directory the search has already been in.
      symlinkSync(".", path.join(tmpRoot, "a"), "dir");
      symlinkSync(".", path.join(tmpRoot, "b"), "dir");
      symlinkSync("..", path.join(tmpRoot, "x", "up"), "dir");
      symlinkSync("..", path.join(tmpRoot, "y", "up"), "dir");
    } catch (err) {
      console.log(`Skipping a symbolic link check: ${err.code}`);
      return;
    }
    // A workspace member that is a link is found, and so is one behind a link
    assert.deepStrictEqual(getAllFiles(tmpRoot, "packages/*/package.json"), [
      path.join(tmpRoot, "packages", "foo", "package.json"),
    ]);
    assert.deepStrictEqual(
      getAllFiles(tmpRoot, "*/package.json").sort(),
      ["a", "b"].map((link) => path.join(tmpRoot, link, "package.json")),
    );
    assert.deepStrictEqual(
      getAllFiles(tmpRoot, "*/libs/*/package.json").sort(),
      ["a", "b"].map((link) =>
        path.join(tmpRoot, link, "libs", "foo", "package.json"),
      ),
    );
    // Without the bound each of these matches the root package.json along
    // 2^6 paths or more, and at least twice as many for every segment added.
    for (const segment of ["*", "*/up"]) {
      assert.strictEqual(
        getAllFiles(tmpRoot, `${Array(6).fill(segment).join("/")}/package.json`)
          .length,
        0,
      );
    }
  } finally {
    rmSync(tmpRoot, { force: true, recursive: true });
  }
});

/**
 * Run a check in a temporary directory holding a "project" to search and,
 * beside it, a "host" directory the project has no business reading, the
 * layout of a scanned checkout whose links lead out of it. Returns early, with
 * a note, where the platform refuses to create a link; a checkout there cannot
 * contain one either.
 */
function withLinkedProject(link, check) {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-read-link-"));
  const originalWarn = console.warn;
  const originalFollow = process.env.CDXGEN_FOLLOW_EXTERNAL_SYMLINKS;
  const warnings = [];
  delete process.env.CDXGEN_FOLLOW_EXTERNAL_SYMLINKS;
  try {
    const project = path.join(root, "project");
    const host = path.join(root, "host");
    mkdirSync(path.join(project, "sub"), { recursive: true });
    mkdirSync(host);
    writeFileSync(path.join(host, "requirements.txt"), "SENTINEL\n");
    writeFileSync(path.join(host, "package.json"), '{"name":"sentinel"}');
    try {
      link({ host, project, root });
    } catch (err) {
      if (err.code !== "EPERM" && process.platform !== "win32") {
        throw err;
      }
      console.log(`Skipping a symbolic link check: ${err.code}`);
      return;
    }
    console.warn = (message) => warnings.push(message);
    clearFileDiscoveryCache();
    check({ host, project, root, warnings });
  } finally {
    console.warn = originalWarn;
    if (originalFollow !== undefined) {
      process.env.CDXGEN_FOLLOW_EXTERNAL_SYMLINKS = originalFollow;
    }
    clearFileDiscoveryCache();
    rmSync(root, { recursive: true, force: true });
  }
}

it("getAllFiles() leaves out a manifest that links to a file outside the directory", () => {
  withLinkedProject(
    ({ project }) =>
      symlinkSync(
        path.join("..", "host", "requirements.txt"),
        path.join(project, "requirements.txt"),
      ),
    ({ project, warnings }) => {
      const own = path.join(project, "requirements-dev.txt");
      writeFileSync(own, "own\n");
      assert.deepStrictEqual(getAllFiles(project, "*requirements*.txt"), [own]);
      assert.deepStrictEqual(getAllFiles(project, "**/*requirements*.txt"), [
        own,
      ]);
      assert.strictEqual(warnings.length, 1, "one warning per directory");
      assert.ok(warnings[0].includes(path.join(project, "requirements.txt")));
    },
  );
});

it("getAllFiles() does not search a directory through a link that leaves it", () => {
  withLinkedProject(
    ({ host, project }) => {
      symlinkSync(host, path.join(project, "requirements"));
      symlinkSync(
        path.join("..", "..", "host"),
        path.join(project, "sub", "link"),
      );
      mkdirSync(path.join(project, "node_modules"));
      symlinkSync(host, path.join(project, "node_modules", "sentinel"));
    },
    ({ project }) => {
      assert.deepStrictEqual(getAllFiles(project, "requirements/*.txt"), []);
      assert.deepStrictEqual(
        getAllFiles(project, "sub/**/*requirements*.txt"),
        [],
      );
      assert.deepStrictEqual(
        getAllFiles(project, "**/node_modules/**/package.json"),
        [],
      );
      // A caller that searches a directory the project named, such as a
      // workspace member, says which directory the matches must stay inside.
      const member = path.join(project, "requirements");
      assert.deepStrictEqual(getAllFiles(member, "*.txt"), [
        path.join(member, "requirements.txt"),
      ]);
      assert.deepStrictEqual(getAllFiles(member, "*.txt", {}, project), []);
    },
  );
});

it("getAllFiles() ignores a pattern that leads out of the directory", () => {
  withLinkedProject(
    () => {
      // No link is needed: the pattern itself names the other directory.
    },
    ({ host, project, warnings }) => {
      assert.deepStrictEqual(getAllFiles(project, "../host/*.txt"), []);
      assert.deepStrictEqual(
        getAllFiles(project, `${host.replaceAll("\\", "/")}/*.txt`),
        [],
      );
      assert.strictEqual(warnings.length, 1);
    },
  );
});

it("getAllFiles() leaves out a link to a file the search ignores", () => {
  withLinkedProject(
    ({ project }) => {
      mkdirSync(path.join(project, ".git"));
      writeFileSync(
        path.join(project, ".git", "config"),
        "url = https://user:SENTINEL@example.com/repo.git\n",
      );
      symlinkSync(
        path.join(".git", "config"),
        path.join(project, "requirements.txt"),
      );
      symlinkSync(".git", path.join(project, "requirements"));
    },
    ({ project, warnings }) => {
      assert.deepStrictEqual(getAllFiles(project, "*requirements*.txt"), []);
      assert.deepStrictEqual(getAllFiles(project, "requirements/*"), []);
      assert.strictEqual(warnings.length, 1);
      // What the caller asked not to ignore may be reached either way.
      assert.deepStrictEqual(
        getAllFiles(project, "requirements.txt", { noIgnore: true }),
        [path.join(project, "requirements.txt")],
      );
    },
  );
});

it("getAllFiles() keeps links that stay inside the directory", () => {
  withLinkedProject(
    ({ project, root }) => {
      const store = path.join("node_modules", ".pnpm", "dep@1.0.0");
      mkdirSync(path.join(project, store, "node_modules", "dep"), {
        recursive: true,
      });
      writeFileSync(
        path.join(project, store, "node_modules", "dep", "package.json"),
        "{}",
      );
      writeFileSync(path.join(project, "requirements.txt"), "own\n");
      symlinkSync(
        path.join(".pnpm", "dep@1.0.0", "node_modules", "dep"),
        path.join(project, "node_modules", "dep"),
      );
      symlinkSync(
        "requirements.txt",
        path.join(project, "requirements-dev.txt"),
      );
      symlinkSync("missing.txt", path.join(project, "requirements-old.txt"));
      symlinkSync(project, path.join(root, "alias"));
    },
    ({ project, root, warnings }) => {
      assert.deepStrictEqual(
        getAllFiles(project, "**/node_modules/**/package.json"),
        [path.join(project, "node_modules", "dep", "package.json")],
      );
      // A link without a target has nothing to read.
      assert.deepStrictEqual(
        getAllFiles(project, "*requirements*.txt").sort(),
        [
          path.join(project, "requirements-dev.txt"),
          path.join(project, "requirements.txt"),
        ],
      );
      // The directory itself may be reached through a link, as /tmp is on
      // macOS.
      assert.deepStrictEqual(
        getAllFiles(path.join(root, "alias"), "requirements.txt"),
        [path.join(root, "alias", "requirements.txt")],
      );
      assert.deepStrictEqual(warnings, []);
    },
  );
});

it("getAllFiles() keeps links between the directories of an exploded image", () => {
  withLinkedProject(
    ({ project }) => {
      const dep = path.join(project, "usr", "share", "nodejs", "dep");
      mkdirSync(dep, { recursive: true });
      writeFileSync(path.join(dep, "package.json"), "{}");
      mkdirSync(path.join(project, "app", "node_modules"), { recursive: true });
      symlinkSync(
        path.join("..", "..", "usr", "share", "nodejs", "dep"),
        path.join(project, "app", "node_modules", "dep"),
      );
      symlinkSync(
        path.join("..", "..", "..", "host"),
        path.join(project, "app", "node_modules", "sentinel"),
      );
    },
    ({ project }) => {
      const app = path.join(project, "app");
      const pattern = "**/node_modules/**/package.json";
      assert.deepStrictEqual(getAllFiles(app, pattern), []);
      assert.deepStrictEqual(
        getAllFiles(app, pattern, { allLayersExplodedDir: project }),
        [path.join(app, "node_modules", "dep", "package.json")],
      );
      // Another image's directory does not widen the search of this one.
      assert.deepStrictEqual(
        getAllFiles(app, pattern, {
          allLayersExplodedDir: path.join(project, "usr"),
        }),
        [],
      );
    },
  );
});

it("getAllFiles() follows links out of the directory when the operator asks for it", () => {
  withLinkedProject(
    ({ project }) =>
      symlinkSync(
        path.join("..", "host", "requirements.txt"),
        path.join(project, "requirements.txt"),
      ),
    ({ project }) => {
      process.env.CDXGEN_FOLLOW_EXTERNAL_SYMLINKS = "true";
      try {
        // Secure mode does not take the operator's word for it.
        assert.deepStrictEqual(
          getAllFiles(project, "requirements.txt"),
          isSecureMode ? [] : [path.join(project, "requirements.txt")],
        );
      } finally {
        delete process.env.CDXGEN_FOLLOW_EXTERNAL_SYMLINKS;
      }
    },
  );
});

it("safeWriteChunksSync() can copy the file it replaces", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-write-chunks-"));
  try {
    const target = path.join(tempDir, "report.json");
    writeFileSync(target, '{"a":1}');
    // Read lazily, after the write has started, as the dosai report copy is.
    function* wrapped() {
      yield '{"wrapped":';
      yield readFileSync(target);
      yield "}";
    }
    safeWriteChunksSync(target, wrapped());
    assert.deepStrictEqual(JSON.parse(readFileSync(target, "utf-8")), {
      wrapped: { a: 1 },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("safeWriteChunksSync() writes string and buffer chunks in order", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-write-chunks-"));
  try {
    const target = path.join(tempDir, "out.json");
    safeWriteChunksSync(target, [
      '{"a":',
      Buffer.from('"é漢🎉"'),
      ',"b":[1,2]',
      "}",
    ]);
    assert.deepStrictEqual(JSON.parse(readFileSync(target, "utf-8")), {
      a: "é漢🎉",
      b: [1, 2],
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("safeWriteChunksSync() leaves the target untouched when a chunk fails", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-write-chunks-"));
  try {
    const target = path.join(tempDir, "out.json");
    function* chunks() {
      yield '{"a":';
      throw new RangeError("Invalid string length");
    }
    writeFileSync(target, "previous");
    assert.throws(() => safeWriteChunksSync(target, chunks()), RangeError);
    assert.strictEqual(readFileSync(target, "utf-8"), "previous");
    assert.deepStrictEqual(readdirSync(tempDir), ["out.json"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * Run a check in a temporary directory holding a "victim" file outside a
 * "project" directory, the layout of a scanned checkout whose bom.json is a
 * symbolic link. Returns early, with a note, where the platform refuses to
 * create the link; a checkout there cannot contain one either.
 */
function withLinkedOutput(
  linkTarget,
  check,
  type = undefined,
  baseDir = tmpdir(),
) {
  const root = mkdtempSync(path.join(baseDir, "cdxgen-write-link-"));
  const originalWarn = console.warn;
  const warnings = [];
  try {
    const project = path.join(root, "project");
    const victim = path.join(root, "victim.txt");
    mkdirSync(project);
    writeFileSync(victim, "SENTINEL\n");
    const output = path.join(project, "bom.json");
    try {
      symlinkSync(linkTarget(root, victim), output, type);
    } catch (err) {
      console.log(`Skipping a symbolic link check: ${err.code}`);
      return;
    }
    console.warn = (message) => warnings.push(message);
    check({ output, project, root, victim, warnings });
  } finally {
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
}

it("safeWriteSync() replaces a link to another file instead of writing to it", () => {
  withLinkedOutput(
    (_root, victim) => victim,
    ({ output, victim, warnings }) => {
      safeWriteSync(output, '{"bomFormat":"CycloneDX"}');
      assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n");
      assert.strictEqual(lstatSync(output).isSymbolicLink(), false);
      assert.strictEqual(
        readFileSync(output, "utf-8"),
        '{"bomFormat":"CycloneDX"}',
      );
      assert.ok(warnings.some((w) => w.includes("was a symbolic link")));
    },
  );
});

it("safeWriteSync() follows no relative link out of the directory", () => {
  withLinkedOutput(
    () => path.join("..", "victim.txt"),
    ({ output, victim }) => {
      safeWriteSync(output, "bom", "utf-8");
      assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n");
      assert.strictEqual(readFileSync(output, "utf-8"), "bom");
    },
  );
});

it("safeWriteSync() does not create the target of a dangling link", () => {
  withLinkedOutput(
    (root) => path.join(root, "created-by-link.txt"),
    ({ output, root }) => {
      safeWriteSync(output, "bom");
      assert.strictEqual(
        existsSync(path.join(root, "created-by-link.txt")),
        false,
      );
      assert.strictEqual(readFileSync(output, "utf-8"), "bom");
    },
  );
});

it("safeWriteSync() replaces a link to a directory", () => {
  withLinkedOutput(
    (root) => {
      mkdirSync(path.join(root, "elsewhere"));
      return path.join(root, "elsewhere");
    },
    ({ output, root }) => {
      safeWriteSync(output, "bom");
      assert.deepStrictEqual(readdirSync(path.join(root, "elsewhere")), []);
      assert.strictEqual(statSync(output).isFile(), true);
    },
    "junction",
  );
});

it("safeWriteSync() appends to a new file in place of a link", () => {
  withLinkedOutput(
    (_root, victim) => victim,
    ({ output, victim }) => {
      safeWriteSync(output, "appended\n", { flag: "a" });
      assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n");
      assert.strictEqual(readFileSync(output, "utf-8"), "appended\n");
    },
  );
});

it("safeRemoveOutputLinkSync() removes a link and leaves its target alone", () => {
  withLinkedOutput(
    (_root, victim) => victim,
    ({ output, victim, warnings }) => {
      assert.strictEqual(safeRemoveOutputLinkSync(output), true);
      assert.strictEqual(existsSync(output), false);
      assert.throws(() => lstatSync(output), { code: "ENOENT" });
      assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n");
      assert.ok(warnings.some((w) => w.includes("was a symbolic link")));
    },
  );
});

it("safeRemoveOutputLinkSync() removes a dangling link", () => {
  withLinkedOutput(
    (root) => path.join(root, "created-by-link.txt"),
    ({ output, root }) => {
      assert.strictEqual(safeRemoveOutputLinkSync(output), true);
      assert.throws(() => lstatSync(output), { code: "ENOENT" });
      assert.strictEqual(
        existsSync(path.join(root, "created-by-link.txt")),
        false,
      );
    },
  );
});

it("safeRemoveOutputLinkSync() keeps regular files and accepts missing paths", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-output-plain-"));
  try {
    const target = path.join(tempDir, "usages.slices.json");
    assert.strictEqual(safeRemoveOutputLinkSync(target), true);
    writeFileSync(target, "an earlier slice");
    assert.strictEqual(safeRemoveOutputLinkSync(target), true);
    assert.strictEqual(readFileSync(target, "utf-8"), "an earlier slice");
    assert.strictEqual(safeRemoveOutputLinkSync(undefined), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("safeWriteSync() still truncates, appends and sets modes on regular files", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-write-plain-"));
  try {
    const target = path.join(tempDir, "out.json");
    writeFileSync(target, "a much longer previous content");
    safeWriteSync(target, "short");
    assert.strictEqual(readFileSync(target, "utf-8"), "short");
    safeWriteSync(target, "+more", { flag: "a" });
    assert.strictEqual(readFileSync(target, "utf-8"), "short+more");
    safeWriteSync(target, Buffer.from("bytes"));
    assert.strictEqual(readFileSync(target, "utf-8"), "bytes");
    assert.throws(() => safeWriteSync(target, "x", { flag: "wx" }), {
      code: "EEXIST",
    });
    const privateFile = path.join(tempDir, "private.key");
    safeWriteSync(privateFile, "key", { mode: 0o600 });
    if (process.platform !== "win32") {
      assert.strictEqual(statSync(privateFile).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("safeWriteSync() writes through device paths such as /dev/null", () => {
  if (process.platform === "win32") {
    return;
  }
  safeWriteSync("/dev/null", "discarded");
  assert.strictEqual(statSync("/dev/null").isCharacterDevice(), true);
});

it("safeWriteSync() writes to the standard streams and descriptor paths", () => {
  if (process.platform === "win32") {
    return;
  }
  const streamPaths = ["/dev/stdout", "/dev/fd/1"];
  if (existsSync("/proc/self/fd")) {
    streamPaths.push("/proc/self/fd/1");
  }
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-write-stream-"));
  try {
    // A child process whose standard output is a file, as with a shell
    // redirection: /dev/stdout is then a link to that file.
    const redirected = path.join(tempDir, "stdout.txt");
    const stdout = openSync(redirected, "w");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { safeWriteSync } from "./fs.js";
        for (const streamPath of ${JSON.stringify(streamPaths)}) {
          safeWriteSync(streamPath, streamPath + "\\n", { flag: "a" });
        }`,
      ],
      {
        cwd: import.meta.dirname,
        encoding: "utf-8",
        stdio: ["ignore", stdout, "pipe"],
      },
    );
    closeSync(stdout);
    assert.strictEqual(
      readFileSync(redirected, "utf-8"),
      `${streamPaths.join("\n")}\n`,
      result.stderr,
    );
    assert.deepStrictEqual(readdirSync(tempDir), ["stdout.txt"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("safeWriteSync() replaces a link named through /proc/self/cwd or /proc/self/root", () => {
  // Both are other names for an ordinary directory, on Linux.
  if (!existsSync("/proc/self/cwd") || !existsSync("/proc/self/root")) {
    return;
  }
  const spellings = [
    () => path.join("/proc/self/cwd", "bom.json"),
    (output) => path.join("/proc/self/root", output),
  ];
  for (const spelling of spellings) {
    withLinkedOutput(
      (_root, victim) => victim,
      ({ output, project, victim, warnings }) => {
        const originalCwd = process.cwd();
        process.chdir(project);
        try {
          safeWriteSync(spelling(output), "bom");
        } finally {
          process.chdir(originalCwd);
        }
        assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n");
        assert.strictEqual(lstatSync(output).isSymbolicLink(), false);
        assert.strictEqual(readFileSync(output, "utf-8"), "bom");
        assert.ok(warnings.some((w) => w.includes("was a symbolic link")));
      },
    );
  }
});

it("safeWriteSync() replaces a link in a directory under /dev/shm", () => {
  try {
    accessSync("/dev/shm", constants.W_OK);
  } catch {
    return;
  }
  withLinkedOutput(
    (_root, victim) => victim,
    ({ output, victim }) => {
      safeWriteSync(output, "bom");
      assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n");
      assert.strictEqual(readFileSync(output, "utf-8"), "bom");
    },
    undefined,
    "/dev/shm",
  );
});

it("safeWriteSync() replaces a link that only the spelling of its path puts in /dev", () => {
  if (process.platform === "win32") {
    return;
  }
  withLinkedOutput(
    (_root, victim) => victim,
    ({ output, project, victim }) => {
      // <project>/up is a link to a directory `depth` levels below the
      // project, so "up" followed by as many ".." is the project again. A
      // path normalized as text takes the same ".." to the root directory.
      const depth = project.split(path.sep).length;
      const nested = path.join(project, ...Array(depth).fill("nested"));
      mkdirSync(nested, { recursive: true });
      symlinkSync(nested, path.join(project, "up"));
      mkdirSync(path.join(project, "dev"));
      renameSync(output, path.join(project, "dev", "stdout"));
      const spelled = [project, "up", ...Array(depth).fill(".."), "dev"].join(
        path.sep,
      );
      assert.strictEqual(path.resolve(spelled, "stdout"), "/dev/stdout");
      safeWriteSync(`${spelled}${path.sep}stdout`, "bom");
      assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n");
      assert.strictEqual(
        readFileSync(path.join(project, "dev", "stdout"), "utf-8"),
        "bom",
      );
    },
  );
});

it("safeCopyFileSync() replaces a link to another file instead of copying to it", () => {
  withLinkedOutput(
    (_root, victim) => victim,
    ({ output, project, victim, warnings }) => {
      const source = path.join(project, "plugins.sbt");
      writeFileSync(source, "#!/bin/sh\n", { mode: 0o755 });
      if (process.platform !== "win32") {
        chmodSync(victim, 0o600);
      }
      safeCopyFileSync(source, output, constants.COPYFILE_FICLONE);
      assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n");
      if (process.platform !== "win32") {
        assert.strictEqual(statSync(victim).mode & 0o777, 0o600);
      }
      assert.strictEqual(lstatSync(output).isSymbolicLink(), false);
      assert.strictEqual(readFileSync(output, "utf-8"), "#!/bin/sh\n");
      assert.ok(warnings.some((w) => w.includes("was a symbolic link")));
    },
  );
});

it("safeCopyFileSync() does not create the target of a dangling link", () => {
  withLinkedOutput(
    (root) => path.join(root, "created-by-link.txt"),
    ({ output, project, root }) => {
      const source = path.join(project, "plugins.sbt");
      writeFileSync(source, "copied");
      safeCopyFileSync(source, output);
      assert.strictEqual(
        existsSync(path.join(root, "created-by-link.txt")),
        false,
      );
      assert.strictEqual(lstatSync(output).isSymbolicLink(), false);
      assert.strictEqual(readFileSync(output, "utf-8"), "copied");
    },
  );
});

it("safeCopyFileSync() replaces a link to a directory", () => {
  withLinkedOutput(
    (root) => {
      mkdirSync(path.join(root, "elsewhere"));
      return path.join(root, "elsewhere");
    },
    ({ output, project, root }) => {
      const source = path.join(project, "plugins.sbt");
      writeFileSync(source, "copied");
      safeCopyFileSync(source, output);
      assert.deepStrictEqual(readdirSync(path.join(root, "elsewhere")), []);
      assert.strictEqual(statSync(output).isFile(), true);
    },
    "junction",
  );
});

it("safeCopyFileSync() still creates, overwrites and honours COPYFILE_EXCL on regular files", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-copy-plain-"));
  try {
    const source = path.join(tempDir, "source.txt");
    const target = path.join(tempDir, "target.txt");
    writeFileSync(source, "first");
    safeCopyFileSync(source, target);
    assert.strictEqual(readFileSync(target, "utf-8"), "first");
    writeFileSync(source, "second");
    safeCopyFileSync(source, target, constants.COPYFILE_FICLONE);
    assert.strictEqual(readFileSync(target, "utf-8"), "second");
    assert.throws(
      () => safeCopyFileSync(source, target, constants.COPYFILE_EXCL),
      { code: "EEXIST" },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("shellQuoteArgument() quotes one shell command line argument", () => {
  // Windows: plain tokens pass through, spaces and quotes are wrapped
  assert.strictEqual(
    shellQuoteArgument("--slice-outfile", true),
    "--slice-outfile",
  );
  assert.strictEqual(
    shellQuoteArgument("C:\\out dir\\slices.json", true),
    '"C:\\out dir\\slices.json"',
  );
  assert.strictEqual(shellQuoteArgument('a"b', true), '"a\\"b"');
  assert.strictEqual(shellQuoteArgument('a\\"b', true), '"a\\\\\\"b"');
  assert.strictEqual(shellQuoteArgument("", true), '""');
  // POSIX: the safe charset passes through, the rest is single quoted
  assert.strictEqual(shellQuoteArgument("-l", false), "-l");
  assert.strictEqual(
    shellQuoteArgument("/tmp/some dir/app", false),
    "'/tmp/some dir/app'",
  );
  assert.strictEqual(shellQuoteArgument("it's", false), "'it'\\''s'");
  assert.strictEqual(shellQuoteArgument("", false), "''");
});

it("safeSpawnSync() keeps a spaced shell argument one token", () => {
  // node resolves through the shell on both platforms, and the spaced script
  // reaches node as a single argument only when the join quoted it
  const result = safeSpawnSync("node", ["-e", "console.log('a b')"], {
    shell: true,
    timeout: 60000,
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(`${result.stdout}`.trim(), "a b");
});

it("safeSpawnSync() runs a command whose own path contains spaces", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "space cmd-"));
  const tool = path.join(
    dir,
    `tool with spaces${process.platform === "win32" ? ".cmd" : ""}`,
  );
  // A plain echo keeps the test runtime-neutral: process.execPath is the
  // deno binary under deno, which takes no -e.
  if (process.platform === "win32") {
    writeFileSync(tool, "@echo off\r\necho spaced cmd\r\n");
  } else {
    writeFileSync(tool, "#!/bin/sh\necho spaced cmd\n", { mode: 0o755 });
  }
  try {
    const result = safeSpawnSync(tool, ["an arg with spaces"], {
      shell: true,
      timeout: 60000,
    });
    assert.strictEqual(result.status, 0);
    assert.ok(`${result.stdout}`.includes("spaced cmd"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("joinShellCommand() quotes arguments and joins raw shell fragments verbatim", () => {
  const args = ["-e", "console.log(1)", "a b"];
  if (process.platform === "win32") {
    // cmd.exe quoting wraps the spaced argument; parentheses need no quotes
    assert.strictEqual(
      joinShellCommand("node", args),
      'node -e console.log(1) "a b"',
    );
  } else {
    assert.strictEqual(
      joinShellCommand("node", args),
      "node -e 'console.log(1)' 'a b'",
    );
  }
  assert.strictEqual(
    joinShellCommand("node", args, true),
    "node -e console.log(1) a b",
  );
  assert.strictEqual(joinShellCommand("node", undefined), "node");
});

it("safeSpawnSync() records only tools that started in metadata.tools", () => {
  resetExecutedTools();
  try {
    const missing = safeSpawnSync("cdxgen-no-such-binary-4b1d", ["--version"]);
    assert.ok(missing.error, "the missing binary unexpectedly started");
    // Through a shell the spawn itself succeeds and the shell reports the
    // missing command with its exit code instead: 127 from POSIX shells.
    // cmd.exe reports 9009, which is handled too but not asserted here.
    if (process.platform !== "win32") {
      const missingViaShell = safeSpawnSync(
        "cdxgen-no-such-binary-4b1d",
        ["--version"],
        { shell: true },
      );
      assert.ok(!missingViaShell.error);
      assert.strictEqual(missingViaShell.status, 127);
    }
    assert.deepStrictEqual(getExecutedTools(), []);
    const git = safeSpawnSync("git", ["--version"]);
    // git ships on every CI image; a host without it only skips this half.
    if (!git.error) {
      assert.deepStrictEqual(
        getExecutedTools().map((tool) => tool.name),
        ["git"],
      );
    }
  } finally {
    resetExecutedTools();
  }
});

it("safeSpawnSync() refuses a Windows tool shadowed by a file in the directory the child starts in", async () => {
  const spawnCalls = [];
  const { safeSpawnSync: windowsSpawn } = await esmock("./fs.js", {
    "./paths.js": { isWin: true },
    "node:child_process": {
      spawnSync: (command, _args, options) => {
        spawnCalls.push({ command, cwd: options?.cwd });
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  });
  const originalWarn = console.warn;
  const originalCwd = process.cwd();
  const projectDir = mkdtempSync(path.join(tmpdir(), "cdxgen-hijack-"));
  const cleanDir = mkdtempSync(path.join(tmpdir(), "cdxgen-hijack-clean-"));
  writeFileSync(path.join(projectDir, "git.exe"), "");
  writeFileSync(path.join(projectDir, "node.cmd"), "");
  writeFileSync(path.join(projectDir, "go"), "");
  const warnings = [];
  console.warn = (message) => {
    warnings.push(message);
  };
  try {
    const blocked = (result) =>
      /Windows shell hijack risk/.test(result?.error?.message || "");
    // Without a shell, libuv tries git.com and git.exe in the cwd first.
    assert.ok(
      blocked(windowsSpawn("git", ["status"], { cwd: projectDir })),
      "git next to git.exe must be refused without a shell",
    );
    // libuv runs only .com and .exe files, and a bare name gets an extension.
    assert.ok(!blocked(windowsSpawn("node", ["-v"], { cwd: projectDir })));
    assert.ok(!blocked(windowsSpawn("go", ["version"], { cwd: projectDir })));
    // cmd.exe uses PATHEXT, so node.cmd shadows node through a shell.
    assert.ok(
      blocked(windowsSpawn("node", ["-v"], { cwd: projectDir, shell: true })),
    );
    // Without a cwd option the child starts in cdxgen's own directory.
    process.chdir(projectDir);
    assert.ok(
      blocked(windowsSpawn("node", ["-v"], { shell: true })),
      "node next to node.cmd must be refused when no cwd is given",
    );
    assert.ok(blocked(windowsSpawn("git", ["--version"])));
    process.chdir(cleanDir);
    assert.ok(!blocked(windowsSpawn("git", ["--version"])));
    assert.deepStrictEqual(
      spawnCalls.map((call) => call.command),
      ["node", "go", "git"],
    );
  } finally {
    console.warn = originalWarn;
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(cleanDir, { recursive: true, force: true });
  }
});

it("safeSpawnSync() passes only own environment variables to the child", () => {
  const script =
    "process.stdout.write(String(process.env.CDXGEN_INHERITED_TEST_VAR))";
  Object.prototype.CDXGEN_INHERITED_TEST_VAR = "polluted";
  try {
    const withoutEnv = safeSpawnSync(process.execPath, ["-e", script]);
    assert.strictEqual(withoutEnv.stdout, "undefined");
    const env = { ...process.env, CDXGEN_OWN_TEST_VAR: "1" };
    const withEnv = safeSpawnSync(process.execPath, ["-e", script], { env });
    assert.strictEqual(withEnv.stdout, "undefined");
    // The caller's own variables still reach the child.
    const own = safeSpawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.env.CDXGEN_OWN_TEST_VAR))"],
      { env },
    );
    assert.strictEqual(own.stdout, "1");
  } finally {
    delete Object.prototype.CDXGEN_INHERITED_TEST_VAR;
  }
});

// The spawn environment tests live in fs.spawn-env.poku.js: that file stays
// free of esmock so contrib/alt-runtime-tests.js runs it under deno too,
// which is the runtime whose merged spawnSync those tests exist for.

/**
 * Write a zip archive of deflated entries with data descriptors, as the jar
 * tool does. An entry may declare a size other than that of its content, and
 * `copies` adds central directory records that point at the same data.
 */
function writeZip(zipFile, files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, content, declaredSize, copies = [] } of files) {
    const data = deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, Buffer.from(name), data);
    for (const entryName of [name, ...copies]) {
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4);
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(8, 8);
      entry.writeUInt16LE(8, 10);
      entry.writeUInt32LE(data.length, 20);
      entry.writeUInt32LE(declaredSize ?? content.length, 24);
      entry.writeUInt16LE(entryName.length, 28);
      entry.writeUInt32LE(offset, 42);
      central.push(entry, Buffer.from(entryName));
    }
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(zipFile, Buffer.concat([...chunks, centralBuf, end]));
}

async function unzipWithinBudget(zipFile, targetDir, budget) {
  const zip = new StreamZip.async({ file: zipFile });
  try {
    await extractZipWithinBudget(zip, zipFile, targetDir, budget);
  } finally {
    await zip.close();
  }
}

it("createUnzipBudget() follows the size of the archive", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-unzip-"));
  const zipFile = path.join(tmpRoot, "a.zip");
  const mib = 1024 * 1024;
  try {
    assert.strictEqual(createUnzipBudget(zipFile).remainingBytes, 64 * mib);
    writeFileSync(zipFile, "");
    truncateSync(zipFile, 1024);
    assert.strictEqual(createUnzipBudget(zipFile).remainingBytes, 64 * mib);
    truncateSync(zipFile, 2 * mib);
    assert.strictEqual(createUnzipBudget(zipFile).remainingBytes, 200 * mib);
    truncateSync(zipFile, 128 * mib);
    assert.strictEqual(createUnzipBudget(zipFile).remainingBytes, 8192 * mib);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

it("extractZipWithinBudget() extracts an archive and draws on a shared budget", async () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-unzip-"));
  const zipFile = path.join(tmpRoot, "a.zip");
  const targetDir = path.join(tmpRoot, "out");
  try {
    writeZip(zipFile, [
      { name: "META-INF/", content: "" },
      { name: "META-INF/MANIFEST.MF", content: "Manifest-Version: 1.0\n" },
      { name: "com/example/Empty.class", content: "" },
      { name: "com/example/A.class", content: "a".repeat(200000) },
    ]);
    const budget = { remainingBytes: 300000 };
    await unzipWithinBudget(zipFile, targetDir, budget);
    assert.strictEqual(budget.remainingBytes, 300000 - 200000 - 22);
    assert.strictEqual(
      readFileSync(path.join(targetDir, "META-INF", "MANIFEST.MF"), "utf-8"),
      "Manifest-Version: 1.0\n",
    );
    assert.deepStrictEqual(
      ["A.class", "Empty.class"].map(
        (name) =>
          readFileSync(path.join(targetDir, "com", "example", name)).length,
      ),
      [200000, 0],
    );
    // What is left does not cover the same archive a second time.
    const secondDir = path.join(tmpRoot, "second");
    mkdirSync(secondDir);
    await assert.rejects(
      unzipWithinBudget(zipFile, secondDir, budget),
      /unpacks to 200022 bytes, more than the 99978 bytes allowed/,
    );
    assert.deepStrictEqual(readdirSync(secondDir), []);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

it("extractZipWithinBudget() refuses entries that share their compressed data", async () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-unzip-"));
  const zipFile = path.join(tmpRoot, "a.zip");
  const targetDir = path.join(tmpRoot, "out");
  try {
    mkdirSync(targetDir);
    // 1 MiB of zeros is about 1 KB deflated, and every further record that
    // points at it costs the archive some 50 bytes.
    writeZip(zipFile, [
      {
        name: "k",
        content: Buffer.alloc(1024 * 1024),
        copies: Array.from({ length: 80 }, (_, i) => `k${i}`),
      },
    ]);
    assert.ok(statSync(zipFile).size < 8192);
    await assert.rejects(
      unzipWithinBudget(zipFile, targetDir),
      /unpacks to 84934656 bytes, more than the 67108864 bytes allowed/,
    );
    assert.deepStrictEqual(readdirSync(targetDir), []);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

it("extractZipWithinBudget() counts what an entry holds, not what it declares", async () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-unzip-"));
  const zipFile = path.join(tmpRoot, "a.zip");
  const targetDir = path.join(tmpRoot, "out");
  try {
    writeZip(zipFile, [
      { name: "k", content: Buffer.alloc(8 * 1024 * 1024), declaredSize: 10 },
    ]);
    const budget = { remainingBytes: 1024 * 1024 };
    await assert.rejects(
      unzipWithinBudget(zipFile, targetDir, budget),
      /unpacks to more than the 1048576 bytes allowed/,
    );
    assert.ok(statSync(path.join(targetDir, "k")).size <= 1024 * 1024);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

await it("safeSpawn() takes the synchronous path when Deno would merge the parent environment", async () => {
  const hadDeno = Object.hasOwn(globalThis, "Deno");
  const previousDeno = globalThis.Deno;
  const calls = [];
  globalThis.Deno = { version: { deno: "2.0.0" } };
  try {
    const mod = await esmock("./fs.js", {
      "node:child_process": {
        spawn: () => {
          calls.push("spawn");
          throw new Error("the async path was used");
        },
        spawnSync: () => {
          calls.push("spawnSync");
          return { status: 0, stdout: "sync", stderr: "" };
        },
      },
    });
    // An environment without the parent's variables is one Deno's merge
    // would change.
    const result = await mod.safeSpawn("git", ["--version"], {
      env: { CDXGEN_ONLY_VARIABLE: "1" },
    });
    assert.strictEqual(result.stdout, "sync");
    assert.deepStrictEqual(calls, ["spawnSync"]);
  } finally {
    if (hadDeno) {
      globalThis.Deno = previousDeno;
    } else {
      delete globalThis.Deno;
    }
  }
});

await it("safeSpawn() resolves with the result safeSpawnSync returns, without blocking", async () => {
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 20);
  const pending = safeSpawn(process.execPath, [
    "-e",
    "setTimeout(() => { console.log('out'); console.error('err'); process.exitCode = 3; }, 300)",
  ]);
  assert.ok(pending instanceof Promise);
  const exited = await pending;
  clearInterval(ticker);
  assert.ok(ticks > 0, "the event loop did not run while the command ran");
  assert.strictEqual(exited.status, 3);
  assert.strictEqual(exited.error, undefined);
  assert.strictEqual(exited.stdout, "out\n");
  assert.strictEqual(exited.stderr, "err\n");

  const flooding = await safeSpawn(
    process.execPath,
    ["-e", "console.log('x'.repeat(4096))"],
    { maxBuffer: 16 },
  );
  assert.strictEqual(flooding.error?.code, "ENOBUFS");
  assert.strictEqual(flooding.stdout, "x".repeat(16));

  resetExecutedTools();
  try {
    const missing = await safeSpawn("cdxgen-no-such-binary-4b1d", ["-v"]);
    assert.strictEqual(missing.status, null);
    assert.strictEqual(missing.error?.code, "ENOENT");
    assert.deepStrictEqual(getExecutedTools(), []);
    const git = await safeSpawn("git", ["--version"]);
    if (!git.error) {
      assert.deepStrictEqual(
        getExecutedTools().map((tool) => tool.name),
        ["git"],
      );
    }
  } finally {
    resetExecutedTools();
  }
});

await it("safeSpawn() stops a command at its timeout, with the processes it started", async () => {
  const started = Date.now();
  const stalled = await safeSpawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 60000)"],
    { timeout: 200 },
  );
  assert.strictEqual(stalled.status, null);
  assert.strictEqual(stalled.error?.code, "ETIMEDOUT");
  assert.ok(Date.now() - started < 30000);

  // A helper the command started, as git starts git-remote-https or ssh,
  // holds the output pipes and would otherwise outlive the command.
  if (process.platform !== "win32") {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-spawn-group-"));
    const marker = path.join(tmpRoot, "helper-survived");
    const helper = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''), 1500)`;
    const command =
      "require('node:child_process').spawn(process.execPath, ['-e', process.argv[1]], { stdio: 'inherit' });" +
      "setTimeout(() => {}, 60000);";
    try {
      const withHelper = await safeSpawn(
        process.execPath,
        ["-e", command, helper],
        { timeout: 500 },
      );
      assert.strictEqual(withHelper.error?.code, "ETIMEDOUT");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert.ok(!existsSync(marker), "the helper outlived the command");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

it("safeChmodSync() sets the mode of a regular file", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-chmod-plain-"));
  try {
    const wrapper = path.join(tempDir, "gradlew");
    writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o644 });
    assert.strictEqual(safeChmodSync(wrapper, 0o775), true);
    if (process.platform !== "win32") {
      assert.strictEqual(statSync(wrapper).mode & 0o777, 0o775);
    }
    assert.throws(() => safeChmodSync(path.join(tempDir, "mvnw"), 0o775), {
      code: "ENOENT",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("safeChmodSync() leaves the file a link points at alone", () => {
  for (const linkTarget of [
    (_root, victim) => victim,
    () => path.join("..", "victim.txt"),
  ]) {
    withLinkedOutput(linkTarget, ({ output, victim }) => {
      chmodSync(victim, 0o600);
      const modeBefore = statSync(victim).mode;
      assert.strictEqual(safeChmodSync(output, 0o775), false);
      assert.strictEqual(statSync(victim).mode, modeBefore);
      assert.strictEqual(lstatSync(output).isSymbolicLink(), true);
    });
  }
});

it("safeChmodSync() leaves a directory and a link to one alone", () => {
  withLinkedOutput(
    (root) => {
      mkdirSync(path.join(root, "elsewhere"), { mode: 0o700 });
      return path.join(root, "elsewhere");
    },
    ({ output, project, root }) => {
      const elsewhere = path.join(root, "elsewhere");
      const modeBefore = statSync(elsewhere).mode;
      assert.strictEqual(safeChmodSync(output, 0o775), false);
      assert.strictEqual(safeChmodSync(elsewhere, 0o775), false);
      assert.strictEqual(statSync(elsewhere).mode, modeBefore);
      assert.strictEqual(safeChmodSync(project, 0o775), false);
    },
    "junction",
  );
});

it("safeChmodSync() changes no mode in dry-run mode and records the attempt", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-chmod-dry-run-"));
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    const wrapper = path.join(tempDir, "gradlew");
    writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o644 });
    const modeBefore = statSync(wrapper).mode;
    assert.strictEqual(safeChmodSync(wrapper, 0o775), undefined);
    assert.strictEqual(statSync(wrapper).mode, modeBefore);
    assert.ok(
      getRecordedActivities().some(
        (activity) =>
          activity.kind === "chmod" &&
          activity.status === "blocked" &&
          activity.target === wrapper,
      ),
    );
  } finally {
    setDryRunMode(false);
    resetRecordedActivities();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

import { Buffer } from "node:buffer";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  resetRecordedActivities,
  setDryRunMode,
} from "./activity.js";
import {
  clearFileDiscoveryCache,
  createUnzipBudget,
  extractZipWithinBudget,
  joinShellCommand,
  safeChmodSync,
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
function withLinkedOutput(linkTarget, check, type = undefined) {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-write-link-"));
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

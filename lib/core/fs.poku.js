import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import { getAllFiles, safeSpawnSync } from "../ecosystems/utils.js";
import {
  clearFileDiscoveryCache,
  joinShellCommand,
  safeWriteChunksSync,
  setDirWalkCacheRoot,
  shellQuoteArgument,
} from "./fs.js";

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

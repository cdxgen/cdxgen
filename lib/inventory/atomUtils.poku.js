import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import esmock from "esmock";
import { assert, it } from "poku";

import { dirNameStr } from "../core/paths.js";
import {
  ATOM_NATIVE_PACKAGES,
  atomCommandKind,
  atomCompileCommandsArgs,
  atomFrontendArgKeys,
  atomMaxHeapBytes,
  atomProviderKind,
  atomRunTimedOut,
  atomTimeouts,
  buildAtomCommandEnv,
  executeAtom,
  filterAtomSlicesByExcludePatterns,
  findAppModules,
  findCompileCommands,
  getAtomCommand,
  globPatternsToAtomIgnoreRegex,
  isPathExcludedByGlobPatterns,
  reachablesChunkFiles,
  readReachablesSlices,
  reapAtomProcessTree,
  removeReachablesChunkFiles,
  resolveAtomProvider,
  resolvePhpAstgenBin,
  resolvePhpParseBin,
  splitAtomCommand,
} from "./atomUtils.js";

it("converts cdxgen exclude globs to Scala-compatible regex", () => {
  const atomRegex = globPatternsToAtomIgnoreRegex([
    "**/*.spec.js",
    "src/**/fixtures/*.{js,ts}",
    "test/[!a-c]?.jsx",
    "packages/@(api|web)/**/*.test.ts",
  ]);
  const regex = new RegExp(atomRegex);
  assert.ok(regex.test("example.spec.js"));
  assert.ok(regex.test("src/example.spec.js"));
  assert.ok(regex.test("src\\example.spec.js"));
  assert.ok(regex.test("src/app/fixtures/demo.ts"));
  assert.ok(regex.test("test/z1.jsx"));
  assert.ok(regex.test("packages/api/src/foo.test.ts"));
  assert.ok(regex.test("packages/web/foo.test.ts"));
  assert.ok(!regex.test("src/app/fixtures/demo.py"));
  assert.ok(!regex.test("test/a1.jsx"));
  assert.ok(!regex.test("packages/mobile/foo.test.ts"));
  assert.ok(!regex.test("src/example.spec.jsx"));
});

it("treats escaped glob wildcards as literal characters", () => {
  const atomRegex = globPatternsToAtomIgnoreRegex(["src/escaped/\\*.js"]);
  const regex = new RegExp(atomRegex);
  assert.ok(regex.test("src/escaped/*.js"));
  assert.ok(!regex.test("src/escaped/index.js"));
});

it("matches paths against cdxgen exclude globs", () => {
  const patterns = ["**/*.spec.js", "src/generated/**"];
  assert.ok(isPathExcludedByGlobPatterns("src/foo.spec.js", patterns));
  assert.ok(isPathExcludedByGlobPatterns("src/generated/client.js", patterns));
  assert.ok(isPathExcludedByGlobPatterns("src\\foo.spec.js", patterns));
  assert.ok(!isPathExcludedByGlobPatterns("src/foo.test.js", patterns));
  assert.ok(!isPathExcludedByGlobPatterns("src/manual/client.js", patterns));
});

it("builds global Atom and JavaScript astgen exclude environment", () => {
  const originalAstgenIgnoreDirs = process.env.ASTGEN_IGNORE_DIRS;
  const originalAstgenIgnoreFilePattern =
    process.env.ASTGEN_IGNORE_FILE_PATTERN;
  const originalChenIgnoreDirs = process.env.CHEN_IGNORE_DIRS;
  try {
    delete process.env.ASTGEN_IGNORE_DIRS;
    delete process.env.ASTGEN_IGNORE_FILE_PATTERN;
    process.env.CHEN_IGNORE_DIRS = "vendor";
    const options = {
      exclude: [
        "**/ignored/**",
        "src/generated/**",
        "**/*.spec.js",
        "noxfile.py",
      ],
    };
    const env = buildAtomCommandEnv(options, "javascript");
    const chenIgnoreDirs = env.CHEN_IGNORE_DIRS.split(",");
    const astgenIgnoreDirs = env.ASTGEN_IGNORE_DIRS.split(",");
    assert.deepStrictEqual(Object.keys(env).sort(), [
      "ASTGEN_IGNORE_DIRS",
      "ASTGEN_IGNORE_FILE_PATTERN",
      "CHEN_IGNORE_DIRS",
    ]);
    assert.ok(chenIgnoreDirs.includes("vendor"));
    assert.ok(chenIgnoreDirs.includes("ignored"));
    assert.ok(chenIgnoreDirs.includes("generated"));
    assert.ok(chenIgnoreDirs.includes("noxfile.py"));
    assert.ok(!chenIgnoreDirs.includes("src"));
    assert.ok(astgenIgnoreDirs.includes("node_modules"));
    assert.ok(astgenIgnoreDirs.includes("ignored"));
    assert.ok(astgenIgnoreDirs.includes("generated"));
    assert.ok(!astgenIgnoreDirs.includes("noxfile.py"));
    assert.ok(!astgenIgnoreDirs.includes("src"));
    assert.ok(
      new RegExp(env.ASTGEN_IGNORE_FILE_PATTERN).test("src/foo.spec.js"),
    );

    const pythonEnv = buildAtomCommandEnv(options, "python");
    assert.deepStrictEqual(Object.keys(pythonEnv).sort(), ["CHEN_IGNORE_DIRS"]);
  } finally {
    if (originalAstgenIgnoreDirs === undefined) {
      delete process.env.ASTGEN_IGNORE_DIRS;
    } else {
      process.env.ASTGEN_IGNORE_DIRS = originalAstgenIgnoreDirs;
    }
    if (originalAstgenIgnoreFilePattern === undefined) {
      delete process.env.ASTGEN_IGNORE_FILE_PATTERN;
    } else {
      process.env.ASTGEN_IGNORE_FILE_PATTERN = originalAstgenIgnoreFilePattern;
    }
    if (originalChenIgnoreDirs === undefined) {
      delete process.env.CHEN_IGNORE_DIRS;
    } else {
      process.env.CHEN_IGNORE_DIRS = originalChenIgnoreDirs;
    }
  }
});

it("forwards the php batch generator alongside the per-file parser", () => {
  // The env vars are only meaningful with atom-parsetools installed; the
  // resolved locations must live inside that package when found.
  const astgen = withEnv("PHP_ASTGEN_BIN", undefined, resolvePhpAstgenBin);
  const parser = withEnv("PHP_PARSER_BIN", undefined, resolvePhpParseBin);
  if (astgen !== undefined) {
    assert.ok(
      astgen.includes(join("atom-parsetools", "phpastgen.js")),
      `phpastgen resolves inside the parsetools package: ${astgen}`,
    );
  }
  if (parser !== undefined) {
    assert.ok(
      parser.includes(join("atom-parsetools", "plugins", "bin", "php-parse")),
      `php-parse resolves inside the parsetools package: ${parser}`,
    );
  }
  // Explicit operator overrides win, independently of each other.
  assert.strictEqual(
    withEnv("PHP_ASTGEN_BIN", "/opt/phpastgen.js", () =>
      withEnv("PHP_PARSER_BIN", undefined, resolvePhpAstgenBin),
    ),
    "/opt/phpastgen.js",
  );
  assert.strictEqual(
    withEnv("PHP_PARSER_BIN", "/opt/php-parse", resolvePhpParseBin),
    "/opt/php-parse",
  );
  // The php env names both generators; other languages name neither.
  const originalAstgen = process.env.PHP_ASTGEN_BIN;
  const originalParser = process.env.PHP_PARSER_BIN;
  try {
    delete process.env.PHP_ASTGEN_BIN;
    delete process.env.PHP_PARSER_BIN;
    const phpEnv = buildAtomCommandEnv({}, "php");
    assert.strictEqual(phpEnv.PHP_PARSER_BIN, parser);
    assert.strictEqual(phpEnv.PHP_ASTGEN_BIN, astgen);
    const otherEnv = buildAtomCommandEnv({}, "java");
    assert.ok(!("PHP_PARSER_BIN" in otherEnv));
    assert.ok(!("PHP_ASTGEN_BIN" in otherEnv));
    // Excludes keep the php generators and add the ignore settings.
    const excludedEnv = buildAtomCommandEnv(
      { exclude: ["**/vendor/**"] },
      "php",
    );
    assert.strictEqual(excludedEnv.PHP_PARSER_BIN, parser);
    assert.strictEqual(excludedEnv.PHP_ASTGEN_BIN, astgen);
    assert.ok(excludedEnv.CHEN_IGNORE_DIRS.includes("vendor"));
  } finally {
    if (originalAstgen === undefined) {
      delete process.env.PHP_ASTGEN_BIN;
    } else {
      process.env.PHP_ASTGEN_BIN = originalAstgen;
    }
    if (originalParser === undefined) {
      delete process.env.PHP_PARSER_BIN;
    } else {
      process.env.PHP_PARSER_BIN = originalParser;
    }
  }
});

it("filters Atom slices using exclude globs", () => {
  const sliceData = {
    objectSlices: [
      { fileName: "src/index.js", fullName: "src/index.js::program" },
      { fileName: "src/index.spec.js", fullName: "src/index.spec.js::program" },
    ],
    userDefinedTypes: [
      { fileName: "src/generated/client.js", name: "GeneratedClient" },
      { fileName: "src/model.js", name: "Model" },
    ],
    reachables: [
      { flows: [{ parentFileName: "src/index.js" }] },
      { flows: [{ parentFileName: "src/index.spec.js" }] },
    ],
  };
  const filtered = filterAtomSlicesByExcludePatterns(sliceData, [
    "**/*.spec.js",
    "src/generated/**",
  ]);
  assert.deepStrictEqual(
    filtered.objectSlices.map((slice) => slice.fileName),
    ["src/index.js"],
  );
  assert.deepStrictEqual(
    filtered.userDefinedTypes.map((slice) => slice.fileName),
    ["src/model.js"],
  );
  assert.strictEqual(filtered.reachables.length, 1);
});

it("resolves the atom provider kind for all eight published platform triples", () => {
  // Every (os, arch, libc) triple atom publishes a sub-package for, with the
  // kind atom assigns it. This is the parity surface against atom's own
  // NATIVE_PACKAGES set in @appthreat/atom/resolve.js.
  const cases = [
    {
      platform: "win32",
      arch: "x64",
      expectedPkg: "@appthreat/atom-windows-amd64",
      expectedKind: "native",
    },
    {
      platform: "win32",
      arch: "arm64",
      expectedPkg: "@appthreat/atom-windows-arm64",
      expectedKind: "jar",
    },
    {
      platform: "darwin",
      arch: "arm64",
      expectedPkg: "@appthreat/atom-darwin-arm64",
      expectedKind: "native",
    },
    {
      platform: "darwin",
      arch: "x64",
      expectedPkg: "@appthreat/atom-darwin-amd64",
      expectedKind: "jar",
    },
    {
      platform: "linux",
      arch: "x64",
      libc: "glibc",
      expectedPkg: "@appthreat/atom-linux-amd64",
      expectedKind: "native",
    },
    {
      platform: "linux",
      arch: "x64",
      libc: "musl",
      expectedPkg: "@appthreat/atom-linux-amd64-musl",
      expectedKind: "native",
    },
    {
      platform: "linux",
      arch: "arm64",
      libc: "glibc",
      expectedPkg: "@appthreat/atom-linux-arm64",
      expectedKind: "native",
    },
    {
      platform: "linux",
      arch: "arm64",
      libc: "musl",
      expectedPkg: "@appthreat/atom-linux-arm64-musl",
      expectedKind: "jar",
    },
  ];
  for (const c of cases) {
    const resolved = resolveAtomProvider(c);
    assert.strictEqual(
      resolved.preferredPkg,
      c.expectedPkg,
      `pkg for ${c.platform}/${c.arch}/${c.libc || ""}`,
    );
    assert.strictEqual(
      resolved.kind,
      c.expectedKind,
      `kind for ${c.platform}/${c.arch}/${c.libc || ""}`,
    );
    assert.strictEqual(
      ATOM_NATIVE_PACKAGES.has(resolved.preferredPkg),
      resolved.kind === "native",
      `NATIVE_PACKAGES membership mismatch for ${resolved.preferredPkg}`,
    );
  }
});

it("agrees with atom's own resolver for every platform triple", async () => {
  // The drift guard. The assertions above only compare cdxgen's table against
  // itself; this one compares it against @appthreat/atom's resolve.js, which is
  // the thing that actually decides which payload is loaded at runtime. atom is
  // an optional dependency, so skip rather than fail when it is absent.
  // atom's package.json declares `"exports": "./index.js"` (a bare string), so
  // the `@appthreat/atom/resolve.js` subpath is not importable by specifier.
  // Load it by path instead.
  const resolveJs = join(
    dirNameStr,
    "node_modules",
    "@appthreat",
    "atom",
    "resolve.js",
  );
  if (!existsSync(resolveJs)) {
    console.log(
      "@appthreat/atom not installed; skipping resolver parity test.",
    );
    return;
  }
  const atomResolve = await import(pathToFileURL(resolveJs).href);
  const triples = [
    { platform: "win32", arch: "x64" },
    { platform: "win32", arch: "arm64" },
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
    { platform: "linux", arch: "x64", libc: "glibc" },
    { platform: "linux", arch: "x64", libc: "musl" },
    { platform: "linux", arch: "arm64", libc: "glibc" },
    { platform: "linux", arch: "arm64", libc: "musl" },
    { platform: "freebsd", arch: "x64" },
  ];
  for (const triple of triples) {
    const ours = resolveAtomProvider(triple);
    const theirs = atomResolve.resolveAtomProvider(triple);
    const label = `${triple.platform}/${triple.arch}/${triple.libc || ""}`;
    assert.strictEqual(
      ours.preferredPkg,
      theirs.preferredPkg,
      `package disagrees with atom for ${label}`,
    );
    assert.strictEqual(
      ours.kind,
      theirs.kind,
      `kind disagrees with atom for ${label}`,
    );
  }
});

it("falls back to the jar package for an unmapped triple", () => {
  const resolved = resolveAtomProvider({
    platform: "freebsd",
    arch: "x64",
  });
  assert.strictEqual(resolved.preferredPkg, "@appthreat/atom-jar");
  assert.strictEqual(resolved.kind, "jar");
});

it("reports a non-zero atom exit as failure (stub atom exits 1 with no output)", () => {
  const originalAtomCmd = process.env.ATOM_CMD;
  const stubPath = join(tmpdir(), `atom-stub-exit1-${process.pid}.js`);
  writeFileSync(stubPath, "process.exit(1);\n");
  try {
    process.env.ATOM_CMD = `${process.execPath} ${stubPath}`;
    const ok = executeAtom(process.cwd(), ["--help"], {});
    assert.strictEqual(
      ok,
      false,
      "a stub atom exiting 1 must be reported as failure",
    );
    assert.strictEqual(getAtomCommand().includes(stubPath), true);
  } finally {
    if (originalAtomCmd === undefined) {
      delete process.env.ATOM_CMD;
    } else {
      process.env.ATOM_CMD = originalAtomCmd;
    }
    try {
      unlinkSync(stubPath);
    } catch {
      // ignore
    }
  }
});

it("reports an unsupported language as failure (stub atom prints the unsupported banner)", () => {
  const originalAtomCmd = process.env.ATOM_CMD;
  const stubPath = join(tmpdir(), `atom-stub-unsupported-${process.pid}.js`);
  writeFileSync(
    stubPath,
    'console.log("No language frontend supported for language: foo");\n',
  );
  try {
    process.env.ATOM_CMD = `${process.execPath} ${stubPath}`;
    const ok = executeAtom(process.cwd(), ["usages", "-l", "foo"], {});
    assert.strictEqual(
      ok,
      false,
      "a stub atom printing the unsupported banner must be reported as failure",
    );
  } finally {
    if (originalAtomCmd === undefined) {
      delete process.env.ATOM_CMD;
    } else {
      process.env.ATOM_CMD = originalAtomCmd;
    }
    try {
      unlinkSync(stubPath);
    } catch {
      // ignore
    }
  }
});

function withEnv(name, value, body) {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return body();
  } finally {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
}

it("caps atom's heap below what the runtime would default to", () => {
  const bytes = withEnv("ATOM_MAX_HEAP", undefined, atomMaxHeapBytes);
  assert.ok(bytes > 0);
  // A native image defaults to 80% of physical memory and HotSpot to 25%, so
  // the ceiling has to sit under both to be doing anything.
  assert.ok(bytes <= Math.floor(totalmem() / 2));
  assert.ok(bytes <= 8 * 1024 ** 3);
  // The floor keeps a small container workable even though half its memory is
  // less than the floor.
  assert.ok(bytes >= 2 * 1024 ** 3);
});

it("reads an explicit heap ceiling with or without a unit suffix", () => {
  assert.strictEqual(
    withEnv("ATOM_MAX_HEAP", "4g", atomMaxHeapBytes),
    4 * 1024 ** 3,
  );
  assert.strictEqual(
    withEnv("ATOM_MAX_HEAP", "512m", atomMaxHeapBytes),
    512 * 1024 ** 2,
  );
  assert.strictEqual(
    withEnv("ATOM_MAX_HEAP", "6442450944", atomMaxHeapBytes),
    6 * 1024 ** 3,
  );
  // Zero is the runtime's own "unset", so it restores the unbounded default.
  assert.strictEqual(
    withEnv("ATOM_MAX_HEAP", "0", atomMaxHeapBytes),
    undefined,
  );
  // An unparseable value must not silently become a tiny heap.
  assert.strictEqual(
    withEnv("ATOM_MAX_HEAP", "lots", atomMaxHeapBytes),
    withEnv("ATOM_MAX_HEAP", undefined, atomMaxHeapBytes),
  );
});

it("keeps header-mode atom runs out of the shared AST cache", () => {
  const stubPath = join(tmpdir(), `atom-stub-cache-${process.pid}.js`);
  const outPath = join(tmpdir(), `atom-stub-cache-${process.pid}.json`);
  writeFileSync(
    stubPath,
    `require("node:fs").writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  const argvFor = (language) => {
    withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      findAppModules(process.cwd(), language, "usages"),
    );
    return JSON.parse(readFileSync(outPath, "utf-8"));
  };
  try {
    assert.ok(argvFor("h").includes("--no-ast-cache"));
    assert.ok(argvFor("hpp").includes("--no-ast-cache"));
    assert.ok(!argvFor("c").includes("--no-ast-cache"));
  } finally {
    rmSync(stubPath, { force: true });
    rmSync(outPath, { force: true });
  }
});

it("passes the heap ceiling to atom ahead of its own arguments", () => {
  const stubPath = join(tmpdir(), `atom-stub-argv-${process.pid}.js`);
  const outPath = join(tmpdir(), `atom-stub-argv-${process.pid}.json`);
  writeFileSync(
    stubPath,
    `require("node:fs").writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({ argv: process.argv.slice(2), jto: process.env.JAVA_TOOL_OPTIONS }));\n`,
  );
  try {
    withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      withEnv("ATOM_MAX_HEAP", "8g", () =>
        executeAtom(process.cwd(), ["usages", "-l", "java"], {}),
      ),
    );
    const out = JSON.parse(readFileSync(outPath, "utf-8"));
    if (atomProviderKind() === "native") {
      // The runtime consumes -XX: before atom's parser sees argv, so it has to
      // precede the subcommand.
      assert.deepStrictEqual(out.argv, [
        `-XX:MaxHeapSize=${8 * 1024 ** 3}`,
        "usages",
        "-l",
        "java",
      ]);
      assert.strictEqual(out.jto, undefined);
    } else {
      // A jar-kind provider owns the java command line, so the heap ceiling
      // reaches atom through JAVA_TOOL_OPTIONS and argv is untouched.
      assert.deepStrictEqual(out.argv, ["usages", "-l", "java"]);
      assert.ok(
        typeof out.jto === "string" && out.jto.includes("-Xmx"),
        `expected JAVA_TOOL_OPTIONS to contain -Xmx, got ${out.jto}`,
      );
    }
  } finally {
    for (const path of [stubPath, outPath]) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  }
});

it("leaves the heap alone when the caller already set a ceiling", () => {
  const stubPath = join(tmpdir(), `atom-stub-preset-${process.pid}.js`);
  const argvPath = join(tmpdir(), `atom-stub-preset-${process.pid}.json`);
  writeFileSync(
    stubPath,
    `require("node:fs").writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  try {
    withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      withEnv("ATOM_MAX_HEAP", "8g", () =>
        executeAtom(process.cwd(), ["-XX:MaxHeapSize=123456789", "usages"], {}),
      ),
    );
    // On native kind the existing -XX: blocks the prepended ceiling; on jar
    // kind args are never touched. Either way argv must be unchanged.
    assert.deepStrictEqual(JSON.parse(readFileSync(argvPath, "utf-8")), [
      "-XX:MaxHeapSize=123456789",
      "usages",
    ]);
  } finally {
    for (const path of [stubPath, argvPath]) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  }
});

it("warns once per ceiling when the heap is below what slicing is comfortable with", () => {
  const stubPath = join(tmpdir(), `atom-stub-warn-${process.pid}.js`);
  writeFileSync(stubPath, "process.exit(0);\n");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () => {
      // Deliberately unround ceilings. The warning is latched per ceiling so
      // that this holds on a host whose own default is already tight enough to
      // have warned before this test ran - a 7 GB runner caps atom at 3.5 GiB
      // and says so - and a value no host default can land on keeps the latch
      // from being claimed by that earlier warning.
      withEnv("ATOM_MAX_HEAP", "3001m", () => {
        executeAtom(process.cwd(), ["usages"], {});
        executeAtom(process.cwd(), ["usages"], {});
      });
      // A different tight ceiling is a different warning.
      withEnv("ATOM_MAX_HEAP", "4001m", () =>
        executeAtom(process.cwd(), ["usages"], {}),
      );
    });
  } finally {
    console.warn = originalWarn;
    if (existsSync(stubPath)) {
      unlinkSync(stubPath);
    }
  }
  const tight = warnings.filter((line) => line.includes("atom is limited to"));
  assert.strictEqual(
    tight.filter((line) => line.includes("2.9 GiB heap")).length,
    1,
    "two spawns at one ceiling must warn once",
  );
  const four = tight.filter((line) => line.includes("3.9 GiB heap"));
  assert.strictEqual(four.length, 1);
  assert.ok(four[0].includes("7 GiB"));
  assert.ok(four[0].includes("ATOM_MAX_HEAP"));
});

it("gives atom its own time limit inside cdxgen's spawn timeout", () => {
  const derived = withEnv("ATOM_TIMEOUT", undefined, atomTimeouts);
  // atom stops itself first; cdxgen's own kill is the last resort.
  assert.ok(derived.atomTimeoutMs < derived.spawnTimeoutMs);
  assert.ok(derived.spawnTimeoutMs - derived.atomTimeoutMs <= 30_000);
  // An explicit ATOM_TIMEOUT is atom's limit, whatever CDXGEN_TIMEOUT_MS says.
  assert.deepStrictEqual(withEnv("ATOM_TIMEOUT", "7200000", atomTimeouts), {
    atomTimeoutMs: 7_200_000,
    spawnTimeoutMs: 7_230_000,
  });
  // A short limit gets a proportional grace, not thirty seconds.
  assert.deepStrictEqual(withEnv("ATOM_TIMEOUT", "4000", atomTimeouts), {
    atomTimeoutMs: 4000,
    spawnTimeoutMs: 5000,
  });
  // Nonsense falls back to the derived limit.
  assert.deepStrictEqual(
    withEnv("ATOM_TIMEOUT", "soon", atomTimeouts),
    derived,
  );
});

it("recognises every way an atom run can run out of time", () => {
  assert.strictEqual(atomRunTimedOut({ status: 124 }, 10, 1000), true);
  assert.strictEqual(
    atomRunTimedOut({ status: null, error: { code: "ETIMEDOUT" } }, 10, 1000),
    true,
  );
  // An older dispatcher exits 1 when it stops atom.
  assert.strictEqual(atomRunTimedOut({ status: 1 }, 1000, 1000), true);
  assert.strictEqual(atomRunTimedOut({ status: 1 }, 999, 1000), false);
  // atom 3.1 passes on the runtime's own exit on SIGTERM, or SIGKILL.
  assert.strictEqual(atomRunTimedOut({ status: 143 }, 1000, 1000), true);
  assert.strictEqual(atomRunTimedOut({ status: 137 }, 1000, 1000), true);
  assert.strictEqual(atomRunTimedOut({ status: 143 }, 999, 1000), false);
  assert.strictEqual(atomRunTimedOut({ status: 0 }, 5000, 1000), false);
  // Any other status is atom's own exit, not the dispatcher stopping it.
  assert.strictEqual(atomRunTimedOut({ status: 3 }, 5000, 1000), false);
  // Status 1 past the limit with atom's own failure in its output is that failure.
  assert.strictEqual(
    atomRunTimedOut(
      {
        status: 1,
        stderr:
          'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space',
      },
      5000,
      1000,
    ),
    false,
  );
  assert.strictEqual(
    atomRunTimedOut(
      { status: 1, stdout: "Failure: Invalid configuration" },
      5000,
      1000,
    ),
    false,
  );
});

it("tells atom its time limit and names cdxgen as its supervisor", () => {
  const stubPath = join(tmpdir(), `atom-stub-env-${process.pid}.js`);
  const outPath = join(tmpdir(), `atom-stub-env-${process.pid}.json`);
  writeFileSync(
    stubPath,
    `require("node:fs").writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({ timeout: process.env.ATOM_TIMEOUT, parent: process.env.ATOM_PARENT_PID }));\n`,
  );
  try {
    withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      withEnv("ATOM_TIMEOUT", "600000", () =>
        executeAtom(process.cwd(), ["usages"], {}),
      ),
    );
    assert.deepStrictEqual(JSON.parse(readFileSync(outPath, "utf-8")), {
      timeout: "600000",
      parent: String(process.pid),
    });
  } finally {
    for (const path of [stubPath, outPath]) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  }
});

it("reports an atom run stopped by its time limit as a timeout", () => {
  const stubPath = join(tmpdir(), `atom-stub-timeout-${process.pid}.js`);
  writeFileSync(stubPath, "process.exit(124);\n");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const ok = withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      withEnv("ATOM_TIMEOUT", "90000", () =>
        executeAtom(process.cwd(), ["reachables"], {}),
      ),
    );
    assert.strictEqual(ok, false);
  } finally {
    console.warn = originalWarn;
    unlinkSync(stubPath);
  }
  const timeout = warnings.filter((w) => w.includes("did not finish within"));
  assert.strictEqual(timeout.length, 1);
  assert.ok(timeout[0].includes("1.5 minutes"));
  assert.ok(timeout[0].includes("ATOM_TIMEOUT"));
});

it("stops atom when cdxgen's spawn timeout fires, and drops its half-written atom", () => {
  // A stand-in atom that ignores its time limit: cdxgen's spawn timeout kills it.
  const stubPath = join(tmpdir(), `atom-stub-hang-${process.pid}.js`);
  const atomFile = join(tmpdir(), `atom-stub-hang-${process.pid}.atom`);
  writeFileSync(stubPath, "setInterval(() => {}, 1000);\n");
  writeFileSync(atomFile, "partial");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const ok = withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      withEnv("ATOM_TIMEOUT", "800", () =>
        executeAtom(process.cwd(), ["reachables", "-o", atomFile], {}),
      ),
    );
    assert.strictEqual(ok, false);
  } finally {
    console.warn = originalWarn;
    unlinkSync(stubPath);
  }
  assert.ok(warnings.some((w) => w.includes("did not finish within")));
  // The next slice of the run must rebuild the atom rather than fail to load it.
  assert.strictEqual(existsSync(atomFile), false);
  if (process.platform === "win32") {
    // The shell cdxgen spawned is what the timeout killed; the stand-in atom
    // under it must not be left running.
    const survivors = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*atom-stub-hang-${process.pid}.js*' -and $_.Name -eq 'node.exe' }).Count`,
      ],
      { encoding: "utf8" },
    );
    assert.strictEqual(survivors.stdout.trim(), "0");
  }
});

it("reaps the processes a timed-out shell spawn leaves behind on Windows", () => {
  const startedAt = Date.now();
  if (process.platform !== "win32") {
    assert.deepStrictEqual(reapAtomProcessTree(process.pid, startedAt), []);
    return;
  }
  const marker = `reap-marker-${process.pid}`;
  // Mirrors executeAtom: a shell whose child outlives the shell's kill.
  const result = spawnSync(
    `"${process.execPath}" -e "setInterval(() => {}, 1000)" ${marker}`,
    { shell: true, timeout: 1500, killSignal: "SIGKILL" },
  );
  assert.strictEqual(result.error?.code, "ETIMEDOUT");
  const countSurvivors = () =>
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -eq 'node.exe' }).Count`,
      ],
      { encoding: "utf8" },
    ).stdout.trim();
  assert.strictEqual(countSurvivors(), "1", "the child outlived its shell");
  const endedAt = Date.now();
  // Processes that predate the run are never matched, whatever their parent.
  assert.deepStrictEqual(
    reapAtomProcessTree(result.pid, Date.now() + 5000, Date.now() + 5000),
    [],
  );
  // Nor is a child of the root's pid created after the root ended: that pid may
  // already belong to another process.
  assert.deepStrictEqual(
    reapAtomProcessTree(result.pid, startedAt - 10000, startedAt - 5000),
    [],
  );
  assert.strictEqual(countSurvivors(), "1", "a filtered reap stopped nothing");
  const reaped = reapAtomProcessTree(result.pid, startedAt, endedAt);
  assert.strictEqual(reaped.length, 1);
  assert.strictEqual(countSurvivors(), "0");
});

it("classifies an ATOM_CMD by the launcher it names", () => {
  const root = mkdtempSync(join(tmpdir(), "atom-cmd-kind-"));
  try {
    // The jar payload: plugins/bin/<launcher> next to plugins/lib/<jars>.
    const pluginsBin = join(root, "plugins", "bin");
    mkdirSync(pluginsBin, { recursive: true });
    mkdirSync(join(root, "plugins", "lib"));
    writeFileSync(
      join(root, "plugins", "lib", "io.appthreat.atom-4.0.0.jar"),
      "",
    );
    writeFileSync(join(pluginsBin, "atom"), "");
    writeFileSync(join(pluginsBin, "atom.bat"), "");
    // A native sub-package: bin/atom with no lib.
    const nativeBin = join(root, "atom-native", "bin");
    mkdirSync(nativeBin, { recursive: true });
    writeFileSync(join(nativeBin, "atom"), "");
    // A prefix whose bin sits next to an unrelated lib (`/usr/local`).
    const prefixBin = join(root, "prefix", "bin");
    mkdirSync(prefixBin, { recursive: true });
    mkdirSync(join(root, "prefix", "lib"));
    writeFileSync(join(root, "prefix", "lib", "libfoo.so"), "");
    writeFileSync(join(prefixBin, "atom"), "");
    const dispatcher = join(root, "atom", "index.js");
    mkdirSync(dirname(dispatcher));
    writeFileSync(dispatcher, "");
    for (const platformKind of ["native", "jar"]) {
      assert.strictEqual(
        atomCommandKind(join(pluginsBin, "atom"), platformKind),
        "jar",
      );
      assert.strictEqual(
        atomCommandKind(join(pluginsBin, "atom.bat"), platformKind),
        "jar",
      );
      assert.strictEqual(atomCommandKind("atom.bat", platformKind), "jar");
      assert.strictEqual(
        atomCommandKind(join(nativeBin, "atom"), platformKind),
        platformKind,
      );
      assert.strictEqual(
        atomCommandKind(join(prefixBin, "atom"), platformKind),
        platformKind,
      );
      assert.strictEqual(
        atomCommandKind(`${process.execPath} ${dispatcher}`, platformKind),
        platformKind,
      );
      assert.strictEqual(
        atomCommandKind("atom.cmd", platformKind),
        platformKind,
      );
      assert.strictEqual(atomCommandKind("atom", platformKind), platformKind);
    }
    // The npm bin shim of a global install is a symlink into the package.
    if (process.platform !== "win32") {
      const shim = join(root, "prefix", "bin", "atom-shim");
      symlinkSync(dispatcher, shim);
      assert.strictEqual(atomCommandKind(shim, "native"), "native");
    }
    // atomProviderKind applies it to ATOM_CMD.
    assert.strictEqual(
      withEnv("ATOM_CMD", join(pluginsBin, "atom"), atomProviderKind),
      "jar",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeSlices(path, flows, mtimeSeconds) {
  writeFileSync(path, JSON.stringify(flows));
  utimesSync(path, mtimeSeconds, mtimeSeconds);
}

it("reads every reachables chunk atom wrote, and none an earlier run left", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-reachables-"));
  try {
    const base = join(dir, "python-reachables.slices.json");
    const now = Math.floor(Date.now() / 1000);
    writeSlices(base, [{ flows: [], purls: ["a"] }], now);
    writeSlices(
      join(dir, "python-reachables.slices_1.json"),
      [{ purls: ["b"] }],
      now,
    );
    writeSlices(
      join(dir, "python-reachables.slices_2.json"),
      [{ purls: ["c"] }],
      now + 1,
    );
    // Left by an earlier run with more flows: older than the base file.
    writeSlices(
      join(dir, "python-reachables.slices_3.json"),
      [{ purls: ["stale"] }],
      now - 3600,
    );
    writeSlices(
      join(dir, "python-reachables.slices_5.json"),
      [{ purls: ["gap"] }],
      now,
    );
    assert.deepStrictEqual(
      readReachablesSlices(base).map((f) => f.purls[0]),
      ["a", "b", "c"],
    );
    assert.strictEqual(reachablesChunkFiles(base).length, 2);
    // The legacy object shape keeps its other keys.
    const legacy = join(dir, "java-reachables.slices.json");
    writeSlices(legacy, { reachables: [{ purls: ["x"] }], version: 1 }, now);
    writeSlices(
      join(dir, "java-reachables.slices_1.json"),
      [{ purls: ["y"] }],
      now,
    );
    const merged = readReachablesSlices(legacy);
    assert.strictEqual(merged.version, 1);
    assert.deepStrictEqual(
      merged.reachables.map((f) => f.purls[0]),
      ["x", "y"],
    );
    assert.strictEqual(
      readReachablesSlices(join(dir, "missing.json")),
      undefined,
    );

    // A run stopped while writing leaves truncated JSON: warn and keep what parses.
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      const truncated = join(dir, "js-reachables.slices.json");
      writeFileSync(truncated, '[{"flows": [], "purls": ["a"]}, {"flo');
      assert.strictEqual(readReachablesSlices(truncated), undefined);
      const partial = join(dir, "ruby-reachables.slices.json");
      writeSlices(partial, [{ purls: ["a"] }], now);
      writeSlices(
        join(dir, "ruby-reachables.slices_1.json"),
        [{ purls: ["b"] }],
        now,
      );
      writeFileSync(join(dir, "ruby-reachables.slices_2.json"), '[{"pur');
      utimesSync(join(dir, "ruby-reachables.slices_2.json"), now, now);
      assert.deepStrictEqual(
        readReachablesSlices(partial).map((f) => f.purls[0]),
        ["a", "b"],
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.strictEqual(
      warnings.filter((w) => w.includes("incomplete or not valid JSON")).length,
      2,
    );
    for (const name of [
      "js-reachables.slices.json",
      "ruby-reachables.slices.json",
      "ruby-reachables.slices_1.json",
      "ruby-reachables.slices_2.json",
    ]) {
      rmSync(join(dir, name));
    }

    removeReachablesChunkFiles(base);
    assert.deepStrictEqual(readdirSync(dir).sort(), [
      "java-reachables.slices.json",
      "java-reachables.slices_1.json",
      "python-reachables.slices.json",
      "python-reachables.slices_5.json",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("detects the jar fallback when the native atom package is not installed", async () => {
  const { kind, preferredPkg } = resolveAtomProvider();
  const root = mkdtempSync(join(tmpdir(), "atom-layout-"));
  try {
    mkdirSync(join(root, "node_modules", "@appthreat", "atom-jar", "plugins"), {
      recursive: true,
    });
    const { atomProviderKind: kindFor } = await esmock("./atomUtils.js", {
      "../core/paths.js": { dirNameStr: root },
    });
    const detected = withEnv("ATOM_CMD", undefined, () =>
      withEnv("ATOM_HOME", undefined, kindFor),
    );
    // Only the jar is installed, so atom runs as the jar on every platform.
    assert.strictEqual(detected, "jar");
    if (kind === "native") {
      const folder = preferredPkg.split("/")[1];
      const binDir = join(root, "node_modules", "@appthreat", folder, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, process.platform === "win32" ? "atom.exe" : "atom"),
        "",
      );
      const withNative = withEnv("ATOM_CMD", undefined, () =>
        withEnv("ATOM_HOME", undefined, kindFor),
      );
      assert.strictEqual(withNative, "native");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A stand-in atom: answers `--frontend-args-keys` with a key table (listing
 * `compile-commands` as atom 4 does, or not as atom 3 does) and otherwise
 * records its arguments in `outPath`.
 */
function keysStubAtom(name, readsCompileCommands, outPath) {
  const stubPath = join(tmpdir(), `atom-stub-${name}-${process.pid}.js`);
  const table = [
    "key                          type   default          description",
    "-".repeat(80),
    "exclude                      csv                     Paths to exclude.",
    "cpp-standard                 string                  C++ standard.",
    ...(readsCompileCommands
      ? [
          "compile-commands             string                  A JSON compilation database.",
          "compile-commands-only        bool   false            Only its units.",
        ]
      : []),
  ].join("\n");
  writeFileSync(
    stubPath,
    `const argv = process.argv.slice(2);
if (argv.includes("--frontend-args-keys")) { console.log(${JSON.stringify(table)}); process.exit(0); }
${outPath ? `require("node:fs").writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(argv));` : ""}
`,
  );
  return stubPath;
}

function compileCommandsProject(...dirs) {
  const root = mkdtempSync(join(tmpdir(), "atom-cdb-"));
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "compile_commands.json"), "[]");
  }
  return root;
}

it("finds a C/C++ project's compilation database in its build directories", () => {
  const roots = [];
  const project = (...dirs) => {
    const root = compileCommandsProject(...dirs);
    roots.push(root);
    return root;
  };
  try {
    let root = project("", "build");
    assert.strictEqual(
      findCompileCommands(root),
      join(root, "compile_commands.json"),
    );
    root = project("out", "cmake-build-release", "cmake-build-debug");
    assert.strictEqual(
      findCompileCommands(root),
      join(root, "out", "compile_commands.json"),
    );
    root = project("cmake-build-release", "cmake-build-debug");
    assert.strictEqual(
      findCompileCommands(root),
      join(root, "cmake-build-debug", "compile_commands.json"),
    );
    root = project("builddir");
    assert.strictEqual(
      findCompileCommands(root),
      join(root, "builddir", "compile_commands.json"),
    );
    // the build tree of an explicit CMakeCache.txt
    root = project("_b/x");
    assert.strictEqual(findCompileCommands(root), undefined);
    assert.strictEqual(
      findCompileCommands(root, {
        cmakeCache: join(root, "_b", "x", "CMakeCache.txt"),
      }),
      join(root, "_b", "x", "compile_commands.json"),
    );
    // nested deeper than a build directory is not searched
    root = project("third_party/lib/build");
    assert.strictEqual(findCompileCommands(root), undefined);
    assert.strictEqual(findCompileCommands(join(root, "missing")), undefined);
  } finally {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

it("takes an explicit compilation database as a file or a directory", () => {
  const root = compileCommandsProject("elsewhere/build", "build");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const explicit = join(root, "elsewhere", "build", "compile_commands.json");
    assert.strictEqual(
      findCompileCommands(root, { compileCommands: explicit }),
      explicit,
    );
    assert.strictEqual(
      findCompileCommands(root, { compileCommands: join(root, "elsewhere") }),
      explicit,
    );
    // an explicit value that holds no database does not fall back to the lookup
    assert.strictEqual(
      findCompileCommands(root, { compileCommands: join(root, "nothing") }),
      undefined,
    );
    assert.strictEqual(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
});

it("lists the frontend-args keys the installed atom accepts", () => {
  const atom4 = keysStubAtom("keys4", true);
  const atom3 = keysStubAtom("keys3", false);
  const broken = join(tmpdir(), `atom-stub-broken-${process.pid}.js`);
  writeFileSync(broken, "process.exit(1);\n");
  try {
    const keysOf = (stub) =>
      withEnv("ATOM_CMD", `${process.execPath} ${stub}`, () =>
        atomFrontendArgKeys("c"),
      );
    assert.ok(keysOf(atom4).has("compile-commands"));
    assert.ok(keysOf(atom4).has("compile-commands-only"));
    assert.ok(keysOf(atom3).has("cpp-standard"));
    assert.ok(!keysOf(atom3).has("compile-commands"));
    assert.ok(!keysOf(atom3).has("key"));
    // an atom without --frontend-args-keys accepts no keys
    assert.strictEqual(keysOf(broken).size, 0);
  } finally {
    rmSync(atom4, { force: true });
    rmSync(atom3, { force: true });
    rmSync(broken, { force: true });
  }
});

it("passes the compilation database to atom for C/C++ languages only", () => {
  const root = compileCommandsProject("build");
  const comma = compileCommandsProject("a,b");
  // every character here is legal in a directory name on Windows too, so the
  // fixture works on every platform the tests run on
  const shellishDir = "cmake-build-a&calc^b%c!d";
  const shellish = compileCommandsProject(shellishDir);
  const atom4 = keysStubAtom("args4", true);
  const savedAtomCmd = process.env.ATOM_CMD;
  process.env.ATOM_CMD = `${process.execPath} ${atom4}`;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const database = join(root, "build", "compile_commands.json");
    for (const language of ["c", "cpp", "c++", "newc", "h", "hpp", "i"]) {
      assert.deepStrictEqual(atomCompileCommandsArgs(root, language), [
        "--frontend-args",
        `compile-commands=${database}`,
      ]);
    }
    for (const language of ["java", "python", "js", "swift"]) {
      assert.deepStrictEqual(atomCompileCommandsArgs(root, language), []);
    }
    // --frontend-args splits on commas
    assert.deepStrictEqual(
      atomCompileCommandsArgs(comma, "c", {
        compileCommands: join(comma, "a,b"),
      }),
      [],
    );
    assert.strictEqual(warnings.length, 1);
    // a path a Windows shell command line would interpret is never passed on,
    // even when the atom run itself would take it
    assert.deepStrictEqual(atomCompileCommandsArgs(shellish, "c"), []);
    assert.deepStrictEqual(
      atomCompileCommandsArgs(shellish, "c", {
        compileCommands: join(shellish, shellishDir),
      }),
      [],
    );
    assert.strictEqual(warnings.length, 3);
    assert.deepStrictEqual(atomCompileCommandsArgs(join(root, "build"), "c"), [
      "--frontend-args",
      `compile-commands=${database}`,
    ]);
  } finally {
    console.warn = originalWarn;
    if (savedAtomCmd === undefined) {
      delete process.env.ATOM_CMD;
    } else {
      process.env.ATOM_CMD = savedAtomCmd;
    }
    rmSync(atom4, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(comma, { recursive: true, force: true });
    rmSync(shellish, { recursive: true, force: true });
  }
});

it("gives an atom that cannot read a compilation database its usual arguments", () => {
  const root = compileCommandsProject("build");
  const outPath = join(tmpdir(), `atom-stub-cdb3-${process.pid}.json`);
  const atom3 = keysStubAtom("cdb3", false, outPath);
  try {
    const argvFor = (language) => {
      withEnv("ATOM_CMD", `${process.execPath} ${atom3}`, () =>
        findAppModules(root, language, "usages"),
      );
      return JSON.parse(readFileSync(outPath, "utf-8"));
    };
    const header = argvFor("h");
    assert.ok(!header.includes("--frontend-args"));
    const at = header.indexOf("usages");
    assert.deepStrictEqual(header.slice(at, at + 3), ["usages", "-l", "h"]);
    assert.strictEqual(header.at(-1), root);
    assert.ok(header.includes("--no-ast-cache"));
    assert.ok(!argvFor("c").includes("--frontend-args"));
  } finally {
    rmSync(atom3, { force: true });
    rmSync(outPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

it("hands atom the database when collecting C/C++ modules", () => {
  const root = compileCommandsProject("build");
  const outPath = join(tmpdir(), `atom-stub-cdb-${process.pid}.json`);
  const stubPath = keysStubAtom("cdb4", true, outPath);
  const argvFor = (language) => {
    withEnv("ATOM_CMD", `${process.execPath} ${stubPath}`, () =>
      findAppModules(root, language, "usages"),
    );
    return JSON.parse(readFileSync(outPath, "utf-8"));
  };
  try {
    const argv = argvFor("h");
    const at = argv.indexOf("--frontend-args");
    assert.ok(at > 0);
    assert.strictEqual(
      argv[at + 1],
      `compile-commands=${join(root, "build", "compile_commands.json")}`,
    );
    // the source directory stays the last argument
    assert.strictEqual(argv.at(-1), root);
    assert.ok(!argvFor("python").includes("--frontend-args"));
  } finally {
    rmSync(stubPath, { force: true });
    rmSync(outPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

it("uses only an explicit compilation database in secure mode", async () => {
  const root = compileCommandsProject("", "elsewhere");
  try {
    const { findCompileCommands: secureFind } = await esmock("./atomUtils.js", {
      "../core/activity.js": { isSecureMode: true },
    });
    assert.strictEqual(secureFind(root), undefined);
    const explicit = join(root, "elsewhere", "compile_commands.json");
    assert.strictEqual(
      secureFind(root, { compileCommands: explicit }),
      explicit,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("splits an atom command without cutting a binary path at its spaces", () => {
  assert.deepStrictEqual(splitAtomCommand("atom"), ["atom", undefined]);
  // a bare command name resolves through the PATH, so its first space splits
  assert.deepStrictEqual(splitAtomCommand("node script.js"), [
    "node",
    "script.js",
  ]);
  const spacey = mkdtempSync(join(tmpdir(), "atom split-"));
  try {
    const binDir = join(spacey, "tools dir");
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, "run.js");
    writeFileSync(bin, "");
    // the prefix at the first space is a directory, not the binary
    assert.deepStrictEqual(splitAtomCommand(`${bin} -l c`), [bin, "-l c"]);
    // an extra argument survives whole
    assert.deepStrictEqual(splitAtomCommand(`${bin} -l c src`), [
      bin,
      "-l c src",
    ]);
  } finally {
    rmSync(spacey, { recursive: true, force: true });
  }
  // nothing on disk matches: the first space keeps the old behaviour
  assert.deepStrictEqual(splitAtomCommand("/no such dir/app arg"), [
    "/no",
    "such dir/app arg",
  ]);
});

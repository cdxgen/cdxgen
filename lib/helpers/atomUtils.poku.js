import process from "node:process";

import { assert, it } from "poku";

import {
  buildAtomCommandEnv,
  filterAtomSlicesByExcludePatterns,
  globPatternsToAtomIgnoreRegex,
  isPathExcludedByGlobPatterns,
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

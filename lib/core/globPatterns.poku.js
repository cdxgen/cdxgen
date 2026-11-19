import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Glob } from "glob";
import { assert, describe, it } from "poku";

import { getAllFiles } from "./fs.js";
import {
  boundUntrustedGlobPatterns,
  globBraceExpansionCount,
  splitGlobPatternList,
  UNTRUSTED_GLOB_EXPANSION_BUDGET,
  UNTRUSTED_GLOB_PATTERN_MAX_LENGTH,
} from "./globPatterns.js";

describe("globBraceExpansionCount()", () => {
  it("counts lists and ranges the way brace-expansion expands them", () => {
    for (const [pattern, count] of [
      ["**/*.js", 1],
      ["**/{test,tests}/**", 2],
      ["**/*.{js,ts,jsx,tsx}", 4],
      ["{a,b}{c,d,e}", 6],
      ["{a,{b,{c,d}}}", 4],
      ["{1..10}", 10],
      ["{-2..2}", 5],
      ["{0..100..5}", 21],
      ["{10..1..3}", 4],
      ["{a..z}", 26],
      ["{1..5..0}", 5],
      ["{{a,b}c}", 2],
      ["\\{a,b\\}", 1],
      ["{a\\,b,c}", 2],
    ]) {
      assert.strictEqual(globBraceExpansionCount(pattern), count, pattern);
    }
  });

  it("stops counting just past the cap", () => {
    assert.strictEqual(globBraceExpansionCount("**/{1..100000}/**", 128), 129);
    assert.strictEqual(globBraceExpansionCount("{a,b}".repeat(20), 128), 129);
    assert.strictEqual(
      globBraceExpansionCount("{1..99999999999999999999999}", 128),
      129,
    );
  });

  it("counts a range past the safe integers as over the cap", () => {
    // brace-expansion steps through a range in doubles. 2 ** 53 + 1 is
    // 2 ** 53 again, so it expands each of the first three to 100000 patterns.
    // The fourth steps back into the safe integers and has one member, but
    // its ends are not safe and it is refused with the others. The ends of
    // the last are 2 ** 53 + 1 apart: it has 4 members where the distance in
    // doubles gives 3.
    for (const pattern of [
      "{9007199254740992..9007199254740992}",
      "{9007199254740990..9007199254740993}",
      "{18014398509481984..18014398509481980}",
      "{-9007199254740992..-9007199254740992}",
      "{-2..9007199254740991..3002399751580331}",
    ]) {
      assert.strictEqual(globBraceExpansionCount(pattern, 128), 129, pattern);
    }
    for (const [pattern, count] of [
      ["{9007199254740991..9007199254740991}", 1],
      ["{9007199254740989..9007199254740991}", 3],
      ["{-9007199254740991..-9007199254740990}", 2],
      ["{0..9007199254740991..9007199254740991}", 2],
    ]) {
      assert.strictEqual(globBraceExpansionCount(pattern, 128), count, pattern);
    }
    assert.deepStrictEqual(
      boundUntrustedGlobPatterns(["{9007199254740992..9007199254740992}"])
        .accepted,
      [],
    );
  });

  it("counts brace forms with context-dependent expansion as over the cap", () => {
    // brace-expansion expands {{,1..100000}} to 100000 patterns: the list
    // inside gives "1..100000", which it braces and expands again.
    for (const pattern of [
      "{{,1..100000}}",
      "{a}",
      "{}",
      "{a,b",
      "a}b",
      "{x{1..3}}",
      "1{a-},*b}{*",
    ]) {
      assert.strictEqual(globBraceExpansionCount(pattern, 128), 129, pattern);
    }
  });

  it("reads each character once", () => {
    const deep = `${"{a,".repeat(20000)}b${"}".repeat(20000)}`;
    const started = performance.now();
    assert.strictEqual(globBraceExpansionCount(deep, 128), 129);
    // The bounded expansion takes milliseconds; the bound only has to
    // separate a loaded runner from unbounded expansion.
    assert.ok(performance.now() - started < 5000);
  });
});

describe("splitGlobPatternList()", () => {
  it("splits at commas unless the pattern has a brace", () => {
    for (const [pattern, entries] of [
      ["**/dist/**", ["**/dist/**"]],
      ["one,two", ["one", "two"]],
      [" a,b, c,,", ["a", "b", "c"]],
      ["**/{a,b}/**", ["**/{a,b}/**"]],
      ["a,{b,c}", ["a,{b,c}"]],
      [",", []],
      [7, ["7"]],
    ]) {
      assert.deepStrictEqual(splitGlobPatternList(pattern), entries, pattern);
    }
  });
});

describe("boundUntrustedGlobPatterns()", () => {
  it("keeps patterns in order while they fit the budget", () => {
    const { accepted, expansions, refused } = boundUntrustedGlobPatterns([
      "**/{test,tests}/**",
      7,
      null,
      "x".repeat(UNTRUSTED_GLOB_PATTERN_MAX_LENGTH + 1),
      "{1..200}",
      "{1..100}",
      "{1..50}",
      "**/dist/**",
    ]);
    assert.deepStrictEqual(accepted, [
      "**/{test,tests}/**",
      "7",
      "{1..100}",
      "**/dist/**",
    ]);
    assert.strictEqual(expansions, 104);
    assert.deepStrictEqual(
      refused.map((entry) => entry.reason),
      [
        "is not a string",
        `is longer than ${UNTRUSTED_GLOB_PATTERN_MAX_LENGTH} characters`,
        `expands to more than ${UNTRUSTED_GLOB_EXPANSION_BUDGET} patterns`,
        `would bring the patterns past ${UNTRUSTED_GLOB_EXPANSION_BUDGET} after brace expansion`,
      ],
    );
  });

  it("refuses every brace when braces are not allowed", () => {
    const { accepted, refused } = boundUntrustedGlobPatterns(
      ["**/{a,b}/**", "**/test/**"],
      { allowBraces: false },
    );
    assert.deepStrictEqual(accepted, ["**/test/**"]);
    assert.deepStrictEqual(refused, [
      { pattern: "**/{a,b}/**", reason: "uses braces" },
    ]);
  });

  it("counts the patterns glob splits '..' after '**' into", () => {
    for (const [pattern, count] of [
      ["../../shared/**", 1],
      ["packages/*/../shared", 1],
      ["**/*.{test,spec}.js", 2],
      ["**/{.github,.vscode}/**", 2],
      ["**/.{git,svn}/**", 2],
      ["**/{1..9}/**", 9],
      ["**/../a/b", 2],
      ["**/./**/../a/b", 4],
      ["**/../a/**/../b/**/../c/d", 32],
      ["**/{..,x}/a/b", 4],
      ["**/.{.,x}/a/b", 4],
      ["*{*,x}/../a/b", 4],
      ["{a,b}/**/\\.\\./c/d", 4],
    ]) {
      assert.strictEqual(
        boundUntrustedGlobPatterns(pattern).expansions,
        count,
        pattern,
      );
      assert.ok(new Glob(pattern, {}).patterns.length <= count, pattern);
    }
  });

  it("refuses a pattern that repeats '..' after '**'", () => {
    // glob makes 2^n patterns of n repeats, with or without braces around.
    const repeated = (times) => "**/../a/".repeat(times);
    for (const options of [{}, { allowBraces: false }]) {
      assert.deepStrictEqual(
        boundUntrustedGlobPatterns(
          [repeated(5), repeated(26), "**/dist/**"],
          options,
        ),
        {
          accepted: ["**/dist/**"],
          expansions: 1,
          refused: [5, 26].map((times) => ({
            pattern: repeated(times),
            reason: `expands to more than ${UNTRUSTED_GLOB_EXPANSION_BUDGET} patterns`,
          })),
        },
      );
    }
    for (const pattern of [
      "**/{..,x}/a/".repeat(4),
      `{x,y}/${"**/\\.\\./a/".repeat(4)}`,
      "*{*,x}/.{.,x}/a/".repeat(3),
    ]) {
      assert.deepStrictEqual(
        boundUntrustedGlobPatterns(pattern).accepted,
        [],
        pattern,
      );
    }
    assert.deepStrictEqual(boundUntrustedGlobPatterns(repeated(3)), {
      accepted: [repeated(3)],
      expansions: 32,
      refused: [],
    });
  });

  it("refuses patterns that leave the scanned directory when asked to", () => {
    const inside = ["**/*.json", "./src/**", "src/**/../lib/*.js", "{a,b}/**"];
    const outside = [
      "/**",
      "../**",
      "{.,x}{.,y}/**",
      "**/../a",
      "/tmp/{a,b}/**",
    ];
    assert.deepStrictEqual(
      boundUntrustedGlobPatterns([...inside, ...outside], { keepInTree: true })
        .accepted,
      inside,
    );
    assert.strictEqual(
      boundUntrustedGlobPatterns(outside).accepted.length,
      outside.length,
    );
    const { refused } = boundUntrustedGlobPatterns("/**", { keepInTree: true });
    assert.deepStrictEqual(refused, [
      {
        pattern: "/**",
        reason: "is absolute or climbs out of the scanned directory",
      },
    ]);
  });

  it("charges a comma separated list for every pattern the evidence filters read from it", () => {
    // 128 entries of 100 names each are 128 patterns to glob, and 12,800 to
    // the atom and dosai exclude filters.
    const lists = Array.from({ length: 128 }, (_, list) =>
      Array.from({ length: 100 }, (_, item) =>
        (list * 100 + item).toString(16).padStart(4, "0"),
      ).join(","),
    );
    const { accepted, expansions, refused } = boundUntrustedGlobPatterns(
      ["a,b, c,,", ...lists, "**/dist/**", "x,".repeat(200)],
      { allowBraces: false },
    );
    assert.deepStrictEqual(accepted, ["a,b, c,,", lists[0], "**/dist/**"]);
    assert.strictEqual(expansions, 104);
    assert.strictEqual(
      accepted.flatMap((pattern) => splitGlobPatternList(pattern)).length,
      expansions,
    );
    assert.deepStrictEqual(
      [...new Set(refused.map((entry) => entry.reason))],
      [
        `would bring the patterns past ${UNTRUSTED_GLOB_EXPANSION_BUDGET} after comma list expansion`,
        `expands to more than ${UNTRUSTED_GLOB_EXPANSION_BUDGET} patterns`,
      ],
    );
    // A comma inside braces belongs to the brace expression, and a pattern
    // of nothing but commas is still one pattern to glob.
    assert.strictEqual(boundUntrustedGlobPatterns("**/{a,b}/**").expansions, 2);
    assert.strictEqual(boundUntrustedGlobPatterns("a,{b,c}").expansions, 2);
    assert.strictEqual(boundUntrustedGlobPatterns(",").expansions, 1);
  });

  it("accepts a single pattern, nothing, and a smaller budget", () => {
    assert.deepStrictEqual(boundUntrustedGlobPatterns("**/docs/**").accepted, [
      "**/docs/**",
    ]);
    assert.deepStrictEqual(boundUntrustedGlobPatterns(undefined), {
      accepted: [],
      expansions: 0,
      refused: [],
    });
    assert.deepStrictEqual(
      boundUntrustedGlobPatterns(["a", "b", "c"], { budget: 2 }).accepted,
      ["a", "b"],
    );
  });

  it("keeps a scan quick when every accepted pattern is used", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cdxgen-glob-bound-"));
    try {
      for (let index = 0; index < 60; index += 1) {
        const dir = path.join(root, `dir${index}`, "a".repeat(60));
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, `${"a".repeat(120)}.js`), "");
      }
      // Unbounded, each of the first three takes getAllFiles() from half a
      // second to two seconds on a tree like this one.
      const { accepted } = boundUntrustedGlobPatterns([
        "**/{1..100000}/**",
        `**/${"{a,b}".repeat(20)}/**`,
        "{{,1..100000}}",
        ...Array.from({ length: 200 }, (_, i) => `**/{x${i},y${i}}/**`),
      ]);
      assert.strictEqual(accepted.length, UNTRUSTED_GLOB_EXPANSION_BUDGET / 2);
      const started = performance.now();
      const files = getAllFiles(root, "**/*.js", { exclude: accepted });
      const elapsed = performance.now() - started;
      assert.strictEqual(files.length, 60);
      // A real expansion blowup would take orders of magnitude longer than
      // a loaded runner does here.
      assert.ok(elapsed < 5000, `took ${Math.round(elapsed)} ms`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

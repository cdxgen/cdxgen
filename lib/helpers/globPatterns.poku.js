import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, describe, it } from "poku";

import {
  boundUntrustedGlobPatterns,
  globBraceExpansionCount,
  UNTRUSTED_GLOB_EXPANSION_BUDGET,
  UNTRUSTED_GLOB_PATTERN_MAX_LENGTH,
} from "./globPatterns.js";
import { getAllFiles } from "./utils.js";

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
    assert.ok(performance.now() - started < 1000);
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
      assert.ok(elapsed < 1500, `took ${Math.round(elapsed)} ms`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

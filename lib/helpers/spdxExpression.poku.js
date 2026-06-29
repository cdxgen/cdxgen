import assert from "node:assert";

import { test } from "poku";

import {
  canonicalizeAST,
  correctLicenseId,
  parseSpdxExpression,
  renderAST,
  tokenize,
} from "./spdxExpression.js";

test("spdxExpression tokenizer", () => {
  const tokens = tokenize("(MIT OR Apache-2.0 WITH Bison-exception-2.2+)");
  assert.deepStrictEqual(tokens, [
    "(",
    "MIT",
    "OR",
    "Apache-2.0",
    "WITH",
    "Bison-exception-2.2",
    "+",
    ")",
  ]);
});

test("spdxExpression parser & validator", () => {
  // Valid SPDX Expression
  const res1 = parseSpdxExpression("MIT OR Apache-2.0");
  assert.strictEqual(res1.valid, true);
  assert.strictEqual(res1.unknown.length, 0);
  assert.strictEqual(res1.ast.type, "Or");

  // Expression with WITH exception
  const res2 = parseSpdxExpression("GPL-2.0-only WITH Classpath-exception-2.0");
  assert.strictEqual(res2.valid, true);
  assert.strictEqual(res2.unknown.length, 0);
  assert.strictEqual(res2.ast.type, "With");

  // Expression with '+'
  const res3 = parseSpdxExpression("GPL-3.0+");
  assert.strictEqual(res3.valid, true);
  assert.strictEqual(res3.ast.type, "License");
  assert.strictEqual(res3.ast.plus, true);

  // Invalid expression (unknown operands)
  const res4 = parseSpdxExpression("MIT OR UnknownLicenseIDHere");
  assert.strictEqual(res4.valid, false);
  assert.deepStrictEqual(res4.unknown, ["UnknownLicenseIDHere"]);

  // Syntax error expression
  const res5 = parseSpdxExpression("MIT OR (Apache-2.0");
  assert.strictEqual(res5.valid, false);
  assert.ok(res5.unknown.length > 0);
});

test("spdxExpression renderAST (parenthesization and normalization)", () => {
  // Simple
  const ast1 = parseSpdxExpression("MIT OR Apache-2.0").ast;
  assert.strictEqual(renderAST(ast1), "MIT OR Apache-2.0");

  // Operator precedence rendering (OR inside AND must have parentheses)
  const ast2 = parseSpdxExpression("(MIT OR Apache-2.0) AND GPL-3.0-only").ast;
  assert.strictEqual(renderAST(ast2), "(MIT OR Apache-2.0) AND GPL-3.0-only");

  // Precedence: AND inside OR does not need parentheses by default precedence
  const ast3 = parseSpdxExpression("MIT OR (Apache-2.0 AND GPL-3.0-only)").ast;
  assert.strictEqual(renderAST(ast3), "MIT OR Apache-2.0 AND GPL-3.0-only");
});

test("spdxExpression parser edge cases", () => {
  // WITH binds tighter than OR (exception attaches to the left operand only)
  const ast1 = parseSpdxExpression(
    "MIT WITH Classpath-exception-2.0 OR GPL-2.0-only",
  ).ast;
  assert.strictEqual(ast1.type, "Or");
  assert.strictEqual(ast1.left.type, "With");

  // Nested parentheses round-trip and canonicalize casing
  const res2 = parseSpdxExpression("mit AND (apache-2.0 OR isc)");
  assert.strictEqual(res2.valid, true);
  assert.strictEqual(
    renderAST(canonicalizeAST(res2.ast)),
    "MIT AND (Apache-2.0 OR ISC)",
  );

  // Redundant parentheses are dropped on render
  assert.strictEqual(renderAST(parseSpdxExpression("(MIT)").ast), "MIT");

  // Idempotent render
  const r = renderAST(
    canonicalizeAST(parseSpdxExpression("MIT AND (Apache-2.0 OR ISC)").ast),
  );
  assert.strictEqual(renderAST(canonicalizeAST(parseSpdxExpression(r).ast)), r);

  // Invalid syntax variations are reported as invalid (not thrown)
  for (const bad of [
    "MIT OR OR Apache-2.0",
    "MIT AND",
    "AND MIT",
    "MIT OR (Apache-2.0",
    "MIT)",
    "WITH Classpath-exception-2.0",
  ]) {
    const res = parseSpdxExpression(bad);
    assert.strictEqual(res.valid, false, `expected invalid: ${bad}`);
  }

  // Exception applied to a compound expression is rejected
  assert.strictEqual(
    parseSpdxExpression("(MIT OR Apache-2.0) WITH Classpath-exception-2.0")
      .valid,
    false,
  );
});

test("spdxExpression correctLicenseId (aliases and fuzzy correction)", () => {
  // Exact lookup (case insensitive)
  assert.strictEqual(correctLicenseId("mit"), "MIT");
  assert.strictEqual(correctLicenseId("apache-2.0"), "Apache-2.0");

  // Alias lookup
  assert.strictEqual(correctLicenseId("Apache 2.0"), "Apache-2.0");
  assert.strictEqual(correctLicenseId("Apache2"), "Apache-2.0");
  assert.strictEqual(correctLicenseId("Zero-Clause BSD"), "0BSD");
});

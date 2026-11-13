import { assert, describe, it } from "poku";

import { sanitizeMcpRefToken } from "./mcpDiscovery.js";

describe("sanitizeMcpRefToken()", () => {
  it("normalizes path traversal and punctuation-heavy input into safe tokens", () => {
    assert.strictEqual(
      sanitizeMcpRefToken("../Secrets/Prod Token"),
      "secrets-prod-token",
    );
    assert.strictEqual(
      sanitizeMcpRefToken("..\\..\\etc\\passwd"),
      "etc-passwd",
    );
  });

  it("returns unknown for empty or separator-only input", () => {
    assert.strictEqual(sanitizeMcpRefToken("..."), "unknown");
    assert.strictEqual(sanitizeMcpRefToken("///"), "unknown");
  });

  it("does not normalize more input than a token can use", () => {
    // Out of canonical order: class 230 marks followed by class 220 marks.
    const marks = "\u0301".repeat(100000) + "\u0316".repeat(100000);
    assert.strictEqual(sanitizeMcpRefToken(`x${marks}`), "x");
    assert.strictEqual(sanitizeMcpRefToken("A".repeat(300)), "a".repeat(128));
  });
});

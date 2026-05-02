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
});

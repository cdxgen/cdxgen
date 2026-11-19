import { assert, describe, it } from "poku";

import {
  credentialIndicatorsForText,
  sanitizeMcpRefToken,
} from "./mcpDiscovery.js";

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

describe("credentialIndicatorsForText()", () => {
  it("flags underscore and hyphen delimited secret keys", () => {
    for (const key of [
      "sk_test_StripeStyleKey0123456789",
      "sk-proj_UnderscoreStyleKey0123456789",
      "sk-proj-OpenAiProjectKey0123456789abcdefghijklmnopqrstuvwxyzABCD",
      "sk-ant-api03-AnthropicKey0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFAA",
      "sk-LegacyOpenAiKey0123456789abcdefghijklmnopqrstuv",
    ]) {
      assert.deepStrictEqual(credentialIndicatorsForText(`KEY=${key} run`), [
        "generic-secret",
      ]);
    }
  });

  it("flags bearer tokens in base64 and percent-encoded form", () => {
    for (const token of [
      "Short0Head+WholeTokenSurvives/0123456789abcdefghij==",
      "tilde~token~0123456789abcdef",
      "AAAAAAAAAAAAAAAAAAAAAMLheAAAAAAA0%2BuSeid%2BULvsea4JtiGRiSDSJSI%3D",
    ]) {
      assert.deepStrictEqual(
        credentialIndicatorsForText(`Authorization: Bearer ${token}`),
        ["bearer-token"],
      );
    }
  });

  it("ignores short hyphenated words that only share a key prefix", () => {
    assert.deepStrictEqual(
      credentialIndicatorsForText("Use the sk-learn wrapper and sk-test."),
      [],
    );
  });
});

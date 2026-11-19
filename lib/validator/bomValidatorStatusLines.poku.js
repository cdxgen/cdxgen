import { assert, describe, it } from "poku";
import sinon from "sinon";

import { validateBom } from "./bomValidator.js";

describe("validateBom() status lines", () => {
  it("writes control characters from the BOM as escapes in its status lines", async () => {
    const consoleLogStub = sinon.stub(console, "log");
    try {
      assert.strictEqual(
        await validateBom({
          bomFormat: "CycloneDX",
          specVersion: "1.6\r\u001b[2K",
        }),
        false,
      );
      assert.strictEqual(
        await validateBom({
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          version: 0,
          metadata: { component: { name: "\r\u001b[2Kbad\u001b[8m" } },
        }),
        false,
      );
      const lines = consoleLogStub
        .getCalls()
        .map((call) => call.args[0])
        .filter((arg) => typeof arg === "string");
      assert.ok(lines.length >= 2);
      for (const line of lines) {
        assert.ok(
          ![...line].some((char) => char.charCodeAt(0) < 32),
          JSON.stringify(line),
        );
      }
      assert.ok(lines.some((line) => line.includes("\\u001b[2Kbad")));
    } finally {
      consoleLogStub.restore();
    }
  });
});

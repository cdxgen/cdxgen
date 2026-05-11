import { assert, describe, it } from "poku";

import {
  createOccurrenceEvidence,
  formatOccurrenceEvidence,
  parseOccurrenceEvidenceLocation,
} from "./evidenceUtils.js";

describe("evidence utils", () => {
  it("creates occurrence evidence with structured line details", () => {
    assert.deepStrictEqual(
      createOccurrenceEvidence("src/index.js", {
        line: 14,
        offset: 3,
        symbol: "node:crypto.createHash",
      }),
      {
        location: "src/index.js",
        line: 14,
        offset: 3,
        symbol: "node:crypto.createHash",
      },
    );
  });

  it("parses hash-style line locations", () => {
    assert.deepStrictEqual(parseOccurrenceEvidenceLocation("src/index.js#27"), {
      location: "src/index.js",
      line: 27,
    });
  });

  it("parses colon-style line and offset locations", () => {
    assert.deepStrictEqual(
      parseOccurrenceEvidenceLocation("src/index.js:29:7"),
      {
        location: "src/index.js",
        line: 29,
        offset: 7,
      },
    );
  });

  it("formats structured occurrence evidence for display", () => {
    assert.strictEqual(
      formatOccurrenceEvidence({
        location: "src/index.js",
        line: 12,
        offset: 1,
      }),
      "src/index.js:12:1",
    );
  });
});

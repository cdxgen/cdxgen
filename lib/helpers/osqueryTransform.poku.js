import { assert, describe, it } from "poku";

import {
  createOsQueryPurl,
  deriveOsQueryDescription,
  deriveOsQueryName,
  deriveOsQueryPublisher,
  deriveOsQueryVersion,
  sanitizeOsQueryIdentity,
} from "./osqueryTransform.js";

describe("osqueryTransform helpers", () => {
  it("derives version, name, publisher, and description from osquery rows", () => {
    const row = {
      pid: "1024",
      provider: "null",
      summary: "sample description",
    };
    assert.strictEqual(deriveOsQueryVersion(row), "1024");
    assert.strictEqual(deriveOsQueryName(row, false), "1024");
    assert.strictEqual(deriveOsQueryPublisher(row), "");
    assert.strictEqual(deriveOsQueryDescription(row), "sample description");
  });

  it("falls back to query name for single-row synthetic entries", () => {
    const row = {};
    assert.strictEqual(deriveOsQueryName(row, true, "os-image"), "os-image");
  });

  it("sanitizes osquery identity strings used in purl fields", () => {
    assert.strictEqual(
      sanitizeOsQueryIdentity("{My App:%Name}"),
      "My+App--Name",
    );
  });

  it("creates valid purl strings for osquery-derived components", () => {
    const purl = createOsQueryPurl(
      "swid",
      "microsoft",
      "windows+11",
      "22H2",
      undefined,
      "windows",
    );
    assert.ok(purl.startsWith("pkg:swid/microsoft/"));
    assert.ok(purl.includes("@22H2"));
  });
});

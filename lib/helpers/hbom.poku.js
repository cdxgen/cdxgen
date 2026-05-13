import { assert, describe, it } from "poku";

import {
  ensureNoMixedHbomProjectTypes,
  ensureSupportedHbomSpecVersion,
  hasHbomProjectType,
  isHbomOnlyProjectTypes,
  normalizeHbomOptions,
} from "./hbom.js";

describe("hbom helpers", () => {
  it("detects hbom project types and rejects mixed project selections", () => {
    assert.strictEqual(hasHbomProjectType(undefined), false);
    assert.strictEqual(hasHbomProjectType(["js"]), false);
    assert.strictEqual(hasHbomProjectType(["hbom"]), true);
    assert.strictEqual(hasHbomProjectType(["hardware"]), true);
    assert.strictEqual(isHbomOnlyProjectTypes(undefined), false);
    assert.strictEqual(isHbomOnlyProjectTypes(["hbom"]), true);
    assert.strictEqual(isHbomOnlyProjectTypes(["hardware"]), true);
    assert.strictEqual(isHbomOnlyProjectTypes(["hbom", "hardware"]), true);
    assert.strictEqual(isHbomOnlyProjectTypes(["hbom", "js"]), false);
    ensureNoMixedHbomProjectTypes(["hbom"]);
    ensureNoMixedHbomProjectTypes(["hardware"]);
    assert.throws(
      () => ensureNoMixedHbomProjectTypes(["hbom", "js"]),
      /cannot be mixed/u,
    );
  });

  it("enforces CycloneDX 1.7 for hbom generation", () => {
    ensureSupportedHbomSpecVersion(undefined);
    ensureSupportedHbomSpecVersion(1.7);
    assert.throws(
      () => ensureSupportedHbomSpecVersion(1.6),
      /only CycloneDX 1\.7/u,
    );
  });

  it("normalizes hbom collector options", () => {
    assert.deepStrictEqual(
      normalizeHbomOptions({
        arch: "arm64",
        noCommandEnrichment: true,
        platform: "darwin",
        plistEnrichment: true,
        privileged: true,
        sensitive: true,
        strict: true,
        timeout: "2500",
      }),
      {
        allowPartial: false,
        architecture: "arm64",
        includeCommandEnrichment: false,
        includePlistEnrichment: true,
        includePrivilegedEnrichment: true,
        includeSensitiveIdentifiers: true,
        platform: "darwin",
        timeoutMs: 2500,
      },
    );
  });
});

import { assert, describe, it } from "poku";

import {
  expandBomAuditCategories,
  validateBomAuditCategories,
} from "./auditCategories.js";

describe("auditCategories", () => {
  it("keeps host-topology as a direct category", () => {
    assert.deepStrictEqual(expandBomAuditCategories("host-topology"), [
      "host-topology",
    ]);
  });

  it("expands the host alias to the HBOM packs plus host-topology", () => {
    assert.deepStrictEqual(expandBomAuditCategories("host"), [
      "hbom-security",
      "hbom-performance",
      "hbom-compliance",
      "host-topology",
    ]);
  });

  it("expands the golem alias to all Go Evinse rule packs", () => {
    assert.deepStrictEqual(expandBomAuditCategories("golem"), [
      "golem-security",
      "golem-performance",
      "golem-compliance",
    ]);
  });

  it("accepts host-topology during validation", () => {
    const validation = validateBomAuditCategories("host-topology", [
      { category: "host-topology" },
      { category: "hbom-security" },
    ]);
    assert.deepStrictEqual(validation.categories, ["host-topology"]);
    assert.deepStrictEqual(validation.expandedCategories, ["host-topology"]);
  });
});

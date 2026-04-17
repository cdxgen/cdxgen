import { assert, describe, it } from "poku";

import {
  __test,
  getAllComplianceRules,
  getCraRules,
  getScvsRules,
} from "./complianceRules.js";

const {
  componentLicenseId,
  inventoryComponents,
  looksLikeSpdx,
  collectReferencedRefs,
} = __test;

function baseBom(overrides = {}) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "urn:uuid:1b671687-395b-41f5-a30f-a58921a69b79",
    metadata: {
      timestamp: "2024-01-02T03:04:05Z",
      tools: {
        components: [
          { type: "application", name: "cdxgen", version: "12.0.0" },
        ],
      },
      component: {
        name: "demo",
        version: "1.0.0",
        type: "application",
        "bom-ref": "pkg:generic/demo@1.0.0",
      },
      supplier: {
        name: "Acme",
        contact: [{ email: "psirt@example.com" }],
      },
    },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        purl: "pkg:npm/lodash@4.17.21",
        "bom-ref": "pkg:npm/lodash@4.17.21",
        licenses: [{ license: { id: "MIT" } }],
        hashes: [{ alg: "SHA-256", content: "abc" }],
        copyright: "Copyright (c) OpenJS",
      },
    ],
    dependencies: [
      { ref: "pkg:generic/demo@1.0.0", dependsOn: ["pkg:npm/lodash@4.17.21"] },
      { ref: "pkg:npm/lodash@4.17.21", dependsOn: [] },
    ],
    ...overrides,
  };
}

describe("complianceRules catalog", () => {
  it("exposes SCVS + CRA rules with stable ids", () => {
    const all = getAllComplianceRules();
    assert.ok(all.length >= 80, `expected >= 80 rules, got ${all.length}`);
    const scvs = getScvsRules();
    const cra = getCraRules();
    assert.strictEqual(scvs.length + cra.length, all.length);
    for (const r of all) {
      assert.ok(typeof r.id === "string" && r.id.length > 0, `bad id ${r.id}`);
      assert.ok(
        typeof r.evaluate === "function",
        `rule ${r.id} missing evaluate`,
      );
      assert.ok(
        Array.isArray(r.standardRefs),
        `rule ${r.id} missing standardRefs`,
      );
    }
    const ids = new Set(all.map((r) => r.id));
    assert.strictEqual(ids.size, all.length, "rule ids must be unique");
  });

  it("SCVS rule ids match the SCVS-X.Y convention", () => {
    for (const r of getScvsRules()) {
      assert.match(r.id, /^SCVS-\d+\.\d+$/);
      assert.strictEqual(r.standard, "SCVS");
    }
  });

  it("CRA rule ids match the CRA-MIN-XXX convention", () => {
    for (const r of getCraRules()) {
      assert.match(r.id, /^CRA-MIN-\d+$/);
      assert.strictEqual(r.standard, "CRA");
    }
  });
});

describe("complianceRules helpers", () => {
  it("inventoryComponents filters non-inventory types", () => {
    const bom = {
      components: [
        { type: "library", name: "a" },
        { type: "cryptographic-asset", name: "b" },
        { type: "framework", name: "c" },
      ],
    };
    assert.deepStrictEqual(
      inventoryComponents(bom).map((c) => c.name),
      ["a", "c"],
    );
  });

  it("looksLikeSpdx accepts common forms and rejects garbage", () => {
    assert.ok(looksLikeSpdx("MIT"));
    assert.ok(looksLikeSpdx("Apache-2.0"));
    assert.ok(looksLikeSpdx("Apache-2.0 OR MIT"));
    assert.ok(looksLikeSpdx("(MIT AND LGPL-2.1-only)"));
    assert.ok(!looksLikeSpdx("NOASSERTION"));
    assert.ok(!looksLikeSpdx("unknown"));
    assert.ok(!looksLikeSpdx(""));
    assert.ok(!looksLikeSpdx(null));
  });

  it("componentLicenseId prefers id then name then expression", () => {
    assert.strictEqual(
      componentLicenseId({ licenses: [{ license: { id: "MIT" } }] }),
      "MIT",
    );
    assert.strictEqual(
      componentLicenseId({ licenses: [{ license: { name: "Custom" } }] }),
      "Custom",
    );
    assert.strictEqual(
      componentLicenseId({ licenses: [{ expression: "MIT OR Apache-2.0" }] }),
      "MIT OR Apache-2.0",
    );
    assert.strictEqual(componentLicenseId({}), null);
    assert.strictEqual(componentLicenseId({ licenses: [] }), null);
  });

  it("collectReferencedRefs gathers all refs", () => {
    const bom = baseBom();
    const refs = collectReferencedRefs(bom);
    assert.ok(refs.has("pkg:generic/demo@1.0.0"));
    assert.ok(refs.has("pkg:npm/lodash@4.17.21"));
  });
});

describe("SCVS automatable rules on a clean BOM", () => {
  const bom = baseBom();
  const rules = getScvsRules().filter((r) => r.automatable);

  it("SCVS-1.1, 1.3, 1.7, 2.1, 2.3, 2.7, 2.9, 2.11, 2.12, 2.14, 3.20 all pass", () => {
    const expected = [
      "SCVS-1.1",
      "SCVS-1.3",
      "SCVS-1.7",
      "SCVS-2.1",
      "SCVS-2.3",
      "SCVS-2.7",
      "SCVS-2.9",
      "SCVS-2.11",
      "SCVS-2.12",
      "SCVS-2.14",
      "SCVS-3.20",
    ];
    for (const id of expected) {
      const r = rules.find((x) => x.id === id);
      assert.ok(r, `missing rule ${id}`);
      const res = r.evaluate(bom);
      assert.strictEqual(res.status, "pass", `${id}: ${res.message}`);
    }
  });

  it("SCVS-2.4 fails when BOM is not signed, passes when signed", () => {
    const rule = rules.find((r) => r.id === "SCVS-2.4");
    assert.strictEqual(rule.evaluate(bom).status, "fail");
    const signed = baseBom({
      signature: { algorithm: "RS512", value: "xxx" },
    });
    assert.strictEqual(rule.evaluate(signed).status, "pass");
  });

  it("SCVS-1.1 fails when a component has no version", () => {
    const rule = rules.find((r) => r.id === "SCVS-1.1");
    const bad = baseBom({
      components: [{ type: "library", name: "no-version", purl: "pkg:npm/x" }],
    });
    const res = rule.evaluate(bad);
    assert.strictEqual(res.status, "fail");
    assert.match(res.message, /missing a version/);
  });

  it("SCVS-2.3 fails when serialNumber is missing", () => {
    const rule = rules.find((r) => r.id === "SCVS-2.3");
    assert.strictEqual(
      rule.evaluate(baseBom({ serialNumber: undefined })).status,
      "fail",
    );
    assert.strictEqual(
      rule.evaluate(baseBom({ serialNumber: "garbage" })).status,
      "fail",
    );
  });

  it("SCVS-2.11 fails when root name or version is missing", () => {
    const rule = rules.find((r) => r.id === "SCVS-2.11");
    const noVer = baseBom({
      metadata: {
        ...baseBom().metadata,
        component: { name: "x", "bom-ref": "x", type: "application" },
      },
    });
    assert.strictEqual(rule.evaluate(noVer).status, "fail");
    const noName = baseBom({
      metadata: {
        ...baseBom().metadata,
        component: {},
      },
    });
    assert.strictEqual(rule.evaluate(noName).status, "fail");
  });

  it("SCVS-2.12 fails when a purl is unparseable", () => {
    const rule = rules.find((r) => r.id === "SCVS-2.12");
    const bom = baseBom({
      components: [
        {
          type: "library",
          name: "bad",
          version: "1.0.0",
          purl: "not-a-purl",
          "bom-ref": "bad",
        },
      ],
    });
    const res = rule.evaluate(bom);
    assert.strictEqual(res.status, "fail");
    assert.ok(res.locations.length > 0);
  });

  it("SCVS-2.15 rejects NOASSERTION-style license ids", () => {
    const rule = rules.find((r) => r.id === "SCVS-2.15");
    const bom = baseBom({
      components: [
        {
          type: "library",
          name: "x",
          version: "1.0.0",
          purl: "pkg:npm/x@1.0.0",
          "bom-ref": "x",
          licenses: [{ license: { id: "NOASSERTION" } }],
        },
      ],
    });
    assert.strictEqual(rule.evaluate(bom).status, "fail");
  });

  it("SCVS-3.20 flags orphan components not in dep graph", () => {
    const rule = rules.find((r) => r.id === "SCVS-3.20");
    const orphan = baseBom({
      components: [
        ...baseBom().components,
        {
          type: "library",
          name: "orphan",
          version: "0.0.1",
          purl: "pkg:npm/orphan@0.0.1",
          "bom-ref": "pkg:npm/orphan@0.0.1",
          licenses: [{ license: { id: "MIT" } }],
          hashes: [{ alg: "SHA-256", content: "1" }],
        },
      ],
    });
    const res = rule.evaluate(orphan);
    assert.strictEqual(res.status, "fail");
    assert.match(res.message, /not referenced/);
  });

  it("SCVS-6.3 passes when no modified components exist", () => {
    const rule = rules.find((r) => r.id === "SCVS-6.3");
    assert.strictEqual(rule.evaluate(baseBom()).status, "pass");
  });
});

describe("CRA rules", () => {
  const rules = getCraRules();

  it("all pass on the well-formed baseline BOM", () => {
    for (const r of rules) {
      const res = r.evaluate(baseBom());
      assert.strictEqual(
        res.status,
        "pass",
        `${r.id} expected pass, got ${res.status}: ${res.message}`,
      );
    }
  });

  it("CRA-MIN-001 fails when supplier is missing", () => {
    const rule = rules.find((r) => r.id === "CRA-MIN-001");
    const bom = baseBom();
    bom.metadata.supplier = undefined;
    assert.strictEqual(rule.evaluate(bom).status, "fail");
  });

  it("CRA-MIN-002 fails when contact is empty", () => {
    const rule = rules.find((r) => r.id === "CRA-MIN-002");
    const bom = baseBom();
    bom.metadata.supplier = { name: "Acme" };
    assert.strictEqual(rule.evaluate(bom).status, "fail");
  });

  it("CRA-MIN-004 fails when dependency graph is empty", () => {
    const rule = rules.find((r) => r.id === "CRA-MIN-004");
    const bom = baseBom({ dependencies: [] });
    assert.strictEqual(rule.evaluate(bom).status, "fail");
  });

  it("CRA-MIN-008 supports both array (1.4) and object (1.5+) tool shapes", () => {
    const rule = rules.find((r) => r.id === "CRA-MIN-008");
    const legacy = baseBom();
    legacy.metadata.tools = [{ name: "old" }];
    assert.strictEqual(rule.evaluate(legacy).status, "pass");
    const missing = baseBom();
    missing.metadata.tools = undefined;
    assert.strictEqual(rule.evaluate(missing).status, "fail");
  });
});

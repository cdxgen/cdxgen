import crypto from "node:crypto";

import { assert, describe, it } from "poku";

import { generateSigningKeyPair, signBom } from "../helpers/bomSigner.js";
import {
  __test,
  getAllComplianceRules,
  getCisaAiRules,
  getCisaRules,
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
  it("exposes SCVS + CRA + CISA rules with stable ids", () => {
    const all = getAllComplianceRules();
    assert.ok(all.length >= 80, `expected >= 80 rules, got ${all.length}`);
    const scvs = getScvsRules();
    const cra = getCraRules();
    const cisa = getCisaRules();
    const cisaAi = getCisaAiRules();
    assert.strictEqual(
      scvs.length + cra.length + cisa.length + cisaAi.length,
      all.length,
    );
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

  it("CISA rule ids match the CISA-MIN-XXX convention and cite their element", () => {
    for (const r of getCisaRules()) {
      assert.match(r.id, /^CISA-MIN-\d+$/);
      assert.strictEqual(r.standard, "CISA");
      assert.strictEqual(r.category, "compliance-cisa");
      for (const ref of r.standardRefs) {
        assert.match(ref, /^CISA-2026-/, `${r.id} must cite its element`);
      }
    }
  });

  it("AI rule ids match the CISA-AI-XXX convention and cite their element", () => {
    for (const r of getCisaAiRules()) {
      assert.match(r.id, /^CISA-AI-\d+$/);
      assert.strictEqual(r.standard, "CISA");
      assert.strictEqual(r.category, "compliance-cisa-ai");
      for (const ref of r.standardRefs) {
        assert.match(ref, /^CISA-2026-AI-/, `${r.id} must cite its element`);
      }
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

describe("SCVS manual controls with predictive audit assistance", () => {
  it("includes cdx-audit guidance for mapped manual-review controls", () => {
    const mappedRuleIds = [
      "SCVS-2.8",
      "SCVS-3.3",
      "SCVS-3.6",
      "SCVS-4.10",
      "SCVS-4.11",
      "SCVS-6.1",
      "SCVS-6.2",
    ];

    mappedRuleIds.forEach((ruleId) => {
      const rule = getScvsRules().find((entry) => entry.id === ruleId);
      assert.ok(rule, `missing rule ${ruleId}`);
      const result = rule.evaluate(baseBom());
      assert.strictEqual(result.status, "manual");
      assert.match(
        result.mitigation,
        /cdx-audit --bom bom\.json --scope required/,
      );
      assert.strictEqual(
        result.evidence?.suggestedCommand,
        "cdx-audit --bom bom.json --scope required",
      );
      assert.strictEqual(result.evidence?.reviewMode, "manual-with-cdx-audit");
    });
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
/**
 * A BOM that satisfies every automatable CISA 2026 minimum elements rule, so
 * each rule can be shown failing by removing exactly its own element. The
 * target component carries the component elements too, because the CISA
 * component elements cover it as well as the subcomponents.
 */
function cisaBom(overrides = {}) {
  return baseBom({
    version: 1,
    signature: { algorithm: "ES256", keyId: "k1", value: "abc123" },
    metadata: {
      ...baseBom().metadata,
      authors: [{ name: "Acme SBOM Team", email: "sbom@example.com" }],
      lifecycles: [{ phase: "build" }],
      component: {
        ...baseBom().metadata.component,
        purl: "pkg:generic/demo@1.0.0",
        manufacturer: { name: "Acme Corporation" },
        licenses: [{ license: { id: "Apache-2.0" } }],
      },
    },
    components: [
      {
        ...baseBom().components[0],
        hashes: [{ alg: "SHA-256", content: "a".repeat(64) }],
        supplier: { name: "OpenJS Foundation" },
      },
    ],
    ...overrides,
  });
}

/**
 * The seventeen data fields of Appendix A, Table 1 and the six practices and
 * processes of the CISA 2026 minimum elements, as the standardRefs name them.
 */
const CISA_2026_ELEMENTS = [
  "CISA-2026-COMPONENT-DEPENDENCY-RELATIONSHIP",
  "CISA-2026-COMPONENT-HASH-ALGORITHM",
  "CISA-2026-COMPONENT-HASH-VALUE",
  "CISA-2026-COMPONENT-IDENTIFIERS",
  "CISA-2026-COMPONENT-LICENSE",
  "CISA-2026-COMPONENT-NAME",
  "CISA-2026-COMPONENT-PRODUCER",
  "CISA-2026-COMPONENT-VERSION",
  "CISA-2026-SBOM-AUTHOR",
  "CISA-2026-SBOM-AUTHOR-SIGNATURE",
  "CISA-2026-SBOM-DATA-FORMAT-NAME",
  "CISA-2026-SBOM-DATA-FORMAT-VERSION",
  "CISA-2026-SBOM-GENERATION-CONTEXT",
  "CISA-2026-SBOM-TIMESTAMP",
  "CISA-2026-SBOM-TOOL-NAME",
  "CISA-2026-SBOM-TOOL-VERSION",
  "CISA-2026-SBOM-VERSION",
  "CISA-2026-PRACTICE-ACCOMMODATION-OF-UPDATES",
  "CISA-2026-PRACTICE-COVERAGE",
  "CISA-2026-PRACTICE-DISTRIBUTION-AND-DELIVERY",
  "CISA-2026-PRACTICE-UNKNOWN-INFORMATION",
  "CISA-2026-PRACTICE-FREQUENCY",
  "CISA-2026-PRACTICE-MACHINE-PROCESSABLE-DATA",
];

/**
 * The elements of the System Level Properties, Models, Datasets,
 * Infrastructure, Security Properties and KPI clusters of the G7 SBOM for AI
 * minimum elements that the cisa-ai rules cite. System components and
 * infrastructure software are the BOM's component inventory itself, and the
 * Metadata cluster repeats the general elements the cisa rules cite.
 */
const CISA_AI_ELEMENTS = [
  "CISA-2026-AI-SYSTEM-NAME",
  "CISA-2026-AI-SYSTEM-PRODUCER",
  "CISA-2026-AI-SYSTEM-VERSION",
  "CISA-2026-AI-SYSTEM-TIMESTAMP",
  "CISA-2026-AI-SYSTEM-DATA-FLOW",
  "CISA-2026-AI-SYSTEM-DATA-USAGE",
  "CISA-2026-AI-SYSTEM-INPUT-OUTPUT-PROPERTIES",
  "CISA-2026-AI-SYSTEM-INTENDED-APPLICATION-AREA",
  "CISA-2026-AI-MODEL-NAME",
  "CISA-2026-AI-MODEL-IDENTIFIER",
  "CISA-2026-AI-MODEL-VERSION",
  "CISA-2026-AI-MODEL-TIMESTAMP",
  "CISA-2026-AI-MODEL-PRODUCER",
  "CISA-2026-AI-MODEL-DESCRIPTION",
  "CISA-2026-AI-MODEL-HASH-VALUE",
  "CISA-2026-AI-MODEL-HASH-ALGORITHM",
  "CISA-2026-AI-MODEL-PROPERTIES",
  "CISA-2026-AI-MODEL-INPUT-OUTPUT-PROPERTIES",
  "CISA-2026-AI-MODEL-TRAINING-PROPERTIES",
  "CISA-2026-AI-MODEL-LICENSE",
  "CISA-2026-AI-MODEL-EXTERNAL-REFERENCES",
  "CISA-2026-AI-DATASET-NAME",
  "CISA-2026-AI-DATASET-DESCRIPTION",
  "CISA-2026-AI-DATASET-CONTENT",
  "CISA-2026-AI-DATASET-IDENTIFIER",
  "CISA-2026-AI-DATASET-HASH",
  "CISA-2026-AI-DATASET-PROVENANCE",
  "CISA-2026-AI-DATASET-STATISTICAL-PROPERTIES",
  "CISA-2026-AI-DATASET-SENSITIVITY",
  "CISA-2026-AI-DATASET-DEPENDENCY-RELATIONSHIP",
  "CISA-2026-AI-DATASET-LICENSE",
  "CISA-2026-AI-INFRASTRUCTURE-HARDWARE",
  "CISA-2026-AI-SECURITY-CONTROLS",
  "CISA-2026-AI-SECURITY-COMPLIANCE",
  "CISA-2026-AI-CYBERSECURITY-POLICY-INFORMATION",
  "CISA-2026-AI-VULNERABILITY-REFERENCING",
  "CISA-2026-AI-SECURITY-METRICS",
  "CISA-2026-AI-OPERATIONAL-PERFORMANCE-KPIS",
];

describe("CISA element coverage", () => {
  it("the cisa rules cite every data field and practice of the guidance", () => {
    const cited = getCisaRules().flatMap((r) => r.standardRefs);
    assert.deepStrictEqual(
      [...new Set(cited)].sort(),
      [...CISA_2026_ELEMENTS].sort(),
    );
  });

  it("the cisa-ai rules cite every AI-specific element of the guidance", () => {
    const cited = getCisaAiRules().flatMap((r) => r.standardRefs);
    assert.deepStrictEqual(
      [...new Set(cited)].sort(),
      [...CISA_AI_ELEMENTS].sort(),
    );
  });
});

describe("CISA 2026 rules", () => {
  const rules = getCisaRules();
  const rule = (id) => rules.find((r) => r.id === id);

  it("all automatable rules pass on the fully populated BOM", () => {
    for (const r of rules.filter((candidate) => candidate.automatable)) {
      const res = r.evaluate(cisaBom());
      assert.strictEqual(
        res.status,
        "pass",
        `${r.id} expected pass, got ${res.status}: ${res.message}`,
      );
    }
  });

  it("CISA-MIN-001 reads metadata.authors and metadata.manufacturer", () => {
    const none = cisaBom();
    none.metadata.authors = undefined;
    assert.strictEqual(rule("CISA-MIN-001").evaluate(none).status, "fail");
    // CycloneDX has no singular metadata.author.
    none.metadata.author = { name: "Not A Field" };
    assert.strictEqual(rule("CISA-MIN-001").evaluate(none).status, "fail");
    const manufacturer = cisaBom();
    manufacturer.metadata.authors = undefined;
    manufacturer.metadata.manufacturer = { name: "Acme SBOM Team" };
    assert.strictEqual(
      rule("CISA-MIN-001").evaluate(manufacturer).status,
      "pass",
    );
  });

  it("CISA-MIN-001 does not accept the cdxgen default author on its own", () => {
    const defaultOnly = cisaBom();
    defaultOnly.metadata.authors = [{ name: "OWASP Foundation" }];
    const res = rule("CISA-MIN-001").evaluate(defaultOnly);
    assert.strictEqual(res.status, "fail");
    assert.match(res.message, /--author/);
    assert.match(res.mitigation, /--author/);
    const both = cisaBom();
    both.metadata.authors = [
      { name: "OWASP Foundation" },
      { name: "Acme SBOM Team" },
    ];
    assert.strictEqual(rule("CISA-MIN-001").evaluate(both).status, "pass");
  });

  it("CISA-MIN-002 accepts the signatures cdx-sign writes", () => {
    const { privateKey } = generateSigningKeyPair("ES256");
    const signed = signBom(baseBom(), { privateKey, algorithm: "ES256" });
    assert.strictEqual(typeof signed.signature.value, "string");
    assert.strictEqual(rule("CISA-MIN-002").evaluate(signed).status, "pass");
    const signers = signBom(baseBom(), {
      privateKey,
      algorithm: "ES256",
      mode: "signers",
    });
    assert.ok(Array.isArray(signers.signature.signers));
    assert.strictEqual(rule("CISA-MIN-002").evaluate(signers).status, "pass");
    const chain = signBom(baseBom(), {
      privateKey,
      algorithm: "ES256",
      mode: "chain",
    });
    assert.ok(Array.isArray(chain.signature.chain));
    assert.strictEqual(rule("CISA-MIN-002").evaluate(chain).status, "pass");
  });

  it("CISA-MIN-002 fails when unsigned or signed with an HMAC", () => {
    const unsigned = cisaBom();
    unsigned.signature = undefined;
    const res = rule("CISA-MIN-002").evaluate(unsigned);
    assert.strictEqual(res.status, "fail");
    assert.match(res.mitigation, /cdx-sign/);
    const noValue = cisaBom({ signature: { algorithm: "ES256" } });
    assert.strictEqual(rule("CISA-MIN-002").evaluate(noValue).status, "fail");
    const hmac = signBom(baseBom(), {
      privateKey: crypto.randomBytes(64),
      algorithm: "HS256",
    });
    const hmacRes = rule("CISA-MIN-002").evaluate(hmac);
    assert.strictEqual(hmacRes.status, "fail");
    assert.match(hmacRes.message, /HS256/);
  });

  it("CISA-MIN-003 reads bomFormat and the 2.0 specFormat", () => {
    const foreign = cisaBom({ bomFormat: "SPDX" });
    assert.strictEqual(rule("CISA-MIN-003").evaluate(foreign).status, "fail");
    const legacy = cisaBom({ specVersion: "1.3" });
    assert.strictEqual(rule("CISA-MIN-003").evaluate(legacy).status, "pass");
    const unpublished = cisaBom({ specVersion: "1.9" });
    assert.strictEqual(
      rule("CISA-MIN-003").evaluate(unpublished).status,
      "fail",
    );
    const missing = cisaBom({ specVersion: undefined });
    assert.strictEqual(rule("CISA-MIN-003").evaluate(missing).status, "fail");
    const modern = cisaBom({ specVersion: "2.0" });
    modern.bomFormat = undefined;
    modern.specFormat = "CycloneDX";
    assert.strictEqual(rule("CISA-MIN-003").evaluate(modern).status, "pass");
  });

  it("CISA-MIN-004 accepts a lifecycle phase or a named lifecycle", () => {
    const none = cisaBom();
    none.metadata.lifecycles = undefined;
    assert.strictEqual(rule("CISA-MIN-004").evaluate(none).status, "fail");
    const bogus = cisaBom();
    bogus.metadata.lifecycles = [{ phase: "compile" }];
    assert.strictEqual(rule("CISA-MIN-004").evaluate(bogus).status, "fail");
    const named = cisaBom();
    named.metadata.lifecycles = [{ name: "after build, from release images" }];
    assert.strictEqual(rule("CISA-MIN-004").evaluate(named).status, "pass");
  });

  it("CISA-MIN-005 requires a tool name and version but accepts an explicit unknown", () => {
    const empty = cisaBom();
    empty.metadata.tools = { components: [] };
    assert.strictEqual(rule("CISA-MIN-005").evaluate(empty).status, "fail");
    const unversioned = cisaBom();
    unversioned.metadata.tools = { components: [{ name: "cdxgen" }] };
    assert.strictEqual(
      rule("CISA-MIN-005").evaluate(unversioned).status,
      "fail",
    );
    const both = cisaBom();
    both.metadata.tools = { components: [{ version: "1.0" }, { name: "x" }] };
    const res = rule("CISA-MIN-005").evaluate(both);
    assert.match(res.message, /without a name/);
    assert.match(res.message, /without a version/);
    const unknown = cisaBom();
    unknown.metadata.tools = {
      components: [{ name: "cdxgen", version: "unknown" }],
    };
    assert.strictEqual(rule("CISA-MIN-005").evaluate(unknown).status, "pass");
    const legacyArray = cisaBom();
    legacyArray.metadata.tools = [{ name: "cdxgen", version: "8.0.0" }];
    assert.strictEqual(
      rule("CISA-MIN-005").evaluate(legacyArray).status,
      "pass",
    );
  });

  it("CISA-MIN-006 wants an integer SBOM version and an RFC 9562 serial number", () => {
    for (const version of [undefined, 0, "1", 1.5]) {
      const bom = cisaBom({ version });
      assert.strictEqual(
        rule("CISA-MIN-006").evaluate(bom).status,
        "fail",
        `version ${version}`,
      );
    }
    const badSerial = cisaBom({ serialNumber: "abc-123" });
    assert.strictEqual(rule("CISA-MIN-006").evaluate(badSerial).status, "fail");
    const noSerial = cisaBom({ serialNumber: undefined });
    assert.strictEqual(rule("CISA-MIN-006").evaluate(noSerial).status, "pass");
  });

  it("CISA-MIN-007 accepts RFC 3339 and RFC 9557 forms", () => {
    for (const ts of [
      "2026-07-29T12:00:00Z",
      "2026-07-29t12:00:00.123z",
      "2026-07-29T12:00:00+05:30",
      "2026-07-29T12:00:00Z[Europe/Berlin]",
      "2026-07-29T12:00:00+02:00[Europe/Berlin][u-ca=gregory]",
      "2024-02-29T00:00:00Z",
      "2016-12-31T23:59:60Z",
    ]) {
      const bom = cisaBom();
      bom.metadata.timestamp = ts;
      assert.strictEqual(rule("CISA-MIN-007").evaluate(bom).status, "pass", ts);
    }
  });

  it("CISA-MIN-007 rejects timestamps outside RFC 9557", () => {
    for (const ts of [
      undefined,
      "2026-07-29",
      "2026-07-29T12:00:00",
      "2026-07-29 12:00:00Z",
      "29/07/2026",
      "2026-02-30T00:00:00Z",
      "2025-02-29T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-07-29T24:00:00Z",
      "2026-07-29T12:60:00Z",
      "2026-07-29T12:00:61Z",
      "2026-07-29T12:00:00+24:00",
      "2026-07-29T12:00:00Z[]",
    ]) {
      const bom = cisaBom();
      bom.metadata.timestamp = ts;
      assert.strictEqual(
        rule("CISA-MIN-007").evaluate(bom).status,
        "fail",
        String(ts),
      );
    }
  });

  it("the component rules judge the target component", () => {
    const strips = [
      ["CISA-MIN-008", (c) => (c.name = undefined)],
      ["CISA-MIN-009", (c) => (c.version = undefined)],
      ["CISA-MIN-010", (c) => (c.manufacturer = undefined)],
      ["CISA-MIN-011", (c) => (c.purl = undefined)],
      ["CISA-MIN-013", (c) => (c.licenses = undefined)],
    ];
    for (const [id, strip] of strips) {
      const bom = cisaBom();
      strip(bom.metadata.component);
      const res = rule(id).evaluate(bom);
      assert.strictEqual(res.status, "fail", `${id}: ${res.message}`);
      assert.match(res.message, /1\/2 component/, id);
    }
  });

  it("CISA-MIN-008 fails when the BOM names no target component", () => {
    const bom = cisaBom();
    bom.metadata.component = undefined;
    const res = rule("CISA-MIN-008").evaluate(bom);
    assert.strictEqual(res.status, "fail");
    assert.match(res.message, /metadata\.component/);
  });

  it("the component rules include firmware but leave data and files out", () => {
    const bom = cisaBom();
    bom.components.push(
      { type: "firmware", name: "bios", "bom-ref": "fw" },
      { type: "data", name: "config" },
      { type: "file", name: "a.so" },
    );
    const res = rule("CISA-MIN-009").evaluate(bom);
    assert.strictEqual(res.status, "fail");
    assert.match(res.message, /^1\/3 component/);
  });

  it("CISA-MIN-009 accepts an explicit unknown component version", () => {
    const bom = cisaBom();
    bom.components[0].version = undefined;
    assert.strictEqual(rule("CISA-MIN-009").evaluate(bom).status, "fail");
    bom.components[0].version = "unknown";
    assert.strictEqual(rule("CISA-MIN-009").evaluate(bom).status, "pass");
  });

  it("CISA-MIN-010 accepts manufacturer, supplier, authors or an unknown provenance", () => {
    const strip = (c) => {
      c.supplier = undefined;
      c.manufacturer = undefined;
    };
    const none = cisaBom();
    strip(none.components[0]);
    assert.strictEqual(rule("CISA-MIN-010").evaluate(none).status, "fail");
    for (const fill of [
      (c) => (c.manufacturer = { name: "OpenJS Foundation" }),
      (c) => (c.supplier = { name: "unknown" }),
      (c) => (c.authors = [{ name: "John-David Dalton" }]),
      (c) => (c.author = "John-David Dalton"),
    ]) {
      const bom = cisaBom();
      strip(bom.components[0]);
      fill(bom.components[0]);
      assert.strictEqual(rule("CISA-MIN-010").evaluate(bom).status, "pass");
    }
  });

  it("CISA-MIN-011 accepts purl, cpe, swid, OmniBOR and SWHID identifiers", () => {
    const none = cisaBom();
    none.components[0].purl = undefined;
    assert.strictEqual(rule("CISA-MIN-011").evaluate(none).status, "fail");
    for (const fill of [
      (c) => (c.cpe = "cpe:2.3:a:lodash:lodash:4.17.21:*:*:*:*:*:*:*"),
      (c) => (c.swid = { tagId: "lodash-4.17.21", name: "lodash" }),
      (c) => (c.omniborId = [`gitoid:blob:sha1:${"a".repeat(40)}`]),
      (c) => (c.swhid = [`swh:1:rev:${"a".repeat(40)}`]),
    ]) {
      const bom = cisaBom();
      bom.components[0].purl = undefined;
      fill(bom.components[0]);
      assert.strictEqual(rule("CISA-MIN-011").evaluate(bom).status, "pass");
    }
  });

  it("CISA-MIN-012 rejects weak algorithms and non-hex contents", () => {
    for (const hashes of [
      undefined,
      [{ alg: "MD5", content: "a".repeat(32) }],
      [{ alg: "SHA-1", content: "a".repeat(40) }],
      [{ alg: "SHA-256", content: "not-hex!" }],
    ]) {
      const bom = cisaBom();
      bom.components[0].hashes = hashes;
      assert.strictEqual(rule("CISA-MIN-012").evaluate(bom).status, "fail");
    }
    const mixed = cisaBom();
    mixed.components[0].hashes = [
      { alg: "SHA-1", content: "a".repeat(40) },
      { alg: "SHA-512", content: "b".repeat(128) },
    ];
    assert.strictEqual(rule("CISA-MIN-012").evaluate(mixed).status, "pass");
  });

  it("CISA-MIN-012 judges the target hash only after build", () => {
    const beforeBuild = cisaBom();
    assert.strictEqual(beforeBuild.metadata.component.hashes, undefined);
    assert.strictEqual(
      rule("CISA-MIN-012").evaluate(beforeBuild).status,
      "pass",
    );
    const afterBuild = cisaBom();
    afterBuild.metadata.lifecycles = [{ phase: "post-build" }];
    const res = rule("CISA-MIN-012").evaluate(afterBuild);
    assert.strictEqual(res.status, "fail");
    assert.match(res.message, /^1\/2 component/);
    afterBuild.metadata.component.hashes = [
      { alg: "SHA-256", content: "c".repeat(64) },
    ];
    assert.strictEqual(
      rule("CISA-MIN-012").evaluate(afterBuild).status,
      "pass",
    );
  });

  it("CISA-MIN-013 fails without licenses and accepts an unknown name", () => {
    const bom = cisaBom();
    bom.components[0].licenses = undefined;
    assert.strictEqual(rule("CISA-MIN-013").evaluate(bom).status, "fail");
    bom.components[0].licenses = [{ license: { name: "unknown" } }];
    assert.strictEqual(rule("CISA-MIN-013").evaluate(bom).status, "pass");
  });

  it("CISA-MIN-014 needs an edge leading to every component", () => {
    const empty = cisaBom({ dependencies: [] });
    assert.strictEqual(rule("CISA-MIN-014").evaluate(empty).status, "fail");
    // A component with only its own node, and no node depending on it, is
    // not related to the target.
    const flat = cisaBom({
      dependencies: [
        { ref: "pkg:generic/demo@1.0.0", dependsOn: [] },
        { ref: "pkg:npm/lodash@4.17.21", dependsOn: [] },
      ],
    });
    const res = rule("CISA-MIN-014").evaluate(flat);
    assert.strictEqual(res.status, "fail");
    assert.match(res.message, /^1\/1 component/);
    const provided = cisaBom({
      dependencies: [
        { ref: "pkg:generic/demo@1.0.0", provides: ["pkg:npm/lodash@4.17.21"] },
      ],
    });
    assert.strictEqual(rule("CISA-MIN-014").evaluate(provided).status, "pass");
  });

  it("the practices that need process evidence stay manual", () => {
    for (const id of [
      "CISA-MIN-015",
      "CISA-MIN-016",
      "CISA-MIN-017",
      "CISA-MIN-018",
    ]) {
      assert.strictEqual(rule(id).automatable, false, id);
      assert.strictEqual(rule(id).evaluate(cisaBom()).status, "manual", id);
      assert.strictEqual(rule(id).severity, "info", id);
    }
  });
});

/**
 * A BOM that satisfies every automatable AI element rule: a model component
 * with the full set of Models-cluster fields and a dataset component with the
 * Datasets-cluster fields the rules read, on top of the base metadata.
 */
function aiBom(overrides = {}) {
  return cisaBom({
    components: [
      ...cisaBom().components,
      {
        type: "machine-learning-model",
        name: "zephyr-7b-beta",
        version: "abc123",
        group: "HuggingFaceH4",
        purl: "pkg:huggingface/HuggingFaceH4/zephyr-7b-beta@abc123",
        "bom-ref": "pkg:huggingface/HuggingFaceH4/zephyr-7b-beta@abc123",
        supplier: { name: "HuggingFaceH4" },
        description: "Helpful assistant model",
        licenses: [{ license: { id: "MIT" } }],
        hashes: [{ alg: "SHA-256", content: "a".repeat(64) }],
        externalReferences: [
          {
            type: "website",
            url: "https://huggingface.co/HuggingFaceH4/zephyr-7b-beta",
          },
        ],
        modelCard: {
          modelParameters: {
            task: "text-generation",
            architectureFamily: "mistral",
            modelArchitecture: "MistralForCausalLM",
            inputs: [{ format: "text" }],
            outputs: [{ format: "text" }],
          },
        },
      },
      {
        type: "data",
        name: "ultrachat_200k",
        purl: "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets",
        "bom-ref":
          "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets",
        supplier: { name: "HuggingFaceH4" },
        description: "Filtered UltraChat dialogues used for fine-tuning",
        licenses: [{ license: { id: "MIT" } }],
        hashes: [{ alg: "SHA-256", content: "b".repeat(64) }],
        data: [
          {
            type: "dataset",
            name: "HuggingFaceH4/ultrachat_200k",
            contents: {
              url: "https://huggingface.co/datasets/HuggingFaceH4/ultrachat_200k",
            },
          },
        ],
      },
    ],
    ...overrides,
  });
}

describe("CISA and G7 AI SBOM rules", () => {
  const rules = getCisaAiRules();
  const rule = (id) => rules.find((r) => r.id === id);

  it("all automatable rules pass on the AI BOM", () => {
    for (const r of rules.filter((candidate) => candidate.automatable)) {
      const res = r.evaluate(aiBom());
      assert.strictEqual(
        res.status,
        "pass",
        `${r.id} expected pass, got ${res.status}: ${res.message}`,
      );
    }
  });

  it("no AI rule fails on a BOM without AI components", () => {
    assert.strictEqual(rules.length, 16);
    for (const r of rules) {
      const res = r.evaluate(cisaBom());
      assert.strictEqual(res.status, "pass", `${r.id}: ${res.message}`);
      assert.match(res.message, /do not apply/, r.id);
    }
    // A plain BOM whose root has no version or producer still passes the
    // system rules, which only apply to AI systems.
    const bare = cisaBom();
    bare.metadata.component.version = undefined;
    bare.metadata.supplier = undefined;
    bare.metadata.component.manufacturer = undefined;
    for (const id of ["CISA-AI-001", "CISA-AI-002"]) {
      const res = rule(id).evaluate(bare);
      assert.strictEqual(res.status, "pass", `${id}: ${res.message}`);
    }
  });

  it("the system rules apply to a BOM with only a dataset component", () => {
    const datasetOnly = aiBom();
    datasetOnly.components = datasetOnly.components.filter(
      (c) => c.type !== "machine-learning-model",
    );
    datasetOnly.metadata.supplier = undefined;
    datasetOnly.metadata.component.manufacturer = undefined;
    const res = rule("CISA-AI-002").evaluate(datasetOnly);
    assert.strictEqual(res.status, "fail");
  });

  it("CISA-AI-001 fails when the system component has no version", () => {
    const bom = aiBom();
    bom.metadata.component.version = undefined;
    assert.strictEqual(rule("CISA-AI-001").evaluate(bom).status, "fail");
    const unknown = aiBom();
    unknown.metadata.component.version = "unknown";
    assert.strictEqual(rule("CISA-AI-001").evaluate(unknown).status, "pass");
  });

  it("CISA-AI-002 reads the system producer from metadata or the component", () => {
    const withoutProducer = () => {
      const bom = aiBom();
      bom.metadata.supplier = undefined;
      bom.metadata.component.manufacturer = undefined;
      return bom;
    };
    const res = rule("CISA-AI-002").evaluate(withoutProducer());
    assert.strictEqual(res.status, "fail");
    assert.match(res.mitigation, /does not populate/);
    assert.doesNotMatch(res.mitigation, /--author/);
    for (const fill of [
      (bom) => (bom.metadata.supplier = { name: "Acme AI" }),
      (bom) => (bom.metadata.manufacture = { name: "Acme AI" }),
      (bom) => (bom.metadata.component.supplier = { name: "Acme AI" }),
      (bom) => (bom.metadata.component.manufacturer = { name: "Acme AI" }),
      (bom) => (bom.metadata.component.authors = [{ name: "Jane Doe" }]),
    ]) {
      const bom = withoutProducer();
      fill(bom);
      assert.strictEqual(rule("CISA-AI-002").evaluate(bom).status, "pass");
    }
    // metadata.manufacturer names the BOM creator from 1.6, not the system
    // producer, so it does not satisfy the element.
    const bomCreator = withoutProducer();
    bomCreator.metadata.manufacturer = { name: "Acme SBOM Team" };
    assert.strictEqual(rule("CISA-AI-002").evaluate(bomCreator).status, "fail");
  });

  it("CISA-AI-004 accepts the creator recorded as manufacturer", () => {
    const bom = aiBom();
    bom.components[1].supplier = undefined;
    assert.strictEqual(rule("CISA-AI-004").evaluate(bom).status, "fail");
    bom.components[1].manufacturer = { name: "Mistral AI" };
    assert.strictEqual(rule("CISA-AI-004").evaluate(bom).status, "pass");
  });

  it("each model rule fails when its own element is removed", () => {
    const checks = [
      ["CISA-AI-003", (c) => (c.version = undefined)],
      ["CISA-AI-005", (c) => (c.purl = undefined)],
      ["CISA-AI-006", (c) => (c.hashes = undefined)],
      ["CISA-AI-007", (c) => (c.licenses = undefined)],
      [
        "CISA-AI-008",
        (c) => {
          c.description = undefined;
          c.modelCard = undefined;
        },
      ],
      [
        "CISA-AI-012",
        (c) => {
          c.modelCard.modelParameters.architectureFamily = undefined;
          c.modelCard.modelParameters.modelArchitecture = undefined;
        },
      ],
      ["CISA-AI-013", (c) => (c.modelCard.modelParameters.outputs = [])],
      ["CISA-AI-014", (c) => (c.externalReferences = undefined)],
    ];
    for (const [id, strip] of checks) {
      const bom = aiBom();
      strip(bom.components[1]);
      const res = rule(id).evaluate(bom);
      assert.strictEqual(res.status, "fail", `${id}: ${res.message}`);
      assert.match(res.message, /^1\/1 model/, id);
    }
  });

  it("each dataset rule fails when its own element is removed", () => {
    const checks = [
      [
        "CISA-AI-009",
        (c) => {
          c.purl = undefined;
          // Keep the dataset entry so the component is still recognised as
          // one, while removing every URL that could identify it.
          c.data = [{ type: "dataset", name: "HuggingFaceH4/ultrachat_200k" }];
        },
      ],
      ["CISA-AI-010", (c) => (c.licenses = undefined)],
      ["CISA-AI-015", (c) => (c.description = undefined)],
      ["CISA-AI-016", (c) => (c.hashes = undefined)],
    ];
    for (const [id, strip] of checks) {
      const bom = aiBom();
      strip(bom.components[2]);
      const res = rule(id).evaluate(bom);
      assert.strictEqual(res.status, "fail", `${id}: ${res.message}`);
      assert.match(res.message, /^1\/1 dataset/, id);
    }
  });

  it("CISA-AI-011 stays a manual-review item", () => {
    assert.strictEqual(rule("CISA-AI-011").automatable, false);
    assert.strictEqual(rule("CISA-AI-011").evaluate(aiBom()).status, "manual");
  });
});

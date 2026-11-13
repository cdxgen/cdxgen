import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { assert, describe, it } from "poku";

import { assertRefIntegrity } from "../../test/helpers/cyclonedx20RefIntegrity.js";
import { copyIntoGitRepo } from "../../test/helpers/gitFixture.js";
import { createBom } from "../cli/index.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { sortBomCollections } from "../stages/postgen/sortBom.js";
import { applySpecVersionCompatibility } from "../stages/postgen/specVersionCompat.js";
import { validateBom } from "../validator/bomValidator.js";
import precompiled20 from "../validator/generated/validate-2.0.mjs";
import {
  CDX20_INTERNAL_SECTIONS_KEY,
  loadBomForAnalysis,
  readCycloneDx20,
  renderCycloneDx20,
  renderCycloneDx20WithReport,
} from "./cyclonedx20.js";
import { MAX_READ_DEPTH } from "./cyclonedx20ReadContext.js";
import {
  ALGORITHM_PROPERTY_ENUMS_1X,
  COMPONENT_TYPES_1X,
  EXTERNAL_REFERENCE_TYPES_1X,
  IDENTITY_FIELDS_1X,
  IDENTITY_TECHNIQUES_1X,
  PROTOCOL_TYPES_1X,
  SCORE_METHODS_1X,
} from "./cyclonedx20Tables.js";

const UPSTREAM_DIR = join("test", "data", "cyclonedx-2.0-upstream");
const READ_FIXTURE_DIR = join("test", "data", "cyclonedx-2.0-read");
const VALID_FILES = readdirSync(UPSTREAM_DIR)
  .filter((name) => name.startsWith("valid-") && name.endsWith(".json"))
  .sort();

const readJson = (path) => JSON.parse(readFileSync(path, "utf-8"));
const readUpstream = (name) => readJson(join(UPSTREAM_DIR, name));

/**
 * The 2.0 → 1.7 path of `cdx-convert --to 1.7`: read into the internal
 * model, apply the 1.x compatibility pass, sort.
 */
function downgradeTo17(bom20) {
  const { internalBom, losses } = readCycloneDx20(bom20);
  const bom17 = applySpecVersionCompatibility(structuredClone(internalBom), {
    specVersion: "1.7",
  });
  sortBomCollections(bom17);
  return { bom17, losses, internalBom };
}

/** Resolve an RFC 6901 JSON pointer; `{found: false}` when it does not. */
function resolvePointer(doc, pointer) {
  if (pointer === "") {
    return { found: true, value: doc };
  }
  if (!pointer.startsWith("/")) {
    return { found: false };
  }
  let node = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (node === null || typeof node !== "object") {
      return { found: false };
    }
    const key = Array.isArray(node) ? Number(token) : token;
    if (!Object.hasOwn(node, key)) {
      return { found: false };
    }
    node = node[key];
  }
  return { found: true, value: node };
}

// The 1.7 output of these documents is schema-valid, but cdxgen's deep
// checks reject content the source document itself has. The list, with a
// reason per document, is shared with the cdx-convert corpus smoke test.
const { $comment: _deepCheckComment, ...DEEP_CHECK_EXCEPTIONS } = readJson(
  join(READ_FIXTURE_DIR, "deep-check-exceptions.json"),
);

// Documents whose content has no 1.x home at all, so even the schema check
// fails at 1.7. Each must report at least one loss. None today.
const NO_1X_HOME = {};

describe("readCycloneDx20() 2.0 → 1.7 over the upstream corpus", () => {
  it("downgrades every upstream valid document to a valid 1.7 BOM", async () => {
    assert.strictEqual(VALID_FILES.length, 152);
    const deepFailures = [];
    for (const name of VALID_FILES) {
      const { bom17, losses } = downgradeTo17(readUpstream(name));
      assert.strictEqual(bom17.specVersion, "1.7", `${name}: specVersion`);
      assert.ok(
        !Object.hasOwn(bom17, CDX20_INTERNAL_SECTIONS_KEY),
        `${name}: the internal sections key never reaches 1.x`,
      );
      assert.ok(
        !`${bom17.$schema ?? ""}`.includes("2.0"),
        `${name}: no 2.0 $schema in 1.x output`,
      );
      if (Object.hasOwn(NO_1X_HOME, name)) {
        assert.ok(losses.length > 0, `${name}: ${NO_1X_HOME[name]}`);
        continue;
      }
      assert.ok(
        await validateBom(bom17, { deep: false }),
        `${name}: schema-valid 1.7`,
      );
      if (!(await validateBom(bom17))) {
        deepFailures.push(name);
      }
    }
    assert.deepStrictEqual(
      deepFailures,
      Object.keys(DEEP_CHECK_EXCEPTIONS).sort(),
      "the deep-check exceptions changed; update DEEP_CHECK_EXCEPTIONS only with a reason",
    );
  });

  it("reports every loss with an RFC 6901 pointer into the input", () => {
    for (const name of VALID_FILES) {
      const bom = readUpstream(name);
      for (const { pointer, reason } of readCycloneDx20(bom).losses) {
        assert.ok(typeof reason === "string" && reason.length > 0);
        assert.ok(
          resolvePointer(bom, pointer).found,
          `${name}: loss pointer '${pointer}' (${reason}) resolves`,
        );
      }
    }
  });

  it("reports a loss for every document whose round trip is not identical", () => {
    for (const name of VALID_FILES) {
      const bom = readUpstream(name);
      const { internalBom, losses } = readCycloneDx20(bom);
      const out = renderCycloneDx20(internalBom);
      // Post-quantum risks cdxgen derives for a document without `risks`
      // (#4592) are an addition, not a loss.
      if (bom.risks === undefined && out.risks !== undefined) {
        assert.ok(
          out.risks.risks.every((risk) => risk.refId.startsWith("risk-pqc-")),
          `${name} gains only derived risks`,
        );
        delete out.risks;
      }
      if (!isDeepStrictEqual(out, bom)) {
        assert.ok(losses.length > 0, `${name} changes without a loss`);
      }
    }
  });
});

describe("readCycloneDx20() losses", () => {
  it("escapes ~ and / in loss pointers", () => {
    const bom = {
      specFormat: "CycloneDX",
      specVersion: "2.0",
      "ext:example.com:a/b~c": "value",
    };
    const { losses } = readCycloneDx20(bom);
    assert.deepStrictEqual(
      losses.map((loss) => loss.pointer),
      ["/ext:example.com:a~1b~0c"],
    );
    assert.ok(resolvePointer(bom, losses[0].pointer).found);
  });

  it("reports unmapped members with indexed pointers, through the allowlists", () => {
    const bom = readJson(join(READ_FIXTURE_DIR, "reverse.json"));
    assert.ok(precompiled20(bom), "the fixture is valid 2.0");
    const { losses } = readCycloneDx20(bom);
    const component = "/inventories/0/components/0";
    assert.deepStrictEqual(
      losses.map((loss) => loss.pointer),
      [
        "/metadata/manufacturer/origins",
        `${component}/parties/0/organization/url/1/name`,
        `${component}/parties/0/organization/addresses/1`,
        `${component}/parties/0/organization/legalName`,
        `${component}/parties/1/person/phone/1`,
        `${component}/parties/2/roles/0`,
        `${component}/evidence/identity/0/methods/0/description`,
        `${component}/evidence/identity/0/methods/0/result`,
        `${component}/measurements`,
        "/inventories/0/components/1/cryptoProperties/algorithmProperties/implementationPlatform/1",
        "/inventories/0/components/1/cryptoProperties/algorithmProperties/cryptoFunctions/2",
        "/inventories/0/components/2/cryptoProperties/relatedCryptoMaterialProperties/securedBy/algorithmRef/1",
        "/$comment",
      ],
    );
    for (const { pointer } of losses) {
      assert.ok(resolvePointer(bom, pointer).found, pointer);
    }
  });

  it("is stable over a second read and render", () => {
    const bom = readJson(join(READ_FIXTURE_DIR, "reverse.json"));
    const { internalBom } = readCycloneDx20(bom);
    const again = readCycloneDx20(renderCycloneDx20(internalBom));
    assert.ok(isDeepStrictEqual(renderCycloneDx20(again.internalBom), bom));
  });
});

describe("readCycloneDx20() reverse converters", () => {
  const bom20 = readJson(join(READ_FIXTURE_DIR, "reverse.json"));
  const { bom17, internalBom } = downgradeTo17(bom20);
  const byRef = (ref) =>
    internalBom.components.find((component) => component["bom-ref"] === ref);

  it("writes a valid 1.7 BOM", async () => {
    assert.ok(await validateBom(bom17));
    assert.strictEqual(bom17.$schema, undefined, "the 2.0 $schema is gone");
  });

  it("reads parties back into 1.x organizations and contacts", () => {
    assert.deepStrictEqual(byRef("lib-a").supplier, {
      "bom-ref": "party-supplier",
      name: "Supplier Inc",
      url: [
        "https://supplier.example.com",
        "https://docs.supplier.example.com",
      ],
      address: { country: "US", locality: "Springfield" },
      contact: [
        {
          name: "Support Desk",
          email: "support@supplier.example.com",
          phone: "+1-555-0100",
        },
      ],
    });
    assert.deepStrictEqual(internalBom.metadata.manufacturer, {
      "bom-ref": "metadata-manufacturer",
      name: "Example Corp",
      url: ["https://example.com"],
    });
  });

  it("strips 2.0-only evidence members and maps the unknown technique", () => {
    assert.deepStrictEqual(byRef("lib-a").evidence, {
      identity: [
        {
          field: "purl",
          confidence: 0.9,
          methods: [
            { technique: "manifest-analysis", confidence: 0.9 },
            { technique: "other", confidence: 0.2 },
          ],
        },
      ],
    });
  });

  it("reads list-valued cryptoProperties back to one value", () => {
    assert.deepStrictEqual(byRef("alg-aes").cryptoProperties, {
      assetType: "algorithm",
      oid: "2.16.840.1.101.3.4.1.46",
      algorithmProperties: {
        primitive: "ae",
        algorithmFamily: "AES",
        mode: "gcm",
        implementationPlatform: "x86_64",
        cryptoFunctions: ["encrypt", "decrypt"],
      },
    });
    assert.deepStrictEqual(
      byRef("key-1").cryptoProperties.relatedCryptoMaterialProperties.securedBy,
      { mechanism: "HSM", algorithmRef: "alg-aes" },
    );
  });

  it("reads vulnerability tools, weaknesses and annotator references", () => {
    const scanner = {
      type: "application",
      "bom-ref": "tool-scanner",
      name: "scanner",
      version: "1.0.0",
    };
    const [vulnerability] = internalBom.vulnerabilities;
    assert.deepStrictEqual(vulnerability.tools, { components: [scanner] });
    assert.deepStrictEqual(vulnerability.cwes, [79]);
    assert.strictEqual(vulnerability["bom-ref"], "vuln-1");
    assert.deepStrictEqual(internalBom.annotations[0].annotator, {
      component: scanner,
    });
  });

  it("reads every composition target and the formulation trigger", () => {
    assert.deepStrictEqual(internalBom.compositions, [
      {
        aggregate: "incomplete_first_party_only",
        assemblies: ["app", "lib-a"],
      },
      { aggregate: "complete", dependencies: ["app", "lib-a"] },
    ]);
    const [workflow] = internalBom.formulation[0].workflows;
    assert.deepStrictEqual(workflow.trigger, {
      "bom-ref": "trigger-1",
      uid: "trigger-uid-1",
      type: "api",
    });
    assert.deepStrictEqual(workflow.inputs, [
      { environmentVars: [{ name: "CI", value: "true" }] },
    ]);
  });

  it("puts an unreferenced definitions component back into the formulation", () => {
    assert.deepStrictEqual(internalBom.formulation[0].components, [
      { type: "platform", name: "node", version: "24.0.0" },
    ]);
    assert.ok(
      !internalBom.components.some((component) => component.name === "node"),
      "a formula component never becomes an SBOM component",
    );
  });

  it("renders a changed component from the 1.x model, not its shadow", () => {
    const changed = structuredClone(internalBom);
    const libA = changed.components.find(
      (component) => component["bom-ref"] === "lib-a",
    );
    libA.version = "2.0.1";
    const bom = renderCycloneDx20(changed);
    assert.ok(precompiled20(bom));
    const rendered = bom.inventories[0].components.find(
      (component) => component.refId === "lib-a",
    );
    assert.strictEqual(rendered.version, "2.0.1");
    assert.strictEqual(rendered.measurements, undefined, "lost at 1.x");
  });
});

describe("readCycloneDx20() definitions placement", () => {
  it("keeps a definitions component without a refId", async () => {
    const bom = readUpstream("valid-minimal-viable-2.0.json");
    const [entry] = bom.definitions.components;
    assert.strictEqual(entry.refId, undefined);
    const { bom17, losses } = downgradeTo17(bom);
    assert.strictEqual(bom17.components.length, 1);
    assert.strictEqual(bom17.components[0].name, entry.name);
    assert.deepStrictEqual(losses, []);
    assert.ok(await validateBom(bom17));
  });

  it("never hides an inventory component behind a formula refId", () => {
    const bom = {
      specFormat: "CycloneDX",
      specVersion: "2.0",
      inventories: [
        {
          refId: "inventory-app",
          subject: { type: "application", refId: "app", name: "app" },
          components: [
            { type: "library", refId: "shared", name: "lib", version: "1" },
          ],
        },
      ],
      formulation: [
        {
          refId: "formula-1",
          workflows: [{ refId: "w", uid: "w-uid", taskTypes: ["build"] }],
        },
      ],
      definitions: {
        components: [{ type: "platform", refId: "shared", name: "node" }],
      },
    };
    assert.ok(precompiled20(bom));
    const { internalBom } = readCycloneDx20(bom);
    assert.deepStrictEqual(internalBom.components, [
      { type: "library", "bom-ref": "shared", name: "lib", version: "1" },
    ]);
    assert.deepStrictEqual(internalBom.formulation[0].components, [
      { type: "platform", "bom-ref": "shared", name: "node" },
    ]);
  });

  it("reads a formula component the formulation mentions into that formula", () => {
    const bom = readUpstream("valid-formulation-2.0.json");
    const { internalBom } = readCycloneDx20(bom);
    // Neither entry is mentioned by the formulation and the document has no
    // inventory, so both are root components (rule 4).
    assert.strictEqual(internalBom.components.length, 2);
    const mentioned = structuredClone(bom);
    mentioned.formulation[0].workflows[0].resourceReferences = [
      { ref: "component-1" },
    ];
    const read = readCycloneDx20(mentioned).internalBom;
    assert.deepStrictEqual(
      read.formulation[0].components.map((component) => component["bom-ref"]),
      ["component-1"],
    );
    assert.strictEqual(read.components.length, 1);
  });

  it("keeps a generated formulation out of the inventory", async () => {
    const options = {
      projectType: ["js"],
      specVersion: "2.0",
      includeFormulation: true,
    };
    // The git components of the formulation come from the repository that
    // holds the scanned path, so the fixture is scanned from a copy that is a
    // repository of its own.
    const repo = copyIntoGitRepo(
      join("test", "data", "svelte-precision"),
      "cdxgen-cdx20-read-formulation-",
    );
    let bomNSData;
    try {
      bomNSData = await postProcess(
        await createBom(repo.dir, options),
        options,
        repo.dir,
      );
    } finally {
      repo.cleanup();
    }
    const expected = bomNSData.internalBomJson;
    const { internalBom, losses } = readCycloneDx20(bomNSData.bomJson);
    assert.deepStrictEqual(losses, []);
    assert.strictEqual(
      internalBom.components.length,
      expected.components.length,
    );
    const formulaRefs = new Set(
      expected.formulation[0].components
        .map((component) => component["bom-ref"])
        .filter(Boolean),
    );
    assert.ok(formulaRefs.size > 0);
    assert.ok(
      !internalBom.components.some((component) =>
        formulaRefs.has(component["bom-ref"]),
      ),
      "no formula component becomes an inventory component",
    );
    assert.strictEqual(
      internalBom.formulation[0].components.length +
        (internalBom.formulation[0].services?.length || 0),
      expected.formulation[0].components.length +
        (expected.formulation[0].services?.length || 0),
    );
    assert.ok(
      isDeepStrictEqual(renderCycloneDx20(internalBom), bomNSData.bomJson),
      "the formulation document round trips identically",
    );
  });
});

describe("renderCycloneDx20() changes that keep the round trip", () => {
  const app = {
    type: "application",
    "bom-ref": "pkg:npm/app@1.0.0",
    name: "app",
    version: "1.0.0",
  };
  it("keeps the formula components of a subject-less document apart from the SBOM", () => {
    const node = {
      type: "platform",
      "bom-ref": "pkg:generic/node@24.0.0",
      name: "node",
      version: "24.0.0",
    };
    const shared = {
      type: "library",
      "bom-ref": "pkg:npm/left-pad@1.3.0",
      name: "left-pad",
      version: "1.3.0",
    };
    const model = {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [app, shared],
      formulation: [
        {
          "bom-ref": "formula-1",
          components: [node, shared, { type: "platform", name: "unnamed" }],
        },
        { "bom-ref": "formula-2", components: [structuredClone(node)] },
      ],
    };
    const { bomJson, report } = renderCycloneDx20WithReport(model);
    assert.ok(precompiled20(bomJson), JSON.stringify(precompiled20.errors));
    assertRefIntegrity(bomJson, "subject-less formulation");
    assert.deepStrictEqual(
      bomJson.definitions.components.map((component) => component.name),
      ["app", "left-pad", "node"],
    );
    assert.deepStrictEqual(
      bomJson.formulation.map((formula) => formula.properties),
      [
        [
          {
            name: "cdx:formulation:componentRefs",
            value: JSON.stringify(["pkg:generic/node@24.0.0"]),
          },
        ],
        [
          {
            name: "cdx:formulation:componentRefs",
            value: JSON.stringify(["pkg:generic/node@24.0.0"]),
          },
        ],
      ],
    );
    assert.strictEqual(
      report.drops[
        "formula component that is also an SBOM component (subject-less document)"
      ],
      1,
    );
    assert.strictEqual(
      report.drops["formula component without a refId (subject-less document)"],
      1,
    );
    // Read back, the SBOM keeps app and left-pad and the formulas get node.
    const { internalBom, losses } = readCycloneDx20(bomJson);
    assert.deepStrictEqual(
      internalBom.components.map((component) => component.name),
      ["app", "left-pad"],
    );
    assert.deepStrictEqual(
      internalBom.formulation.map((formula) =>
        (formula.components || []).map((component) => component.name),
      ),
      [["node"], ["node"]],
    );
    assert.strictEqual(internalBom.formulation[0].properties, undefined);
    assert.ok(
      !losses.some((loss) => loss.pointer.startsWith("/definitions")),
      JSON.stringify(losses),
    );
    assert.deepStrictEqual(renderCycloneDx20(internalBom), bomJson);
  });

  it("keeps an empty dependsOn, writes cwes as weaknesses and keeps modelCard properties", () => {
    const { bomJson, report } = renderCycloneDx20WithReport({
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      metadata: { component: app },
      components: [
        {
          type: "machine-learning-model",
          "bom-ref": "pkg:huggingface/acme/model@main",
          name: "model",
          modelCard: {
            modelParameters: { task: "fill-mask" },
            properties: [{ name: "cdx:huggingface:downloads", value: "10" }],
          },
        },
      ],
      dependencies: [{ ref: "pkg:npm/app@1.0.0", dependsOn: [] }],
      vulnerabilities: [
        {
          "bom-ref": "vuln-1",
          id: "CVE-2026-0001",
          cwes: [79, 89],
          affects: [{ ref: "pkg:npm/app@1.0.0" }],
        },
      ],
    });
    assert.ok(precompiled20(bomJson), JSON.stringify(precompiled20.errors));
    assert.deepStrictEqual(bomJson.dependencies, [
      { ref: "pkg:npm/app@1.0.0", dependsOn: [] },
    ]);
    assert.deepStrictEqual(bomJson.vulnerabilities[0].weaknesses, [
      { kind: "flaw", identifiers: [{ scheme: "cwe", value: "CWE-79" }] },
      { kind: "flaw", identifiers: [{ scheme: "cwe", value: "CWE-89" }] },
    ]);
    assert.deepStrictEqual(
      bomJson.inventories[0].components[0].modelProperties,
      {
        properties: [{ name: "cdx:huggingface:downloads", value: "10" }],
      },
    );
    assert.strictEqual(report.drops["component.modelCard.modelParameters"], 1);
    const { internalBom } = readCycloneDx20(bomJson);
    assert.deepStrictEqual(internalBom.vulnerabilities[0].cwes, [79, 89]);
    assert.deepStrictEqual(internalBom.dependencies[0].dependsOn, []);
  });

  it("renders a repeated party as a partyReference", () => {
    const supplier = { "bom-ref": "org-acme", name: "Acme" };
    const bomJson = renderCycloneDx20({
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      metadata: { component: app },
      components: [
        { type: "library", "bom-ref": "a", name: "a", supplier },
        { type: "library", "bom-ref": "b", name: "b", supplier },
      ],
    });
    assert.ok(precompiled20(bomJson));
    const [first, second] = bomJson.inventories[0].components;
    assert.deepStrictEqual(first.parties, [
      {
        refId: "org-acme",
        roles: [{ role: "supplier" }],
        organization: { name: "Acme" },
      },
    ]);
    assert.deepStrictEqual(second.parties, [{ ref: "org-acme" }]);
    const { internalBom } = readCycloneDx20(bomJson);
    assert.deepStrictEqual(
      internalBom.components.map((component) => component.supplier),
      [
        { "bom-ref": "org-acme", name: "Acme" },
        { "bom-ref": "org-acme", name: "Acme" },
      ],
    );
  });
});

describe("1.x tables used by the reader", () => {
  const schema = readJson(join("data", "bom-1.7.schema.json")).definitions;
  const crypto = schema.cryptoProperties.properties;
  const algorithm = crypto.algorithmProperties.properties;
  it("match data/bom-1.7.schema.json", () => {
    const same = (set, values, label) =>
      assert.deepStrictEqual([...set].sort(), [...values].sort(), label);
    same(
      EXTERNAL_REFERENCE_TYPES_1X,
      schema.externalReference.properties.type.enum,
      "externalReference.type",
    );
    same(COMPONENT_TYPES_1X, schema.component.properties.type.enum, "type");
    same(
      IDENTITY_FIELDS_1X,
      schema.componentIdentityEvidence.properties.field.enum,
      "identity field",
    );
    same(
      IDENTITY_TECHNIQUES_1X,
      schema.componentIdentityEvidence.properties.methods.items.properties
        .technique.enum,
      "identity technique",
    );
    same(SCORE_METHODS_1X, schema.scoreMethod.enum, "score method");
    same(
      PROTOCOL_TYPES_1X,
      crypto.protocolProperties.properties.type.enum,
      "protocol type",
    );
    for (const [field, values] of Object.entries(ALGORITHM_PROPERTY_ENUMS_1X)) {
      same(
        values,
        algorithm[field].enum || algorithm[field].items.enum,
        `algorithmProperties.${field}`,
      );
    }
  });
});

describe("formula membership from references only", () => {
  it("keeps a component whose refId equals a task type as an SBOM component", () => {
    const bom20 = readJson(join(READ_FIXTURE_DIR, "formula-task-type.json"));
    assert.ok(precompiled20(bom20), "the fixture is a valid 2.0 document");
    const { internalBom } = readCycloneDx20(bom20);
    assert.deepStrictEqual(
      internalBom.components?.map((component) => component["bom-ref"]),
      ["build"],
    );
    assert.strictEqual(internalBom.formulation[0].components, undefined);
    assert.deepStrictEqual(internalBom.formulation[0].workflows[0].taskTypes, [
      "build",
    ]);
  });

  it("still reads a component a resource reference names into the formula", () => {
    const bom20 = readJson(join(READ_FIXTURE_DIR, "formula-task-type.json"));
    bom20.formulation[0].workflows[0].resourceReferences = [{ ref: "build" }];
    const { internalBom } = readCycloneDx20(bom20);
    assert.strictEqual(internalBom.components, undefined);
    assert.deepStrictEqual(
      internalBom.formulation[0].components.map(
        (component) => component["bom-ref"],
      ),
      ["build"],
    );
  });
});

describe("loadBomForAnalysis()", () => {
  it("reads a 2.0 document with a stray 1.x member as 2.0 and reports it", () => {
    const bom20 = readJson(join(READ_FIXTURE_DIR, "stray-components.json"));
    const { internalBom, specVersion, losses } = loadBomForAnalysis(bom20);
    assert.strictEqual(specVersion, "2.0");
    assert.strictEqual(internalBom.metadata.component["bom-ref"], "app");
    assert.deepStrictEqual(
      internalBom.components.map((component) => component.name),
      ["left-pad"],
    );
    assert.ok(
      losses.some((loss) => loss.pointer === "/components"),
      JSON.stringify(losses),
    );
  });

  it("returns the reader model as is, and reads its JSON copy as a 2.0 document", () => {
    const bom20 = readJson(join(READ_FIXTURE_DIR, "stray-components.json"));
    const { internalBom } = loadBomForAnalysis(bom20);
    const again = loadBomForAnalysis(internalBom);
    assert.strictEqual(again.internalBom, internalBom);
    assert.deepStrictEqual(again.losses, []);
    assert.ok(
      !JSON.stringify(internalBom).includes("internalModel"),
      "the mark never reaches JSON",
    );
    // A JSON copy has no mark, so it is read as the 2.0 document it claims
    // to be: its 1.x root members are reported, never taken as the model.
    const copied = JSON.parse(JSON.stringify(internalBom));
    const serialized = loadBomForAnalysis(copied);
    assert.notStrictEqual(serialized.internalBom, copied);
    assert.ok(
      serialized.losses.some((loss) => loss.pointer === "/components"),
      JSON.stringify(serialized.losses),
    );
  });

  it("keeps the model of the 2.0 compatibility pass as is", () => {
    const model = applySpecVersionCompatibility(
      readJson(join(READ_FIXTURE_DIR, "internal-sections-1.7.json")),
      { specVersion: "2.0" },
    );
    assert.strictEqual(model.specVersion, "2.0");
    const { internalBom, losses } = loadBomForAnalysis(model);
    assert.strictEqual(internalBom, model);
    assert.deepStrictEqual(losses, []);
  });

  it("ignores the internal sections key on a 1.x document", () => {
    const bom17 = readJson(
      join(READ_FIXTURE_DIR, "internal-sections-1.7.json"),
    );
    const { internalBom, specVersion } = loadBomForAnalysis(bom17);
    assert.strictEqual(specVersion, "1.7");
    assert.strictEqual(internalBom[CDX20_INTERNAL_SECTIONS_KEY], undefined);
    assert.ok(bom17[CDX20_INTERNAL_SECTIONS_KEY], "the input is not mutated");
    const rendered = renderCycloneDx20(
      applySpecVersionCompatibility(structuredClone(internalBom), {
        specVersion: "2.0",
      }),
    );
    assert.ok(precompiled20(rendered));
    assert.ok(!JSON.stringify(rendered).includes("injected-risk"));
    assert.deepStrictEqual(
      rendered.inventories[0].components.map((component) => component.name),
      ["left-pad"],
    );
  });
});

describe("deeply nested 2.0 input", () => {
  /** A valid 2.0 document whose components nest `depth` levels deep. */
  const nestedDocument = (depth) => {
    let component = { type: "library", refId: `c${depth}`, name: `c${depth}` };
    for (let level = depth - 1; level >= 0; level--) {
      component = {
        type: "library",
        refId: `c${level}`,
        name: `c${level}`,
        components: [component],
      };
    }
    return {
      specFormat: "CycloneDX",
      specVersion: "2.0",
      inventories: [
        {
          refId: "inventory",
          subject: { type: "application", refId: "app", name: "app" },
          components: [component],
        },
      ],
    };
  };
  const readDepth = (internalBom) => {
    let depth = 0;
    for (let c = internalBom.components?.[0]; c; c = c.components?.[0]) {
      depth += 1;
    }
    return depth;
  };

  it("reads a document within the depth limit completely", () => {
    const bom20 = nestedDocument(200);
    assert.ok(precompiled20(bom20), "the generated document is valid 2.0");
    const { internalBom, losses } = readCycloneDx20(bom20);
    assert.strictEqual(readDepth(internalBom), 201);
    assert.deepStrictEqual(losses, []);
  });

  it("cuts components nested past the depth limit with one loss", () => {
    const { internalBom, losses } = loadBomForAnalysis(
      nestedDocument(MAX_READ_DEPTH + 50),
    );
    assert.ok(readDepth(internalBom) < MAX_READ_DEPTH);
    assert.strictEqual(losses.length, 1, "one loss for the cut subtree");
    assert.match(losses[0].pointer, /^\/inventories\/0\/components\/0\//);
    assert.strictEqual(
      losses[0].reason,
      `nested deeper than ${MAX_READ_DEPTH} objects: not read`,
    );
    // The cut model renders back to a valid 2.0 document.
    assert.ok(precompiled20(renderCycloneDx20(internalBom)));
  });

  it("keeps a parsed __proto__ member as data", () => {
    const bom20 = JSON.parse(
      '{"specFormat":"CycloneDX","specVersion":"2.0","__proto__":{"polluted":true}}',
    );
    const { internalBom, losses } = readCycloneDx20(bom20);
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(internalBom.polluted, undefined);
    assert.ok(losses.some((loss) => loss.pointer === "/__proto__"));
  });
});

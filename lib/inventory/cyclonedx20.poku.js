import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { assert, describe, it } from "poku";

import { assertRefIntegrity } from "../../test/helpers/cyclonedx20RefIntegrity.js";
import { copyIntoGitRepo } from "../../test/helpers/gitFixture.js";
import { createBom } from "../cli/index.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { sortBomCollections } from "../stages/postgen/sortBom.js";
import { convertCycloneDxToSpdx } from "../stages/postgen/spdxConverter.js";
import { applySpecVersionCompatibility } from "../stages/postgen/specVersionCompat.js";
import { validateBom } from "../validator/bomValidator.js";
import precompiled20 from "../validator/generated/validate-2.0.mjs";
import { getSupportedCycloneDxComponentTypes } from "./bomUtils.js";
import {
  CDX20_INTERNAL_SECTIONS_KEY,
  DEPENDENCY_TRACK_CDX20_ERROR,
  loadBomForAnalysis,
  readCycloneDx20,
  refreshRenderedBom,
  renderCycloneDx20,
  renderCycloneDx20WithReport,
} from "./cyclonedx20.js";

// The pinned draft's example corpus, vendored verbatim from
// CycloneDX/specification 2.0-dev at ea8c3605829d1da13339a0790b6da73548e42a6b
// (see test/data/cyclonedx-2.0-upstream/README.md).
const UPSTREAM_DIR = join("test", "data", "cyclonedx-2.0-upstream");

// Validates a directory with the runtime-compiled validator in a child
// process (see the script for why it is a file and not `-e` code).
const RUNTIME_VALIDATE_SCRIPT = join(
  resolve(fileURLToPath(new URL("../..", import.meta.url))),
  "test",
  "cdx20-runtime-validate.mjs",
);

// Absolute paths for the tests that spawn the CLI with a temporary cwd, so
// nothing (atom slices, flowsummary files) is written into the repository.
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CDXGEN_BIN = join(REPO_ROOT, "bin", "cdxgen.js");
const RENDER_FIXTURE_DIR = join("test", "data", "cyclonedx-2.0-render");
const RENDER_FIXTURES = [
  "services",
  "identifiers",
  "parties",
  "compositions",
  "annotations",
  "legacy",
  "self-scan",
  "definitions",
  "attachments",
  "crypto",
];

const isRecord = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const readRenderFixture = (name) =>
  JSON.parse(readFileSync(join(RENDER_FIXTURE_DIR, `${name}.json`), "utf-8"));

/** Run bin/cdxgen.js from a fresh temporary directory. */
function runCdxgen(args, cwd) {
  return spawnSync(process.execPath, [CDXGEN_BIN, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, CDXGEN_NO_CACHE: "true" },
  });
}

/**
 * Write to every object and array of a rendered document. Run against the
 * output of a deep-frozen input, any object shared with the input throws.
 */
function mutateDeeply(node) {
  if (Array.isArray(node)) {
    node.forEach(mutateDeeply);
    node.push("mutated");
    return;
  }
  if (isRecord(node)) {
    for (const value of Object.values(node)) {
      mutateDeeply(value);
    }
    node.__mutated = true;
  }
}

/** A deep copy whose object keys are in reverse order. */
function reverseKeyOrder(node) {
  if (Array.isArray(node)) {
    return node.map(reverseKeyOrder);
  }
  if (!isRecord(node)) {
    return node;
  }
  return Object.fromEntries(
    Object.keys(node)
      .reverse()
      .map((key) => [key, reverseKeyOrder(node[key])]),
  );
}

/** All components of a rendered document: inventory or definitions. */
const isNonEmptyRefId = (value) =>
  typeof value === "string" && value.length > 0;

const renderedComponents = (bom20) =>
  bom20.inventories?.[0]?.components ?? bom20.definitions?.components ?? [];

const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
};

/** Generate a BOM through the real pipeline at the given spec version. */
async function generateFixture(path, options) {
  const generationOptions = { ...options, specVersion: options.specVersion };
  const bomNSData = await createBom(path, generationOptions);
  return postProcess(bomNSData, generationOptions, path);
}

// Every scenario is one of the no-change baseline fixtures, so a 2.0
// regression here sits next to a proof that 1.6/1.7 output is unchanged.
const SCENARIOS = [
  {
    name: "js evidence",
    path: join("test", "data", "svelte-precision"),
    options: { projectType: ["js"] },
    assertBom: (bom20) => {
      const inventory = bom20.inventories[0];
      assert.ok(inventory.subject.refId, "subject carries a refId");
      const identities = inventory.components.flatMap(
        (component) => component.identifiers || [],
      );
      assert.ok(identities.length > 0, "js fixture renders purl identifiers");
      assert.ok(
        inventory.components.some(
          (component) => component.evidence?.occurrences?.length,
        ),
        "occurrence evidence survives the render",
      );
    },
  },
  {
    name: "certificates",
    path: join("test", "data", "cbom-certs", "rootfs"),
    options: { projectType: ["universal"], includeCrypto: true },
    assertBom: (bom20) => {
      // This fixture has no subject component, so the components live in the
      // definitions registry the way upstream's
      // valid-component-evidence-assertion-2.0.json declares its components.
      const components = bom20.definitions.components;
      const certificates = components.filter(
        (component) => component.cryptoProperties?.assetType === "certificate",
      );
      const related = components.filter(
        (component) =>
          component.cryptoProperties?.assetType === "related-crypto-material",
      );
      assert.ok(certificates.length === 4, "four certificate assets");
      assert.ok(related.length === 4, "four related-crypto-material assets");
      const toolNames = bom20.metadata.tools.components.map(
        (tool) => tool.name,
      );
      assert.ok(
        toolNames.includes("trustinspector"),
        "the helper appears in metadata.tools.components",
      );
    },
  },
  {
    name: "ai services",
    path: join("test", "data", "mcp-repotest"),
    options: { projectType: ["ai"] },
    assertBom: (bom20) => {
      const serviceComponents = bom20.inventories[0].components.filter(
        (component) => component.type === "service",
      );
      assert.ok(
        serviceComponents.length >= 1,
        "services render as components of type service",
      );
      const service = serviceComponents[0];
      assert.ok(service.refId, "service carries a refId");
      assert.ok(
        service.refId.startsWith("urn:service:"),
        "service refId keeps the urn:service bom-ref",
      );
      assert.ok(service.evidence?.occurrences?.length);
    },
  },
  {
    name: "formulation",
    path: join("test", "data", "svelte-precision"),
    // The git components of the formulation come from the repository that
    // holds the scanned path, so the fixture is scanned from a copy that is a
    // repository of its own.
    gitRepo: true,
    options: { projectType: ["js"], includeFormulation: true },
    assertBom: (bom20) => {
      const workflow = bom20.formulation[0].workflows[0];
      assert.ok(workflow.refId, "workflow bom-ref becomes refId");
      assert.ok(workflow.uid, "workflow keeps its uid");
      const serialized = JSON.stringify(bom20);
      assert.ok(
        serialized.includes("omniborid"),
        "gitoid identifiers render under the omniborid scheme",
      );
    },
  },
  {
    name: "compositions",
    path: join("test", "data", "svelte-precision"),
    options: {
      projectType: ["js"],
      requiredOnly: true,
      autoCompositions: true,
    },
    assertBom: (bom20) => {
      const composition = bom20.compositions[0];
      assert.strictEqual(composition.kind, "components");
      assert.strictEqual(composition.aggregate, "incomplete");
      assert.ok(
        composition.targets[0].startsWith("inventory-"),
        "composition targets the inventory refId",
      );
    },
  },
];

describe("renderCycloneDx20() on generated BOMs", () => {
  for (const scenario of SCENARIOS) {
    it(`renders the ${scenario.name} fixture as a valid 2.0 document`, async () => {
      const repo = scenario.gitRepo
        ? copyIntoGitRepo(scenario.path, "cdxgen-cdx20-formulation-")
        : undefined;
      let bomNSData;
      try {
        bomNSData = await generateFixture(repo?.dir || scenario.path, {
          ...scenario.options,
          specVersion: "2.0",
        });
      } finally {
        repo?.cleanup();
      }
      const bom20 = bomNSData.bomJson;
      assert.strictEqual(bom20.specFormat, "CycloneDX");
      assert.strictEqual(bom20.specVersion, "2.0");
      assert.ok(!bom20.components, "no root components in 2.0");
      assert.ok(!bom20.services, "no root services in 2.0");
      assert.ok(!bom20.metadata?.component, "no metadata.component in 2.0");
      assert.ok(
        precompiled20(bom20),
        "validates with the precompiled validator",
      );
      assert.ok(
        await validateBom(bom20, { deep: false }),
        "validates with the runtime-compiled validator",
      );
      scenario.assertBom(bom20);
      assertRefIntegrity(bom20, scenario.name);
      // The internal model stays 1.x-shaped and never serializes.
      const internal = bomNSData.internalBomJson;
      assert.ok(internal, "internalBomJson is set at 2.0");
      assert.ok(
        Array.isArray(internal.components) || Array.isArray(internal.services),
      );
      assert.ok(
        !JSON.stringify(bom20).includes(CDX20_INTERNAL_SECTIONS_KEY),
        "the internal sections key never reaches the rendered document",
      );
    });
  }

  it("shares no objects with its input (purity)", async () => {
    const bomNSData = await generateFixture(
      join("test", "data", "svelte-precision"),
      { projectType: ["js"], specVersion: "1.7", includeFormulation: true },
    );
    const inputs = [
      ["svelte-precision", bomNSData.bomJson],
      ...RENDER_FIXTURES.map((name) => [name, readRenderFixture(name)]),
    ];
    for (const [label, input] of inputs) {
      const pristine = structuredClone(input);
      const frozen = deepFreeze(structuredClone(input));
      const bom20 = renderCycloneDx20(frozen);
      assert.strictEqual(bom20.specFormat, "CycloneDX");
      // A shared object is frozen, so writing to it throws in this strict
      // module; afterwards the input must still equal its pristine copy.
      assert.doesNotThrow(
        () => mutateDeeply(bom20),
        `${label}: the output shares no object with the input`,
      );
      assert.deepStrictEqual(
        frozen,
        pristine,
        `${label}: the input is unchanged`,
      );
    }
  });

  it("renders the same internal model to byte-identical JSON", async () => {
    const bomNSData = await generateFixture(
      join("test", "data", "svelte-precision"),
      { projectType: ["js"], specVersion: "1.7", includeFormulation: true },
    );
    const inputs = [
      ["svelte-precision", bomNSData.bomJson],
      ...RENDER_FIXTURES.map((name) => [name, readRenderFixture(name)]),
    ];
    for (const [label, input] of inputs) {
      const first = JSON.stringify(renderCycloneDx20(input));
      const second = JSON.stringify(renderCycloneDx20(structuredClone(input)));
      assert.strictEqual(first, second, `${label}: renders deterministically`);
      // Cloned subtrees keep the key order of their input, so a reordered
      // input gives the same document with its own key order.
      assert.deepStrictEqual(
        renderCycloneDx20(reverseKeyOrder(input)),
        JSON.parse(first),
        `${label}: input key order does not change the content`,
      );
    }
  });

  it("keeps the cdxgen party role as asserter and points identifiers at it", async () => {
    const bomNSData = await generateFixture(
      join("test", "data", "svelte-precision"),
      {
        projectType: ["js"],
        specVersion: "2.0",
      },
    );
    const bom20 = bomNSData.bomJson;
    const party = bom20.definitions.parties.find(
      (candidate) => candidate.refId === "party-cdxgen",
    );
    assert.ok(party, "the cdxgen party is declared");
    assert.deepStrictEqual(party.roles, [{ role: "asserter" }]);
    assert.strictEqual(party.system.kind, "automation");
    const cdxgenTool = bom20.metadata.tools.components.find(
      (tool) => tool.name === "cdxgen",
    );
    assert.ok(cdxgenTool.refId, "the cdxgen tool carries a refId");
    assert.strictEqual(
      party.system.ref,
      cdxgenTool.refId,
      "the party's system.ref points at the cdxgen tool",
    );
    const identifier = bom20.inventories[0].components
      .flatMap((component) => component.identifiers || [])
      .find((entry) => entry.identities.some((i) => i.scheme === "purl"));
    assert.strictEqual(identifier.party, "party-cdxgen");
  });

  it("renders identity fields outside the scheme enum with the custom branch", async () => {
    // Correction F: `field: "name"` has no predefined identityScheme value, so
    // it renders through the custom {name} branch of
    // #/$defs/cyclonedx-component-2.0/$defs/identityScheme. This test proves
    // the result validates.
    const internal = {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      version: 1,
      metadata: { timestamp: "2026-01-01T00:00:00Z" },
      components: [
        {
          type: "library",
          "bom-ref": "pkg:npm/demo@1.0.0",
          name: "demo",
          version: "1.0.0",
          evidence: {
            identity: [
              {
                field: "name",
                concludedValue: "demo",
                confidence: 0.5,
                methods: [
                  { technique: "filename", confidence: 0.5, value: "demo.js" },
                ],
              },
            ],
          },
        },
      ],
    };
    const bom20 = renderCycloneDx20(internal);
    const scheme = (bom20.inventories?.[0]?.components ??
      bom20.definitions.components)[0].evidence.identity[0].scheme;
    assert.deepStrictEqual(scheme, { name: "name" });
    assert.ok(precompiled20(bom20), "custom scheme validates");
  });

  it("drops identity methods that would need an invented confidence", () => {
    const internal = {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      version: 1,
      metadata: { timestamp: "2026-01-01T00:00:00Z" },
      components: [
        {
          type: "library",
          "bom-ref": "pkg:npm/demo@1.0.0",
          name: "demo",
          evidence: {
            identity: [
              {
                field: "purl",
                concludedValue: "pkg:npm/demo@1.0.0",
                confidence: 0.4,
                methods: [
                  // Inherits the identity confidence when present.
                  { technique: "filename" },
                ],
              },
              {
                field: "purl",
                concludedValue: "pkg:npm/demo@1.0.0",
                methods: [
                  // Dropped: no method or identity confidence at all.
                  { technique: "hash-comparison", value: "abc" },
                ],
              },
            ],
          },
        },
      ],
    };
    const bom20 = renderCycloneDx20(internal);
    // No subject component in this synthetic document, so the component is
    // declared in definitions.components.
    const identities = bom20.definitions.components[0].evidence.identity;
    assert.strictEqual(identities[0].methods[0].technique, "filename");
    assert.strictEqual(identities[0].methods[0].confidence, 0.4);
    assert.strictEqual(identities[1].methods, undefined);
  });
});

/** A small 1.x internal model with one identity entry per component. */
function claimsModel(metadata, identity) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    ...(metadata ? { metadata } : {}),
    components: [
      {
        type: "library",
        "bom-ref": "pkg:npm/demo@1.0.0",
        name: "demo",
        version: "1.0.0",
        evidence: { identity: [identity] },
      },
    ],
  };
}

const CLAIM_IDENTITY = Object.freeze({
  field: "name",
  concludedValue: "demo",
  confidence: 0.8,
  methods: [
    { technique: "manifest-analysis", confidence: 0.8, value: "package.json" },
    // No value: nothing names what the method found, so no result.
    { technique: "filename", confidence: 0.3 },
  ],
});

// A third-party 2.0 document: its identity entry is asserted by its own
// supplier party, with its own timestamp and method result.
const FOREIGN_IDENTITY_DOC = Object.freeze({
  specFormat: "CycloneDX",
  specVersion: "2.0",
  serialNumber: "urn:uuid:3e671687-395b-41f5-a30f-a58921a69d03",
  version: 1,
  metadata: { timestamp: "2026-01-01T00:00:00Z" },
  inventories: [
    {
      refId: "inventory-app",
      subject: { refId: "app", type: "application", name: "app" },
      components: [
        {
          refId: "lib-a",
          type: "library",
          name: "lib-a",
          version: "1.0.0",
          evidence: {
            identity: [
              {
                scheme: "purl",
                concludedValue: "pkg:npm/lib-a@1.0.0",
                confidence: 0.9,
                methods: [
                  {
                    technique: "manifest-analysis",
                    confidence: 0.9,
                    result: "detected",
                    value: "package-lock.json",
                  },
                ],
                assertion: {
                  parties: [
                    {
                      party: { ref: "party-acme" },
                      role: { role: "supplier" },
                    },
                  ],
                },
                timestamp: "2025-06-01T00:00:00Z",
              },
            ],
          },
        },
      ],
    },
  ],
  definitions: {
    parties: [
      {
        refId: "party-acme",
        roles: [{ role: "supplier" }],
        organization: { name: "Acme" },
      },
    ],
  },
});

const FOREIGN_IDENTITY_POINTER =
  "/inventories/0/components/0/evidence/identity/0";

/** The cdxgen party declarations of a rendered document. */
const cdxgenParties = (bom20) =>
  (bom20.definitions?.parties || []).filter(
    (party) => party.refId === "party-cdxgen",
  );

describe("attributed claims on identity evidence (#4591)", () => {
  const generated = generateFixture(join("test", "data", "svelte-precision"), {
    projectType: ["js"],
    specVersion: "2.0",
  });

  it("attributes the js fixture identities to the declared cdxgen party", async () => {
    const { bomJson: bom20, internalBomJson } = await generated;
    const cdxgenTool = bom20.metadata.tools.components.find(
      (tool) => tool.name === "cdxgen",
    );
    assert.ok(cdxgenTool.refId, "the cdxgen tool carries a refId");
    const components = bom20.inventories[0].components.filter(
      (entry) => entry.evidence?.identity?.length,
    );
    assert.ok(components.length > 0, "fixture carries identity evidence");
    for (const component of components) {
      const internal = internalBomJson.components.find(
        (entry) => entry["bom-ref"] === component.refId,
      );
      component.evidence.identity.forEach((identity, index) => {
        const source = internal.evidence.identity[index];
        assert.deepStrictEqual(identity.assertion, {
          parties: [
            { party: { ref: "party-cdxgen" }, role: { role: "asserter" } },
          ],
        });
        assert.deepStrictEqual(identity.tools, [cdxgenTool.refId]);
        assert.strictEqual(identity.timestamp, bom20.metadata.timestamp);
        // Confidence only where the 1.x model has one; never invented.
        assert.strictEqual(identity.confidence, source.confidence);
        identity.methods.forEach((method, methodIndex) => {
          const sourceMethod = source.methods[methodIndex];
          assert.strictEqual(
            method.confidence,
            sourceMethod.confidence ?? source.confidence,
          );
          assert.strictEqual(
            method.result,
            typeof sourceMethod.value === "string" ? "detected" : undefined,
          );
        });
      });
    }
    assert.strictEqual(cdxgenParties(bom20).length, 1, "declared once");
    assert.ok(precompiled20(bom20));
    assertRefIntegrity(bom20, "js identity claims");
  });

  it("reads cdxgen's own claims back without a loss and round-trips them", async () => {
    const { bomJson: bom20 } = await generated;
    const { internalBom, losses } = readCycloneDx20(bom20);
    assert.deepStrictEqual(losses, []);
    assert.ok(!internalBom[CDX20_INTERNAL_SECTIONS_KEY]?.shadows?.identity);
    const identities = internalBom.components.flatMap(
      (component) => component.evidence?.identity || [],
    );
    assert.ok(identities.length > 0);
    for (const identity of identities) {
      assert.strictEqual(identity.assertion, undefined);
      assert.strictEqual(identity.timestamp, undefined);
      assert.ok(
        identity.methods.every((method) => method.result === undefined),
      );
    }
    assert.deepStrictEqual(renderCycloneDx20(internalBom), bom20);
  });

  it("converts cdxgen's own 2.0 claims to a valid 1.7 BOM", async () => {
    const { bomJson: bom20 } = await generated;
    const { internalBom } = readCycloneDx20(bom20);
    const bom17 = applySpecVersionCompatibility(structuredClone(internalBom), {
      specVersion: "1.7",
    });
    sortBomCollections(bom17);
    assert.strictEqual(bom17.specVersion, "1.7");
    const serialized = JSON.stringify(bom17);
    assert.ok(!serialized.includes('"result"'), "no method result at 1.7");
    assert.ok(!serialized.includes('"assertion"'), "no assertion at 1.7");
    assert.ok(await validateBom(bom17), "the 1.7 output validates");
  });

  it("keeps a helper's tools refs instead of crediting cdxgen's tool", () => {
    const bom20 = renderCycloneDx20(
      claimsModel(
        {
          timestamp: "2026-01-01T00:00:00Z",
          tools: {
            components: [
              {
                type: "application",
                name: "cdxgen",
                version: "13.7.0",
                "bom-ref": "pkg:npm/@cdxgen/cdxgen@13.7.0",
              },
              {
                type: "application",
                name: "trivy",
                version: "0.60.0",
                "bom-ref": "urn:tool:trivy:0.60.0",
              },
            ],
          },
        },
        { ...CLAIM_IDENTITY, tools: ["urn:tool:trivy:0.60.0"] },
      ),
    );
    const identity = renderedComponents(bom20)[0].evidence.identity[0];
    assert.deepStrictEqual(identity.tools, ["urn:tool:trivy:0.60.0"]);
    assert.ok(precompiled20(bom20));
    assertRefIntegrity(bom20, "helper tools");
  });

  it("claims identity analysis only for a declared cdxgen tool and never invents one", () => {
    const declaredTool = {
      timestamp: "2026-01-01T00:00:00Z",
      tools: {
        components: [
          {
            type: "application",
            name: "cdxgen",
            version: "13.7.0",
            "bom-ref": "pkg:npm/@cdxgen/cdxgen@13.7.0",
          },
        ],
      },
    };
    const cases = [
      ["no metadata", undefined, undefined, undefined, false, 0],
      [
        "metadata without tools",
        { timestamp: "2026-01-01T00:00:00Z" },
        undefined,
        "2026-01-01T00:00:00Z",
        false,
        0,
      ],
      [
        "a cdxgen tool with a purl but no bom-ref",
        {
          tools: {
            components: [
              {
                type: "application",
                name: "cdxgen",
                version: "13.7.0",
                purl: "pkg:npm/%40cdxgen/cdxgen@13.7.0",
              },
            ],
          },
        },
        undefined,
        undefined,
        false,
        // The tool's purl identifier is asserted by the cdxgen party (no
        // listed tool has a refId), so the party is declared.
        1,
      ],
      [
        "a declared cdxgen tool",
        declaredTool,
        ["pkg:npm/@cdxgen/cdxgen@13.7.0"],
        "2026-01-01T00:00:00Z",
        true,
        1,
      ],
    ];
    for (const [
      label,
      metadata,
      tools,
      timestamp,
      attributed,
      partyCount,
    ] of cases) {
      const bom20 = renderCycloneDx20(claimsModel(metadata, CLAIM_IDENTITY));
      const identity = renderedComponents(bom20)[0].evidence.identity[0];
      assert.deepStrictEqual(identity.tools, tools, `${label}: tools`);
      assert.strictEqual(identity.timestamp, timestamp, `${label}: timestamp`);
      // cdxgen asserts only analysis it did: with no declared cdxgen tool
      // the identity has no assertion and no method result.
      assert.deepStrictEqual(
        identity.assertion,
        attributed
          ? {
              parties: [
                {
                  party: { ref: "party-cdxgen" },
                  role: { role: "asserter" },
                },
              ],
            }
          : undefined,
        `${label}: assertion`,
      );
      assert.deepStrictEqual(
        identity.methods.map((method) => method.result),
        attributed ? ["detected", undefined] : [undefined, undefined],
        `${label}: result only for cdxgen's method that names its value`,
      );
      // The component has no purl, so only the assertion (or a tool's
      // identifier) references the cdxgen party; it is declared once when
      // referenced, else not at all.
      assert.strictEqual(
        cdxgenParties(bom20).length,
        partyCount,
        `${label}: party`,
      );
      const { internalBom, losses } = readCycloneDx20(bom20);
      assert.deepStrictEqual(losses, [], `${label}: read without a loss`);
      assert.deepStrictEqual(
        renderCycloneDx20(internalBom),
        bom20,
        `${label}: round trip`,
      );
      assert.ok(precompiled20(bom20), `${label}: valid`);
      assertRefIntegrity(bom20, label);
    }
  });

  it("declares the cdxgen party only when something references it", () => {
    const internal = claimsModel(
      { timestamp: "2026-01-01T00:00:00Z" },
      CLAIM_IDENTITY,
    );
    delete internal.components[0].evidence;
    const bom20 = renderCycloneDx20(internal);
    assert.deepStrictEqual(cdxgenParties(bom20), []);
    assert.ok(precompiled20(bom20));
  });

  it("drops identity techniques the draft forbids and keeps the rest", () => {
    const bom20 = renderCycloneDx20(
      claimsModel(
        { timestamp: "2026-01-01T00:00:00Z" },
        {
          field: "purl",
          confidence: 0.8,
          methods: [
            {
              technique: "reachability-analysis",
              confidence: 0.9,
              value: "reachability is not an identity technique",
            },
            {
              technique: "manifest-analysis",
              confidence: 0.8,
              value: "package.json",
            },
          ],
        },
      ),
    );
    const methods = renderedComponents(bom20)[0].evidence.identity[0].methods;
    // No declared cdxgen tool, so no result is claimed for the method.
    assert.deepStrictEqual(methods, [
      {
        technique: "manifest-analysis",
        confidence: 0.8,
        value: "package.json",
      },
    ]);
    assert.ok(precompiled20(bom20));
  });

  it("round-trips a foreign identity entry unchanged and reports its losses", () => {
    assert.ok(precompiled20(FOREIGN_IDENTITY_DOC), "the fixture is valid 2.0");
    const { internalBom, losses } = readCycloneDx20(FOREIGN_IDENTITY_DOC);
    assert.deepStrictEqual(
      losses.filter((loss) => loss.pointer.includes("/evidence/")),
      [
        {
          pointer: `${FOREIGN_IDENTITY_POINTER}/methods/0/result`,
          reason: "identificationMethod.result has no 1.x field",
        },
        {
          pointer: `${FOREIGN_IDENTITY_POINTER}/assertion`,
          reason: "identityEvidence.assertion has no 1.x field",
        },
        {
          pointer: `${FOREIGN_IDENTITY_POINTER}/timestamp`,
          reason: "identityEvidence.timestamp has no 1.x field",
        },
      ],
    );
    assert.deepStrictEqual(internalBom.components[0].evidence.identity, [
      {
        field: "purl",
        concludedValue: "pkg:npm/lib-a@1.0.0",
        confidence: 0.9,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.9,
            value: "package-lock.json",
          },
        ],
      },
    ]);
    const bom20 = renderCycloneDx20(internalBom);
    assert.deepStrictEqual(bom20, FOREIGN_IDENTITY_DOC);
    assert.deepStrictEqual(cdxgenParties(bom20), []);
    assertRefIntegrity(bom20, "foreign identity");
  });

  it("keeps the foreign assertion when only another component field changes", () => {
    const { internalBom } = readCycloneDx20(FOREIGN_IDENTITY_DOC);
    internalBom.components[0].description = "edited after the read";
    const bom20 = renderCycloneDx20(internalBom);
    const component = bom20.inventories[0].components[0];
    assert.strictEqual(component.description, "edited after the read");
    assert.deepStrictEqual(
      component.evidence.identity,
      FOREIGN_IDENTITY_DOC.inventories[0].components[0].evidence.identity,
    );
    assert.deepStrictEqual(cdxgenParties(bom20), []);
    assert.ok(precompiled20(bom20));
    assertRefIntegrity(bom20, "foreign identity, edited component");
  });

  it("renders an edited foreign identity from the 1.x model", () => {
    const { internalBom } = readCycloneDx20(FOREIGN_IDENTITY_DOC);
    internalBom.components[0].evidence.identity[0].concludedValue =
      "pkg:npm/lib-a@1.0.1";
    const bom20 = renderCycloneDx20(internalBom);
    const identity = bom20.inventories[0].components[0].evidence.identity[0];
    assert.strictEqual(identity.concludedValue, "pkg:npm/lib-a@1.0.1");
    // Rendered from the 1.x model. The document declares no cdxgen tool, so
    // cdxgen claims nothing: no assertion, no tool, no method result; the
    // document's timestamp is kept.
    assert.deepStrictEqual(identity, {
      scheme: "purl",
      concludedValue: "pkg:npm/lib-a@1.0.1",
      confidence: 0.9,
      methods: [
        {
          technique: "manifest-analysis",
          confidence: 0.9,
          value: "package-lock.json",
        },
      ],
      timestamp: "2026-01-01T00:00:00Z",
    });
    assert.deepStrictEqual(cdxgenParties(bom20), []);
    assert.ok(
      bom20.definitions.parties.some((party) => party.refId === "party-acme"),
      "the carried party stays declared",
    );
    assert.ok(precompiled20(bom20));
    assertRefIntegrity(bom20, "foreign identity, edited");
  });

  it("converts a foreign identity to a valid 1.7 BOM without 2.0 members", async () => {
    const { internalBom } = readCycloneDx20(FOREIGN_IDENTITY_DOC);
    const bom17 = applySpecVersionCompatibility(structuredClone(internalBom), {
      specVersion: "1.7",
    });
    sortBomCollections(bom17);
    assert.deepStrictEqual(bom17.components[0].evidence.identity, [
      {
        field: "purl",
        concludedValue: "pkg:npm/lib-a@1.0.0",
        confidence: 0.9,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.9,
            value: "package-lock.json",
          },
        ],
      },
    ]);
    assert.ok(await validateBom(bom17));
  });
});

// Another tool's 1.x BOM: syft is the listed tool, cdxgen is not.
function foreignToolModel(tools) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "urn:uuid:6b9b1f0c-6f8e-4c47-9d6e-2f0e7a1f5d21",
    version: 1,
    metadata: {
      timestamp: "2026-02-01T00:00:00Z",
      ...(tools ? { tools } : {}),
      component: {
        type: "application",
        "bom-ref": "app",
        name: "app",
      },
    },
    components: [
      {
        type: "library",
        "bom-ref": "pkg:npm/lib-a@1.0.0",
        name: "lib-a",
        version: "1.0.0",
        purl: "pkg:npm/lib-a@1.0.0",
        evidence: {
          identity: [
            {
              field: "purl",
              concludedValue: "pkg:npm/lib-a@1.0.0",
              confidence: 0.9,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 0.9,
                  value: "package-lock.json",
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

const SYFT_TOOLS = Object.freeze({
  components: [
    {
      type: "application",
      author: "anchore",
      name: "syft",
      version: "1.20.0",
    },
    {
      type: "application",
      author: "anchore",
      name: "syft",
      version: "1.20.0",
      "bom-ref": "pkg:golang/github.com/anchore/syft@v1.20.0",
    },
  ],
});

// The identity of a foreign 1.x BOM: no cdxgen assertion, tool or result.
const FOREIGN_TOOL_IDENTITY = Object.freeze({
  scheme: "purl",
  concludedValue: "pkg:npm/lib-a@1.0.0",
  confidence: 0.9,
  methods: [
    {
      technique: "manifest-analysis",
      confidence: 0.9,
      value: "package-lock.json",
    },
  ],
  timestamp: "2026-02-01T00:00:00Z",
});

/** Every identifier group of the rendered inventory and tools. */
const identifierParties = (bom20) =>
  [
    bom20.inventories?.[0]?.subject,
    ...(bom20.inventories?.[0]?.components || []),
    ...(bom20.metadata?.tools?.components || []),
  ].flatMap((entry) =>
    (entry?.identifiers || []).map((identifier) => identifier.party),
  );

describe("claims on another tool's 1.x BOM (#4591)", () => {
  it("credits the identifiers to the listed tool and claims no identity analysis", async () => {
    const bom20 = renderCycloneDx20(foreignToolModel(SYFT_TOOLS));
    const toolPartyRefId =
      "party-tool-pkg:golang/github.com/anchore/syft@v1.20.0";
    const component = bom20.inventories[0].components[0];
    assert.deepStrictEqual(component.evidence.identity, [
      FOREIGN_TOOL_IDENTITY,
    ]);
    assert.deepStrictEqual(component.identifiers, [
      {
        party: toolPartyRefId,
        identities: [{ scheme: "purl", value: "pkg:npm/lib-a@1.0.0" }],
      },
    ]);
    assert.deepStrictEqual(bom20.definitions.parties, [
      {
        refId: toolPartyRefId,
        roles: [{ role: "asserter" }],
        system: {
          kind: "automation",
          label: "syft",
          ref: "pkg:golang/github.com/anchore/syft@v1.20.0",
        },
      },
    ]);
    assert.deepStrictEqual(cdxgenParties(bom20), []);
    assert.ok(
      !JSON.stringify(bom20).includes('"party-cdxgen"'),
      "nothing is credited to cdxgen",
    );
    assert.ok(precompiled20(bom20), "valid (precompiled)");
    assert.ok(
      await validateBom(bom20, { deep: false }),
      "valid (runtime-compiled)",
    );
    assertRefIntegrity(bom20, "syft tool party");
  });

  it("reads the tool party back without a loss and round-trips it", () => {
    const bom20 = renderCycloneDx20(foreignToolModel(SYFT_TOOLS));
    const { internalBom, losses } = readCycloneDx20(bom20);
    assert.deepStrictEqual(losses, []);
    // The derived party is the renderer's again: it reaches neither the 1.x
    // model nor the carried sections.
    assert.strictEqual(
      internalBom[CDX20_INTERNAL_SECTIONS_KEY]?.definitionsParties,
      undefined,
    );
    assert.ok(!JSON.stringify(internalBom).includes("party-tool-"));
    assert.deepStrictEqual(renderCycloneDx20(internalBom), bom20);
  });

  it("re-derives the tool party from edited 1.x tools", () => {
    const bom20 = renderCycloneDx20(foreignToolModel(SYFT_TOOLS));
    const { internalBom } = readCycloneDx20(bom20);
    internalBom.metadata.tools.components[1]["bom-ref"] = "urn:tool:syft";
    const edited = renderCycloneDx20(internalBom);
    assert.deepStrictEqual(edited.definitions.parties, [
      {
        refId: "party-tool-urn:tool:syft",
        roles: [{ role: "asserter" }],
        system: { kind: "automation", label: "syft", ref: "urn:tool:syft" },
      },
    ]);
    assert.ok(precompiled20(edited));
    assertRefIntegrity(edited, "edited syft tool party");
  });

  it("credits cdxgen, the converting tool, with the identifiers of a BOM without tools", async () => {
    const bom20 = renderCycloneDx20(foreignToolModel(undefined));
    const component = bom20.inventories[0].components[0];
    assert.deepStrictEqual(component.evidence.identity, [
      FOREIGN_TOOL_IDENTITY,
    ]);
    assert.deepStrictEqual(identifierParties(bom20), ["party-cdxgen"]);
    assert.deepStrictEqual(bom20.definitions.parties, [
      {
        refId: "party-cdxgen",
        roles: [{ role: "asserter" }],
        system: { kind: "automation", label: "cdxgen" },
      },
    ]);
    assert.ok(precompiled20(bom20), "valid (precompiled)");
    assert.ok(
      await validateBom(bom20, { deep: false }),
      "valid (runtime-compiled)",
    );
    assertRefIntegrity(bom20, "no tools");
    const { internalBom, losses } = readCycloneDx20(bom20);
    assert.deepStrictEqual(losses, []);
    assert.strictEqual(
      internalBom[CDX20_INTERNAL_SECTIONS_KEY]?.definitionsParties,
      undefined,
    );
    assert.deepStrictEqual(renderCycloneDx20(internalBom), bom20);
  });

  it("reports identifiers credited to a party the tools do not derive", () => {
    const bom20 = renderCycloneDx20(foreignToolModel(SYFT_TOOLS));
    const changed = structuredClone(bom20);
    changed.inventories[0].components[0].identifiers[0].party = "party-cdxgen";
    changed.definitions.parties.push({
      refId: "party-cdxgen",
      roles: [{ role: "asserter" }],
      system: { kind: "automation", label: "cdxgen" },
    });
    assert.ok(precompiled20(changed));
    const { internalBom, losses } = readCycloneDx20(changed);
    assert.ok(
      losses.some(
        (loss) =>
          loss.pointer === "/inventories/0/components/0/identifiers/0/party",
      ),
      "the identifier party is a loss",
    );
    // The component shadow restores the original attribution.
    assert.deepStrictEqual(renderCycloneDx20(internalBom), changed);
  });
});

describe("readCycloneDx20() and loadBomForAnalysis()", () => {
  it("reads a rendered document back and round-trips it", async () => {
    const bomNSData = await generateFixture(
      join("test", "data", "svelte-precision"),
      {
        projectType: ["js"],
        specVersion: "2.0",
      },
    );
    const first = bomNSData.bomJson;
    const { internalBom, losses } = readCycloneDx20(first);
    assert.ok(
      Array.isArray(internalBom.components),
      "internal model is 1.x-shaped",
    );
    assert.strictEqual(internalBom.bomFormat, "CycloneDX");
    assert.ok(
      internalBom.components.some((component) => component.purl),
      "identifiers read back into purl fields",
    );
    const second = renderCycloneDx20(internalBom);
    assert.ok(precompiled20(second), "re-rendered document validates");
    assert.deepStrictEqual(second, first);
    // The plan's round trip: render(read(render(internal))) equals
    // render(internal).
    const third = renderCycloneDx20(readCycloneDx20(second).internalBom);
    assert.ok(
      isDeepStrictEqual(third, second),
      "a second read+render cycle is stable",
    );
    // cdxgen's own document carries nothing 1.x cannot hold.
    assert.deepStrictEqual(losses, []);
  });

  it("flattens a definitions-declared document and reports extra subjects", () => {
    // Derived from upstream valid-component-evidence-assertion-2.0.json: the
    // components live in definitions.components and there is no subject.
    const bom20 = JSON.parse(
      readFileSync(
        join(UPSTREAM_DIR, "valid-component-evidence-assertion-2.0.json"),
        "utf-8",
      ),
    );
    const { internalBom, losses } = readCycloneDx20(bom20);
    assert.ok(internalBom.components.length > 0);
    const reRendered = renderCycloneDx20(internalBom);
    assert.ok(precompiled20(reRendered));
    // The evidence assertion and its 2.0-only technique have no 1.x field.
    const identity = "/definitions/components/0/evidence/identity/0";
    assert.deepStrictEqual(
      losses.map((loss) => loss.pointer),
      [
        `${identity}/methods/0/technique`,
        `${identity}/assertion`,
        `${identity}/timestamp`,
      ],
    );
    assert.ok(isDeepStrictEqual(reRendered, bom20), "kept for 2.0 output");
  });

  it("returns 1.x documents unchanged through loadBomForAnalysis", () => {
    const bom17 = {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      version: 1,
      components: [],
    };
    const { internalBom, specVersion, losses } = loadBomForAnalysis(bom17);
    assert.strictEqual(internalBom, bom17);
    assert.strictEqual(specVersion, "1.7");
    assert.strictEqual(losses.length, 0);
  });

  it("carries 2.0-only sections on the internal key and never leaks it", () => {
    const bom20 = JSON.parse(
      readFileSync(
        join(UPSTREAM_DIR, "valid-ai-ml-risk-integration-2.0.json"),
        "utf-8",
      ),
    );
    const { internalBom } = readCycloneDx20(bom20);
    assert.ok(internalBom[CDX20_INTERNAL_SECTIONS_KEY]);
    const reRendered = renderCycloneDx20(internalBom);
    assert.ok(
      !JSON.stringify(reRendered).includes(CDX20_INTERNAL_SECTIONS_KEY),
    );
    assert.ok(precompiled20(reRendered), "round trip validates");
  });
});

describe("getInternalBom() and refreshRenderedBom()", () => {
  it("falls back to bomJson at 1.x and refresh re-renders at 2.0", async () => {
    const bomNSData = await generateFixture(
      join("test", "data", "svelte-precision"),
      {
        projectType: ["js"],
        specVersion: "2.0",
      },
    );
    const { getInternalBom } = await import("./cyclonedx20.js");
    const internal = getInternalBom(bomNSData);
    assert.strictEqual(internal, bomNSData.internalBomJson);
    // A post-postProcess mutation of the internal model...
    internal.components.push({
      type: "library",
      "bom-ref": "pkg:npm/late@1.0.0",
      name: "late",
      version: "1.0.0",
      purl: "pkg:npm/late@1.0.0",
    });
    internal.dependencies.push({ ref: "pkg:npm/late@1.0.0", dependsOn: [] });
    refreshRenderedBom(bomNSData, { specVersion: "2.0" });
    assert.ok(
      bomNSData.bomJson.inventories[0].components.some(
        (component) => component.refId === "pkg:npm/late@1.0.0",
      ),
      "the mutation reaches the rendered document after refresh",
    );
    assert.ok(precompiled20(bomNSData.bomJson));
    // At 1.x both helpers leave the document alone.
    const bom17 = { bomJson: { bomFormat: "CycloneDX", specVersion: "1.7" } };
    assert.strictEqual(getInternalBom(bom17), bom17.bomJson);
    refreshRenderedBom(bom17, { specVersion: "1.7" });
    assert.ok(!bom17.internalBomJson);
  });
});

describe("upstream 2.0 example corpus", () => {
  const files = readdirSync(UPSTREAM_DIR).filter(
    (name) => name.startsWith("valid-") || name.startsWith("invalid-"),
  );

  it("accepts every upstream valid document with the precompiled validator", () => {
    const validFiles = files.filter((name) => name.startsWith("valid-"));
    assert.strictEqual(validFiles.length, 152);
    for (const name of validFiles) {
      const bom = JSON.parse(readFileSync(join(UPSTREAM_DIR, name), "utf-8"));
      assert.ok(precompiled20(bom), `${name} should validate`);
    }
  });

  it("accepts every upstream valid document with the runtime-compiled validator", () => {
    // A separate process, so the validator promise cached by earlier tests in
    // this file cannot answer for CDXGEN_PRECOMPILED_VALIDATORS=0.
    const result = spawnSync(
      process.execPath,
      [RUNTIME_VALIDATE_SCRIPT, UPSTREAM_DIR, "valid-"],
      {
        encoding: "utf-8",
        env: { ...process.env, CDXGEN_PRECOMPILED_VALIDATORS: "0" },
      },
    );
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const { accepted, rejected } = JSON.parse(result.stdout);
    assert.deepStrictEqual(rejected, []);
    assert.strictEqual(accepted.length, 152);
  });

  it("rejects every upstream invalid document", async () => {
    for (const name of files.filter((name) => name.startsWith("invalid-"))) {
      let bom;
      try {
        bom = JSON.parse(readFileSync(join(UPSTREAM_DIR, name), "utf-8"));
      } catch {
        continue;
      }
      assert.ok(!precompiled20(bom), `${name} must be rejected`);
      assert.ok(
        !(await validateBom(bom, { deep: false })),
        `${name} must be rejected by the runtime validator too`,
      );
    }
  });

  // The named negative fixtures prove the regenerated validator enforces the
  // exact structural rules cdxgen's old 2.0 output used to violate.
  it("rejects metadata.component and root components in 2.0", () => {
    // invalid-inventory-old-metadata-component-2.0.json
    // invalid-inventory-old-root-components-2.0.json
    for (const name of [
      "invalid-inventory-old-metadata-component-2.0.json",
      "invalid-inventory-old-root-components-2.0.json",
    ]) {
      const bom = JSON.parse(readFileSync(join(UPSTREAM_DIR, name), "utf-8"));
      assert.ok(!precompiled20(bom), `${name} must be rejected`);
    }
  });

  it("reads every upstream valid document without throwing", () => {
    for (const name of files.filter((name) => name.startsWith("valid-"))) {
      const bom = JSON.parse(readFileSync(join(UPSTREAM_DIR, name), "utf-8"));
      const { internalBom } = readCycloneDx20(bom);
      assert.ok(isRecord(internalBom));
      assert.ok(
        precompiled20(renderCycloneDx20(internalBom)),
        `${name} renders back to a valid document`,
      );
    }
  });

  // Every upstream valid document reads and renders back to the identical
  // document, except the ones below, whose losses say what 1.x and the read
  // could not keep. Before readCycloneDx20 kept shadows of the objects its
  // 1.x form cannot reproduce, only ORIGINAL_IDENTICAL round-tripped; that
  // set must never shrink.
  const NOT_IDENTICAL = {
    "valid-hardware-material-2.0.json":
      "a nested material component is dropped and definitions.components order changes",
    "valid-inventory-multi-product-shared-2.0.json":
      "the second inventory and its shared references have no 1.x form",
    "valid-measurements-2.0.json":
      "definitions.components order changes (root entries render after the carried material)",
  };
  // Crypto documents for which cdxgen derives post-quantum migration risks
  // (#4592), and only when it is a listed tool: as published (no cdxgen tool)
  // they render back identically; with cdxgen listed they gain exactly these.
  const DERIVED_ADDITIONS = {
    "valid-cryptography-certificate-2.0.json": [
      "risk-pqc-6b00f384-6c39-420f-91eb-94de0f7be569",
      "risk-pqc-a154af0a-0dca-4ed5-b611-2405a3a6ae47",
    ],
    "valid-cryptography-certificate-advanced-2.0.json": [
      "risk-pqc-2A0DA4D2-BBCA-4515-9BCD-C870A3EA4CE8",
      "risk-pqc-14478B86-9306-45B5-BA2A-1660B723244C",
    ],
    "valid-cryptography-full-2.0.json": [
      "risk-pqc-algorithm-ecdh-brainpool160r1",
      "risk-pqc-algorithm-rsa-sha256",
      "risk-pqc-algorithm-ffdh-group14",
      "risk-pqc-algorithm-ecdsa-p256",
      "risk-pqc-algorithm-rsaes-oaep-4096",
    ],
    // The hybrid combiner (draft-ietf-tls-hybrid-design-13) gets no risk.
    "valid-cryptography-implementation-2.0.json": ["risk-pqc-ecdhsecp521r1"],
  };
  const ORIGINAL_IDENTICAL = [
    "valid-attestation-2.0.json",
    "valid-behavior-process-2.0.json",
    "valid-behavior-statemachine-2.0.json",
    "valid-blueprint-authentication-2.0.json",
    "valid-blueprint-visualization-2.0.json",
    "valid-component-evidence-assertion-2.0.json",
    "valid-component-evidence-license-copyright-2.0.json",
    "valid-component-evidence-shared-technique-2.0.json",
    "valid-component-mediatype-2.0.json",
    "valid-component-ref-2.0.json",
    "valid-control-cdxa-claim-2.0.json",
    "valid-control-full-2.0.json",
    "valid-control-grc-standalone-2.0.json",
    "valid-control-minimal-2.0.json",
    "valid-data-erd-relationships-2.0.json",
    "valid-inventory-vex-only-2.0.json",
    "valid-perspective-2.0.json",
    "valid-release-notes-inline-2.0.json",
    "valid-risk-ai-bias-2.0.json",
    "valid-standard-2.0.json",
    "valid-threatmodel-simple-2.0.json",
    "valid-vex-mitigating-control-2.0.json",
    "valid-vulnerability-evidence-callstacks-2.0.json",
    "valid-vulnerability-evidence-hardened-2.0.json",
    "valid-vulnerability-evidence-llm-2.0.json",
    "valid-vulnerability-evidence-not-affected-2.0.json",
    "valid-vulnerability-evidence-perspectives-2.0.json",
    "valid-vulnerability-evidence-sast-rule-2.0.json",
    "valid-vulnerability-evidence-shared-occurrence-2.0.json",
    "valid-vulnerability-evidence-unknown-technique-2.0.json",
    "valid-weakness-kinds-2.0.json",
    "valid-weakness-reference-2.0.json",
  ];
  it("round trips every upstream valid document identically but the listed ones", () => {
    const validFiles = files.filter((name) => name.startsWith("valid-")).sort();
    const identical = [];
    for (const name of validFiles) {
      const bom = JSON.parse(readFileSync(join(UPSTREAM_DIR, name), "utf-8"));
      const { internalBom, losses } = readCycloneDx20(bom);
      const out = renderCycloneDx20(internalBom);
      if (Object.hasOwn(DERIVED_ADDITIONS, name)) {
        assert.deepStrictEqual(out, bom, `${name} renders back identically`);
        const withCdxgen = structuredClone(internalBom);
        withCdxgen.metadata ||= {};
        withCdxgen.metadata.tools = {
          components: [
            ...(withCdxgen.metadata.tools?.components || []),
            {
              type: "application",
              name: "cdxgen",
              version: "13.7.0",
              "bom-ref": "pkg:npm/@cdxgen/cdxgen@13.7.0",
            },
          ],
        };
        assert.deepStrictEqual(
          renderCycloneDx20(withCdxgen).risks.risks.map((risk) => risk.refId),
          DERIVED_ADDITIONS[name],
          `${name} gains exactly the derived risks once cdxgen is listed`,
        );
        identical.push(name);
      } else if (isDeepStrictEqual(out, bom)) {
        identical.push(name);
      } else {
        assert.ok(
          losses.length > 0,
          `${name} changes in the round trip, so it must report a loss`,
        );
      }
    }
    assert.deepStrictEqual(
      identical,
      validFiles.filter((name) => !Object.hasOwn(NOT_IDENTICAL, name)),
      "the identical round-trip set changed; update NOT_IDENTICAL only with a reason",
    );
    for (const name of ORIGINAL_IDENTICAL) {
      assert.ok(identical.includes(name), `${name} must stay identical`);
    }
  });
});

describe("2.0 CLI end to end", () => {
  it("renders the cbom-js-repotest crypto algorithms through the CLI", () => {
    // The fixture lists no package, so the CLI skips evinse here; the eight
    // algorithm assets come from the source analysis --include-crypto runs.
    // The evinse path itself is covered by the --evidence test below.
    const workDir = mkdtempSync(join(tmpdir(), "cdx20-cbom-"));
    const output = join(workDir, "cdx20-cbom-algos-test.json");
    const result = runCdxgen(
      [
        join(REPO_ROOT, "test", "data", "cbom-js-repotest"),
        "--include-crypto",
        "--evidence",
        "--deep",
        "--spec-version",
        "2.0",
        "-o",
        output,
      ],
      workDir,
    );
    assert.strictEqual(result.status, 0, result.stderr?.slice(-400));
    const bom20 = JSON.parse(readFileSync(output, "utf-8"));
    rmSync(workDir, { recursive: true, force: true });
    assert.ok(
      precompiled20(bom20),
      "CLI output validates against the pinned schema",
    );
    assertRefIntegrity(bom20, "cbom-js-repotest CLI");
    const components =
      bom20.inventories?.[0]?.components ?? bom20.definitions.components;
    const algorithms = components.filter(
      (component) => component.cryptoProperties?.assetType === "algorithm",
    );
    assert.strictEqual(algorithms.length, 8);
    assert.ok(
      algorithms.every((algorithm) => !algorithm.identifiers),
      "cryptographic assets never carry identifiers (they have no purl)",
    );
  });
});

describe("2.0 support boundaries", () => {
  it("keeps service components through the 2.0 component-type filter", () => {
    const types20 = getSupportedCycloneDxComponentTypes("2.0");
    assert.ok(types20.includes("service"));
    assert.ok(types20.includes("material"));
    const bom = {
      bomFormat: "CycloneDX",
      specVersion: "2.0",
      version: 1,
      metadata: { timestamp: "2026-01-01T00:00:00Z" },
      components: [
        { type: "library", "bom-ref": "pkg:npm/a@1.0.0", name: "a" },
      ],
      services: [
        { "bom-ref": "urn:service:demo:1", name: "demo", version: "1" },
      ],
    };
    const bom20 = renderCycloneDx20(bom);
    // No subject component, so the entries live in definitions.components.
    assert.ok(
      bom20.definitions.components.some(
        (component) => component.type === "service",
      ),
    );
    assert.ok(precompiled20(bom20));
  });

  it("keeps the 1.x component-type choices untouched at 1.x", () => {
    for (const version of ["1.5", "1.6", "1.7"]) {
      const types = getSupportedCycloneDxComponentTypes(version);
      assert.ok(!types.includes("service"), `${version} has no service type`);
      assert.ok(!types.includes("material"), `${version} has no material type`);
    }
  });

  it("rejects protobuf export at 2.0 with the version gap named", async () => {
    const { assertProtoSupportedSpecVersion } = await import("./protobom.js");
    assert.throws(
      () => assertProtoSupportedSpecVersion("2.0", "protobuf export"),
      /not currently supported.*@cdxgen\/cdx-proto/,
    );
  });

  it("exports SPDX from the internal model of a 2.0 run", async () => {
    const bomNSData = await generateFixture(
      join("test", "data", "svelte-precision"),
      {
        projectType: ["js"],
        specVersion: "2.0",
      },
    );
    const spdxJson = convertCycloneDxToSpdx(bomNSData.internalBomJson, {
      specVersion: "2.0",
      filePath: join("test", "data", "svelte-precision"),
    });
    assert.ok(spdxJson, "SPDX export works at 2.0 from the internal model");
    const { validateSpdx } = await import("../validator/bomValidator.js");
    assert.ok(validateSpdx(spdxJson), "the SPDX export validates");
  });

  it("signs a 2.0 document with JSS through the CLI and verifies", () => {
    // CycloneDX 2.0 signs with the JSON Signature Scheme of ITU-T X.590 (see
    // lib/helpers/jssSigner.poku.js for the algorithm and vector tests). The
    // generated keys land next to the output, inside the temporary cwd.
    const workDir = mkdtempSync(join(tmpdir(), "cdx20-sign-"));
    try {
      const output = join(workDir, "cdx20-sign-e2e-test.json");
      const signResult = runCdxgen(
        [
          join(REPO_ROOT, "test", "data", "svelte-precision"),
          "--spec-version",
          "2.0",
          "--generate-key-and-sign",
          "-o",
          output,
        ],
        workDir,
      );
      assert.strictEqual(
        signResult.status,
        0,
        `${signResult.stdout?.slice(-400)}\n${signResult.stderr?.slice(-400)}`,
      );
      const signedBom = JSON.parse(readFileSync(output, "utf-8"));
      assert.ok(signedBom.signatures?.length, "root JSS signature present");
      assert.strictEqual(signedBom.signatures[0].algorithm, "Ed25519");
      const privateKeyFile = join(workDir, "private.key");
      assert.ok(existsSync(privateKeyFile), "the private key is in the cwd");
      if (process.platform !== "win32") {
        assert.strictEqual(
          statSync(privateKeyFile).mode & 0o777,
          0o600,
          "the generated private key is readable by the owner only",
        );
      }
      const verifyResult = spawnSync(
        process.execPath,
        [
          join(REPO_ROOT, "bin", "verify.js"),
          "--public-key",
          join(workDir, "public.key"),
          "-i",
          output,
        ],
        { cwd: workDir, encoding: "utf-8" },
      );
      assert.strictEqual(
        verifyResult.status,
        0,
        verifyResult.stderr || verifyResult.stdout,
      );
      assert.match(verifyResult.stdout, /JSS signature\(s\) verified/u);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("does not read keys or sign a 2.0 document in dry run", () => {
    const workDir = mkdtempSync(join(tmpdir(), "cdx20-sign-dry-"));
    try {
      const output = join(workDir, "cdx20-dry-run.json");
      const result = spawnSync(
        process.execPath,
        [
          CDXGEN_BIN,
          join(REPO_ROOT, "test", "data", "svelte-precision"),
          "--spec-version",
          "2.0",
          "--generate-key-and-sign",
          "--dry-run",
          "-o",
          output,
        ],
        {
          cwd: workDir,
          encoding: "utf-8",
          env: { ...process.env, CDXGEN_NO_CACHE: "true" },
        },
      );
      const combined = `${result.stdout}\n${result.stderr}`;
      assert.strictEqual(result.status, 0, combined.slice(-400));
      assert.doesNotMatch(combined, /Created public\/private key pairs/u);
      assert.doesNotMatch(combined, /verifiable natively/u);
      assert.doesNotMatch(
        combined,
        /\|\s*sign\s*\|[^\n]*\|\s*completed/u,
        "no signing activity completes in dry run",
      );
      assert.deepStrictEqual(readdirSync(workDir), [], "nothing is written");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

/** Render a synthetic fixture and check it against the precompiled schema. */
function renderFixture(name) {
  const { bomJson, report } = renderCycloneDx20WithReport(
    readRenderFixture(name),
  );
  assert.ok(
    precompiled20(bomJson),
    `${name}: validates with the precompiled validator: ${JSON.stringify(precompiled20.errors?.slice(0, 3))}`,
  );
  assertRefIntegrity(bomJson, name);
  return { bom20: bomJson, drops: report.drops, rewrites: report.rewrites };
}

const componentByRefId = (bom20, refId) =>
  renderedComponents(bom20).find((component) => component.refId === refId);

describe("renderCycloneDx20() on synthetic internal models", () => {
  it("validates every fixture with the runtime-compiled validator too", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cdx20-render-"));
    for (const name of RENDER_FIXTURES) {
      writeFileSync(
        join(outDir, `${name}.json`),
        JSON.stringify(renderCycloneDx20(readRenderFixture(name))),
      );
    }
    const result = spawnSync(
      process.execPath,
      [RUNTIME_VALIDATE_SCRIPT, outDir],
      {
        encoding: "utf-8",
        env: { ...process.env, CDXGEN_PRECOMPILED_VALIDATORS: "0" },
      },
    );
    rmSync(outDir, { recursive: true, force: true });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.deepStrictEqual(JSON.parse(result.stdout).rejected, []);
  });

  it("renders services with endpoints, data, provider and trust fields", () => {
    const { bom20, drops } = renderFixture("services");
    const payments = componentByRefId(
      bom20,
      "urn:service:billing:payments-api:1",
    );
    assert.strictEqual(payments.type, "service");
    assert.strictEqual(payments.group, "billing");
    assert.deepStrictEqual(payments.endpoints, [
      "https://payments.example.com/v1/charge",
      "https://payments.example.com/v1/refund",
    ]);
    assert.deepStrictEqual(payments.parties, [
      {
        roles: [{ role: "provider" }],
        organization: {
          name: "Example Payments Ltd",
          url: [{ url: "https://payments.example.com" }],
        },
      },
      {
        roles: [{ role: "provider" }],
        person: {
          name: "Payments Support",
          email: [{ address: "support@payments.example.com" }],
          phone: [{ number: "+1-555-0100" }],
        },
      },
    ]);
    // 1.x free-text classifications use the custom {name} branch; the data
    // flow has no 2.0 field and is counted.
    assert.deepStrictEqual(payments.data[0], {
      type: "other",
      name: "cardholder",
      classification: { name: "PII" },
    });
    assert.deepStrictEqual(payments.data[1], {
      type: "other",
      name: "receipt",
      classification: "public",
      governance: [
        {
          roles: [{ role: "steward" }],
          person: {
            name: "Data Steward",
            email: [{ address: "steward@billing.example.com" }],
          },
        },
        {
          roles: [{ role: "owner" }],
          organization: {
            name: "Billing Team",
            url: [{ url: "https://billing.example.com" }],
          },
        },
      ],
    });
    assert.deepStrictEqual(payments.licenses, [
      { license: { id: "Apache-2.0" } },
    ]);
    assert.deepStrictEqual(payments.components, [
      {
        type: "service",
        refId: "urn:service:billing:fraud-check:1",
        name: "fraud-check",
        version: "1",
        endpoints: ["https://payments.example.com/v1/fraud"],
      },
    ]);
    assert.deepStrictEqual(bom20.dependencies[2], {
      ref: "urn:service:billing:payments-api:1",
      dependsOn: ["urn:service:billing:fraud-check:1"],
    });
    // authenticated, x-trust-boundary and trustZone have no 2.0 field; they
    // ride as the documented cdx:service:* properties after the service's
    // own properties, and are not counted as drops.
    assert.deepStrictEqual(payments.properties, [
      { name: "cdx:service:httpMethod", value: "POST" },
      { name: "cdx:service:authenticated", value: "true" },
      { name: "cdx:service:xTrustBoundary", value: "true" },
      { name: "cdx:service:trustZone", value: "pci" },
    ]);
    assert.strictEqual(drops["service.authenticated"], undefined);
    assert.strictEqual(drops["service.x-trust-boundary"], undefined);
    assert.strictEqual(drops["service.trustZone"], undefined);
    assert.strictEqual(drops["service.data.flow"], 2);
  });

  it("reads the carried service fields back without duplicating them", () => {
    const internal = readRenderFixture("services");
    const bom20 = renderCycloneDx20(internal);
    const { internalBom, losses } = readCycloneDx20(bom20);
    const payments = internalBom.services.find(
      (service) => service["bom-ref"] === "urn:service:billing:payments-api:1",
    );
    assert.strictEqual(payments.authenticated, true);
    assert.strictEqual(payments["x-trust-boundary"], true);
    assert.strictEqual(payments.trustZone, "pci");
    // The carried properties leave the 1.x property list.
    assert.deepStrictEqual(payments.properties, [
      { name: "cdx:service:httpMethod", value: "POST" },
    ]);
    assert.ok(
      !losses.some((loss) => loss.pointer.includes("/properties")),
      JSON.stringify(losses),
    );
    // Rendering the read model gives the same document: no property twice.
    const again = renderCycloneDx20(internalBom);
    assert.deepStrictEqual(again, bom20);
    assert.deepStrictEqual(
      componentByRefId(again, "urn:service:billing:payments-api:1")
        .properties.map((property) => property.name)
        .filter((name) => name !== "cdx:service:httpMethod"),
      [
        "cdx:service:authenticated",
        "cdx:service:xTrustBoundary",
        "cdx:service:trustZone",
      ],
    );
    // A false boolean round trips as false, and a value that does not parse
    // as a boolean stays a property (no 1.x boolean can hold it).
    const odd = structuredClone(bom20);
    const oddPayments = componentByRefId(
      odd,
      "urn:service:billing:payments-api:1",
    );
    oddPayments.properties = [
      { name: "cdx:service:xTrustBoundary", value: "false" },
      { name: "cdx:service:authenticated", value: "sometimes" },
    ];
    const oddRead = readCycloneDx20(odd).internalBom.services.find(
      (service) => service["bom-ref"] === "urn:service:billing:payments-api:1",
    );
    assert.strictEqual(oddRead["x-trust-boundary"], false);
    assert.strictEqual(oddRead.authenticated, undefined);
    assert.deepStrictEqual(oddRead.properties, [
      { name: "cdx:service:authenticated", value: "sometimes" },
    ]);
    // Out of render order, the shadow keeps the document identical.
    assert.deepStrictEqual(
      renderCycloneDx20(readCycloneDx20(odd).internalBom),
      odd,
    );
  });

  it("renders purl, cpe, swid, omniborId and swhid identities", () => {
    const { bom20, drops } = renderFixture("identifiers");
    const openssl = componentByRefId(bom20, "pkg:generic/openssl@3.0.13");
    assert.deepStrictEqual(openssl.identifiers, [
      {
        party: "party-cdxgen",
        identities: [
          { scheme: "purl", value: "pkg:generic/openssl@3.0.13" },
          {
            scheme: "cpe",
            value: "cpe:2.3:a:openssl:openssl:3.0.13:*:*:*:*:*:*:*",
          },
          { scheme: "swid", value: "swidgen-openssl-3.0.13" },
        ],
      },
    ]);
    const file = componentByRefId(
      bom20,
      "gitoid:blob:sha1:0b5e1d3a4f6c7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    );
    assert.deepStrictEqual(file.identifiers[0].identities, [
      {
        scheme: "omniborid",
        value: "gitoid:blob:sha1:0b5e1d3a4f6c7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      },
      {
        scheme: "swhid",
        value: "swh:1:cnt:0b5e1d3a4f6c7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      },
    ]);
    const party = bom20.definitions.parties.find(
      (candidate) => candidate.refId === "party-cdxgen",
    );
    assert.deepStrictEqual(party, {
      refId: "party-cdxgen",
      roles: [{ role: "asserter" }],
      system: {
        kind: "automation",
        label: "cdxgen",
        ref: "pkg:npm/@cdxgen/cdxgen@13.7.0",
      },
    });
    // 2.0 identifies a SWID tag by its tagId; the other tag members are
    // counted.
    assert.deepStrictEqual(drops, {
      "component.swid.name": 1,
      "component.swid.version": 1,
    });
  });

  it("omits the party's system.ref when no cdxgen tool refId is declared", () => {
    const internal = readRenderFixture("identifiers");
    delete internal.metadata.tools;
    const bom20 = renderCycloneDx20(internal);
    assert.ok(precompiled20(bom20));
    assertRefIntegrity(bom20, "identifiers without tools");
    const party = bom20.definitions.parties.find(
      (candidate) => candidate.refId === "party-cdxgen",
    );
    assert.deepStrictEqual(party.system, {
      kind: "automation",
      label: "cdxgen",
    });
  });

  it("renders suppliers, manufacturers and authors as valid 2.0 parties", () => {
    const { bom20, drops } = renderFixture("parties");
    // A Hugging Face supplier: url strings become {url} objects.
    assert.deepStrictEqual(
      componentByRefId(
        bom20,
        "pkg:huggingface/google-bert/bert-base-uncased@main",
      ).parties,
      [
        {
          roles: [{ role: "supplier" }],
          organization: {
            name: "google-bert",
            url: [{ url: "https://huggingface.co/google-bert" }],
          },
        },
      ],
    );
    // A supplier with a bom-ref: the bom-ref is the party's refId.
    const requests = componentByRefId(bom20, "pkg:pypi/requests@2.32.3");
    assert.deepStrictEqual(requests.parties, [
      { roles: [{ role: "author" }], person: { name: "Kenneth Reitz" } },
      { roles: [{ role: "author" }], person: { name: "Nate Prewitt" } },
      {
        roles: [{ role: "author" }],
        person: {
          name: "PSF Maintainers",
          email: [{ address: "maintainers@python.org" }],
          phone: [{ number: "+1-555-0199" }],
        },
      },
      {
        roles: [{ role: "publisher" }],
        organization: { name: "Python Software Foundation" },
      },
      {
        refId: "supplier-psf",
        roles: [{ role: "supplier" }],
        organization: { name: "Python Software Foundation" },
      },
    ]);
    // A supplier with contacts: each contact becomes a person party, and the
    // manufacturer address moves to `addresses`.
    const gateway = componentByRefId(bom20, "urn:device:edge-gateway:4");
    assert.deepStrictEqual(gateway.parties, [
      {
        roles: [{ role: "supplier" }],
        organization: { name: "Gateway Vendor" },
      },
      {
        refId: "gateway-contact",
        roles: [{ role: "supplier" }],
        person: {
          name: "Gateway Support",
          email: [{ address: "support@gateway.example.com" }],
          phone: [{ number: "+44 20 7946 0000" }],
        },
      },
      {
        roles: [{ role: "supplier" }],
        person: { email: [{ address: "security@gateway.example.com" }] },
      },
      {
        roles: [{ role: "manufacturer" }],
        organization: {
          name: "Gateway Factory",
          url: [
            { url: "https://factory.example.com" },
            { url: "https://factory.example.com/about" },
          ],
          addresses: [
            {
              refId: "factory-address",
              country: "DE",
              region: "Bavaria",
              locality: "Munich",
              postalCode: "80331",
              streetAddress: "Industriestr. 9",
            },
          ],
        },
      },
    ]);
    // metadata keeps the common organizationalEntity, with refIds.
    assert.deepStrictEqual(bom20.metadata.authors, [
      {
        refId: "metadata-author-1",
        name: "Jane Builder",
        email: "jane@example.com",
      },
    ]);
    assert.deepStrictEqual(bom20.metadata.supplier, {
      refId: "metadata-supplier",
      name: "Example Corp",
      address: {
        country: "US",
        locality: "Springfield",
        streetAddress: "1 Main St",
      },
      url: ["https://example.com"],
      contact: [{ name: "Release Desk", email: "release@example.com" }],
    });
    // Every bom-ref has a 2.0 home (party and address refIds).
    assert.deepStrictEqual(drops, {});
  });

  it("keeps the scope of assemblies and dependencies compositions", () => {
    const { bom20, drops } = renderFixture("compositions");
    assert.deepStrictEqual(bom20.compositions, [
      {
        kind: "components",
        aggregate: "incomplete",
        targets: ["inventory-pkg:npm/app@1.0.0"],
      },
      {
        kind: "components",
        aggregate: "complete",
        targets: ["inventory-pkg:npm/app@1.0.0"],
      },
      {
        kind: "components",
        aggregate: "incomplete-first-party-only",
        targets: ["pkg:npm/a@1.0.0", "pkg:npm/b@2.0.0"],
      },
      {
        kind: "dependencies",
        aggregate: "incomplete-first-party-only",
        targets: ["pkg:npm/app@1.0.0"],
      },
    ]);
    assert.deepStrictEqual(drops, {
      "composition (aggregate outside the 2.0 enum)": 1,
      "composition (no declared target)": 1,
      "composition target (undeclared)": 1,
      "composition.bom-ref": 1,
    });
  });

  it("renders tool, service, organization and individual annotators", () => {
    const { bom20, drops, rewrites } = renderFixture("annotations");
    const [summary, byService, byInlineService, byOrganization, byPerson] =
      bom20.annotations;
    // The tool is declared in metadata.tools, so the annotator references it
    // and the serial-number subject is retargeted to the inventory.
    assert.deepStrictEqual(summary.annotator, {
      component: { ref: "pkg:npm/@cdxgen/cdxgen@13.7.0" },
    });
    assert.deepStrictEqual(summary.subjects, [
      "inventory-pkg:npm/annotated-app@1.0.0",
    ]);
    assert.strictEqual(summary.refId, "annotation-summary");
    // A service annotator becomes a component; this one is a tool already.
    assert.deepStrictEqual(byService.annotator, {
      component: { ref: "urn:service:scanner:remote-audit:1" },
    });
    assert.deepStrictEqual(byService.subjects, ["pkg:npm/lodash@4.17.21"]);
    assert.deepStrictEqual(byInlineService.annotator, {
      component: {
        type: "service",
        refId: "urn:service:reviewer:inline:1",
        name: "inline-reviewer",
        endpoints: ["https://review.example.com"],
      },
    });
    assert.deepStrictEqual(byOrganization.subjects, [
      "urn:cdx:0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f/1#pkg:npm/lodash@4.17.21",
    ]);
    assert.deepStrictEqual(byOrganization.annotator.organization, {
      refId: "annotator-org",
      name: "Example Security Team",
      url: ["https://security.example.com"],
      contact: [
        {
          refId: "annotator-org-contact",
          name: "Triage",
          email: "triage@security.example.com",
        },
      ],
    });
    assert.deepStrictEqual(byPerson.annotator, {
      individual: {
        refId: "annotator-person",
        name: "Alex Reviewer",
        email: "alex@example.com",
      },
    });
    // Retargeting a subject and turning a repeated refId into a reference
    // lose nothing, so they are rewrites, not drops.
    assert.deepStrictEqual(drops, {
      "annotation subject (undeclared)": 1,
    });
    assert.deepStrictEqual(rewrites, {
      "annotation subject (serial number → inventory)": 1,
      "duplicate refId (rendered as a reference)": 2,
    });
    // Each reference replaced an annotator whose every member the declared
    // tool already holds: the cdxgen annotator equals the tool, and the
    // service annotator is the tool service without its endpoints.
    const tools = bom20.metadata.tools.components;
    const cdxgenTool = tools.find(
      (tool) => tool.refId === "pkg:npm/@cdxgen/cdxgen@13.7.0",
    );
    assert.deepStrictEqual(
      [cdxgenTool.name, cdxgenTool.version, cdxgenTool.group],
      ["cdxgen", "13.7.0", "@cdxgen"],
    );
    const auditTool = tools.find(
      (tool) => tool.refId === "urn:service:scanner:remote-audit:1",
    );
    assert.deepStrictEqual(
      [auditTool.type, auditTool.name, auditTool.version, auditTool.endpoints],
      ["service", "remote-audit", "1", ["https://audit.example.com/api"]],
    );
  });

  it("drops the serial-number subject of a subject-less document", () => {
    const internal = readRenderFixture("annotations");
    // Without a subject there is no inventory to retarget to; the
    // dependency on the old subject goes with it.
    delete internal.metadata.component;
    delete internal.dependencies;
    const { bomJson, report } = renderCycloneDx20WithReport(internal);
    assert.ok(precompiled20(bomJson));
    assertRefIntegrity(bomJson, "subject-less annotations");
    assert.deepStrictEqual(bomJson.annotations[0].subjects, []);
    // The serial number, the undeclared component and the removed subject.
    assert.strictEqual(report.drops["annotation subject (undeclared)"], 3);
  });

  it("normalizes legacy tools, evidence licenses, data and crypto families", () => {
    const { bom20, drops } = renderFixture("legacy");
    // The 1.5 tools array becomes components; vendor maps to publisher.
    assert.deepStrictEqual(bom20.metadata.tools.components, [
      {
        refId: "pkg:npm/@cdxgen/cdxgen@13.7.0",
        type: "application",
        name: "cdxgen",
        version: "13.7.0",
        parties: [
          {
            roles: [{ role: "publisher" }],
            organization: { name: "OWASP Foundation" },
          },
        ],
      },
    ]);
    assert.ok(!bom20.metadata.manufacture);
    const vendored = componentByRefId(bom20, "pkg:npm/vendored@1.2.3");
    assert.deepStrictEqual(vendored.evidence.licenses, [
      { license: { id: "MIT" } },
      { license: { name: "Custom Vendor License" } },
      { expression: "Apache-2.0 OR MIT" },
    ]);
    assert.deepStrictEqual(vendored.evidence.callStacks, [
      { frames: [{ module: "vendored", function: "init", line: 10 }] },
    ]);
    assert.strictEqual(
      vendored.pedigree.ancestors[0].refId,
      "pkg:npm/vendored-upstream@1.2.0",
    );
    assert.ok(!vendored.signature, "signature has no 2.0 field");
    assert.deepStrictEqual(
      componentByRefId(bom20, "urn:data:training-config").data,
      [
        {
          refId: "urn:data:training-config:contents",
          type: "configuration",
          name: "training.yaml",
          contents: {
            attachment: {
              mediaType: "application/yaml",
              content: "epochs: 3",
            },
            url: "https://example.com/training.yaml",
          },
          classification: "internal",
        },
      ],
    );
    // KMAC is not in the pinned 2.0 algorithm family enum; AES is.
    const kmac = componentByRefId(
      bom20,
      "crypto/algorithm/kmac256@2.16.840.1.101.3.4.2.20",
    );
    assert.deepStrictEqual(kmac.cryptoProperties.algorithmProperties, {
      primitive: "mac",
      cryptoFunctions: ["tag"],
    });
    assert.strictEqual(
      componentByRefId(
        bom20,
        "crypto/algorithm/aes-256-gcm@2.16.840.1.101.3.4.1.46",
      ).cryptoProperties.algorithmProperties.algorithmFamily,
      "AES",
    );
    assert.deepStrictEqual(drops, {
      "component.data.description": 1,
      "component.modified": 1,
      "component.pedigree.notes": 1,
      "component.signature": 1,
      "cryptoProperties.algorithmProperties.algorithmFamily": 1,
      "evidence.licenses.acknowledgement": 1,
      "evidence.licenses.license.acknowledgement": 1,
      "evidence.licenses.license.text": 1,
      "evidence.licenses.license.url": 1,
      "metadata.manufacture": 1,
      "metadata.tools (legacy entry without a name)": 1,
    });
  });
});

describe("renderCycloneDx20() reference integrity and 1.x sections", () => {
  it("keeps the subject of a self-scan and references only what covers a repeat", () => {
    const { bom20, drops, rewrites } = renderFixture("self-scan");
    const subject = bom20.inventories[0].subject;
    // The subject repeats the refId of the cdxgen tool; the inventory is
    // walked first, so it keeps its licenses, hashes and properties.
    assert.strictEqual(subject.refId, "pkg:npm/@cdxgen/cdxgen@13.7.0");
    assert.deepStrictEqual(subject.licenses, [
      { license: { id: "Apache-2.0" } },
    ]);
    assert.strictEqual(subject.hashes.length, 1);
    assert.deepStrictEqual(subject.properties, [
      { name: "SrcFile", value: "package.json" },
    ]);
    // The tool has a publisher the subject lacks, and the annotator another
    // version: each keeps its members under a new refId.
    assert.strictEqual(
      bom20.metadata.tools.components[0].refId,
      "pkg:npm/@cdxgen/cdxgen@13.7.0-dup-1",
    );
    assert.deepStrictEqual(bom20.annotations[0].annotator.component, {
      refId: "pkg:npm/@cdxgen/cdxgen@13.7.0-dup-2",
      type: "application",
      name: "cdxgen",
      version: "13.6.0",
      group: "@cdxgen",
    });
    // The subject declares the supplier party; the components' equal
    // supplier parties become partyReferences, and the organizationalEntity
    // in metadata.supplier, which has no reference form, a new refId.
    const supplierParty = subject.parties.find(
      (party) => party.refId === "supplier-owasp",
    );
    assert.ok(supplierParty?.organization);
    for (const component of bom20.inventories[0].components.slice(0, 2)) {
      assert.deepStrictEqual(component.parties, [{ ref: "supplier-owasp" }]);
    }
    assert.strictEqual(bom20.metadata.supplier.refId, "supplier-owasp-dup-1");
    // Formula components the inventory declares stay out of definitions;
    // the workflow's resource reference resolves to the inventory entry.
    assert.strictEqual(bom20.definitions.components, undefined);
    assert.ok(
      bom20.inventories[0].components.some(
        (component) => component.refId === "pkg:github/actions/checkout@v4",
      ),
    );
    assert.deepStrictEqual(rewrites, {
      "definitions component (already declared in inventory)": 1,
      "duplicate refId (kept under a new refId)": 3,
      "duplicate refId (rendered as a reference)": 2,
    });
    assert.deepStrictEqual(drops, {
      "definitions component (already declared in inventory; members it adds dropped)": 1,
    });
  });

  it("never renders a reference form in definitions.components", () => {
    const internal = readRenderFixture("self-scan");
    delete internal.metadata.component;
    const { bomJson } = renderCycloneDx20WithReport(internal);
    assert.ok(precompiled20(bomJson));
    assertRefIntegrity(bomJson, "subject-less self-scan");
    for (const entry of bomJson.definitions.components) {
      assert.ok(entry.ref === undefined && isNonEmptyRefId(entry.refId));
    }
  });

  it("renames standards, patents and declarations members and counts signatures", () => {
    const { bom20, drops } = renderFixture("definitions");
    const [standard] = bom20.definitions.standards;
    assert.strictEqual(standard.refId, "std-example-1.0");
    assert.strictEqual(
      standard.description,
      "A two-level standard for the test.",
    );
    assert.deepStrictEqual(
      standard.requirements.map((requirement) => requirement.refId),
      ["req-1", "req-1.1"],
    );
    assert.strictEqual(standard.requirements[1].parent, "req-1");
    assert.deepStrictEqual(standard.levels[0].requirements, [
      "req-1",
      "req-1.1",
    ]);
    assert.ok(!JSON.stringify(bom20).includes('"bom-ref"'));
    assert.deepStrictEqual(
      bom20.definitions.patents.map((patent) => patent.refId),
      ["patent-us-1", "family-1"],
    );
    const component = bom20.inventories[0].components[0];
    assert.deepStrictEqual(component.patentAssertions, [
      {
        refId: "assertion-2",
        assertionType: "ownership",
        patentRefs: ["patent-us-1"],
        asserter: {
          refId: "asserter-org-2",
          name: "Patent Holder Inc",
          url: ["https://patents.example.com"],
        },
      },
    ]);
    const { declarations } = bom20;
    assert.strictEqual(declarations.assessors[0].refId, "assessor-1");
    assert.strictEqual(declarations.claims[0].refId, "claim-1");
    assert.deepStrictEqual(declarations.evidence[0].data[0].contents, {
      attachment: { mediaType: "text/markdown", content: "# Threat model" },
    });
    assert.deepStrictEqual(
      declarations.targets.components.map((entry) => entry.type),
      ["library", "service"],
    );
    assert.deepStrictEqual(
      declarations.affirmation.signatories.map((signatory) => signatory.name),
      ["Signs Elsewhere"],
    );
    const signatureReason =
      "(1.x JSF signature: does not verify after re-rendering)";
    assert.deepStrictEqual(drops, {
      "declarations.affirmation.signatories (no organization and external reference)": 1,
      [`declarations.affirmation.signatories.signature ${signatureReason}`]: 1,
      [`declarations.affirmation.signature ${signatureReason}`]: 1,
      [`declarations.attestations.signature ${signatureReason}`]: 1,
      [`declarations.signature ${signatureReason}`]: 1,
      [`definitions.standards.signature ${signatureReason}`]: 1,
      "document.x-unknown-root-member": 1,
      "patentAssertions (no asserter)": 1,
      "patentAssertions.asserter (neither an organization nor a contact)": 1,
      [`signature ${signatureReason}`]: 1,
    });
  });

  it("renders the ASVS 5.0 template and an escape standard with refIds", () => {
    for (const file of [
      join("data", "templates", "asvs-5.0.cdx.json"),
      join("test", "data", "standards-escape", "escape.cdx.json"),
    ]) {
      const { bomJson, report } = renderCycloneDx20WithReport(
        JSON.parse(readFileSync(file, "utf-8")),
      );
      assert.ok(
        precompiled20(bomJson),
        `${file}: ${JSON.stringify(precompiled20.errors?.slice(0, 3))}`,
      );
      assertRefIntegrity(bomJson, file);
      assert.ok(bomJson.definitions.standards.length > 0);
      assert.ok(!JSON.stringify(bomJson).includes('"bom-ref"'));
      assert.deepStrictEqual(report.drops, {}, file);
    }
  });

  it("converts every attachment and resolves dependencies and affects", () => {
    const { bom20, drops } = renderFixture("attachments");
    const [patched, service] = bom20.inventories[0].components;
    assert.deepStrictEqual(patched.licenses[0].license.text, {
      mediaType: "text/markdown",
      content: "# Custom License",
    });
    assert.deepStrictEqual(patched.licenses[1].license.text, {
      mediaType: "text/plain; charset=utf-8",
      encoding: "base64",
      content: "TGljZW5zZQ==",
    });
    assert.deepStrictEqual(patched.releaseNotes.notes, [
      {
        locale: "en-US",
        text: { mediaType: "text/markdown", content: "Fixed a bug." },
      },
    ]);
    assert.deepStrictEqual(patched.pedigree.patches[0].diff.text, {
      mediaType: "text/x-diff",
      content: "--- a\n+++ b\n",
    });
    assert.deepStrictEqual(service.releaseNotes.notes, [
      { text: { content: "Service notes." } },
    ]);
    const [vulnerability, unresolved] = bom20.vulnerabilities;
    assert.deepStrictEqual(
      vulnerability.proofOfConcept.supportingMaterial.map(
        (attachment) => attachment.mediaType,
      ),
      ["text/markdown", "text/xml", "image/png"],
    );
    assert.deepStrictEqual(vulnerability.credits, {
      organizations: [
        {
          refId: "credit-org",
          name: "Finder Labs",
          url: ["https://finder.example.com"],
        },
      ],
      individuals: [
        {
          refId: "credit-person",
          name: "Jo Finder",
          email: "jo@finder.example.com",
        },
      ],
    });
    assert.deepStrictEqual(
      vulnerability.affects.map((entry) => entry.ref),
      [
        "pkg:npm/patched@1.0.0",
        "urn:cdx:3e671687-395b-41f5-a30f-a58921a69b79/1#pkg:npm/elsewhere@1.0.0",
      ],
    );
    assert.strictEqual(unresolved.affects, undefined);
    assert.deepStrictEqual(bom20.dependencies, [
      {
        ref: "pkg:npm/attached-app@3.0.0",
        dependsOn: ["pkg:npm/patched@1.0.0"],
      },
      { ref: "pkg:npm/patched@1.0.0", dependsOn: [] },
    ]);
    // A 1.x string entry is a name with a null value; the repeated name
    // keeps its first value.
    assert.deepStrictEqual(
      bom20.formulation[0].workflows[0].inputs[0].environmentVars,
      { NODE_ENV: "production", CI: null },
    );
    assert.deepStrictEqual(drops, {
      "component.swid.name": 1,
      "component.swid.patch": 1,
      "component.swid.tagVersion": 1,
      "component.swid.version": 1,
      "dependency (undeclared ref)": 1,
      "dependency.dependsOn (undeclared ref)": 1,
      "environmentVars (repeated name)": 1,
      "releaseNotes.notes.text (no content)": 1,
      "releaseNotes.notes.text.contentType (not a media type)": 1,
      "vulnerability.affects (undeclared ref)": 2,
      "vulnerability.signature": 1,
    });
  });

  it("moves deprecated crypto references to relatedCryptographicAssets", () => {
    const { bom20, drops, rewrites } = renderFixture("crypto");
    const byRef = (refId) => componentByRefId(bom20, refId).cryptoProperties;
    assert.deepStrictEqual(
      byRef("crypto/certificate/server").certificateProperties
        .relatedCryptographicAssets,
      [
        { type: "algorithm", ref: "crypto/algorithm/rsa-2048" },
        { type: "publicKey", ref: "crypto/key/server" },
      ],
    );
    assert.strictEqual(
      byRef("crypto/certificate/server").certificateProperties
        .certificateFileExtension,
      "crt",
    );
    const key = byRef("crypto/key/server").relatedCryptoMaterialProperties;
    assert.deepStrictEqual(key.relatedCryptographicAssets, [
      { type: "algorithm", ref: "crypto/algorithm/rsa-2048" },
    ]);
    assert.deepStrictEqual(key.securedBy, {
      mechanism: "HSM",
      algorithmRef: ["crypto/algorithm/rsa-2048"],
    });
    const protocol = byRef("crypto/protocol/ikev2").protocolProperties;
    assert.deepStrictEqual(protocol.relatedCryptographicAssets, [
      { type: "algorithm", ref: "crypto/algorithm/rsa-2048" },
    ]);
    assert.deepStrictEqual(protocol.ikev2TransformTypes.encr, [
      { algorithm: "crypto/algorithm/rsa-2048" },
    ]);
    assert.deepStrictEqual(drops, {
      "cryptoProperties.algorithmProperties.certificationLevel": 1,
      "cryptoProperties.protocolProperties.type": 1,
    });
    assert.strictEqual(Object.keys(rewrites).length, 6);
  });

  it("renders the tracebom chain certificates as a valid 2.0 document", () => {
    const { bomJson, report } = renderCycloneDx20WithReport(
      JSON.parse(
        readFileSync(
          join("test", "data", "tracebom-chain", "bom-1.6.json"),
          "utf-8",
        ),
      ),
    );
    assert.ok(
      precompiled20(bomJson),
      JSON.stringify(precompiled20.errors?.slice(0, 3)),
    );
    assertRefIntegrity(bomJson, "tracebom-chain");
    assert.deepStrictEqual(report.drops, {
      "cryptoProperties.algorithmProperties.curve": 1,
    });
  });
});

describe("2.0 generation wiring", () => {
  it("keeps the evinse inventory at --evidence --spec-version 2.0", () => {
    const workDir = mkdtempSync(join(tmpdir(), "cdx20-evinse-"));
    const fixture = join(REPO_ROOT, "test", "data", "svelte-precision");
    const runs = {};
    for (const specVersion of ["1.7", "2.0"]) {
      const output = join(workDir, `evinse-${specVersion}.json`);
      const result = runCdxgen(
        [
          fixture,
          "-t",
          "js",
          "--evidence",
          "--spec-version",
          specVersion,
          "-o",
          output,
        ],
        workDir,
      );
      const log = `${result.stdout}\n${result.stderr}`;
      assert.strictEqual(result.status, 0, log.slice(-600));
      // createEvinseFile prints this only when it ran; a skipped evidence
      // step prints "Skipping the evidence analysis" instead.
      assert.ok(
        log.includes(`${output} created successfully`),
        `evinse ran at ${specVersion}: ${log.slice(-600)}`,
      );
      assert.ok(!log.includes("Skipping the evidence analysis"));
      runs[specVersion] = JSON.parse(readFileSync(output, "utf-8"));
    }
    rmSync(workDir, { recursive: true, force: true });
    const bom17 = runs["1.7"];
    const bom20 = runs["2.0"];
    assert.ok(precompiled20(bom20), "the evinse 2.0 output validates");
    assertRefIntegrity(bom20, "evinse 2.0");
    const components20 = bom20.inventories[0].components;
    assert.ok(bom17.components.length > 0);
    assert.strictEqual(components20.length, bom17.components.length);
    const withOccurrences = (components) =>
      components.filter((component) => component.evidence?.occurrences?.length)
        .length;
    assert.strictEqual(
      withOccurrences(components20),
      withOccurrences(bom17.components),
    );
    assert.strictEqual(bom20.dependencies.length, bom17.dependencies.length);
  });

  it("refuses a Dependency-Track upload at 2.0 before generating", () => {
    const workDir = mkdtempSync(join(tmpdir(), "cdx20-dtrack-"));
    const output = join(workDir, "bom.json");
    const result = runCdxgen(
      [
        join(REPO_ROOT, "test", "data", "svelte-precision"),
        "--spec-version",
        "2.0",
        "--server-url",
        "https://dtrack.invalid",
        "--api-key",
        "test-key",
        "-o",
        output,
      ],
      workDir,
    );
    const generated = existsSync(output);
    rmSync(workDir, { recursive: true, force: true });
    assert.strictEqual(result.status, 1);
    assert.ok(
      result.stderr.includes(DEPENDENCY_TRACK_CDX20_ERROR),
      result.stderr.slice(-400),
    );
    assert.ok(DEPENDENCY_TRACK_CDX20_ERROR.includes("--spec-version 1.7"));
    assert.ok(!generated, "no BOM is generated");
  });

  it("reads the internal model back unchanged through loadBomForAnalysis", async () => {
    const bomNSData = await generateFixture(
      join("test", "data", "svelte-precision"),
      { projectType: ["js"], specVersion: "2.0" },
    );
    const { internalBom, losses } = loadBomForAnalysis(
      bomNSData.internalBomJson,
    );
    assert.strictEqual(internalBom, bomNSData.internalBomJson);
    assert.deepStrictEqual(losses, []);
    // The rendered document still goes through the reader.
    const read = loadBomForAnalysis(bomNSData.bomJson);
    assert.strictEqual(
      read.internalBom.components.length,
      bomNSData.internalBomJson.components.length,
    );
  });
});

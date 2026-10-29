import { readFileSync as actualReadFileSync } from "node:fs";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { getLicenses } from "../inventory/spdx.js";
import { validateBom, validateRefs } from "./bomValidator.js";

const validCycloneDx20Bom = {
  specFormat: "CycloneDX",
  specVersion: "2.0",
  serialNumber: "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
  version: 1,
  metadata: {
    component: {
      "bom-ref": "pkg:generic/demo@1.0.0",
      name: "demo",
      purl: "pkg:generic/demo@1.0.0",
      type: "application",
      version: "1.0.0",
    },
    tools: {
      components: [{ type: "application", name: "cdxgen", version: "12.4.0" }],
    },
  },
  components: [
    {
      "bom-ref": "pkg:npm/lodash@4.17.21",
      name: "lodash",
      purl: "pkg:npm/lodash@4.17.21",
      type: "library",
      version: "4.17.21",
    },
  ],
  dependencies: [
    {
      ref: "pkg:generic/demo@1.0.0",
      dependsOn: ["pkg:npm/lodash@4.17.21"],
    },
    { ref: "pkg:npm/lodash@4.17.21", dependsOn: [] },
  ],
};

describe("validateBom()", () => {
  it("validates CycloneDX 2.0-dev JSON against the bundled schema", async () => {
    assert.strictEqual(await validateBom(validCycloneDx20Bom), true);
  });

  it("returns a clear validation failure for unsupported spec versions", async () => {
    const readFileSyncStub = sinon.stub();
    const consoleLogStub = sinon.stub(console, "log");
    try {
      const { validateBom } = await esmock("./bomValidator.js", {
        "node:fs": {
          readFileSync: readFileSyncStub,
        },
      });

      assert.strictEqual(
        await validateBom({ bomFormat: "CycloneDX", specVersion: "2.0.1" }),
        false,
      );
      sinon.assert.notCalled(readFileSyncStub);
      sinon.assert.calledWithMatch(
        consoleLogStub,
        "Unsupported CycloneDX specVersion '2.0.1'.",
      );
    } finally {
      consoleLogStub.restore();
    }
  });

  it("caches compiled CycloneDX schema validators by spec version", async () => {
    // Pre-compiled validators are loaded via dynamic import(); the second
    // call must reuse the cached promise rather than re-importing.
    const readFileSyncStub = sinon
      .stub()
      .callsFake((...args) => actualReadFileSync(...args));
    const { validateBom } = await esmock("./bomValidator.js", {
      "node:fs": {
        readFileSync: readFileSyncStub,
      },
    });

    assert.strictEqual(await validateBom(validCycloneDx20Bom), true);
    const readCountAfterFirstValidation = readFileSyncStub.callCount;

    assert.strictEqual(await validateBom(validCycloneDx20Bom), true);
    assert.strictEqual(
      readFileSyncStub.callCount,
      readCountAfterFirstValidation,
    );
  });
});

describe("validateSpdx()", () => {
  it("lazy-loads the bundled SPDX export schema on first validation call", async () => {
    const readFileSyncStub = sinon
      .stub()
      .returns(
        '{"type":"object","properties":{"@context":{"const":"https://spdx.org/rdf/3.0.1/spdx-context.jsonld"},"@graph":{"type":"array"}}}',
      );
    const { validateSpdx } = await esmock("./bomValidator.js", {
      "node:fs": {
        readFileSync: readFileSyncStub,
      },
      "../ecosystems/utils.js": {
        DEBUG_MODE: false,
        dirNameStr: "/tmp",
        isPartialTree: sinon.stub().returns(false),
      },
      "../stages/postgen/spdxConverter.js": {
        SPDX_JSONLD_CONTEXT: "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
        SPDX_SPEC_VERSION: "3.0.1",
      },
    });

    sinon.assert.notCalled(readFileSyncStub);
    assert.strictEqual(
      validateSpdx({
        "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
        "@graph": [],
      }),
      false,
    );
    sinon.assert.calledOnce(readFileSyncStub);
  });

  it("caches the bundled SPDX export schema between validation calls", async () => {
    const readFileSyncStub = sinon
      .stub()
      .returns(
        '{"type":"object","properties":{"@context":{"const":"https://spdx.org/rdf/3.0.1/spdx-context.jsonld"},"@graph":{"type":"array"}}}',
      );
    const { validateSpdx } = await esmock("./bomValidator.js", {
      "node:fs": {
        readFileSync: readFileSyncStub,
      },
      "../ecosystems/utils.js": {
        DEBUG_MODE: false,
        dirNameStr: "/tmp",
        isPartialTree: sinon.stub().returns(false),
      },
      "../stages/postgen/spdxConverter.js": {
        SPDX_JSONLD_CONTEXT: "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
        SPDX_SPEC_VERSION: "3.0.1",
      },
    });

    validateSpdx({
      "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
      "@graph": [],
    });
    validateSpdx({
      "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
      "@graph": [],
    });

    sinon.assert.calledOnce(readFileSyncStub);
  });
});

describe("idn-email enforcement", () => {
  // ajv-formats has no idn-email and `strict: false` accepts any unknown
  // format, so contact addresses went unchecked here while `cdxrs validate`
  // rejected them. cdxgen registers the format itself.
  const bomWithSupplierEmail = (email) => ({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
    version: 1,
    metadata: {
      component: {
        "bom-ref": "root",
        name: "demo",
        purl: "pkg:generic/demo@1.0.0",
        type: "application",
        version: "1.0.0",
      },
      supplier: { name: "acme", contact: [{ name: "ops", email }] },
    },
    components: [],
    dependencies: [{ dependsOn: [], ref: "root" }],
  });

  it("accepts a valid contact address", async () => {
    assert.equal(
      await validateBom(bomWithSupplierEmail("ops@acme.example")),
      true,
    );
  });

  it("rejects a contact address that is not an email", async () => {
    assert.equal(
      await validateBom(bomWithSupplierEmail("plainly not an email")),
      false,
    );
  });
});

describe("uniqueItems enforcement", () => {
  const bomWith = (overrides) => ({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
    version: 1,
    metadata: {
      component: {
        "bom-ref": "root",
        name: "demo",
        purl: "pkg:generic/demo@1.0.0",
        type: "application",
        version: "1.0.0",
      },
    },
    components: [
      {
        "bom-ref": "pkg:npm/left-pad@1.3.0",
        name: "left-pad",
        purl: "pkg:npm/left-pad@1.3.0",
        type: "library",
        version: "1.3.0",
      },
    ],
    dependencies: [{ dependsOn: [], ref: "root" }],
    ...overrides,
  });
  const duplicated = (component) => [
    structuredClone(component),
    structuredClone(component),
  ];

  it("accepts a document whose arrays hold no repeats", async () => {
    assert.equal(await validateBom(bomWith({})), true);
  });

  it("rejects a repeated entry in components", async () => {
    const bom = bomWith({});
    assert.equal(
      await validateBom(bomWith({ components: duplicated(bom.components[0]) })),
      false,
    );
  });

  it("rejects a repeated entry in a nested components array", async () => {
    const bom = bomWith({});
    const parent = {
      "bom-ref": "pkg:npm/parent@1.0.0",
      components: duplicated(bom.components[0]),
      name: "parent",
      purl: "pkg:npm/parent@1.0.0",
      type: "library",
      version: "1.0.0",
    };
    assert.equal(await validateBom(bomWith({ components: [parent] })), false);
  });

  it("rejects a repeated reference in dependsOn", async () => {
    assert.equal(
      await validateBom(
        bomWith({
          dependencies: [
            {
              dependsOn: ["pkg:npm/left-pad@1.3.0", "pkg:npm/left-pad@1.3.0"],
              ref: "root",
            },
          ],
        }),
      ),
      false,
    );
  });

  it("distinguishes entries that differ only in a nested value", async () => {
    const bom = bomWith({});
    const first = structuredClone(bom.components[0]);
    const second = structuredClone(bom.components[0]);
    first["bom-ref"] = "pkg:npm/left-pad@1.3.0#a";
    second["bom-ref"] = "pkg:npm/left-pad@1.3.0#b";
    first.properties = [{ name: "cdx:npm:kind", value: "a" }];
    second.properties = [{ name: "cdx:npm:kind", value: "b" }];
    assert.equal(
      await validateBom(bomWith({ components: [first, second] })),
      true,
    );
  });
});

describe("validateRefs()", () => {
  it("treats a missing dependsOn as empty instead of throwing", () => {
    // Protobuf round-trips drop empty dependsOn lists, including the parent's.
    const bomJson = {
      metadata: {
        component: { "bom-ref": "pkg:npm/app@1.0.0", name: "app" },
      },
      components: [{ "bom-ref": "pkg:npm/a@1.0.0", name: "a" }],
      dependencies: [{ ref: "pkg:npm/app@1.0.0" }, { ref: "pkg:npm/a@1.0.0" }],
    };
    assert.strictEqual(validateRefs(bomJson), true);
  });

  it("accepts the encoded ref of a keystore that holds certificates, and still rejects an encoded purl", () => {
    // What a rootfs scan of almalinux:9.4-minimal gives with trustinspector
    // 4.2.0, which reports the CA trust bundles as keystores.
    const keystore =
      "crypto/related-crypto-material/keystore/%2Fetc%2Fpki%2Fca-trust%2Fextracted%2Fjava%2Fcacerts";
    const certificate =
      "crypto/certificate/ISRG%20Root%20X1@sha256:96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6";
    const bomJson = {
      components: [
        { "bom-ref": keystore, name: "cacerts" },
        { "bom-ref": certificate, name: "ISRG Root X1" },
      ],
      dependencies: [
        { ref: keystore, dependsOn: [certificate] },
        { ref: certificate, dependsOn: [] },
      ],
    };
    assert.strictEqual(validateRefs(bomJson), true);
    assert.strictEqual(
      validateRefs({
        components: [{ "bom-ref": "pkg:npm/%40scope/a@1.0.0", name: "a" }],
        dependencies: [{ ref: "pkg:npm/%40scope/a@1.0.0", dependsOn: [] }],
      }),
      false,
    );
  });
});

describe("validateBom() SPDX license identifiers", () => {
  // Every identifier cdxgen may emit as license.id must be in the bundled
  // spdx.schema.json enum, or the BOM fails schema validation. Refreshing
  // data/spdx-licenses.json therefore needs the schema copy refreshed in step.
  const readData = (name) =>
    JSON.parse(
      actualReadFileSync(
        new URL(`../../data/${name}`, import.meta.url),
        "utf-8",
      ),
    );
  const spdxIds = readData("spdx-licenses.json");

  it("bundles a schema enum that covers data/spdx-licenses.json", () => {
    const schemaIds = new Set(readData("spdx.schema.json").enum);
    assert.deepStrictEqual(
      spdxIds.filter((id) => !schemaIds.has(id)),
      [],
    );
  });

  for (const specVersion of ["1.6", "1.7"]) {
    it(`accepts every known SPDX identifier as license.id in ${specVersion}`, async () => {
      // A few deprecated identifiers resolve to an expression instead; only
      // the license.id shape is under test here.
      const components = spdxIds
        .map((id) => getLicenses({ license: id }))
        .filter((licenses) => licenses?.[0]?.license?.id)
        .map((licenses, index) => ({
          "bom-ref": `pkg:generic/lic-${index}@1.0.0`,
          licenses,
          name: `lic-${index}`,
          purl: `pkg:generic/lic-${index}@1.0.0`,
          type: "library",
          version: "1.0.0",
        }));
      assert.ok(components.length > spdxIds.length - 20);
      assert.strictEqual(
        await validateBom({
          bomFormat: "CycloneDX",
          specVersion,
          serialNumber: "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
          version: 1,
          metadata: {
            component: {
              "bom-ref": "root",
              name: "demo",
              purl: "pkg:generic/demo@1.0.0",
              type: "application",
              version: "1.0.0",
            },
          },
          components,
          dependencies: [
            {
              dependsOn: components.map((component) => component["bom-ref"]),
              ref: "root",
            },
          ],
        }),
        true,
      );
    });
  }
});

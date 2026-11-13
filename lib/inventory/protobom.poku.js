import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { assert, it } from "poku";

import { getTmpDir } from "../ecosystems/utils.js";
import {
  assertProtoSupportedSpecVersion,
  convertBomSpecVersion,
  getBomStats,
  isProtoBomFile,
  isProtoSupportedSpecVersion,
  readBinary,
  writeBinary,
} from "./protobom.js";

const testBom = JSON.parse(
  readFileSync("./test/data/bom-java.json", { encoding: "utf-8" }),
);
const cbomFixture = JSON.parse(
  readFileSync("./test/data/bom-cbom-js-fixture.json", { encoding: "utf-8" }),
);
const cardinalityFixture = JSON.parse(
  readFileSync("./test/data/bom-1.6-cardinality.json", { encoding: "utf-8" }),
);

const createTempDir = () => mkdtempSync(join(getTmpDir(), "bin-tests-"));

const cleanupTempDir = (tempDir) => {
  if (tempDir?.startsWith(getTmpDir()) && rmSync) {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

it("proto binary tests", () => {
  const tempDir = createTempDir();
  const binFile = join(tempDir, "test.cdx.bin");
  writeBinary({}, binFile);
  assert.deepStrictEqual(existsSync(binFile), true);
  writeBinary(testBom, binFile);
  assert.deepStrictEqual(existsSync(binFile), true);
  assert.equal(isProtoBomFile(binFile), true);
  assert.equal(isProtoBomFile("test.proto"), true);
  assert.equal(isProtoBomFile("bom.json"), false);
  let bomObject = readBinary(binFile);
  assert.ok(bomObject);
  assert.deepStrictEqual(
    bomObject.serialNumber,
    "urn:uuid:cc8b5a04-2698-4375-b04c-cedfa4317fee",
  );
  assert.deepStrictEqual(bomObject.bomFormat, "CycloneDX");
  assert.deepStrictEqual(bomObject.specVersion, "1.5");
  assert.equal(
    bomObject.metadata.component.type.startsWith("CLASSIFICATION_"),
    false,
  );
  bomObject = readBinary(binFile, false, 1.5);
  assert.ok(bomObject);
  assert.deepStrictEqual(
    bomObject.serialNumber,
    "urn:uuid:cc8b5a04-2698-4375-b04c-cedfa4317fee",
  );
  assert.deepStrictEqual(bomObject.specVersion, "1.5");
  const modernBinFile = join(tempDir, "test-1.7.cdx");
  writeBinary(
    {
      bomFormat: "CycloneDX",
      metadata: {
        component: {
          name: "cdxgen",
          type: "application",
        },
      },
      serialNumber: "urn:uuid:11111111-1111-1111-1111-111111111111",
      specVersion: "1.7",
      version: 1,
    },
    modernBinFile,
  );
  const modernBomObject = readBinary(modernBinFile);
  assert.ok(modernBomObject);
  assert.deepStrictEqual(modernBomObject.bomFormat, "CycloneDX");
  assert.deepStrictEqual(modernBomObject.specVersion, "1.7");
  assert.deepStrictEqual(
    modernBomObject.metadata.component.type,
    "application",
  );
  assert.deepStrictEqual(modernBomObject.metadata.component.name, "cdxgen");
  cleanupTempDir(tempDir);
});

it("translates both environmentVars spellings for the protobuf round-trip", () => {
  // The JSON schema lets an environmentVars entry be a property object or a
  // bare name whose value is withheld; the protobuf message holds a oneof of
  // the property and the bare name, so each entry is translated to the arm
  // it belongs to. Without the translation a bare name failed decoding, and
  // a property's value landed on the string arm, losing its name.
  const tempDir = createTempDir();
  const binFile = join(tempDir, "envvars.cdx.bin");
  const bomWithEnvVars = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    formulation: [
      {
        workflows: [
          {
            inputs: [
              {
                environmentVars: [
                  { name: "internal:GIT_BRANCH", value: "main" },
                  "JAVA_HOME_25_X64",
                ],
              },
            ],
            outputs: [{ environmentVars: ["GITHUB_STEP_SUMMARY"] }],
          },
        ],
      },
    ],
  };
  writeBinary(bomWithEnvVars, binFile);
  const bomObject = readBinary(binFile);
  const inputs = bomObject.formulation[0].workflows[0].inputs[0];
  assert.deepStrictEqual(inputs.environmentVars, [
    { property: { name: "internal:GIT_BRANCH", value: "main" } },
    { value: "JAVA_HOME_25_X64" },
  ]);
  assert.deepStrictEqual(
    bomObject.formulation[0].workflows[0].outputs[0].environmentVars,
    [{ value: "GITHUB_STEP_SUMMARY" }],
  );
  // The same BOM as a JSON string takes the same path.
  writeBinary(JSON.stringify(bomWithEnvVars), binFile);
  assert.deepStrictEqual(
    readBinary(binFile).formulation[0].workflows[0].inputs[0]
      .environmentVars[1],
    { value: "JAVA_HOME_25_X64" },
  );
  cleanupTempDir(tempDir);
});

it("keeps canonical definitions and declarations as objects during proto round-trip", () => {
  const tempDir = createTempDir();
  const binFile = join(tempDir, "standard-sections.cdx");
  writeBinary(
    {
      bomFormat: "CycloneDX",
      declarations: {
        affirmation: {
          statement: "verified",
        },
        claims: [
          {
            predicate: "meets-control",
            target: "pkg:npm/demo-app@1.0.0",
          },
        ],
      },
      definitions: {
        standards: [
          {
            name: "ASVS",
            requirements: [
              {
                identifier: "V1.1",
                title: "Authenticate requests",
              },
            ],
            version: "5.0",
          },
        ],
      },
      metadata: {
        component: {
          name: "demo-app",
          type: "application",
          version: "1.0.0",
        },
      },
      serialNumber: "urn:uuid:22222222-2222-2222-2222-222222222222",
      specVersion: "1.7",
      version: 1,
    },
    binFile,
  );

  const bomObject = readBinary(binFile);
  assert.ok(bomObject);
  assert.equal(Array.isArray(bomObject.definitions), false);
  assert.equal(Array.isArray(bomObject.declarations), false);
  assert.equal(bomObject.definitions.standards[0].name, "ASVS");
  assert.equal(
    bomObject.definitions.standards[0].requirements[0].identifier,
    "V1.1",
  );
  assert.equal(bomObject.declarations.claims[0].predicate, "meets-control");
  assert.equal(bomObject.declarations.affirmation.statement, "verified");
  cleanupTempDir(tempDir);
});

it("rejects unsupported CycloneDX 2.0 protobuf operations with a clear error", () => {
  const tempDir = createTempDir();
  const binFile = join(tempDir, "unsupported-2.0.cdx");
  assert.throws(
    () =>
      writeBinary(
        {
          specFormat: "CycloneDX",
          specVersion: "2.0",
          version: 1,
        },
        binFile,
      ),
    /CycloneDX 2\.0 is not currently supported for protobuf serialization/,
  );
  assert.throws(
    () => assertProtoSupportedSpecVersion("2.0", "protobuf export"),
    /@cdxgen\/cdx-proto supports 1\.5, 1\.6, 1\.7 only/,
  );
  assert.throws(
    () =>
      writeBinary(
        {
          bomFormat: "CycloneDX",
          specVersion: "2.0.1",
          version: 1,
        },
        binFile,
      ),
    /CycloneDX 2\.0\.1 is not currently supported for protobuf serialization/,
  );
  assert.throws(
    () => assertProtoSupportedSpecVersion("2.0.1", "protobuf export"),
    /CycloneDX 2\.0\.1 is not currently supported for protobuf export/,
  );
  cleanupTempDir(tempDir);
});

it("round-trips real CBOM fixture data with cryptographic assets intact", () => {
  const tempDir = createTempDir();
  const binFile = join(tempDir, "cbom-fixture.cdx");
  writeBinary(cbomFixture, binFile);

  const bomObject = readBinary(binFile);
  const cryptoComponents = (bomObject.components || []).filter(
    (component) => component.type === "cryptographic-asset",
  );

  assert.ok(bomObject);
  assert.equal(bomObject.specVersion, "1.7");
  assert.ok(cryptoComponents.length >= 3);
  assert.equal(
    cryptoComponents.some(
      (component) => component.cryptoProperties?.assetType === "algorithm",
    ),
    true,
  );
  assert.equal(
    cryptoComponents.some((component) => component.purl !== undefined),
    false,
  );
  assert.equal(
    cryptoComponents.some(
      (component) =>
        component.name === "sha-512" &&
        component.cryptoProperties?.oid === "2.16.840.1.101.3.4.2.3",
    ),
    true,
  );
  cleanupTempDir(tempDir);
});

it("round-trips AI inventory services and model properties through protobuf", () => {
  const tempDir = createTempDir();
  const binFile = join(tempDir, "ai-inventory.cdx");
  writeBinary(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      version: 1,
      services: [
        {
          "bom-ref": "urn:service:ai:openai:OpenAI-API",
          group: "openai",
          name: "OpenAI API",
          endpoints: ["https://api.openai.com/v1/responses"],
          properties: [
            { name: "cdx:ai:kind", value: "inference-service" },
            { name: "cdx:ai:modelId", value: "gpt-4o-mini" },
          ],
        },
      ],
      components: [
        {
          "bom-ref": "urn:cdx:ai:model:openai:gpt-4o-mini",
          type: "machine-learning-model",
          group: "openai",
          name: "gpt-4o-mini",
          properties: [
            { name: "cdx:ai:provider", value: "openai" },
            { name: "cdx:ai:source", value: "source-code-analysis" },
          ],
        },
      ],
      dependencies: [
        {
          ref: "urn:service:ai:openai:OpenAI-API",
          dependsOn: ["urn:cdx:ai:model:openai:gpt-4o-mini"],
        },
      ],
    },
    binFile,
  );
  const bomObject = readBinary(binFile);
  assert.ok(bomObject.services?.[0]);
  assert.strictEqual(bomObject.services[0].group, "openai");
  assert.ok(
    bomObject.services[0].properties.some(
      (property) =>
        property.name === "cdx:ai:modelId" && property.value === "gpt-4o-mini",
    ),
  );
  assert.strictEqual(bomObject.components[0].type, "machine-learning-model");
  cleanupTempDir(tempDir);
});

it("carries CycloneDX 1.7 citations through a proto round-trip", () => {
  // Citations were dropped before encoding while @cdxgen/cdx-proto could not
  // decode them: `pointers`/`expressions` are wrapper messages around a
  // repeated string, and canonical JSON carries bare string arrays. cdx-proto
  // 2.1.0 handles both shapes, so the binary export must now preserve the
  // provenance rather than silently discarding it.
  const tempDir = createTempDir();
  const binFile = join(tempDir, "citations.cdx");
  writeBinary(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      version: 1,
      serialNumber: "urn:uuid:22222222-2222-2222-2222-222222222222",
      metadata: {
        component: { name: "demo-app", type: "application" },
      },
      citations: [
        {
          timestamp: "2026-01-01T00:00:00Z",
          expressions: ["$.components"],
          attributedTo: "pkg:npm/@cdxgen/cdxgen@13.0.0",
          note: "Component inventory collected by cdxgen.",
        },
        {
          timestamp: "2026-01-01T00:00:00Z",
          pointers: ["/components/0/licenses/0"],
          process: "urn:cdx:formula:audit",
        },
      ],
    },
    binFile,
  );
  const bomObject = readBinary(binFile);
  assert.strictEqual(bomObject.citations.length, 2);
  assert.deepStrictEqual(bomObject.citations[0].expressions, ["$.components"]);
  assert.strictEqual(
    bomObject.citations[0].attributedTo,
    "pkg:npm/@cdxgen/cdxgen@13.0.0",
  );
  assert.deepStrictEqual(bomObject.citations[1].pointers, [
    "/components/0/licenses/0",
  ]);
  assert.strictEqual(bomObject.citations[1].process, "urn:cdx:formula:audit");
  cleanupTempDir(tempDir);
});

it("keeps the dependency graph intact across a proto round-trip", () => {
  const tempDir = createTempDir();
  const binFile = join(tempDir, "bom-deps.cdx");
  writeBinary(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        timestamp: "2026-01-01T00:00:00Z",
        component: {
          "bom-ref": "root",
          type: "application",
          name: "app",
          version: "1.0.0",
        },
      },
      components: [
        { "bom-ref": "a@1", type: "library", name: "a", version: "1" },
        { "bom-ref": "b@1", type: "library", name: "b", version: "1" },
      ],
      dependencies: [
        { ref: "root", dependsOn: ["a@1"] },
        { ref: "a@1", dependsOn: ["b@1"] },
      ],
    },
    binFile,
  );
  const bomObject = readBinary(binFile);
  const dependsOnByRef = Object.fromEntries(
    bomObject.dependencies.map((dep) => [dep.ref, dep.dependsOn || []]),
  );
  assert.deepStrictEqual(dependsOnByRef.root, ["a@1"]);
  assert.deepStrictEqual(dependsOnByRef["a@1"], ["b@1"]);
  cleanupTempDir(tempDir);
});

it("restores empty dependsOn lists dropped by the protobuf round-trip", () => {
  const tempDir = createTempDir();
  const binFile = join(tempDir, "bom-empty-deps.cdx");
  writeBinary(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        timestamp: "2026-01-01T00:00:00Z",
        component: {
          "bom-ref": "root",
          type: "application",
          name: "app",
          version: "1.0.0",
        },
      },
      components: [
        { "bom-ref": "a@1", type: "library", name: "a", version: "1" },
      ],
      dependencies: [
        { ref: "root", dependsOn: ["a@1"] },
        { ref: "a@1", dependsOn: [] },
      ],
    },
    binFile,
  );
  const bomObject = readBinary(binFile);
  const aEntry = bomObject.dependencies.find((dep) => dep.ref === "a@1");
  assert.deepStrictEqual(aEntry.dependsOn, []);
  cleanupTempDir(tempDir);
});

it("reports bom statistics", () => {
  const stats = getBomStats(testBom);
  assert.strictEqual(stats.specVersion, testBom.specVersion);
  assert.strictEqual(stats.componentCount, testBom.components.length);
  assert.ok(stats.binaryByteSize > 0);
  assert.ok(stats.binaryByteSize < stats.jsonByteSize);
});

it("cross-converts between spec versions", () => {
  const { bomJson, warnings } = convertBomSpecVersion(testBom, "1.5");
  assert.strictEqual(bomJson.specVersion, "1.5");
  assert.strictEqual(bomJson.components.length, testBom.components.length);
  assert.ok(Array.isArray(warnings));
});

it("rejects conversion to an unsupported spec version", () => {
  assert.throws(() => convertBomSpecVersion(testBom, "1.4"));
});

it("reshapes 1.5/1.6 cardinality fields in both conversion directions", () => {
  // cdx-proto 2.3.0 made convertBom cardinality-safe: `metadata.licenses` and
  // `evidence.identity` (singular in 1.5, an array since 1.6) are reshaped
  // automatically, including `evidence.identity` on nested components. This
  // guards the regression where a 1.6 -> 1.5 conversion threw or silently
  // dropped the field instead of collapsing it.
  const { bomJson: downgraded, warnings } = convertBomSpecVersion(
    cardinalityFixture,
    "1.5",
  );
  assert.strictEqual(downgraded.specVersion, "1.5");

  const component = downgraded.components[0];
  assert.equal(Array.isArray(component.evidence.identity), false);
  assert.deepStrictEqual(component.evidence.identity, {
    field: "purl",
    confidence: 1,
  });
  assert.equal(Array.isArray(component.components[0].evidence.identity), false);
  assert.deepStrictEqual(component.components[0].evidence.identity, {
    field: "purl",
    confidence: 0.9,
  });
  assert.equal(Array.isArray(downgraded.metadata.licenses), false);
  assert.deepStrictEqual(downgraded.metadata.licenses, {
    license: { id: "MIT" },
  });
  assert.ok(warnings.includes("$.components[].evidence.identity[1]"));
  assert.ok(warnings.includes("$.metadata.licenses[1]"));

  const { bomJson: upgraded, warnings: upgradeWarnings } =
    convertBomSpecVersion(downgraded, "1.6");
  assert.strictEqual(upgraded.specVersion, "1.6");
  assert.equal(Array.isArray(upgraded.components[0].evidence.identity), true);
  assert.deepStrictEqual(upgraded.components[0].evidence.identity, [
    { field: "purl", confidence: 1 },
  ]);
  assert.equal(
    Array.isArray(upgraded.components[0].components[0].evidence.identity),
    true,
  );
  assert.equal(Array.isArray(upgraded.metadata.licenses), true);
  assert.deepStrictEqual(upgradeWarnings, []);
});

it("accepts BOM JSON strings and decoded messages as serialization input", () => {
  const tempDir = createTempDir();
  const binFile = join(tempDir, "string-input.cdx");
  writeBinary(JSON.stringify(cardinalityFixture), binFile);
  const fromString = readBinary(binFile);
  assert.strictEqual(fromString.specVersion, "1.6");
  assert.strictEqual(fromString.components[0].name, "left-pad");

  // A decoded message must pass through unchanged, including through stats.
  const message = readBinary(binFile, false);
  const stats = getBomStats(message);
  assert.strictEqual(stats.specVersion, "1.6");
  assert.strictEqual(stats.componentCount, 1);
  assert.strictEqual(stats.dependencyCount, 2);
  const messageBinFile = join(tempDir, "message-input.cdx");
  writeBinary(message, messageBinFile);
  const fromMessage = readBinary(messageBinFile);
  assert.deepStrictEqual(fromMessage.serialNumber, fromString.serialNumber);
  assert.deepStrictEqual(fromMessage.dependencies, fromString.dependencies);
  cleanupTempDir(tempDir);
});

it("accepts v-prefixed and patch-suffixed spec version spellings", () => {
  // cdx-proto's normalizeSpecVersion accepts the spellings seen in the wild,
  // so protobuf operations gate on it instead of cdxgen's stricter pattern.
  assert.equal(isProtoSupportedSpecVersion("v1.6"), true);
  assert.equal(isProtoSupportedSpecVersion("1.6.0"), true);
  assert.equal(isProtoSupportedSpecVersion(1.5), true);
  assert.equal(isProtoSupportedSpecVersion("1.4"), false);
  assert.equal(isProtoSupportedSpecVersion("2.0"), false);
  assert.doesNotThrow(() => assertProtoSupportedSpecVersion("v1.6"));

  const tempDir = createTempDir();
  const binFile = join(tempDir, "spelled-version.cdx");
  writeBinary(
    {
      bomFormat: "CycloneDX",
      metadata: { component: { name: "demo-app", type: "application" } },
      version: 1,
    },
    binFile,
    "v1.6",
  );
  assert.strictEqual(readBinary(binFile).specVersion, "1.6");
  assert.equal(isProtoBomFile("BOM.CDX"), true);
  assert.equal(isProtoBomFile("bom.base64"), false);
  cleanupTempDir(tempDir);
});

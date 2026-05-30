import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { assert, it } from "poku";

import {
  assertProtoSupportedSpecVersion,
  isProtoBomFile,
  readBinary,
  writeBinary,
} from "./protobom.js";
import { getTmpDir } from "./utils.js";

const testBom = JSON.parse(
  readFileSync("./test/data/bom-java.json", { encoding: "utf-8" }),
);
const cbomFixture = JSON.parse(
  readFileSync("./test/data/bom-cbom-js-fixture.json", { encoding: "utf-8" }),
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
    /@appthreat\/cdx-proto supports 1\.5, 1\.6, 1\.7 only/,
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

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { assert, it } from "poku";

import { isProtoBomFile, readBinary, writeBinary } from "./protobom.js";
import { getTmpDir } from "./utils.js";

const tempDir = mkdtempSync(join(getTmpDir(), "bin-tests-"));
const testBom = JSON.parse(
  readFileSync("./test/data/bom-java.json", { encoding: "utf-8" }),
);

it("proto binary tests", () => {
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
  if (tempDir?.startsWith(getTmpDir()) && rmSync) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

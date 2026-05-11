import { assert, describe, it } from "poku";

import {
  getContainerFileInventoryStats,
  getPropertyValue,
  getSourceDerivedCryptoComponents,
  getUnpackagedExecutableComponents,
  getUnpackagedSharedLibraryComponents,
} from "./inventoryStats.js";

describe("inventoryStats helpers", () => {
  const components = [
    {
      type: "file",
      name: "demo",
      properties: [{ name: "internal:is_executable", value: "true" }],
    },
    {
      type: "file",
      name: "libdemo.so",
      properties: [{ name: "internal:is_shared_library", value: "true" }],
    },
    {
      type: "file",
      name: "README.md",
      properties: [{ name: "internal:is_executable", value: "false" }],
    },
    {
      type: "cryptographic-asset",
      name: "sha-512",
      properties: [
        { name: "cdx:crypto:sourceType", value: "js-ast:node:crypto" },
      ],
    },
    {
      type: "cryptographic-asset",
      name: "cert.pem",
      properties: [{ name: "cdx:crypto:sourceType", value: "certificate" }],
    },
  ];

  it("getPropertyValue() reads properties from arrays and component objects", () => {
    assert.strictEqual(
      getPropertyValue(components[0], "internal:is_executable"),
      "true",
    );
    assert.strictEqual(
      getPropertyValue(components[0].properties, "internal:is_executable"),
      "true",
    );
    assert.strictEqual(getPropertyValue({}, "missing"), undefined);
  });

  it("filters unpackaged executable and shared-library file components", () => {
    assert.deepStrictEqual(
      getUnpackagedExecutableComponents(components).map(
        (component) => component.name,
      ),
      ["demo"],
    );
    assert.deepStrictEqual(
      getUnpackagedSharedLibraryComponents(components).map(
        (component) => component.name,
      ),
      ["libdemo.so"],
    );
  });

  it("filters source-derived crypto components", () => {
    assert.deepStrictEqual(
      getSourceDerivedCryptoComponents(components).map(
        (component) => component.name,
      ),
      ["sha-512"],
    );
  });

  it("summarizes unpackaged container file inventory counts", () => {
    assert.deepStrictEqual(getContainerFileInventoryStats(components), {
      unpackagedExecutables: [components[0]],
      unpackagedSharedLibraries: [components[1]],
      unpackagedExecutableCount: 1,
      unpackagedSharedLibraryCount: 1,
    });
  });
});

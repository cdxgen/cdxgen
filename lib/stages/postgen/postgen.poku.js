import { readFileSync } from "node:fs";

import { assert, it } from "poku";

import { filterBom, postProcess } from "./postgen.js";

it("filter bom tests", () => {
  const bomJson = JSON.parse(
    readFileSync("./test/data/bom-postgen-test.json", "utf-8"),
  );
  let newBom = filterBom(bomJson, {});
  assert.deepStrictEqual(bomJson, newBom);
  assert.deepStrictEqual(newBom.components.length, 1060);
  newBom = filterBom(bomJson, { requiredOnly: true });
  for (const comp of newBom.components) {
    if (comp.scope && comp.scope !== "required") {
      throw new Error(`${comp.scope} is unexpected`);
    }
  }
  assert.deepStrictEqual(newBom.components.length, 345);
});

it("filter bom tests2", () => {
  const bomJson = JSON.parse(
    readFileSync("./test/data/bom-postgen-test2.json", "utf-8"),
  );
  let newBom = filterBom(bomJson, {});
  assert.deepStrictEqual(bomJson, newBom);
  assert.deepStrictEqual(newBom.components.length, 199);
  newBom = filterBom(bomJson, { requiredOnly: true });
  for (const comp of newBom.components) {
    if (comp.scope && comp.scope !== "required") {
      throw new Error(`${comp.scope} is unexpected`);
    }
  }
  assert.deepStrictEqual(newBom.components.length, 199);
  newBom = filterBom(bomJson, { filter: [""] });
  assert.deepStrictEqual(newBom.components.length, 199);
  newBom = filterBom(bomJson, { filter: ["apache"] });
  for (const comp of newBom.components) {
    if (comp.purl.includes("apache")) {
      throw new Error(`${comp.purl} is unexpected`);
    }
  }
  assert.deepStrictEqual(newBom.components.length, 158);
  newBom = filterBom(bomJson, { filter: ["apache", "json"] });
  for (const comp of newBom.components) {
    if (comp.purl.includes("apache") || comp.purl.includes("json")) {
      throw new Error(`${comp.purl} is unexpected`);
    }
  }
  assert.deepStrictEqual(newBom.components.length, 135);
  assert.deepStrictEqual(newBom.compositions, undefined);
  newBom = filterBom(bomJson, {
    only: ["org.springframework"],
    specVersion: 1.5,
    autoCompositions: true,
  });
  for (const comp of newBom.components) {
    if (!comp.purl.includes("org.springframework")) {
      throw new Error(`${comp.purl} is unexpected`);
    }
  }
  assert.deepStrictEqual(newBom.components.length, 29);
  assert.deepStrictEqual(newBom.compositions, [
    {
      aggregate: "incomplete_first_party_only",
      "bom-ref": "pkg:maven/sec/java-sec-code@1.0.0?type=jar",
    },
  ]);
});

it("postProcess adds formulation exactly once when includeFormulation is true", () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [],
      dependencies: [],
      metadata: { properties: [] },
    },
  };
  const options = { includeFormulation: true, specVersion: 1.5 };
  const result = postProcess(bomNSData, options);
  assert.ok(
    Array.isArray(result.bomJson.formulation),
    "formulation must be an array",
  );
  assert.ok(
    result.bomJson.formulation.length > 0,
    "formulation must have at least one entry",
  );
});

it("postProcess does not add formulation when includeFormulation is false", () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [],
      dependencies: [],
      metadata: { properties: [] },
    },
  };
  const options = { includeFormulation: false, specVersion: 1.5 };
  const result = postProcess(bomNSData, options);
  assert.strictEqual(
    result.bomJson.formulation,
    undefined,
    "formulation must not be added when disabled",
  );
});

it("postProcess preserves existing formulation and does not overwrite it", () => {
  const sentinel = [{ "bom-ref": "already-present" }];
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [],
      dependencies: [],
      metadata: { properties: [] },
      formulation: sentinel,
    },
  };
  const options = { includeFormulation: true, specVersion: 1.5 };
  const result = postProcess(bomNSData, options);
  assert.strictEqual(
    result.bomJson.formulation[0]["bom-ref"],
    "already-present",
    "existing formulation must not be overwritten",
  );
});

it("postProcess passes formulationList from bomNSData into the formulation section", () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [],
      dependencies: [],
      metadata: { properties: [] },
    },
    formulationList: [{ type: "library", name: "pixi-pkg", version: "1.0.0" }],
  };
  const options = { includeFormulation: true, specVersion: 1.5 };
  const result = postProcess(bomNSData, options);
  assert.ok(
    Array.isArray(result.bomJson.formulation),
    "formulation must be present",
  );
  // The formulationList item should be reflected somewhere in the formulation components
  const allComponents = result.bomJson.formulation.flatMap(
    (f) => f.components ?? [],
  );
  assert.ok(
    allComponents.some((c) => c.name === "pixi-pkg"),
    "pixi-pkg from formulationList should appear in formulation components",
  );
});

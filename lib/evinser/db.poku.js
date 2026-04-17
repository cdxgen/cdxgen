import { assert, describe, test } from "poku";

import { createOrLoad } from "./db.js";

describe("In-Memory DB Helper Tests", async () => {
  const { sequelize, Namespaces } = await createOrLoad();

  await test("Model Initialization", () => {
    assert.ok(sequelize, "Database instance should exist");
    assert.ok(Namespaces, "Namespaces model should be initialized");
  });

  await test("Namespaces: findOrCreate (New Record)", async () => {
    const purl = "pkg:npm/axios@1.0.0";
    const data = {
      description: "Promise based HTTP client",
      versions: ["1.0.0"],
    };

    const [instance, created] = await Namespaces.findOrCreate({
      where: { purl },
      defaults: { purl, data },
    });

    assert.strictEqual(created, true, "Should indicate record was created");
    assert.strictEqual(instance.purl, purl, "PURL should match");
    assert.deepStrictEqual(instance.data, data, "Data object should match");
    assert.ok(instance.createdAt, "createdAt should exist");
    assert.ok(instance.updatedAt, "updatedAt should exist");
  });

  await test("Namespaces: findOrCreate (Existing Record)", async () => {
    const purl = "pkg:npm/axios@1.0.0";
    const data = { ignored: "data" };

    const [instance, created] = await Namespaces.findOrCreate({
      where: { purl },
      defaults: { purl, data },
    });

    assert.strictEqual(
      created,
      false,
      "Should indicate record was NOT created",
    );
    assert.strictEqual(instance.purl, purl, "PURL should match existing");
    assert.notDeepStrictEqual(
      instance.data,
      data,
      "Should return existing data from DB, not new defaults",
    );
    assert.strictEqual(
      instance.data.description,
      "Promise based HTTP client",
      "Data integrity check",
    );
  });

  await test("Namespaces: findByPk", async () => {
    const purl = "pkg:npm/axios@1.0.0";
    const record = await Namespaces.findByPk(purl);

    assert.ok(record, "Record should be found");
    assert.strictEqual(record.purl, purl);
    assert.strictEqual(
      typeof record.data,
      "object",
      "Data string should be parsed back to JSON object",
    );
    assert.strictEqual(
      record.data.versions[0],
      "1.0.0",
      "Nested JSON data should be accessible",
    );
  });

  await test("Namespaces: findByPk (Not Found)", async () => {
    const record = await Namespaces.findByPk("pkg:npm/non-existent");
    assert.strictEqual(
      record,
      null,
      "Should return null for non-existent records",
    );
  });

  await test("Namespaces: findAll (with LIKE filter)", async () => {
    await Namespaces.findOrCreate({
      where: { purl: "pkg:npm/react" },
      defaults: {
        purl: "pkg:npm/react",
        data: { description: "UI Library", author: "Meta" },
      },
    });

    const results = await Namespaces.findAll({
      where: {
        data: { like: "%HTTP%" },
      },
    });

    assert.strictEqual(
      results.length,
      1,
      "Should find exactly one record matching 'HTTP'",
    );
    assert.strictEqual(results[0].purl, "pkg:npm/axios@1.0.0");
  });

  await test("Namespaces: findAll (No Filter)", async () => {
    const results = await Namespaces.findAll({});
    assert.strictEqual(
      results.length,
      2,
      "Should return all records in the table",
    );
  });

  sequelize.close();
});

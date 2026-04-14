import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { circleCiParser } from "./circleCi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

describe("circleCiParser", () => {
  it("has correct metadata", () => {
    assert.strictEqual(circleCiParser.id, "circleci");
    assert.ok(Array.isArray(circleCiParser.patterns));
    assert.ok(circleCiParser.patterns.length > 0);
    assert.strictEqual(typeof circleCiParser.parse, "function");
  });

  it("returns empty arrays for no files", () => {
    const result = circleCiParser.parse([], {});
    assert.deepStrictEqual(result.workflows, []);
    assert.deepStrictEqual(result.components, []);
    assert.deepStrictEqual(result.services, []);
    assert.deepStrictEqual(result.properties, []);
    assert.deepStrictEqual(result.dependencies, []);
  });

  it("parses the CircleCI fixture", () => {
    const f = path.join(repoRoot, "test", "data", "circleci-config.yml");
    const result = circleCiParser.parse([f], {});

    assert.ok(Array.isArray(result.workflows));
    assert.ok(result.workflows.length > 0, "expected at least one workflow");

    // The fixture has one workflow named 'build-test-deploy'
    const wf = result.workflows.find((w) => w.name === "build-test-deploy");
    assert.ok(wf, "expected build-test-deploy workflow");
    assert.ok(wf["bom-ref"]);
    assert.ok(Array.isArray(wf.tasks));
    assert.ok(wf.tasks.length > 0);

    const taskNames = wf.tasks.map((t) => t.name);
    assert.ok(taskNames.includes("build"), "expected build job");
    assert.ok(taskNames.includes("test"), "expected test job");
  });

  it("captures orb references as components", () => {
    const f = path.join(repoRoot, "test", "data", "circleci-config.yml");
    const result = circleCiParser.parse([f], {});

    // The fixture uses circleci/node and circleci/aws-ecr orbs
    assert.ok(result.components.length > 0, "expected orb components");
    const orbNames = result.components.map((c) => c.name);
    assert.ok(orbNames.includes("node"), "expected circleci/node orb");
    assert.ok(orbNames.includes("aws-ecr"), "expected circleci/aws-ecr orb");
  });

  it("captures executor images as components", () => {
    const f = path.join(repoRoot, "test", "data", "circleci-config.yml");
    const result = circleCiParser.parse([f], {});

    const containerComps = result.components.filter(
      (c) => c.type === "container",
    );
    assert.ok(
      containerComps.length > 0,
      "expected container executor components",
    );
    assert.ok(
      containerComps.some((c) => c.name?.includes("node")),
      "expected a node executor image component",
    );
  });

  it("produces workflow dependency links", () => {
    const f = path.join(repoRoot, "test", "data", "circleci-config.yml");
    const result = circleCiParser.parse([f], {});

    assert.ok(result.dependencies.length > 0);
    const wfDep = result.dependencies.find(
      (d) => d.ref === result.workflows[0]["bom-ref"],
    );
    assert.ok(wfDep);
    assert.ok(wfDep.dependsOn.length > 0);
  });

  it("gracefully handles missing file", () => {
    const result = circleCiParser.parse(["/no/such/.circleci/config.yml"], {});
    assert.deepStrictEqual(result.workflows, []);
    assert.deepStrictEqual(result.components, []);
  });
});

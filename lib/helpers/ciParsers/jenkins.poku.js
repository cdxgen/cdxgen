import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { jenkinsParser } from "./jenkins.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

describe("jenkinsParser", () => {
  it("has correct metadata", () => {
    assert.strictEqual(jenkinsParser.id, "jenkins");
    assert.ok(Array.isArray(jenkinsParser.patterns));
    assert.ok(jenkinsParser.patterns.length > 0);
    assert.strictEqual(typeof jenkinsParser.parse, "function");
  });

  it("returns empty arrays for no files", () => {
    const result = jenkinsParser.parse([], {});
    assert.deepStrictEqual(result.workflows, []);
    assert.deepStrictEqual(result.components, []);
    assert.deepStrictEqual(result.services, []);
    assert.deepStrictEqual(result.properties, []);
    assert.deepStrictEqual(result.dependencies, []);
  });

  it("parses the Jenkinsfile fixture", () => {
    const f = path.join(repoRoot, "test", "data", "Jenkinsfile");
    const result = jenkinsParser.parse([f], {});

    assert.ok(Array.isArray(result.workflows));
    assert.strictEqual(result.workflows.length, 1, "expected one workflow");

    const wf = result.workflows[0];
    assert.ok(wf["bom-ref"]);
    assert.strictEqual(wf.name, "Jenkinsfile Pipeline");
    assert.ok(Array.isArray(wf.tasks));
    assert.ok(wf.tasks.length > 0, "expected at least one task (stage)");

    const stageNames = wf.tasks.map((t) => t.name);
    assert.ok(stageNames.includes("Install"), "expected Install stage");
    assert.ok(stageNames.includes("Build"), "expected Build stage");
    assert.ok(stageNames.includes("Test"), "expected Test stage");
  });

  it("captures docker agent image as a component", () => {
    const f = path.join(repoRoot, "test", "data", "Jenkinsfile");
    const result = jenkinsParser.parse([f], {});
    const compNames = result.components.map((c) => c.name);
    assert.ok(
      compNames.some((n) => n.includes("node")),
      "expected node docker image component",
    );
  });

  it("produces workflow dependency links", () => {
    const f = path.join(repoRoot, "test", "data", "Jenkinsfile");
    const result = jenkinsParser.parse([f], {});

    assert.ok(result.dependencies.length > 0);
    const wfDep = result.dependencies.find(
      (d) => d.ref === result.workflows[0]["bom-ref"],
    );
    assert.ok(wfDep);
    assert.ok(wfDep.dependsOn.length > 0);
  });

  it("gracefully handles non-declarative content", () => {
    const f = path.join(repoRoot, "test", "data", "gitlab-ci.yml");
    const result = jenkinsParser.parse([f], {});
    // .gitlab-ci.yml is not a Jenkinsfile → empty result
    assert.deepStrictEqual(result.workflows, []);
  });

  it("gracefully handles missing file", () => {
    const result = jenkinsParser.parse(["/no/such/Jenkinsfile"], {});
    assert.deepStrictEqual(result.workflows, []);
  });
});

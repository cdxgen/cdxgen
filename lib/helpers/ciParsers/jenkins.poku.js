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

  it("parses Jenkinsfile.agentany: agent any with no Docker image", () => {
    const f = path.join(repoRoot, "test", "data", "Jenkinsfile.agentany");
    const result = jenkinsParser.parse([f], {});

    assert.strictEqual(result.workflows.length, 1);
    // agent any → no container component
    assert.strictEqual(
      result.components.length,
      0,
      "no Docker component expected for agent any",
    );

    // agent property should record 'any'
    const agentProp = result.workflows[0].properties.find(
      (p) => p.name === "cdx:jenkins:agent",
    );
    assert.ok(agentProp, "expected cdx:jenkins:agent property");
    assert.strictEqual(agentProp.value, "any", "agent value should be 'any'");
  });

  it("parses Jenkinsfile.agentany: all expected stages present", () => {
    const f = path.join(repoRoot, "test", "data", "Jenkinsfile.agentany");
    const result = jenkinsParser.parse([f], {});

    const stageNames = result.workflows[0].tasks.map((t) => t.name);
    assert.ok(stageNames.includes("Checkout"), "expected Checkout stage");
    assert.ok(stageNames.includes("Compile"), "expected Compile stage");
    assert.ok(stageNames.includes("Unit Tests"), "expected Unit Tests stage");
    assert.ok(
      stageNames.includes("Integration Tests"),
      "expected Integration Tests stage",
    );
    assert.ok(stageNames.includes("Package"), "expected Package stage");
    assert.ok(stageNames.includes("Deploy"), "expected Deploy stage");
  });

  it("parses Jenkinsfile.agentany: `when` condition captured", () => {
    const f = path.join(repoRoot, "test", "data", "Jenkinsfile.agentany");
    const result = jenkinsParser.parse([f], {});

    const integTask = result.workflows[0].tasks.find(
      (t) => t.name === "Integration Tests",
    );
    assert.ok(integTask, "Integration Tests task must exist");
    const whenProp = integTask.properties.find(
      (p) => p.name === "cdx:jenkins:stage:when",
    );
    assert.ok(whenProp, "expected cdx:jenkins:stage:when property");
    assert.ok(
      whenProp.value.includes("RUN_INTEGRATION_TESTS"),
      "when must include param check",
    );
  });

  it("parses Jenkinsfile.agentany: parallel stage detected", () => {
    const f = path.join(repoRoot, "test", "data", "Jenkinsfile.agentany");
    const result = jenkinsParser.parse([f], {});

    const parallelTask = result.workflows[0].tasks.find(
      (t) => t.name === "Code Analysis",
    );
    assert.ok(parallelTask, "Code Analysis task must exist");
    const parallelProp = parallelTask.properties.find(
      (p) => p.name === "cdx:jenkins:stage:parallel",
    );
    assert.ok(parallelProp, "expected cdx:jenkins:stage:parallel property");
    assert.strictEqual(parallelProp.value, "true");
  });

  it("parses Jenkinsfile.multiplatform: per-stage Docker agents extracted", () => {
    const f = path.join(repoRoot, "test", "data", "Jenkinsfile.multiplatform");
    const result = jenkinsParser.parse([f], {});

    assert.strictEqual(result.workflows.length, 1);
    const stageNames = result.workflows[0].tasks.map((t) => t.name);
    assert.ok(stageNames.includes("Build Linux"), "expected Build Linux stage");
    assert.ok(
      stageNames.includes("Build Windows"),
      "expected Build Windows stage",
    );
    assert.ok(stageNames.includes("Build macOS"), "expected Build macOS stage");
    assert.ok(stageNames.includes("Package"), "expected Package stage");
    assert.ok(stageNames.includes("Release"), "expected Release stage");

    // Build Linux uses golang:1.22-bookworm docker image
    const compNames = result.components.map((c) => c.name);
    assert.ok(
      compNames.some((n) => n.includes("golang")),
      "expected golang Docker image component from Build Linux stage",
    );
  });

  it("parses Jenkinsfile.multiplatform: bat step in Windows stage captured", () => {
    const f = path.join(repoRoot, "test", "data", "Jenkinsfile.multiplatform");
    const result = jenkinsParser.parse([f], {});

    const winTask = result.workflows[0].tasks.find(
      (t) => t.name === "Build Windows",
    );
    assert.ok(winTask, "Build Windows task must exist");

    // bat steps should be captured as steps
    if (winTask.steps && winTask.steps.length > 0) {
      const batStep = winTask.steps.find((s) =>
        s.commands?.[0]?.executed?.includes("go"),
      );
      assert.ok(batStep, "expected a step with go command from bat");
    }
  });

  it("parses multiple Jenkinsfiles: two files produce two workflows", () => {
    const f1 = path.join(repoRoot, "test", "data", "Jenkinsfile");
    const f2 = path.join(repoRoot, "test", "data", "Jenkinsfile.agentany");
    const result = jenkinsParser.parse([f1, f2], {});
    assert.strictEqual(result.workflows.length, 2, "expected two workflows");
  });
});

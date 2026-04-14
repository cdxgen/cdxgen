import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { githubActionsParser } from "./githubActions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

describe("githubActionsParser", () => {
  it("has correct metadata", () => {
    assert.strictEqual(githubActionsParser.id, "github-actions");
    assert.ok(Array.isArray(githubActionsParser.patterns));
    assert.ok(githubActionsParser.patterns.length > 0);
    assert.strictEqual(typeof githubActionsParser.parse, "function");
  });

  it("returns empty arrays for no files", () => {
    const result = githubActionsParser.parse([], {});
    assert.deepStrictEqual(result.workflows, []);
    assert.deepStrictEqual(result.components, []);
    assert.deepStrictEqual(result.services, []);
    assert.deepStrictEqual(result.properties, []);
    assert.deepStrictEqual(result.dependencies, []);
  });

  it("parses a real GitHub Actions workflow file", () => {
    const wfFile = path.join(repoRoot, ".github", "workflows", "nodejs.yml");
    const result = githubActionsParser.parse([wfFile], { specVersion: 1.6 });

    assert.ok(Array.isArray(result.workflows));
    assert.ok(result.workflows.length > 0, "expected at least one workflow");

    const wf = result.workflows[0];
    assert.ok(wf["bom-ref"], "workflow must have bom-ref");
    assert.ok(wf.uid, "workflow must have uid");
    assert.ok(wf.name, "workflow must have a name");
    assert.ok(Array.isArray(wf.tasks), "workflow must have tasks array");
    assert.ok(wf.tasks.length > 0, "workflow must have at least one task");

    const firstTask = wf.tasks[0];
    assert.ok(firstTask["bom-ref"], "task must have bom-ref");
    assert.ok(firstTask.name, "task must have a name");

    // Components include referenced actions
    assert.ok(Array.isArray(result.components));
    assert.ok(result.components.length > 0, "expected action components");
    const actionComp = result.components.find((c) =>
      c.purl?.startsWith("pkg:github/"),
    );
    assert.ok(actionComp, "expected at least one pkg:github component");
  });

  it("parses the test fixture with vulnerable actions", () => {
    const wfFile = path.join(
      repoRoot,
      "test",
      "data",
      "github-actions-tj.yaml",
    );
    const result = githubActionsParser.parse([wfFile], { specVersion: 1.5 });

    assert.ok(result.workflows.length > 0);
    assert.ok(result.components.length > 0);

    const purls = result.components.map((c) => c.purl).filter(Boolean);
    assert.ok(
      purls.some((p) => p.includes("pixel/steamcmd")),
      "expected pixel/steamcmd purl",
    );
    assert.ok(
      purls.some((p) => p.includes("tj/branch")),
      "expected tj/branch purl",
    );
  });

  it("produces workflow→task dependency links", () => {
    const wfFile = path.join(repoRoot, ".github", "workflows", "nodejs.yml");
    const result = githubActionsParser.parse([wfFile], {});

    assert.ok(Array.isArray(result.dependencies));
    assert.ok(result.dependencies.length > 0);

    // At least the workflow-level dep entry must exist
    const workflowDep = result.dependencies.find(
      (d) => d.ref === result.workflows[0]["bom-ref"],
    );
    assert.ok(
      workflowDep,
      "expected a dependency entry for the workflow bom-ref",
    );
    assert.ok(Array.isArray(workflowDep.dependsOn));
    assert.ok(workflowDep.dependsOn.length > 0);
  });

  it("gracefully handles missing file", () => {
    const result = githubActionsParser.parse(
      ["/this/file/does/not/exist.yml"],
      {},
    );
    assert.deepStrictEqual(result.workflows, []);
    assert.deepStrictEqual(result.components, []);
  });

  it("gracefully handles malformed YAML", () => {
    // Parse the Jenkinsfile (not YAML) — should return empty results
    const jf = path.join(repoRoot, "test", "data", "Jenkinsfile");
    const result = githubActionsParser.parse([jf], {});
    // No jobs → empty results
    assert.deepStrictEqual(result.workflows, []);
  });
});

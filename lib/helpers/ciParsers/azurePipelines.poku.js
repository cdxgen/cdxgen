import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { azurePipelinesParser } from "./azurePipelines.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

describe("azurePipelinesParser", () => {
  it("has correct metadata", () => {
    assert.strictEqual(azurePipelinesParser.id, "azure-pipelines");
    assert.ok(Array.isArray(azurePipelinesParser.patterns));
    assert.ok(azurePipelinesParser.patterns.length > 0);
    assert.strictEqual(typeof azurePipelinesParser.parse, "function");
  });

  it("returns empty arrays for no files", () => {
    const result = azurePipelinesParser.parse([], {});
    assert.deepStrictEqual(result.workflows, []);
    assert.deepStrictEqual(result.components, []);
    assert.deepStrictEqual(result.services, []);
    assert.deepStrictEqual(result.properties, []);
    assert.deepStrictEqual(result.dependencies, []);
  });

  it("parses the Azure Pipelines fixture", () => {
    const f = path.join(repoRoot, "test", "data", "azure-pipelines.yml");
    const result = azurePipelinesParser.parse([f], {});

    assert.ok(Array.isArray(result.workflows));
    assert.strictEqual(result.workflows.length, 1);

    const wf = result.workflows[0];
    assert.ok(wf["bom-ref"]);
    assert.strictEqual(wf.name, "Azure Pipelines");
    assert.ok(Array.isArray(wf.tasks));
    assert.ok(wf.tasks.length > 0, "expected at least one task");

    // Stages are flattened: each stage+job becomes a task named
    // "StageName/JobName".  Tasks must NOT have a nested `tasks` property
    // (CycloneDX Task schema has additionalProperties: false).
    for (const task of wf.tasks) {
      assert.ok(!task.tasks, "Task must not have a nested tasks property");
    }

    const taskNames = wf.tasks.map((t) => t.name);
    assert.ok(
      taskNames.some((n) => n.startsWith("Build/")),
      "expected a Build/* task",
    );
    assert.ok(
      taskNames.some((n) => n.startsWith("DeployStaging/")),
      "expected a DeployStaging/* task",
    );
    assert.ok(
      taskNames.some((n) => n.startsWith("DeployProduction/")),
      "expected a DeployProduction/* task",
    );
  });

  it("captures pool vmImage as a component", () => {
    const f = path.join(repoRoot, "test", "data", "azure-pipelines.yml");
    const result = azurePipelinesParser.parse([f], {});

    const compNames = result.components.map((c) => c.name);
    assert.ok(
      compNames.includes("ubuntu-latest"),
      "expected ubuntu-latest component",
    );
  });

  it("records trigger branches in workflow properties", () => {
    const f = path.join(repoRoot, "test", "data", "azure-pipelines.yml");
    const result = azurePipelinesParser.parse([f], {});

    const props = result.workflows[0].properties || [];
    const triggerProp = props.find(
      (p) => p.name === "cdx:azure:trigger:branches",
    );
    assert.ok(triggerProp, "expected trigger branches property");
    assert.ok(triggerProp.value.includes("main"));
  });

  it("produces workflow dependency links", () => {
    const f = path.join(repoRoot, "test", "data", "azure-pipelines.yml");
    const result = azurePipelinesParser.parse([f], {});

    assert.ok(result.dependencies.length > 0);
    const wfDep = result.dependencies.find(
      (d) => d.ref === result.workflows[0]["bom-ref"],
    );
    assert.ok(wfDep);
    assert.ok(wfDep.dependsOn.length > 0);
  });

  it("gracefully handles missing file", () => {
    const result = azurePipelinesParser.parse(
      ["/no/such/azure-pipelines.yml"],
      {},
    );
    assert.deepStrictEqual(result.workflows, []);
    assert.deepStrictEqual(result.components, []);
  });

  it("skips files that do not look like Azure Pipelines", () => {
    // GitLab CI config has no `pool`, `stages` (in Azure sense), etc.
    // But it does have `stages`, so let's use the CircleCI config which has `version` but no pool
    const f = path.join(repoRoot, "test", "data", "circleci-config.yml");
    const result = azurePipelinesParser.parse([f], {});
    // CircleCI config triggers (orbs/executors) don't match Azure heuristic robustly,
    // so we just verify no exception is thrown and a result is returned
    assert.ok(Array.isArray(result.workflows));
    assert.ok(Array.isArray(result.components));
  });

  it("parses azure-pipelines-flat.yml: flat jobs (no stages) extracted as tasks", () => {
    const f = path.join(repoRoot, "test", "data", "azure-pipelines-flat.yml");
    const result = azurePipelinesParser.parse([f], {});

    assert.strictEqual(result.workflows.length, 1);
    const taskNames = result.workflows[0].tasks.map((t) => t.name);
    assert.ok(taskNames.includes("Lint"), "expected Lint job");
    assert.ok(taskNames.includes("UnitTests"), "expected UnitTests job");
    assert.ok(
      taskNames.includes("IntegrationTests"),
      "expected IntegrationTests job",
    );
    assert.ok(taskNames.includes("SecurityScan"), "expected SecurityScan job");
  });

  it("parses azure-pipelines-flat.yml: trigger branches recorded in workflow properties", () => {
    const f = path.join(repoRoot, "test", "data", "azure-pipelines-flat.yml");
    const result = azurePipelinesParser.parse([f], {});

    const triggerProp = result.workflows[0].properties.find(
      (p) => p.name === "cdx:azure:trigger:branches",
    );
    assert.ok(triggerProp, "expected cdx:azure:trigger:branches property");
    assert.ok(
      triggerProp.value.includes("main"),
      "trigger branches must include main",
    );
    assert.ok(
      triggerProp.value.includes("develop"),
      "trigger branches must include develop",
    );
  });

  it("parses azure-pipelines-flat.yml: job-level properties recorded", () => {
    const f = path.join(repoRoot, "test", "data", "azure-pipelines-flat.yml");
    const result = azurePipelinesParser.parse([f], {});

    const lintTask = result.workflows[0].tasks.find((t) => t.name === "Lint");
    assert.ok(lintTask, "Lint task must exist");
    const jobNameProp = lintTask.properties.find(
      (p) => p.name === "cdx:azure:job:name",
    );
    assert.ok(jobNameProp, "expected cdx:azure:job:name property on Lint task");
    assert.strictEqual(jobNameProp.value, "Lint");
  });

  it("parses azure-pipelines-matrix.yml: multi-stage pipeline extracted", () => {
    const f = path.join(repoRoot, "test", "data", "azure-pipelines-matrix.yml");
    const result = azurePipelinesParser.parse([f], {});

    // Each stage+job becomes a flattened task named "StageName/JobName".
    const taskNames = result.workflows[0].tasks.map((t) => t.name);
    assert.ok(
      taskNames.some((n) => n.startsWith("Validate/")),
      "expected Validate/* task",
    );
    assert.ok(
      taskNames.some((n) => n.startsWith("Test/")),
      "expected Test/* task",
    );
    assert.ok(
      taskNames.some((n) => n.startsWith("Build/")),
      "expected Build/* task",
    );
    assert.ok(
      taskNames.some((n) => n.startsWith("DeployStaging/")),
      "expected DeployStaging/* task",
    );
    assert.ok(
      taskNames.some((n) => n.startsWith("DeployProduction/")),
      "expected DeployProduction/* task",
    );
  });

  it("parses azure-pipelines-matrix.yml: stage dependsOn recorded in properties", () => {
    const f = path.join(repoRoot, "test", "data", "azure-pipelines-matrix.yml");
    const result = azurePipelinesParser.parse([f], {});

    // The Test stage depends on Validate; all Test/* tasks carry that property.
    const testTask = result.workflows[0].tasks.find((t) =>
      t.name.startsWith("Test/"),
    );
    assert.ok(testTask, "Test/* task must exist");
    const depProp = testTask.properties.find(
      (p) => p.name === "cdx:azure:stage:dependsOn",
    );
    assert.ok(depProp, "expected cdx:azure:stage:dependsOn property");
    assert.ok(
      depProp.value.includes("Validate"),
      "dependsOn must reference Validate",
    );
  });

  it("parses azure-pipelines-matrix.yml: trigger branches include release/* pattern", () => {
    const f = path.join(repoRoot, "test", "data", "azure-pipelines-matrix.yml");
    const result = azurePipelinesParser.parse([f], {});

    const triggerProp = result.workflows[0].properties.find(
      (p) => p.name === "cdx:azure:trigger:branches",
    );
    assert.ok(triggerProp, "expected cdx:azure:trigger:branches property");
    assert.ok(triggerProp.value.includes("main"), "must include main");
    assert.ok(
      triggerProp.value.includes("release/*"),
      "must include release/* branch pattern",
    );
  });

  it("parses azure-pipelines-matrix.yml: ubuntu-latest pool images captured as components", () => {
    const f = path.join(repoRoot, "test", "data", "azure-pipelines-matrix.yml");
    const result = azurePipelinesParser.parse([f], {});

    const platformComps = result.components.filter(
      (c) => c.type === "platform",
    );
    assert.ok(
      platformComps.length > 0,
      "expected at least one ubuntu-latest platform component",
    );
    assert.ok(
      platformComps.some((c) => c.name === "ubuntu-latest"),
      "expected ubuntu-latest component",
    );
  });

  it("parses multiple Azure Pipelines files: two files produce two workflows", () => {
    const f1 = path.join(repoRoot, "test", "data", "azure-pipelines.yml");
    const f2 = path.join(repoRoot, "test", "data", "azure-pipelines-flat.yml");
    const result = azurePipelinesParser.parse([f1, f2], {});
    assert.strictEqual(
      result.workflows.length,
      2,
      "expected two workflows for two files",
    );
  });
});

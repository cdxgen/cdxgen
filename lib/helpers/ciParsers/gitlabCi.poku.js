import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { gitlabCiParser } from "./gitlabCi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

describe("gitlabCiParser", () => {
  it("has correct metadata", () => {
    assert.strictEqual(gitlabCiParser.id, "gitlab-ci");
    assert.ok(Array.isArray(gitlabCiParser.patterns));
    assert.ok(gitlabCiParser.patterns.length > 0);
    assert.strictEqual(typeof gitlabCiParser.parse, "function");
  });

  it("returns empty arrays for no files", () => {
    const result = gitlabCiParser.parse([], {});
    assert.deepStrictEqual(result.workflows, []);
    assert.deepStrictEqual(result.components, []);
    assert.deepStrictEqual(result.services, []);
    assert.deepStrictEqual(result.properties, []);
    assert.deepStrictEqual(result.dependencies, []);
  });

  it("parses the GitLab CI fixture", () => {
    const f = path.join(repoRoot, "test", "data", "gitlab-ci.yml");
    const result = gitlabCiParser.parse([f], {});

    assert.ok(Array.isArray(result.workflows));
    assert.strictEqual(result.workflows.length, 1, "expected one workflow");

    const wf = result.workflows[0];
    assert.ok(wf["bom-ref"]);
    assert.strictEqual(wf.name, "GitLab CI Pipeline");
    assert.ok(Array.isArray(wf.tasks));
    assert.ok(wf.tasks.length > 0, "expected at least one task (job)");

    const jobNames = wf.tasks.map((t) => t.name);
    assert.ok(jobNames.includes("build"), "expected build job");
    assert.ok(jobNames.includes("test"), "expected test job");

    // image used in jobs captured as components
    assert.ok(Array.isArray(result.components));
    const compNames = result.components.map((c) => c.name);
    assert.ok(
      compNames.includes("node:20"),
      "expected node:20 container component",
    );
  });

  it("extracts services from jobs", () => {
    const f = path.join(repoRoot, "test", "data", "gitlab-ci.yml");
    const result = gitlabCiParser.parse([f], {});
    // The test job has services: [postgres:14, redis:7]
    assert.ok(Array.isArray(result.services));
    assert.ok(
      result.services.length > 0,
      "expected at least one service from jobs",
    );
    const svcNames = result.services.map((s) => s.name);
    assert.ok(
      svcNames.some((n) => n.includes("postgres")),
      "expected postgres service",
    );
    assert.ok(
      svcNames.some((n) => n.includes("redis")),
      "expected redis service",
    );
  });

  it("produces workflow dependency links", () => {
    const f = path.join(repoRoot, "test", "data", "gitlab-ci.yml");
    const result = gitlabCiParser.parse([f], {});

    assert.ok(result.dependencies.length > 0);
    const wfDep = result.dependencies.find(
      (d) => d.ref === result.workflows[0]["bom-ref"],
    );
    assert.ok(wfDep);
    assert.ok(wfDep.dependsOn.length > 0);
  });

  it("gracefully handles missing file", () => {
    const result = gitlabCiParser.parse(["/no/such/file/.gitlab-ci.yml"], {});
    assert.deepStrictEqual(result.workflows, []);
    assert.deepStrictEqual(result.components, []);
  });

  it("skips anchor/reserved keys", () => {
    const f = path.join(repoRoot, "test", "data", "gitlab-ci.yml");
    const result = gitlabCiParser.parse([f], {});
    const taskNames = result.workflows[0].tasks.map((t) => t.name);
    // Should not include 'image', 'stages', 'variables', 'cache', 'services'
    assert.ok(!taskNames.includes("image"));
    assert.ok(!taskNames.includes("stages"));
    assert.ok(!taskNames.includes("variables"));
    assert.ok(!taskNames.includes("cache"));
  });

  it("parses gitlab-ci-rules.yml: all jobs extracted (rules-based pipeline)", () => {
    const f = path.join(repoRoot, "test", "data", "gitlab-ci-rules.yml");
    const result = gitlabCiParser.parse([f], {});

    assert.strictEqual(result.workflows.length, 1);
    const taskNames = result.workflows[0].tasks.map((t) => t.name);

    // Core jobs must be present
    assert.ok(taskNames.includes("flake8"), "expected flake8 job");
    assert.ok(taskNames.includes("mypy"), "expected mypy job");
    assert.ok(taskNames.includes("build:wheel"), "expected build:wheel job");
    assert.ok(taskNames.includes("build:docker"), "expected build:docker job");
    assert.ok(taskNames.includes("test:unit"), "expected test:unit job");
    assert.ok(
      taskNames.includes("test:integration"),
      "expected test:integration job",
    );
    assert.ok(taskNames.includes("test:matrix"), "expected test:matrix job");
    assert.ok(
      taskNames.includes("deploy:staging"),
      "expected deploy:staging job",
    );
    assert.ok(
      taskNames.includes("deploy:production"),
      "expected deploy:production job",
    );

    // Hidden jobs (starts with '.') must NOT appear
    assert.ok(
      !taskNames.some((n) => n.startsWith(".")),
      "hidden jobs must not appear",
    );
  });

  it("parses gitlab-ci-rules.yml: job-level image object extracted", () => {
    const f = path.join(repoRoot, "test", "data", "gitlab-ci-rules.yml");
    const result = gitlabCiParser.parse([f], {});

    // build:docker uses `image: { name: gcr.io/kaniko-project/executor:debug, entrypoint: [""] }`
    const compNames = result.components.map((c) => c.name);
    assert.ok(
      compNames.some((n) => n.includes("kaniko")),
      "expected kaniko image as component from image object syntax",
    );
  });

  it("parses gitlab-ci-rules.yml: services with alias captured", () => {
    const f = path.join(repoRoot, "test", "data", "gitlab-ci-rules.yml");
    const result = gitlabCiParser.parse([f], {});

    const svcNames = result.services.map((s) => s.name);
    assert.ok(
      svcNames.some((n) => n.includes("postgres")),
      "expected postgres:15-alpine service",
    );
    assert.ok(
      svcNames.some((n) => n.includes("redis")),
      "expected redis:7-alpine service",
    );

    // test:integration job should record services in its properties
    const task = result.workflows[0].tasks.find(
      (t) => t.name === "test:integration",
    );
    assert.ok(task, "test:integration task must exist");
    const svcProp = task.properties.find(
      (p) => p.name === "cdx:gitlab:job:services",
    );
    assert.ok(svcProp, "expected cdx:gitlab:job:services property");
    assert.ok(
      svcProp.value.includes("postgres"),
      "services property must include postgres",
    );
  });

  it("parses gitlab-ci-rules.yml: DAG needs recorded in job properties", () => {
    const f = path.join(repoRoot, "test", "data", "gitlab-ci-rules.yml");
    const result = gitlabCiParser.parse([f], {});

    // test:unit needs build:wheel
    const unitTask = result.workflows[0].tasks.find(
      (t) => t.name === "test:unit",
    );
    assert.ok(unitTask, "test:unit task must exist");
    const needsProp = unitTask.properties.find(
      (p) => p.name === "cdx:gitlab:job:needs",
    );
    assert.ok(needsProp, "expected cdx:gitlab:job:needs property on test:unit");
    assert.ok(
      needsProp.value.includes("build:wheel"),
      "needs must reference build:wheel",
    );
  });

  it("parses gitlab-ci-rules.yml: stages property recorded on workflow", () => {
    const f = path.join(repoRoot, "test", "data", "gitlab-ci-rules.yml");
    const result = gitlabCiParser.parse([f], {});

    const stagesProp = result.workflows[0].properties.find(
      (p) => p.name === "cdx:gitlab:stages",
    );
    assert.ok(stagesProp, "expected cdx:gitlab:stages property");
    assert.ok(stagesProp.value.includes("lint"), "stages must include lint");
    assert.ok(
      stagesProp.value.includes("deploy"),
      "stages must include deploy",
    );
  });

  it("parses gitlab-ci-minimal.yml: minimal config — no stages, single job, no image", () => {
    const f = path.join(repoRoot, "test", "data", "gitlab-ci-minimal.yml");
    const result = gitlabCiParser.parse([f], {});

    assert.strictEqual(result.workflows.length, 1, "expected one workflow");
    const taskNames = result.workflows[0].tasks.map((t) => t.name);
    assert.ok(
      taskNames.includes("build_and_test"),
      "expected build_and_test job",
    );

    // No global image → no container components
    assert.strictEqual(
      result.components.filter((c) => c.type === "container").length,
      0,
      "no container components expected for minimal config",
    );

    // No stages property (stages array is empty)
    const stagesProp = result.workflows[0].properties.find(
      (p) => p.name === "cdx:gitlab:stages",
    );
    assert.ok(!stagesProp, "no stages property expected for minimal config");
  });

  it("parses multiple files: two separate .gitlab-ci.yml configs produce two workflows", () => {
    const f1 = path.join(repoRoot, "test", "data", "gitlab-ci.yml");
    const f2 = path.join(repoRoot, "test", "data", "gitlab-ci-minimal.yml");
    const result = gitlabCiParser.parse([f1, f2], {});
    assert.strictEqual(
      result.workflows.length,
      2,
      "expected two workflows for two files",
    );
  });
});

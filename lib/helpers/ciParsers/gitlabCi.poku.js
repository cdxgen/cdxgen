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
});

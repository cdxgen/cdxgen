import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { githubActionsParser, parseWorkflowFile } from "./githubActions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const workflowsDir = path.join(repoRoot, "test", "data", "workflows");

/**
 * Helper: Find a component by purl substring
 */
function findComponentByPurlSubstring(components, substring) {
  return components.find((c) => c.purl?.includes(substring));
}

/**
 * Helper: Extract property value from a component/workflow/task
 */
function getProp(obj, propName) {
  if (!obj?.properties) return undefined;
  const prop = obj.properties.find((p) => p.name === propName);
  return prop?.value;
}

/**
 * Helper: Check if a property exists with expected value
 */
function hasProp(obj, propName, expectedValue) {
  const val = getProp(obj, propName);
  return expectedValue !== undefined
    ? val === expectedValue
    : val !== undefined;
}

/**
 * Helper: Parse workflow and return flattened results for assertions
 */
function parseWorkflow(filename, options = {}) {
  const wfFile = path.join(workflowsDir, filename);
  return githubActionsParser.parse([wfFile], { specVersion: 1.6, ...options });
}

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
    const jf = path.join(repoRoot, "test", "data", "Jenkinsfile");
    const result = githubActionsParser.parse([jf], {});
    assert.deepStrictEqual(result.workflows, []);
  });

  it("derives unnamed workflow names from the file stem without leaking Windows-style path segments", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const workflowFile = path.join(tmpDir, "nested\\workflow-file.yml");
    mkdirSync(path.dirname(workflowFile), { recursive: true });
    writeFileSync(
      workflowFile,
      [
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        '    steps:\n      - run: echo "ok"',
      ].join("\n"),
    );

    try {
      const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
      assert.strictEqual(result.workflows.length, 1);
      assert.strictEqual(result.workflows[0].name, "workflow-file");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("disambiguates identical steps (uniqueItems compliance)", () => {
    const wfFile = path.join(
      repoRoot,
      "test",
      "data",
      "github-actions-qwiet.yaml",
    );
    const result = githubActionsParser.parse([wfFile], {});

    assert.ok(result.workflows.length > 0);
    const wf = result.workflows[0];
    const uploadTask = wf.tasks?.find((t) => t.name === "uploadArtifacts");
    assert.ok(uploadTask, "expected uploadArtifacts task");

    const steps = uploadTask.steps ?? [];
    const stepKeys = steps.map((s) => JSON.stringify(s));
    const uniqueKeys = new Set(stepKeys);
    assert.strictEqual(
      uniqueKeys.size,
      stepKeys.length,
      "steps array contains duplicate items",
    );

    const uploadSteps = steps.filter((s) =>
      s.name.startsWith("actions/upload-artifact@v1.0.0"),
    );
    assert.strictEqual(
      uploadSteps.length,
      2,
      "both upload-artifact steps must be kept",
    );
    assert.ok(
      uploadSteps.some((s) => s.name === "actions/upload-artifact@v1.0.0"),
      "first upload-artifact step must keep original name",
    );
    assert.ok(
      uploadSteps.some((s) => s.name === "actions/upload-artifact@v1.0.0 (2)"),
      "second upload-artifact step must be renamed with counter",
    );

    const preZeroTask = wf.tasks?.find((t) => t.name === "preZero");
    assert.ok(preZeroTask, "expected preZero task");
    const preZeroSteps = preZeroTask.steps ?? [];
    const preZeroKeys = preZeroSteps.map((s) => JSON.stringify(s));
    assert.strictEqual(
      new Set(preZeroKeys).size,
      preZeroKeys.length,
      "preZero steps must also have no duplicates",
    );
  });

  describe("checkout persist-credentials property emission", () => {
    it("emits persistCredentials=true when not specified (default)", () => {
      const result = parseWorkflow("checkout-default.yml");
      assert.ok(result.components.length > 0, "expected action components");
      const checkoutComp = findComponentByPurlSubstring(
        result.components,
        "actions/checkout",
      );
      assert.ok(checkoutComp, "expected actions/checkout component");
      assert.strictEqual(
        getProp(checkoutComp, "cdx:github:checkout:persistCredentials"),
        "true",
        "persistCredentials should default to 'true' when not specified",
      );
    });

    it("emits persistCredentials=false when explicitly disabled", () => {
      const result = parseWorkflow("checkout-no-persist.yml");

      const checkoutComp = findComponentByPurlSubstring(
        result.components,
        "actions/checkout",
      );
      assert.ok(checkoutComp, "expected actions/checkout component");

      assert.strictEqual(
        getProp(checkoutComp, "cdx:github:checkout:persistCredentials"),
        "false",
        "persistCredentials should be 'false' when explicitly set",
      );
    });

    it("emits persistCredentials for checkout in privileged workflow", () => {
      const result = parseWorkflow("checkout-privileged.yml");

      const checkoutComp = findComponentByPurlSubstring(
        result.components,
        "actions/checkout",
      );
      assert.ok(checkoutComp, "expected actions/checkout component");

      assert.strictEqual(
        getProp(checkoutComp, "cdx:github:checkout:persistCredentials"),
        "true",
      );
      assert.strictEqual(
        getProp(checkoutComp, "cdx:github:workflow:hasWritePermissions"),
        "true",
        "workflow should have write permissions flag",
      );
    });

    it("does not emit checkout properties for non-checkout actions", () => {
      const result = parseWorkflow("simple-build.yml");

      const nonCheckoutComp = result.components.find((c) =>
        c.purl?.includes("actions/setup-node"),
      );
      assert.ok(nonCheckoutComp, "expected setup-node component");

      assert.strictEqual(
        getProp(nonCheckoutComp, "cdx:github:checkout:persistCredentials"),
        undefined,
        "non-checkout actions should not have persistCredentials property",
      );
    });
  });

  describe("cache action property emission", () => {
    it("emits cache key and path properties", () => {
      const result = parseWorkflow("cache-basic.yml");

      const cacheComp = findComponentByPurlSubstring(
        result.components,
        "actions/cache",
      );
      assert.ok(cacheComp, "expected actions/cache component");
      // biome-ignore-start lint/suspicious/noTemplateCurlyInString: Test
      assert.strictEqual(
        getProp(cacheComp, "cdx:github:cache:key"),
        "npm-${{ hashFiles('**/package-lock.json') }}",
        "cache key should be extracted",
      );
      // biome-ignore-end lint/suspicious/noTemplateCurlyInString: Test
      assert.strictEqual(
        getProp(cacheComp, "cdx:github:cache:path"),
        "~/.npm",
        "cache path should be extracted",
      );
    });

    it("emits restore-keys as comma-separated list", () => {
      const result = parseWorkflow("cache-restore-keys.yml");

      const cacheComp = findComponentByPurlSubstring(
        result.components,
        "actions/cache",
      );
      assert.ok(cacheComp);

      const restoreKeys = getProp(cacheComp, "cdx:github:cache:restoreKeys");
      assert.ok(restoreKeys, "restore-keys should be emitted");
      assert.ok(
        restoreKeys.includes("npm-") && restoreKeys.includes("node-modules-"),
        "restore-keys should contain both fallback patterns",
      );
    });

    it("emits workflow triggers for cache context analysis", () => {
      const result = parseWorkflow("cache-pull-request.yml");

      const workflow = result.workflows[0];
      const triggers = getProp(workflow, "cdx:github:workflow:triggers");
      assert.ok(triggers, "workflow triggers should be emitted");
      assert.ok(
        triggers.split(",").includes("pull_request"),
        "pull_request trigger should be detected",
      );

      const cacheComp = findComponentByPurlSubstring(
        result.components,
        "actions/cache",
      );
      assert.strictEqual(
        getProp(cacheComp, "cdx:github:workflow:triggers"),
        "pull_request",
        "triggers should be duplicated to component level",
      );
    });

    it("handles cache action without optional fields gracefully", () => {
      const result = parseWorkflow("cache-minimal.yml");

      const cacheComp = findComponentByPurlSubstring(
        result.components,
        "actions/cache",
      );
      assert.ok(cacheComp);

      assert.ok(
        getProp(cacheComp, "cdx:github:cache:key"),
        "cache key should always be present",
      );
      assert.ok(
        getProp(cacheComp, "cdx:github:cache:path") === undefined ||
          typeof getProp(cacheComp, "cdx:github:cache:path") === "string",
        "cache path should be string or undefined",
      );
    });
  });

  describe("script injection interpolation detection", () => {
    it("detects github.event.pull_request interpolation", () => {
      const result = parseWorkflow("injection-pull-request-title.yml");

      const runStepComp = result.components.find((c) =>
        c.properties?.some(
          (p) => p.name === "cdx:github:step:hasUntrustedInterpolation",
        ),
      );
      assert.ok(
        runStepComp,
        "should detect untrusted interpolation in run step",
      );

      assert.strictEqual(
        getProp(runStepComp, "cdx:github:step:hasUntrustedInterpolation"),
        "true",
      );
      const vars = getProp(runStepComp, "cdx:github:step:interpolatedVars");
      assert.ok(vars, "interpolated variables should be listed");
      assert.ok(
        vars.includes("github.event.pull_request.title"),
        "should detect pull_request.title interpolation",
      );
    });

    it("detects github.head_ref interpolation", () => {
      const result = parseWorkflow("injection-head-ref.yml");

      const runStepComp = result.components.find((c) =>
        hasProp(c, "cdx:github:step:hasUntrustedInterpolation", "true"),
      );
      assert.ok(runStepComp);

      const vars = getProp(runStepComp, "cdx:github:step:interpolatedVars");
      assert.ok(
        vars.includes("github.head_ref"),
        "should detect github.head_ref interpolation",
      );
    });

    it("detects inputs.* interpolation in workflow_dispatch", () => {
      const result = parseWorkflow("injection-workflow-inputs.yml");

      const runStepComp = result.components.find((c) =>
        hasProp(c, "cdx:github:step:hasUntrustedInterpolation", "true"),
      );
      assert.ok(runStepComp);

      const vars = getProp(runStepComp, "cdx:github:step:interpolatedVars");
      assert.ok(
        vars.split(",").some((v) => v.trim().startsWith("inputs.")),
        "should detect inputs.* interpolation",
      );
    });

    it("does not flag safe interpolations", () => {
      const result = parseWorkflow("safe-interpolation.yml");

      const runStepComp = result.components.find(
        (c) => c.purl?.includes("run") || c.name?.includes("echo"),
      );

      if (runStepComp) {
        assert.strictEqual(
          getProp(runStepComp, "cdx:github:step:hasUntrustedInterpolation"),
          undefined,
          "safe env-var indirection should not trigger injection detection",
        );
      }
    });

    it("does not flag structured SHA interpolation as untrusted input", () => {
      const result = parseWorkflow("safe-sha-interpolation.yml");

      const runStepComp = result.components.find((c) =>
        c.properties?.some((p) => p.name === "cdx:github:step:type"),
      );
      assert.ok(runStepComp, "expected a run step component");
      assert.strictEqual(
        getProp(runStepComp, "cdx:github:step:hasUntrustedInterpolation"),
        undefined,
      );
    });

    it("handles multiple interpolations in single run block", () => {
      const result = parseWorkflow("injection-multiple-vars.yml");

      const runStepComp = result.components.find((c) =>
        hasProp(c, "cdx:github:step:hasUntrustedInterpolation", "true"),
      );
      assert.ok(runStepComp);

      const vars = getProp(runStepComp, "cdx:github:step:interpolatedVars");
      const varList = vars.split(",");
      assert.ok(
        varList.length >= 2,
        "should detect multiple untrusted variables",
      );
      assert.ok(
        varList.some((v) => v.includes("pull_request.title")),
        "should include pull_request.title",
      );
      assert.ok(
        varList.some((v) => v.includes("pull_request.body")),
        "should include pull_request.body",
      );
    });
  });

  describe("high-risk trigger detection", () => {
    it("flags pull_request_target trigger", () => {
      const result = parseWorkflow("trigger-pull-request-target.yml");

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasHighRiskTrigger"),
        "true",
        "pull_request_target should be flagged as high-risk",
      );

      const triggers = getProp(workflow, "cdx:github:workflow:triggers");
      assert.ok(
        triggers.split(",").includes("pull_request_target"),
        "trigger list should include pull_request_target",
      );
    });

    it("flags issue_comment trigger", () => {
      const result = parseWorkflow("trigger-issue-comment.yml");

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasHighRiskTrigger"),
        "true",
        "issue_comment should be flagged as high-risk",
      );
    });

    it("flags workflow_run trigger", () => {
      const result = parseWorkflow("trigger-workflow-run.yml");

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasHighRiskTrigger"),
        "true",
        "workflow_run should be flagged as high-risk",
      );
    });

    it("does not flag safe triggers", () => {
      const result = parseWorkflow("trigger-safe-push.yml");

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasHighRiskTrigger"),
        undefined,
        "push trigger should not be flagged as high-risk",
      );
    });

    it("combines high-risk trigger with write permissions in components", () => {
      const result = parseWorkflow("trigger-privileged.yml");

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasHighRiskTrigger"),
        "true",
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasWritePermissions"),
        "true",
      );

      const actionComp = result.components.find((c) =>
        c.purl?.includes("actions/checkout"),
      );
      if (actionComp) {
        assert.strictEqual(
          getProp(actionComp, "cdx:github:workflow:hasHighRiskTrigger"),
          "true",
          "high-risk trigger should be duplicated to component",
        );
        assert.strictEqual(
          getProp(actionComp, "cdx:github:workflow:hasWritePermissions"),
          "true",
          "write permissions should be duplicated to component",
        );
      }
    });
  });

  describe("combined security risk scenarios", () => {
    it("detects cache poisoning risk: cache + pull_request + write perms", () => {
      const result = parseWorkflow("risk-cache-poisoning.yml");

      const cacheComp = findComponentByPurlSubstring(
        result.components,
        "actions/cache",
      );
      assert.ok(cacheComp, "expected cache component");

      assert.ok(
        getProp(cacheComp, "cdx:github:cache:key"),
        "cache key should be present",
      );
      assert.strictEqual(
        getProp(cacheComp, "cdx:github:workflow:triggers"),
        "pull_request",
        "pull_request trigger should be duplicated",
      );
      assert.strictEqual(
        getProp(cacheComp, "cdx:github:workflow:hasWritePermissions"),
        "true",
        "write permissions should be duplicated",
      );
    });

    it("detects credential exposure: checkout persist + privileged workflow", () => {
      const result = parseWorkflow("risk-credential-exposure.yml");

      const checkoutComp = findComponentByPurlSubstring(
        result.components,
        "actions/checkout",
      );
      assert.ok(checkoutComp);

      assert.strictEqual(
        getProp(checkoutComp, "cdx:github:checkout:persistCredentials"),
        "true",
      );
      assert.strictEqual(
        getProp(checkoutComp, "cdx:github:workflow:hasWritePermissions"),
        "true",
      );
    });

    it("detects script injection in privileged context", () => {
      const result = parseWorkflow("risk-injection-privileged.yml");

      const injectionComp = result.components.find((c) =>
        hasProp(c, "cdx:github:step:hasUntrustedInterpolation", "true"),
      );
      assert.ok(injectionComp, "should detect injection attempt");

      assert.strictEqual(
        getProp(injectionComp, "cdx:github:workflow:hasWritePermissions"),
        "true",
        "injection in privileged workflow should have permission flag",
      );
    });

    it("detects unpinned action in high-risk trigger workflow", () => {
      const result = parseWorkflow("risk-unpinned-high-risk.yml");

      const actionComp = result.components.find((c) =>
        c.purl?.includes("third-party/action"),
      );
      assert.ok(actionComp);

      assert.strictEqual(
        getProp(actionComp, "cdx:github:action:isShaPinned"),
        "false",
        "action should be detected as unpinned",
      );
      assert.strictEqual(
        getProp(actionComp, "cdx:github:action:versionPinningType"),
        "tag",
        "pinning type should be 'tag'",
      );
      assert.strictEqual(
        getProp(actionComp, "cdx:github:workflow:hasHighRiskTrigger"),
        "true",
      );
    });
  });

  describe("edge cases and robustness", () => {
    it("handles checkout step with complex with: block", () => {
      const result = parseWorkflow("checkout-complex.yml");

      const checkoutComp = findComponentByPurlSubstring(
        result.components,
        "actions/checkout",
      );
      assert.ok(checkoutComp);

      const persistVal = getProp(
        checkoutComp,
        "cdx:github:checkout:persistCredentials",
      );
      assert.ok(
        persistVal === "true" || persistVal === "false",
        "persistCredentials should be boolean string",
      );
    });

    it("handles cache with array-style restore-keys", () => {
      const result = parseWorkflow("cache-array-restore.yml");

      const cacheComp = findComponentByPurlSubstring(
        result.components,
        "actions/cache",
      );
      assert.ok(cacheComp);

      const restoreKeys = getProp(cacheComp, "cdx:github:cache:restoreKeys");
      assert.ok(restoreKeys, "restore-keys should be emitted");
      assert.ok(
        restoreKeys.split(",").length >= 2,
        "should handle array-style restore-keys",
      );
    });

    it("handles interpolation with nested expressions", () => {
      const result = parseWorkflow("injection-nested.yml");

      const runStepComp = result.components.find((c) =>
        hasProp(c, "cdx:github:step:hasUntrustedInterpolation", "true"),
      );
      assert.ok(runStepComp);

      const vars = getProp(runStepComp, "cdx:github:step:interpolatedVars");
      assert.ok(
        vars.includes("github.event.pull_request.title") ||
          vars.includes("github.event.issue.title"),
        "should detect untrusted variable in nested expression",
      );
    });

    it("preserves existing properties when adding new ones", () => {
      const result = parseWorkflow("checkout-default.yml");

      const checkoutComp = findComponentByPurlSubstring(
        result.components,
        "actions/checkout",
      );
      assert.ok(checkoutComp);

      assert.ok(
        hasProp(checkoutComp, "cdx:github:action:uses"),
        "existing uses property should be preserved",
      );
      assert.ok(
        hasProp(checkoutComp, "cdx:github:action:isShaPinned"),
        "existing pinning property should be preserved",
      );
      assert.ok(
        hasProp(checkoutComp, "cdx:github:action:versionPinningType"),
        "existing versionPinningType should be preserved",
      );
      assert.ok(
        hasProp(checkoutComp, "cdx:github:checkout:persistCredentials"),
        "new persistCredentials property should be added",
      );
    });

    it("handles workflow with no jobs gracefully", () => {
      const result = parseWorkflow("empty-workflow.yml");

      assert.ok(Array.isArray(result.workflows));
      if (result.workflows.length > 0) {
        const wf = result.workflows[0];
        assert.ok(wf["bom-ref"], "workflow should have bom-ref even if empty");
      }
    });
  });

  describe("policy rule compatibility", () => {
    it("emits properties in JSONata-accessible format", () => {
      const result = parseWorkflow("checkout-privileged.yml");

      const checkoutComp = findComponentByPurlSubstring(
        result.components,
        "actions/checkout",
      );
      assert.ok(checkoutComp);

      assert.ok(Array.isArray(checkoutComp.properties));
      const propNames = checkoutComp.properties.map((p) => p.name);

      assert.ok(
        propNames.includes("cdx:github:checkout:persistCredentials"),
        "persistCredentials property should be JSONata-accessible",
      );
      assert.ok(
        propNames.includes("cdx:github:workflow:hasWritePermissions"),
        "hasWritePermissions should be JSONata-accessible on component",
      );
      assert.ok(
        propNames.includes("cdx:github:action:isShaPinned"),
        "isShaPinned should be JSONata-accessible",
      );
    });

    it("emits boolean properties as string 'true'/'false' for JSONata", () => {
      const result = parseWorkflow("checkout-default.yml");

      const checkoutComp = findComponentByPurlSubstring(
        result.components,
        "actions/checkout",
      );
      const persistVal = getProp(
        checkoutComp,
        "cdx:github:checkout:persistCredentials",
      );

      assert.strictEqual(
        typeof persistVal,
        "string",
        "boolean-like properties should be emitted as strings",
      );
      assert.ok(
        persistVal === "true" || persistVal === "false",
        "boolean properties should be 'true' or 'false' strings",
      );
    });

    it("emits list properties as comma-separated strings", () => {
      const result = parseWorkflow("cache-restore-keys.yml");

      const cacheComp = findComponentByPurlSubstring(
        result.components,
        "actions/cache",
      );
      const restoreKeys = getProp(cacheComp, "cdx:github:cache:restoreKeys");

      assert.strictEqual(
        typeof restoreKeys,
        "string",
        "list properties should be strings",
      );
      assert.ok(
        restoreKeys.includes(","),
        "multi-value lists should be comma-separated",
      );
    });

    it("duplicates workflow-level properties to components for policy scanning", () => {
      const result = parseWorkflow("risk-cache-poisoning.yml");

      const workflow = result.workflows[0];
      const workflowTriggers = getProp(
        workflow,
        "cdx:github:workflow:triggers",
      );
      const workflowPerms = getProp(
        workflow,
        "cdx:github:workflow:hasWritePermissions",
      );

      const cacheComp = findComponentByPurlSubstring(
        result.components,
        "actions/cache",
      );
      assert.strictEqual(
        getProp(cacheComp, "cdx:github:workflow:triggers"),
        workflowTriggers,
        "triggers should be duplicated to component",
      );
      assert.strictEqual(
        getProp(cacheComp, "cdx:github:workflow:hasWritePermissions"),
        workflowPerms,
        "permissions should be duplicated to component",
      );
    });
  });

  describe("workflow security metadata", () => {
    it("emits hidden Unicode workflow properties when dangerous characters appear in comments", () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
      const workflowFile = path.join(tmpDir, "unicode-workflow.yml");
      writeFileSync(
        workflowFile,
        [
          "name: Unicode workflow",
          "on: push",
          "# suspicious comment \u202E marker",
          "jobs:",
          "  test:",
          "    runs-on: ubuntu-latest",
          '    steps:\n      - run: echo "ok"',
        ].join("\n"),
      );

      try {
        const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
        assert.strictEqual(result.workflows.length, 1);
        const workflow = result.workflows[0];
        assert.strictEqual(
          getProp(workflow, "cdx:github:workflow:hasHiddenUnicode"),
          "true",
        );
        assert.strictEqual(
          getProp(workflow, "cdx:github:workflow:hiddenUnicodeInComments"),
          "true",
        );
        assert.match(
          getProp(workflow, "cdx:github:workflow:hiddenUnicodeCodePoints"),
          /U\+202E/,
        );
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("flags legacy npm and PyPI token-based publish commands in run steps", () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
      const workflowFile = path.join(tmpDir, "publish-workflow.yml");
      writeFileSync(
        workflowFile,
        [
          "name: Publish packages",
          "on: push",
          "env:",
          "  NPM_TOKEN: $" + "{{ secrets.NPM_TOKEN }}",
          "jobs:",
          "  release:",
          "    runs-on: ubuntu-latest",
          "    env:",
          "      TWINE_PASSWORD: $" + "{{ secrets.PYPI_TOKEN }}",
          "    steps:",
          "      - name: Publish npm",
          "        run: npm publish --token=$" + "{NPM_TOKEN}",
          "      - name: Publish pypi",
          "        run: twine upload dist/*",
        ].join("\n"),
      );

      try {
        const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
        const npmStep = result.components.find(
          (component) =>
            getProp(component, "cdx:github:step:publishEcosystem") === "npm",
        );
        const pypiStep = result.components.find(
          (component) =>
            getProp(component, "cdx:github:step:publishEcosystem") === "pypi",
        );

        assert.ok(npmStep, "expected npm publish run-step component");
        assert.ok(pypiStep, "expected PyPI publish run-step component");
        assert.strictEqual(
          getProp(npmStep, "cdx:github:step:usesLegacyPublishToken"),
          "true",
        );
        assert.match(
          getProp(npmStep, "cdx:github:step:legacyPublishTokenSources"),
          /cli-flag/,
        );
        assert.match(
          getProp(npmStep, "cdx:github:step:legacyPublishTokenSources"),
          /env:NPM_TOKEN/,
        );
        assert.strictEqual(
          getProp(pypiStep, "cdx:github:step:usesLegacyPublishToken"),
          "true",
        );
        assert.match(
          getProp(pypiStep, "cdx:github:step:legacyPublishTokenSources"),
          /env:TWINE_PASSWORD/,
        );
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });
});

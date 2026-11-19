import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it, skip } from "poku";

import { parseGitHubWorkflowDataWithEdges } from "../../ecosystems/parsers-misc.js";
import { mergeDependencies } from "../depsUtils.js";
import { getCiParseFailures, resetCiParseFailures } from "./common.js";
import { githubActionsParser, parseWorkflowFile } from "./githubActions.js";
import { appendActionsLockMetadataProperties } from "./githubActionsLockJoin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const workflowsDir = path.join(repoRoot, "test", "data", "workflows");
const actionsLockDir = path.join(repoRoot, "test", "data", "actions-lock");

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

/**
 * Helper: Parse workflow files of an actions-lock fixture tree the way the
 * formulation parser does, with the tree as the project root.
 */
function parseActionsLockFixture(caseName, filenames) {
  const treeRoot = path.join(actionsLockDir, caseName);
  const files = filenames.map((name) =>
    path.join(treeRoot, ".github", "workflows", name),
  );
  return {
    result: githubActionsParser.parse(
      files,
      { specVersion: 1.6 },
      { rootDir: treeRoot },
    ),
    treeRoot,
  };
}

/**
 * Helper: Collect the cdx:github:lock:* properties of a component
 */
function lockPropertiesOf(component) {
  return (component.properties || []).filter((property) =>
    property.name.startsWith("cdx:github:lock:"),
  );
}

/**
 * Helper: Capture console.warn for the duration of the callback
 */
function captureWarnings(callback) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { warnings, result: callback() };
  } finally {
    console.warn = originalWarn;
  }
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

  it("writes literal if conditions as string property values", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const workflowFile = path.join(tmpDir, "literal-if.yml");
    writeFileSync(
      workflowFile,
      [
        "name: Literal if",
        "on: push",
        "jobs:",
        "  always:",
        "    if: true",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "        if: false",
        "      - name: Enabled run",
        "        run: echo on",
        "        if: true",
        "      - name: Disabled run",
        "        run: echo off",
        "        if: false",
        "      - name: Expression run",
        "        run: echo push",
        "        if: github.event_name == 'push'",
        "  never:",
        "    if: false",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo never",
      ].join("\n"),
    );

    try {
      const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
      const allProps = [
        ...result.workflows.flatMap((w) => [
          ...(w.properties || []),
          ...(w.tasks || []).flatMap((t) => t.properties || []),
        ]),
        ...result.components.flatMap((c) => c.properties || []),
      ];
      for (const prop of allProps) {
        assert.strictEqual(
          typeof prop.value,
          "string",
          `${prop.name} must be a string`,
        );
      }
      const jobIfs = allProps
        .filter((p) => p.name === "cdx:github:job:if")
        .map((p) => p.value);
      assert.ok(jobIfs.includes("true"), "expected job if: true");
      assert.ok(jobIfs.includes("false"), "expected job if: false");
      const stepIf = (command) =>
        getProp(
          result.components.find(
            (c) => getProp(c, "cdx:github:step:command") === command,
          ),
          "cdx:github:step:if",
        );
      assert.strictEqual(stepIf("echo on"), "true");
      assert.strictEqual(stepIf("echo off"), "false");
      assert.strictEqual(stepIf("echo push"), "github.event_name == 'push'");
      const checkout = result.components.find((c) =>
        c.purl?.includes("actions/checkout"),
      );
      assert.strictEqual(getProp(checkout, "cdx:github:step:if"), "false");
      assert.strictEqual(
        getProp(checkout, "cdx:github:step:condition"),
        "false",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("writes numeric and boolean scalars as string property values", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const workflowFile = path.join(tmpDir, "scalars.yml");
    writeFileSync(
      workflowFile,
      [
        "name: 2024",
        "on: [push, 1]",
        "concurrency:",
        "  group: 9",
        "jobs:",
        "  build:",
        "    environment: 1",
        "    timeout-minutes: 30",
        "    needs: [1, 2]",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: 42",
        "        uses: actions/cache@v4",
        "        timeout: 5",
        "        with:",
        "          path: 7",
        "          key: 5",
        "          restore-keys:",
        "            - 6",
        "            - 8",
        "      - name: 43",
        "        uses: actions/cache@v4",
        "        with:",
        "          path: 7",
        "          key: 5",
        "          restore-keys: 6",
        "      - name: 44",
        "        uses: actions/checkout@v4",
        "        with:",
        "          ref: 1",
        "          repository: 2",
        "          persist-credentials: false",
        "      - name: true",
        "        run: echo hi",
        "  mapped:",
        "    environment:",
        "      name: 3",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: 45",
        "        run: echo mapped",
        "  called:",
        "    uses: ./.github/workflows/other.yml",
      ].join("\n"),
    );

    try {
      const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
      const objects = [
        ...result.workflows.flatMap((w) => [
          w,
          ...(w.tasks || []).flatMap((t) => [t, ...(t.steps || [])]),
        ]),
        ...result.components,
      ];
      for (const obj of objects) {
        assert.strictEqual(typeof obj.name, "string", "name must be a string");
        for (const prop of obj.properties || []) {
          assert.strictEqual(
            typeof prop.value,
            "string",
            `${prop.name} must be a string`,
          );
        }
      }
      const workflow = result.workflows[0];
      assert.strictEqual(workflow.name, "2024");
      assert.strictEqual(getProp(workflow, "cdx:github:workflow:name"), "2024");
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:concurrencyGroup"),
        "9",
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:triggers"),
        "push,1",
      );
      const build = workflow.tasks.find((t) => t.name === "build");
      assert.strictEqual(getProp(build, "cdx:github:job:environment"), "1");
      assert.strictEqual(getProp(build, "cdx:github:job:timeoutMinutes"), "30");
      assert.strictEqual(getProp(build, "cdx:github:job:needs"), "1,2");
      const mapped = workflow.tasks.find((t) => t.name === "mapped");
      assert.strictEqual(getProp(mapped, "cdx:github:job:environment"), "3");
      const caches = result.components.filter(
        (c) => getProp(c, "cdx:github:cache:key") === "5",
      );
      assert.strictEqual(caches.length, 2);
      assert.strictEqual(getProp(caches[0], "cdx:github:step:name"), "42");
      assert.strictEqual(getProp(caches[0], "cdx:github:step:timeout"), "5");
      assert.strictEqual(getProp(caches[0], "cdx:github:cache:path"), "7");
      assert.strictEqual(
        getProp(caches[0], "cdx:github:cache:restoreKeys"),
        "6,8",
      );
      assert.strictEqual(
        getProp(caches[1], "cdx:github:cache:restoreKeys"),
        "6",
      );
      const checkout = result.components.find((c) =>
        c.purl?.includes("actions/checkout"),
      );
      assert.strictEqual(getProp(checkout, "cdx:github:checkout:ref"), "1");
      assert.strictEqual(
        getProp(checkout, "cdx:github:checkout:repository"),
        "2",
      );
      assert.strictEqual(
        getProp(checkout, "cdx:github:checkout:persistCredentials"),
        "false",
      );
      assert.ok(result.components.some((c) => c.name === "true"));
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("does not write mappings where a scalar is expected", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const workflowFile = path.join(tmpDir, "mappings.yml");
    writeFileSync(
      workflowFile,
      [
        "name: Mappings",
        "on: push",
        "jobs:",
        "  build:",
        "    environment:",
        "      url: https://example.com",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name:",
        "          nested: value",
        "        uses: actions/cache@v4",
        "        with:",
        "          key:",
        "            nested: value",
        "          path:",
        "            nested: value",
      ].join("\n"),
    );

    try {
      const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
      const allProps = [
        ...result.workflows.flatMap((w) => [
          ...(w.properties || []),
          ...(w.tasks || []).flatMap((t) => t.properties || []),
        ]),
        ...result.components.flatMap((c) => c.properties || []),
      ];
      for (const prop of allProps) {
        assert.strictEqual(typeof prop.value, "string");
        assert.ok(
          !prop.value.includes("[object Object]"),
          `${prop.name} must not hold a stringified mapping`,
        );
      }
      const names = allProps.map((p) => p.name);
      assert.ok(!names.includes("cdx:github:job:environment"));
      assert.ok(!names.includes("cdx:github:cache:key"));
      assert.ok(!names.includes("cdx:github:step:name"));
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("gracefully handles non-string run fields", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const workflowFile = path.join(tmpDir, "non-string-run.yml");
    writeFileSync(
      workflowFile,
      [
        "name: Non-string run",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Numeric run",
        "        run: 42",
        "      - name: Object run",
        "        run:",
        "          nested: true",
      ].join("\n"),
    );

    try {
      const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
      assert.strictEqual(result.workflows.length, 1);
      assert.ok(result.workflows[0].tasks?.length > 0);
      const runStepComp = result.components.find(
        (component) =>
          getProp(component, "cdx:github:step:type") === "run" &&
          getProp(component, "cdx:github:step:command") === "42",
      );
      assert.ok(runStepComp, "expected numeric run step to be normalized");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("scans a run block with unclosed expressions in linear time", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const workflowFile = path.join(tmpDir, "unclosed-expressions.yml");
    // Neither run ever closes. An expression scan that backtracks over them
    // needs many seconds, and a linear one a few milliseconds.
    const unclosed = `\${{${" ".repeat(30000)}x ${"${{".repeat(60000)}`;
    writeFileSync(
      workflowFile,
      [
        "name: Unclosed expressions",
        "on: pull_request",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - run: "echo \${{ github.head_ref }} ${unclosed}"`,
      ].join("\n"),
    );

    try {
      const started = Date.now();
      const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
      const elapsed = Date.now() - started;
      const runStepComp = result.components.find((component) =>
        hasProp(component, "cdx:github:step:hasUntrustedInterpolation", "true"),
      );
      assert.ok(runStepComp, "expected the closed expression to be found");
      assert.strictEqual(
        getProp(runStepComp, "cdx:github:step:interpolatedVars"),
        "github.head_ref",
      );
      assert.ok(
        elapsed < 2000,
        `unclosed \${{ must not make the expression scan backtrack, took ${elapsed}ms`,
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("normalizes object-form runs-on values", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const workflowFile = path.join(tmpDir, "object-runs-on.yml");
    writeFileSync(
      workflowFile,
      [
        "name: Object runs-on",
        "on: push",
        "jobs:",
        "  grouped:",
        "    runs-on:",
        "      group: ubuntu-runners",
        "      labels: ubuntu-20.04-16core",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "  selfHosted:",
        "    runs-on:",
        "      group: larger-runners",
        "      labels: [self-hosted, linux, x64]",
        "    steps:",
        '      - run: echo "ok"',
      ].join("\n"),
    );

    try {
      const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
      const actionComp = result.components.find(
        (component) =>
          getProp(component, "cdx:github:action:uses") ===
          "actions/checkout@v4",
      );
      assert.strictEqual(
        getProp(actionComp, "cdx:github:job:runner"),
        "ubuntu-runners,ubuntu-20.04-16core",
      );

      const selfHostedTask = result.workflows[0].tasks.find(
        (task) => task.name === "selfHosted",
      );
      assert.strictEqual(
        getProp(selfHostedTask, "cdx:github:job:runner"),
        "larger-runners,self-hosted,linux,x64",
      );
      assert.strictEqual(
        getProp(selfHostedTask, "cdx:github:job:isSelfHosted"),
        "true",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("keeps every workflow when one file has more steps than a spread call can take", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const smallFile = path.join(tmpDir, "small.yml");
    writeFileSync(
      smallFile,
      [
        "name: Small",
        "on: pull_request_target",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        '      - run: echo "ok"',
      ].join("\n"),
    );
    // 70 jobs share one list of 2000 run steps through a YAML anchor, so a
    // 25 kB file yields 140 000 step components: more arguments than V8 lets
    // push(...components) put on the stack.
    const jobs = 70;
    const stepsPerJob = 2000;
    const lines = ["name: Huge", "on: push", "jobs:"];
    for (let i = 0; i < jobs; i++) {
      lines.push(`  j${i}:`, "    runs-on: ubuntu-latest");
      if (i === 0) {
        lines.push("    steps: &shared");
        for (let s = 0; s < stepsPerJob; s++) {
          lines.push("      - run: a");
        }
      } else {
        lines.push("    steps: *shared");
      }
    }
    const hugeFile = path.join(tmpDir, "huge.yml");
    writeFileSync(hugeFile, lines.join("\n"));

    try {
      const result = githubActionsParser.parse([smallFile, hugeFile], {
        specVersion: 1.7,
      });
      assert.strictEqual(result.workflows.length, 2);
      assert.strictEqual(result.components.length, jobs * stepsPerJob + 1);
      const smallWorkflow = result.workflows.find(
        (workflow) => workflow.name === "Small",
      );
      assert.strictEqual(
        getProp(
          smallWorkflow,
          "cdx:github:workflow:hasPullRequestTargetTrigger",
        ),
        "true",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("keeps the other workflows when one file makes the parser throw", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const goodFile = path.join(tmpDir, "good.yml");
    writeFileSync(
      goodFile,
      [
        "name: Good",
        "on: pull_request_target",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        '      - run: echo "ok"',
      ].join("\n"),
    );
    // runs-on labels that refer to themselves through an alias recurse
    // without end.
    const badFile = path.join(tmpDir, "bad.yml");
    writeFileSync(
      badFile,
      [
        "on: push",
        "jobs:",
        "  a:",
        "    runs-on: &r",
        "      labels: *r",
        "    steps:",
        "      - run: a",
      ].join("\n"),
    );

    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const result = githubActionsParser.parse([badFile, goodFile], {
        specVersion: 1.7,
      });
      assert.strictEqual(result.workflows.length, 1);
      assert.strictEqual(result.workflows[0].name, "Good");
      assert.strictEqual(
        getProp(
          result.workflows[0],
          "cdx:github:workflow:hasPullRequestTargetTrigger",
        ),
        "true",
      );
      assert.ok(
        warnings.some((w) => w.includes("bad.yml")),
        "expected a warning naming the file that failed",
      );
    } finally {
      console.warn = originalWarn;
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("records the files it cannot parse for the BOM audit", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const goodFile = path.join(tmpDir, "good.yml");
    writeFileSync(
      goodFile,
      ["on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest"].join(
        "\n",
      ),
    );
    const invalidFile = path.join(tmpDir, "invalid.yml");
    writeFileSync(invalidFile, "on: push\njobs: [\n");
    const throwingFile = path.join(tmpDir, "throwing.yml");
    writeFileSync(
      throwingFile,
      [
        "on: push",
        "jobs:",
        "  a:",
        "    runs-on: &r",
        "      labels: *r",
        "    steps:",
        "      - run: a",
      ].join("\n"),
    );
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    resetCiParseFailures();
    try {
      githubActionsParser.parse([goodFile, invalidFile, throwingFile], {
        specVersion: 1.7,
      });
      assert.deepStrictEqual(
        getCiParseFailures().map((failure) => [
          failure.parserId,
          path.basename(failure.file),
        ]),
        [
          ["github-actions", "invalid.yml"],
          ["github-actions", "throwing.yml"],
        ],
      );
      resetCiParseFailures();
      assert.deepStrictEqual(getCiParseFailures(), []);
    } finally {
      console.warn = originalWarn;
      resetCiParseFailures();
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("skips jobs and steps that are not mappings and keeps the rest of the file", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const f = path.join(tmpDir, "mixed.yml");
    writeFileSync(
      f,
      [
        "on: pull_request_target",
        "jobs:",
        "  empty:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      -",
        "      - uses: 5",
        "      - uses: actions/checkout@v4",
      ].join("\n"),
    );
    try {
      const result = parseWorkflowFile(f, { specVersion: 1.7 });
      assert.deepStrictEqual(
        result.workflows[0].tasks.map((task) => task.name),
        ["build"],
      );
      assert.ok(findComponentByPurlSubstring(result.components, "checkout"));
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("derives unnamed workflow names from the file stem without leaking Windows-style path segments", () => {
    if (typeof globalThis.Bun !== "undefined") {
      // bun's realpathSync treats the backslash in the file name as a
      // separator and loses the file (oven-sh/bun#33403), so the fixture
      // cannot be read there until that is fixed.
      skip("bun cannot read a file whose name carries a backslash");
    }
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

  it("records the workflow path relative to the scanned root", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
    const workflowFile = path.join(tmpDir, ".github", "workflows", "ci.yml");
    mkdirSync(path.dirname(workflowFile), { recursive: true });
    writeFileSync(
      workflowFile,
      [
        "on: [push, workflow_dispatch]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        '      - run: echo "ok"',
        "  reuse:",
        "    uses: ./.github/workflows/release.yml",
      ].join("\n"),
    );

    try {
      // The components section: internal:SrcFile and the evidence value keep
      // the absolute path for postgen, the cdx:github:* properties do not.
      const direct = parseWorkflowFile(
        workflowFile,
        { specVersion: 1.7 },
        tmpDir,
      );
      const action = findComponentByPurlSubstring(
        direct.components,
        "checkout",
      );
      assert.strictEqual(getProp(action, "internal:SrcFile"), workflowFile);
      assert.strictEqual(
        action.evidence.identity[0].methods[0].value,
        workflowFile,
      );
      for (const obj of [...direct.components, ...direct.workflows]) {
        assert.strictEqual(
          getProp(obj, "cdx:github:workflow:file"),
          ".github/workflows/ci.yml",
        );
        assert.strictEqual(
          getProp(obj, "cdx:github:workflow:workflowDispatchReceiverAliases"),
          "ci,ci.yml,.github/workflows/ci.yml",
        );
      }

      // The formulation section: nothing rewrites paths later.
      const result = githubActionsParser.parse(
        [workflowFile],
        { specVersion: 1.7 },
        { rootDir: tmpDir },
      );
      assert.ok(
        !JSON.stringify(result).includes(JSON.stringify(tmpDir).slice(1, -1)),
        "the formulation data must not carry the scan directory",
      );
      for (const component of result.components) {
        assert.strictEqual(
          getProp(component, "internal:SrcFile"),
          ".github/workflows/ci.yml",
        );
      }
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

  it("annotates Cargo setup, cache, and cargo run steps", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-cargo-"));
    const workflowFile = path.join(tmpDir, "cargo.yml");
    writeFileSync(
      workflowFile,
      [
        "name: Cargo CI",
        "on: push",
        "jobs:",
        "  rust:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: dtolnay/rust-toolchain@stable",
        "      - uses: actions/cache@v4",
        "        with:",
        "          path: |",
        "            ~/.cargo/registry",
        "            ~/.cargo/git",
        "          key: cargo-$" +
          "{{ runner.os }}-$" +
          "{{ hashFiles('**/Cargo.lock') }}",
        "      - run: cargo build --workspace && cargo test --workspace",
      ].join("\n"),
    );

    try {
      const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
      const cargoToolchainComp = result.components.find(
        (component) =>
          getProp(component, "cdx:github:action:uses") ===
          "dtolnay/rust-toolchain@stable",
      );
      const cargoCacheComp = result.components.find(
        (component) =>
          getProp(component, "cdx:github:action:uses") === "actions/cache@v4",
      );
      const cargoRunComp = result.components.find(
        (component) =>
          getProp(component, "cdx:github:step:usesCargo") === "true",
      );
      assert.ok(
        cargoToolchainComp,
        "expected Cargo toolchain action component",
      );
      assert.strictEqual(
        getProp(cargoToolchainComp, "cdx:github:action:ecosystem"),
        "cargo",
      );
      assert.strictEqual(
        getProp(cargoToolchainComp, "cdx:github:action:role"),
        "toolchain",
      );
      assert.ok(cargoCacheComp, "expected Cargo cache action component");
      assert.strictEqual(
        getProp(cargoCacheComp, "cdx:github:action:ecosystem"),
        "cargo",
      );
      assert.strictEqual(
        getProp(cargoCacheComp, "cdx:github:action:role"),
        "cache",
      );
      assert.ok(cargoRunComp, "expected Cargo run step component");
      assert.strictEqual(
        getProp(cargoRunComp, "cdx:github:step:cargoSubcommands"),
        "build,test",
      );
      assert.strictEqual(
        getProp(cargoRunComp, "cdx:github:step:cargoWorkspaceScope"),
        "true",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
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

    it("emits pull_request_target trigger metadata for cache poisoning analysis", () => {
      const result = parseWorkflow("cache-pull-request-target.yml");

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasPullRequestTargetTrigger"),
        "true",
      );

      const cacheComp = findComponentByPurlSubstring(
        result.components,
        "actions/cache",
      );
      assert.ok(cacheComp, "expected actions/cache component");
      assert.strictEqual(
        getProp(cacheComp, "cdx:github:workflow:hasPullRequestTargetTrigger"),
        "true",
      );
      assert.strictEqual(
        getProp(cacheComp, "cdx:github:workflow:hasWritePermissions"),
        "true",
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

  describe("setup action cache disable property emission", () => {
    it("emits cache disable properties for setup-node, setup-python, and setup-rust", () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-cache-"));
      const workflowFile = path.join(tmpDir, "cache-disable.yml");
      writeFileSync(
        workflowFile,
        [
          "name: Cache disable",
          "on: push",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/setup-node@v4",
          "        with:",
          "          node-version: 20",
          "          package-manager-cache: false",
          "      - uses: actions/setup-python@v5",
          "        with:",
          "          python-version: '3.12'",
          "          cache: false",
          "      - uses: moonrepo/setup-rust@v1",
          "        with:",
          "          cache: false",
        ].join("\n"),
      );

      try {
        const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
        const setupNodeComp = result.components.find(
          (component) =>
            getProp(component, "cdx:github:action:uses") ===
            "actions/setup-node@v4",
        );
        const setupPythonComp = result.components.find(
          (component) =>
            getProp(component, "cdx:github:action:uses") ===
            "actions/setup-python@v5",
        );
        const setupRustComp = result.components.find(
          (component) =>
            getProp(component, "cdx:github:action:uses") ===
            "moonrepo/setup-rust@v1",
        );
        assert.ok(setupNodeComp, "expected setup-node component");
        assert.ok(setupPythonComp, "expected setup-python component");
        assert.ok(setupRustComp, "expected setup-rust component");
        assert.strictEqual(
          getProp(setupNodeComp, "cdx:github:action:disablesBuildCache"),
          "true",
        );
        assert.strictEqual(
          getProp(setupNodeComp, "cdx:github:action:buildCacheEcosystem"),
          "npm",
        );
        assert.strictEqual(
          getProp(setupNodeComp, "cdx:github:action:buildCacheDisableInput"),
          "package-manager-cache",
        );
        assert.strictEqual(
          getProp(setupPythonComp, "cdx:github:action:disablesBuildCache"),
          "true",
        );
        assert.strictEqual(
          getProp(setupPythonComp, "cdx:github:action:buildCacheEcosystem"),
          "pypi",
        );
        assert.strictEqual(
          getProp(setupPythonComp, "cdx:github:action:buildCacheDisableInput"),
          "cache",
        );
        assert.strictEqual(
          getProp(setupRustComp, "cdx:github:action:disablesBuildCache"),
          "true",
        );
        assert.strictEqual(
          getProp(setupRustComp, "cdx:github:action:buildCacheEcosystem"),
          "cargo",
        );
        assert.strictEqual(
          getProp(setupRustComp, "cdx:github:action:buildCacheDisableInput"),
          "cache",
        );
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("does not emit cache disable properties when cache is not explicitly disabled", () => {
      const result = parseWorkflow("simple-build.yml");
      const setupNodeComp = result.components.find(
        (component) =>
          getProp(component, "cdx:github:action:uses") ===
          "actions/setup-node@v4",
      );
      assert.ok(setupNodeComp, "expected setup-node component");
      assert.strictEqual(
        getProp(setupNodeComp, "cdx:github:action:disablesBuildCache"),
        undefined,
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

    it("detects github.event.comment.body interpolation in issue_comment workflows", () => {
      const result = parseWorkflow("injection-issue-comment-body.yml");

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasIssueCommentTrigger"),
        "true",
      );
      const runStepComp = result.components.find((c) =>
        hasProp(c, "cdx:github:step:hasUntrustedInterpolation", "true"),
      );
      assert.ok(runStepComp, "expected issue_comment injection component");
      assert.match(
        getProp(runStepComp, "cdx:github:step:interpolatedVars"),
        /github\.event\.comment\.body/,
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

  describe("explicit permissions metadata and sensitive-operation heuristics", () => {
    it("emits false explicit-permissions metadata and sensitive-operation flags for implicit high-risk workflows", () => {
      const result = parseWorkflow(
        "heuristic-implicit-permissions-sensitive.yml",
      );

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasHighRiskTrigger"),
        "true",
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasExplicitPermissionsBlock"),
        "false",
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasAnyExplicitPermissionsBlock"),
        "false",
      );

      const runStepComp = result.components.find(
        (component) => component.name === "Trigger downstream release",
      );
      assert.ok(runStepComp, "expected sensitive run-step component");
      assert.strictEqual(
        getProp(
          runStepComp,
          "cdx:github:workflow:hasAnyExplicitPermissionsBlock",
        ),
        "false",
      );
      assert.strictEqual(
        getProp(runStepComp, "cdx:github:step:hasSensitiveOperations"),
        "true",
      );
      assert.match(
        getProp(runStepComp, "cdx:github:step:sensitiveOperations"),
        /dispatches-workflow/,
      );
      assert.match(
        getProp(runStepComp, "cdx:github:step:sensitiveOperations"),
        /references-sensitive-context/,
      );
    });

    it("emits true explicit-permissions metadata when a permissions block is present", () => {
      const result = parseWorkflow(
        "heuristic-explicit-permissions-sensitive.yml",
      );

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasExplicitPermissionsBlock"),
        "true",
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasAnyExplicitPermissionsBlock"),
        "true",
      );

      const runStepComp = result.components.find(
        (component) => component.name === "Trigger downstream release",
      );
      assert.ok(runStepComp, "expected sensitive run-step component");
      assert.strictEqual(
        getProp(
          runStepComp,
          "cdx:github:workflow:hasAnyExplicitPermissionsBlock",
        ),
        "true",
      );
      assert.strictEqual(
        getProp(runStepComp, "cdx:github:step:hasSensitiveOperations"),
        "true",
      );
    });
  });

  describe("job-scoped privilege and trust metadata", () => {
    it("propagates job-scoped id-token write to components and workflows", () => {
      const result = parseWorkflow("job-id-token-write.yml");

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasIdTokenWrite"),
        "true",
      );

      const actionComp = findComponentByPurlSubstring(
        result.components,
        "vendor/deploy-action",
      );
      assert.ok(actionComp, "expected third-party deploy action");
      assert.strictEqual(
        getProp(actionComp, "cdx:github:workflow:hasIdTokenWrite"),
        "true",
      );
      assert.strictEqual(
        getProp(actionComp, "cdx:github:job:hasIdTokenWrite"),
        "true",
      );
      assert.strictEqual(
        getProp(actionComp, "cdx:actions:isOfficial"),
        "false",
      );
      assert.strictEqual(
        getProp(actionComp, "cdx:actions:isVerified"),
        "false",
      );
    });

    it("emits workflow dispatch input metadata", () => {
      const result = parseWorkflow("injection-workflow-inputs.yml");

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasWorkflowDispatchInputs"),
        "true",
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasWorkflowDispatchTrigger"),
        "true",
      );
      assert.ok(
        getProp(workflow, "cdx:github:workflow:workflowDispatchInputs")?.split(
          ",",
        ).length >= 1,
      );
    });
  });

  describe("reusable workflow parsing", () => {
    it("models external reusable workflows with secrets inheritance", () => {
      const result = parseWorkflow("reusable-workflow-secrets-inherit.yml");

      const reusableComp = result.components.find((c) =>
        hasProp(c, "cdx:github:reusableWorkflow:secretsInherit", "true"),
      );
      assert.ok(reusableComp, "expected reusable workflow component");
      assert.strictEqual(
        getProp(reusableComp, "cdx:github:reusableWorkflow:isExternal"),
        "true",
      );
      assert.strictEqual(
        getProp(reusableComp, "cdx:github:reusableWorkflow:isShaPinned"),
        "false",
      );
      assert.strictEqual(
        getProp(reusableComp, "cdx:github:reusableWorkflow:versionPinningType"),
        "branch",
      );
    });

    it("models external reusable workflows pinned to mutable refs", () => {
      const result = parseWorkflow("reusable-workflow-external-unpinned.yml");

      const reusableComp = result.components.find((c) =>
        hasProp(c, "cdx:github:reusableWorkflow:isExternal", "true"),
      );
      assert.ok(reusableComp, "expected external reusable workflow component");
      assert.strictEqual(
        getProp(reusableComp, "cdx:github:reusableWorkflow:isShaPinned"),
        "false",
      );
      assert.strictEqual(
        getProp(reusableComp, "cdx:github:reusableWorkflow:withKeys"),
        "run-tests",
      );
    });

    it("emits workflow_call producer metadata for reusable workflow definitions", () => {
      const result = parseWorkflow("workflow-call-producer-risky.yml");

      const workflow = result.workflows[0];
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasWorkflowCallTrigger"),
        "true",
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:isWorkflowCallProducer"),
        "true",
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:workflowCallInputs"),
        "release_tag",
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:workflowCallSecrets"),
        "release_token",
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:workflowCallOutputs"),
        "image_tag",
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:hasWritePermissions"),
        "true",
      );

      const actionComp = findComponentByPurlSubstring(
        result.components,
        "vendor/publish-action",
      );
      assert.ok(actionComp, "expected publish action component");
      assert.strictEqual(
        getProp(actionComp, "cdx:github:workflow:hasWorkflowCallTrigger"),
        "true",
      );
      assert.strictEqual(
        getProp(actionComp, "cdx:github:workflow:workflowCallSecrets"),
        "release_token",
      );
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
      assert.strictEqual(
        getProp(cacheComp, "cdx:github:workflow:hasPullRequestTrigger"),
        "true",
      );
      assert.strictEqual(
        getProp(cacheComp, "cdx:github:cache:keyUsesHashFiles"),
        undefined,
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

    it("detects checkout of pull_request head context inside pull_request_target", () => {
      const result = parseWorkflow("checkout-untrusted-pr-head.yml");

      const checkoutComp = findComponentByPurlSubstring(
        result.components,
        "actions/checkout",
      );
      assert.ok(checkoutComp, "expected actions/checkout component");
      assert.strictEqual(
        getProp(
          checkoutComp,
          "cdx:github:workflow:hasPullRequestTargetTrigger",
        ),
        "true",
      );
      assert.strictEqual(
        getProp(checkoutComp, "cdx:github:checkout:checksOutUntrustedRef"),
        "true",
      );
      assert.match(
        getProp(checkoutComp, "cdx:github:checkout:untrustedRefContexts"),
        /github\.event\.pull_request\.head\.sha/,
      );
      assert.strictEqual(
        getProp(checkoutComp, "cdx:github:checkout:referencesForkContext"),
        "true",
      );
      assert.match(
        getProp(checkoutComp, "cdx:github:checkout:forkContextRefs"),
        /github\.event\.pull_request\.head\.repo\.full_name/,
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

    it("detects self-hosted runners in high-risk workflows", () => {
      const result = parseWorkflow("self-hosted-high-risk.yml");

      const actionComp = findComponentByPurlSubstring(
        result.components,
        "actions/checkout",
      );
      assert.ok(actionComp, "expected actions/checkout component");
      assert.strictEqual(
        getProp(actionComp, "cdx:github:job:isSelfHosted"),
        "true",
      );
      assert.strictEqual(
        getProp(actionComp, "cdx:github:workflow:hasHighRiskTrigger"),
        "true",
      );
    });

    it("detects runner-state mutation in privileged run steps", () => {
      const result = parseWorkflow("runner-state-mutation.yml");

      const runStepComp = result.components.find((c) =>
        hasProp(c, "cdx:github:step:mutatesRunnerState", "true"),
      );
      assert.ok(runStepComp, "expected runner-state mutation component");
      assert.strictEqual(
        getProp(runStepComp, "cdx:github:step:runnerStateTargets"),
        "GITHUB_ENV",
      );
      assert.strictEqual(
        getProp(runStepComp, "cdx:github:workflow:hasWritePermissions"),
        "true",
      );
    });

    it("detects outbound commands that reference sensitive context", () => {
      const result = parseWorkflow("outbound-sensitive-context.yml");

      const runStepComp = result.components.find((c) =>
        hasProp(c, "cdx:github:step:hasOutboundNetworkCommand", "true"),
      );
      assert.ok(runStepComp, "expected outbound network component");
      assert.strictEqual(
        getProp(runStepComp, "cdx:github:step:referencesSensitiveContext"),
        "true",
      );
      assert.match(
        getProp(runStepComp, "cdx:github:step:sensitiveContextRefs"),
        /env:UPLOAD_AUTH/,
      );
      assert.strictEqual(
        getProp(runStepComp, "cdx:github:step:likelyExfiltration"),
        "true",
      );
      assert.match(
        getProp(runStepComp, "cdx:github:step:exfiltrationIndicators"),
        /auth-header/,
      );
      assert.match(
        getProp(runStepComp, "cdx:github:step:exfiltrationIndicators"),
        /state-changing-method/,
      );
    });

    it("does not mark low-signal outbound steps as likely exfiltration", () => {
      const result = parseWorkflow("outbound-sensitive-context-low-signal.yml");

      const runStepComp = result.components.find((c) =>
        hasProp(c, "cdx:github:step:hasOutboundNetworkCommand", "true"),
      );
      assert.ok(runStepComp, "expected outbound network component");
      assert.strictEqual(
        getProp(runStepComp, "cdx:github:step:referencesSensitiveContext"),
        "true",
      );
      assert.strictEqual(
        getProp(runStepComp, "cdx:github:step:likelyExfiltration"),
        undefined,
      );
    });

    it("detects fork-aware workflow dispatch chains in run steps", () => {
      const result = parseWorkflow("dispatch-chain-fork-sensitive.yml");

      const dispatchStepComp = result.components.find((c) =>
        hasProp(c, "cdx:github:step:dispatchesWorkflow", "true"),
      );
      assert.ok(
        dispatchStepComp,
        "expected dispatching workflow step component",
      );
      assert.strictEqual(
        getProp(dispatchStepComp, "cdx:github:step:dispatchKinds"),
        "workflow_dispatch",
      );
      assert.match(
        getProp(dispatchStepComp, "cdx:github:step:dispatchMechanisms"),
        /gh-workflow-run/,
      );
      assert.match(
        getProp(dispatchStepComp, "cdx:github:step:dispatchTargets"),
        /workflow:release.yml/,
      );
      assert.strictEqual(
        getProp(dispatchStepComp, "cdx:github:step:referencesForkContext"),
        "true",
      );
      assert.match(
        getProp(dispatchStepComp, "cdx:github:step:sensitiveContextRefs"),
        /env:GH_TOKEN/,
      );
    });

    it("detects workflow dispatches from actions/github-script", () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
      const workflowFile = path.join(tmpDir, "github-script-dispatch.yml");
      writeFileSync(
        workflowFile,
        [
          "name: Script dispatch",
          "on: workflow_run",
          "permissions:",
          "  actions: write",
          "jobs:",
          "  relay:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/github-script@v7",
          "        with:",
          "          github-token: $" + "{{ secrets.GITHUB_TOKEN }}",
          "          script: |",
          "            await github.rest.actions.createWorkflowDispatch({",
          "              owner: 'octo-org',",
          "              repo: 'release-repo',",
          "              workflow_id: 'release.yml',",
          "              ref: 'main',",
          "            });",
        ].join("\n"),
      );

      try {
        const result = parseWorkflowFile(workflowFile, { specVersion: 1.7 });
        const githubScriptComp = findComponentByPurlSubstring(
          result.components,
          "actions/github-script",
        );
        assert.ok(githubScriptComp, "expected actions/github-script component");
        assert.strictEqual(
          getProp(githubScriptComp, "cdx:github:step:dispatchesWorkflow"),
          "true",
        );
        assert.match(
          getProp(githubScriptComp, "cdx:github:step:dispatchTargets"),
          /repo:octo-org\/release-repo/,
        );
        assert.match(
          getProp(githubScriptComp, "cdx:github:step:sensitiveContextRefs"),
          /input:github-token/,
        );
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("correlates dispatch senders with local receiver workflow definitions", () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-"));
      const senderWorkflow = path.join(tmpDir, "sender.yml");
      const dispatchReceiverWorkflow = path.join(tmpDir, "release.yml");
      const repoDispatchReceiverWorkflow = path.join(
        tmpDir,
        "repo-dispatch.yml",
      );
      writeFileSync(
        senderWorkflow,
        [
          "name: Sender workflow",
          "on: push",
          "jobs:",
          "  relay:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - name: Trigger release receiver",
          "        env:",
          "          GH_TOKEN: $" + "{{ github.token }}",
          "        run: gh workflow run release.yml --ref main",
          "      - name: Trigger promote event",
          "        uses: peter-evans/repository-dispatch@v3",
          "        with:",
          "          event-type: promote",
        ].join("\n"),
      );
      writeFileSync(
        dispatchReceiverWorkflow,
        [
          "name: Release workflow",
          "on:",
          "  workflow_dispatch:",
          "    inputs:",
          "      version:",
          "        required: true",
          "jobs:",
          "  release:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo release",
        ].join("\n"),
      );
      writeFileSync(
        repoDispatchReceiverWorkflow,
        [
          "name: Promote workflow",
          "on:",
          "  repository_dispatch:",
          "    types: [promote]",
          "jobs:",
          "  promote:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo promote",
        ].join("\n"),
      );

      try {
        const result = githubActionsParser.parse(
          [
            senderWorkflow,
            dispatchReceiverWorkflow,
            repoDispatchReceiverWorkflow,
          ],
          { specVersion: 1.7 },
        );
        const runDispatchStep = result.components.find(
          (component) => component.name === "Trigger release receiver",
        );
        assert.ok(
          runDispatchStep,
          "expected local workflow_dispatch sender step",
        );
        assert.strictEqual(
          getProp(runDispatchStep, "cdx:github:step:hasLocalDispatchReceiver"),
          "true",
        );
        assert.match(
          getProp(
            runDispatchStep,
            "cdx:github:step:dispatchReceiverWorkflowFiles",
          ),
          /release\.yml/,
        );
        assert.match(
          getProp(
            runDispatchStep,
            "cdx:github:step:dispatchReceiverWorkflowNames",
          ),
          /Release workflow/,
        );

        const actionDispatchStep = result.components.find(
          (component) =>
            getProp(component, "cdx:github:action:uses") ===
            "peter-evans/repository-dispatch@v3",
        );
        assert.ok(
          actionDispatchStep,
          "expected local repository_dispatch sender step",
        );
        assert.strictEqual(
          getProp(
            actionDispatchStep,
            "cdx:github:step:hasLocalDispatchReceiver",
          ),
          "true",
        );
        assert.match(
          getProp(
            actionDispatchStep,
            "cdx:github:step:dispatchReceiverMatchBasis",
          ),
          /repository_dispatch:promote/,
        );

        const releaseWorkflow = result.workflows.find(
          (workflow) => workflow.name === "Release workflow",
        );
        assert.ok(
          releaseWorkflow,
          "expected workflow_dispatch receiver workflow",
        );
        assert.strictEqual(
          getProp(
            releaseWorkflow,
            "cdx:github:workflow:hasLocalDispatchSender",
          ),
          "true",
        );
        assert.match(
          getProp(
            releaseWorkflow,
            "cdx:github:workflow:dispatchSenderWorkflowNames",
          ),
          /Sender workflow/,
        );

        const repoDispatchWorkflow = result.workflows.find(
          (workflow) => workflow.name === "Promote workflow",
        );
        assert.ok(
          repoDispatchWorkflow,
          "expected repository_dispatch receiver workflow",
        );
        assert.match(
          getProp(
            repoDispatchWorkflow,
            "cdx:github:workflow:repositoryDispatchTypes",
          ),
          /promote/,
        );
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
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

    it("treats short hexadecimal refs as mutable action versions, not immutable SHAs", () => {
      const result = parseWorkflow("short-sha-pinning.yml");

      const shortRefComp = result.components.find(
        (component) => component.version === "deadbee",
      );
      assert.ok(shortRefComp, "expected short-ref action component");
      assert.strictEqual(
        getProp(shortRefComp, "cdx:github:action:isShaPinned"),
        "false",
      );
      assert.strictEqual(
        getProp(shortRefComp, "cdx:github:action:versionPinningType"),
        "tag",
      );

      const fullShaComp = result.components.find(
        (component) =>
          component.version === "0123456789abcdef0123456789abcdef01234567",
      );
      assert.ok(fullShaComp, "expected full-SHA action component");
      assert.strictEqual(
        getProp(fullShaComp, "cdx:github:action:isShaPinned"),
        "true",
      );
      assert.strictEqual(
        getProp(fullShaComp, "cdx:github:action:versionPinningType"),
        "sha",
      );

      const sha256Comp = result.components.find(
        (component) =>
          component.version ===
          "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
      );
      assert.ok(sha256Comp, "expected 64-hex action component");
      assert.strictEqual(
        getProp(sha256Comp, "cdx:github:action:isShaPinned"),
        "true",
      );
      assert.strictEqual(
        getProp(sha256Comp, "cdx:github:action:versionPinningType"),
        "sha",
      );

      const upperHexComp = result.components.find(
        (component) =>
          component.version ===
          "FEEDFACEFEEDFACEFEEDFACEFEEDFACEFEEDFACEFEEDFACEFEEDFACEFEEDFACE",
      );
      assert.ok(upperHexComp, "expected uppercase-hex action component");
      assert.strictEqual(
        getProp(upperHexComp, "cdx:github:action:isShaPinned"),
        "false",
      );
      assert.strictEqual(
        getProp(upperHexComp, "cdx:github:action:versionPinningType"),
        "tag",
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

  describe("safe vs risky workflow corpus", () => {
    it("distinguishes safe cache keys from risky PR cache usage", () => {
      const safeResult = parseWorkflow("cache-pull-request.yml");
      const riskyResult = parseWorkflow("risk-cache-poisoning.yml");

      const safeCache = findComponentByPurlSubstring(
        safeResult.components,
        "actions/cache",
      );
      const riskyCache = findComponentByPurlSubstring(
        riskyResult.components,
        "actions/cache",
      );
      assert.ok(safeCache, "expected safe cache component");
      assert.ok(riskyCache, "expected risky cache component");
      assert.strictEqual(
        getProp(safeCache, "cdx:github:cache:keyUsesHashFiles"),
        "true",
      );
      assert.strictEqual(
        getProp(safeCache, "cdx:github:cache:hasRestoreKeys"),
        undefined,
      );
      assert.strictEqual(
        getProp(riskyCache, "cdx:github:cache:keyUsesHashFiles"),
        undefined,
      );
      assert.strictEqual(
        getProp(riskyCache, "cdx:github:workflow:hasWritePermissions"),
        "true",
      );
    });

    it("distinguishes safe and risky workflow_call producers", () => {
      const safeResult = parseWorkflow("workflow-call-producer-safe.yml");
      const riskyResult = parseWorkflow("workflow-call-producer-risky.yml");

      const safeWorkflow = safeResult.workflows[0];
      const riskyWorkflow = riskyResult.workflows[0];
      assert.strictEqual(
        getProp(safeWorkflow, "cdx:github:workflow:hasWorkflowCallTrigger"),
        "true",
      );
      assert.strictEqual(
        getProp(riskyWorkflow, "cdx:github:workflow:hasWorkflowCallTrigger"),
        "true",
      );
      assert.strictEqual(
        getProp(safeWorkflow, "cdx:github:workflow:workflowCallSecrets"),
        undefined,
      );
      assert.strictEqual(
        getProp(riskyWorkflow, "cdx:github:workflow:workflowCallSecrets"),
        "release_token",
      );
      assert.strictEqual(
        getProp(riskyWorkflow, "cdx:github:workflow:workflowCallOutputs"),
        "image_tag",
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

describe("Dogfood: the repository's own workflows and actions.lock", () => {
  // The repository scans itself with the github project type at release time
  // (the source SBOM job in npm-release.yml), so the parser must hold the same
  // invariants on this checkout that the published BOM depends on: the
  // lockfile is present and onboarded, and no workflow edit that skipped the
  // regeneration can pass silently.
  const ownWorkflowsDir = path.join(repoRoot, ".github", "workflows");
  const ownLockPath = path.join(ownWorkflowsDir, "actions.lock");

  it("scans the repository itself as an onboarded tree", () => {
    assert.ok(
      existsSync(ownLockPath),
      ".github/workflows/actions.lock should exist; run gh actions-lock after changing a uses: reference",
    );
    const files = readdirSync(ownWorkflowsDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => path.join(ownWorkflowsDir, f));
    assert.ok(
      files.length >= 20,
      `expected the repository's own workflows, found ${files.length}`,
    );
    const result = githubActionsParser.parse(files, {}, { rootDir: repoRoot });

    const workflows = result.workflows ?? [];
    assert.ok(
      workflows.length >= 20,
      `expected every own workflow to parse, found ${workflows.length}`,
    );
    for (const workflow of workflows) {
      const label =
        getProp(workflow, "cdx:github:workflow:file") ?? "a workflow";
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:lockfilePresent"),
        "true",
        `${label} should see the lockfile`,
      );
      assert.strictEqual(
        getProp(workflow, "cdx:github:workflow:lockfileOnboarded"),
        "true",
        `${label} should be onboarded`,
      );
      assert.notStrictEqual(
        getProp(workflow, "cdx:github:workflow:lockfileReadable"),
        "false",
        `${label} should not report an unreadable lockfile`,
      );
    }

    const unlocked = (result.components ?? []).filter(
      (c) => getProp(c, "cdx:github:action:isLocked") === "false",
    );
    assert.deepStrictEqual(
      unlocked.map((c) => c.purl),
      [],
      "every step-action reference of an onboarded workflow should join the lockfile",
    );

    const pinnedRemote = (result.components ?? []).filter(
      (c) =>
        getProp(c, "cdx:github:action:isShaPinned") === "true" &&
        (c.purl ?? "").startsWith("pkg:github/") &&
        !(c.purl ?? "").includes("cdxgen/cdxgen"),
    );
    assert.ok(
      pinnedRemote.length >= 100,
      `expected the repository's pinned third-party actions, found ${pinnedRemote.length}`,
    );
    const unlockedPinned = pinnedRemote.filter(
      (c) => getProp(c, "cdx:github:action:isLocked") !== "true",
    );
    assert.deepStrictEqual(
      unlockedPinned.map((c) => c.purl),
      [],
      "every pinned third-party action should carry isLocked",
    );

    const stragglers = (result.components ?? []).filter(
      (c) =>
        (c.name ?? "").includes("free-disk-space") ||
        (c.purl ?? "").includes("free-disk-space"),
    );
    assert.deepStrictEqual(
      stragglers.map((c) => c.purl),
      [],
      "the third-party free-disk-space action should be gone from the Actions supply chain",
    );
  });
});

describe("actions.lock join", () => {
  it("joins every step of an onboarded v0.0.3 workflow to its lock entries", () => {
    const { result } = parseActionsLockFixture("valid-v0.0.3", ["deploy.yml"]);

    const scanner = result.components.find(
      (c) => c.purl === "pkg:github/example-org/tenant-scanner@v2.0.0",
    );
    assert.ok(scanner, "expected tenant-scanner action component");
    assert.strictEqual(getProp(scanner, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(
      getProp(scanner, "cdx:github:lock:commit"),
      "111122223333444455556666777788889999aaaa",
    );
    assert.strictEqual(getProp(scanner, "cdx:github:lock:hashAlgo"), "sha1");
    assert.strictEqual(getProp(scanner, "cdx:github:lock:ref"), "v2.0.0");
    assert.strictEqual(getProp(scanner, "cdx:github:lock:ownerId"), "9100021");
    assert.strictEqual(getProp(scanner, "cdx:github:lock:repoId"), "9100022");
    assert.strictEqual(
      getProp(scanner, "cdx:github:lock:hostname"),
      "octocorp.ghe.com",
    );
    // The workflow's own ref keeps describing the file; the lock never
    // overwrites the file-derived pinning properties.
    assert.strictEqual(
      getProp(scanner, "cdx:github:action:versionPinningType"),
      "tag",
    );
    assert.strictEqual(
      getProp(scanner, "cdx:github:action:isShaPinned"),
      "false",
    );
    // The workflow-level lockfile context reaches components.
    assert.strictEqual(
      getProp(scanner, "cdx:github:workflow:lockfileOnboarded"),
      "true",
    );
    assert.strictEqual(
      getProp(scanner, "cdx:github:workflow:lockfilePresent"),
      "true",
    );
    assert.strictEqual(
      getProp(scanner, "cdx:github:workflow:lockfileReadable"),
      undefined,
    );

    const helper = result.components.find(
      (c) => c.purl === "pkg:github/example-org/local-helper@v1.0.0",
    );
    assert.ok(helper, "expected local-helper action component");
    assert.strictEqual(getProp(helper, "cdx:github:action:isLocked"), "true");
    // The entry records no hostname, so none is emitted.
    assert.strictEqual(getProp(helper, "cdx:github:lock:hostname"), undefined);

    const checkout = result.components.find(
      (c) => c.purl === "pkg:github/actions/checkout@v6.0.2",
    );
    assert.ok(checkout, "expected checkout action component");
    assert.strictEqual(getProp(checkout, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(
      getProp(checkout, "cdx:github:lock:hostname"),
      "github.com",
    );

    const workflow = result.workflows[0];
    assert.strictEqual(
      getProp(workflow, "cdx:github:workflow:lockfileOnboarded"),
      "true",
    );
    assert.strictEqual(
      getProp(workflow, "cdx:github:workflow:lockfilePresent"),
      "true",
    );
    assert.strictEqual(
      getProp(workflow, "cdx:github:workflow:lockfileReadable"),
      undefined,
    );
  });

  it("joins a v0.0.2 workflow whose keys mix owner and repository case", () => {
    const { result } = parseActionsLockFixture("valid-v0.0.2", ["release.yml"]);

    const setupNode = result.components.find(
      (c) => c.purl === "pkg:github/example-org/setup-node@v4.1.0",
    );
    assert.ok(setupNode, "expected setup-node action component");
    assert.strictEqual(
      getProp(setupNode, "cdx:github:action:isLocked"),
      "true",
    );
    assert.strictEqual(
      getProp(setupNode, "cdx:github:lock:commit"),
      "0123456789abcdef0123456789abcdef01234567",
    );
    assert.strictEqual(
      getProp(setupNode, "cdx:github:lock:hostname"),
      undefined,
    );

    const upload = result.components.find(
      (c) => c.purl === "pkg:github/example-org/upload-artifact@v3.2.4",
    );
    assert.ok(upload, "expected upload-artifact action component");
    assert.strictEqual(getProp(upload, "cdx:github:action:isLocked"), "true");
  });

  it("joins a v0.0.1 workflow through the normalised digest-suffixed keys", () => {
    const { result } = parseActionsLockFixture("valid-v0.0.1", ["build.yml"]);

    const first = result.components.find(
      (c) => c.purl === "pkg:github/example-org/first-action@v1.2.3",
    );
    assert.ok(first, "expected first-action action component");
    assert.strictEqual(getProp(first, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(
      getProp(first, "cdx:github:lock:commit"),
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
    assert.strictEqual(getProp(first, "cdx:github:lock:ref"), "v1.2.3");

    const second = result.components.find(
      (c) => c.purl === "pkg:github/example-org/second-action@main",
    );
    assert.ok(second, "expected second-action action component");
    assert.strictEqual(getProp(second, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(getProp(second, "cdx:github:lock:ref"), "main");
    assert.strictEqual(
      getProp(second, "cdx:github:action:versionPinningType"),
      "branch",
    );
  });

  it("records the sha256 algorithm and digest of a sha256-pinned entry", () => {
    const { result } = parseActionsLockFixture("valid-sha256", ["verify.yml"]);

    const runner = result.components.find(
      (c) => c.purl === "pkg:github/example-org/verify-runner@v5.0.1",
    );
    assert.ok(runner, "expected verify-runner action component");
    assert.strictEqual(getProp(runner, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(getProp(runner, "cdx:github:lock:hashAlgo"), "sha256");
    assert.strictEqual(
      getProp(runner, "cdx:github:lock:commit"),
      "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
    );
  });

  it("marks every step unlocked when the lockfile version is unsupported", () => {
    const { result } = parseActionsLockFixture("invalid-future-version", [
      "deploy.yml",
    ]);

    assert.ok(result.workflows.length, "the workflow still parses");
    const actionComponents = result.components.filter((c) =>
      c.properties?.some((p) => p.name === "cdx:github:action:uses"),
    );
    assert.ok(actionComponents.length, "expected action components");
    for (const component of actionComponents) {
      assert.strictEqual(
        getProp(component, "cdx:github:action:isLocked"),
        "false",
      );
      assert.strictEqual(lockPropertiesOf(component).length, 0);
    }
    const workflow = result.workflows[0];
    assert.strictEqual(
      getProp(workflow, "cdx:github:workflow:lockfilePresent"),
      "true",
    );
    assert.strictEqual(
      getProp(workflow, "cdx:github:workflow:lockfileReadable"),
      "false",
    );
    assert.strictEqual(
      getProp(workflow, "cdx:github:workflow:lockfileOnboarded"),
      "false",
    );
  });

  it("builds repository-scoped sub-action purls and joins both to one entry", () => {
    const { result } = parseActionsLockFixture("subaction-purl", ["ci.yml"]);

    const save = result.components.find(
      (c) => c.purl === "pkg:github/actions/cache@v4#save",
    );
    assert.ok(save, "expected pkg:github/actions/cache@v4#save");
    assert.strictEqual(save.name, "cache");
    assert.strictEqual(save.group, "actions");
    assert.strictEqual(
      getProp(save, "cdx:github:action:uses"),
      "actions/cache/save@v4",
    );
    assert.strictEqual(getProp(save, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(getProp(save, "cdx:github:lock:hashAlgo"), "sha256");

    const restore = result.components.find(
      (c) => c.purl === "pkg:github/actions/cache@v4#restore",
    );
    assert.ok(restore, "expected pkg:github/actions/cache@v4#restore");
    assert.strictEqual(getProp(restore, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(
      getProp(restore, "cdx:github:lock:commit"),
      getProp(save, "cdx:github:lock:commit"),
      "both sub-actions join to the single actions/cache@v4 entry",
    );

    const leaf = result.components.find(
      (c) => c.purl === "pkg:github/example-org/leaf@v1.0.0",
    );
    assert.ok(leaf, "expected leaf action component");
    assert.strictEqual(getProp(leaf, "cdx:github:action:isLocked"), "true");
  });

  it("joins two versions of one action through each workflow's own pin list", () => {
    const { result } = parseActionsLockFixture("two-versions-one-action", [
      "build.yml",
      "release.yml",
    ]);

    const v1 = result.components.find(
      (c) => c.purl === "pkg:github/example-org/tool@v1.0.0",
    );
    assert.ok(v1, "expected the v1.0.0 tool component");
    assert.strictEqual(getProp(v1, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(
      getProp(v1, "cdx:github:lock:commit"),
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );

    const v2 = result.components.find(
      (c) => c.purl === "pkg:github/example-org/tool@v2.0.0",
    );
    assert.ok(v2, "expected the v2.0.0 tool component");
    assert.strictEqual(getProp(v2, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(
      getProp(v2, "cdx:github:lock:commit"),
      "cafebabecafebabecafebabecafebabecafebabe",
    );
  });

  it("keeps a namespace-less step action without a purl instead of aborting the file", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-lock-"));
    const workflowFile = path.join(tmpDir, "namespace-less.yml");
    writeFileSync(
      workflowFile,
      [
        "name: Namespace-less",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: someaction@v1",
        "      - uses: actions/checkout@v4",
      ].join("\n"),
    );

    try {
      const result = githubActionsParser.parse([workflowFile], {
        specVersion: 1.6,
      });
      assert.strictEqual(result.workflows.length, 1);
      const unnamed = result.components.find(
        (c) => c["bom-ref"] === "application:someaction:v1",
      );
      assert.ok(unnamed, "expected the fallback bom-ref component");
      assert.strictEqual(unnamed.purl, undefined);
      assert.strictEqual(unnamed.version, "v1");
      const checkout = result.components.find(
        (c) => c.purl === "pkg:github/actions/checkout@v4",
      );
      assert.ok(checkout, "the later step still produces a component");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("keeps a namespace-less reusable workflow call without a purl instead of aborting the file", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-lock-"));
    const workflowFile = path.join(tmpDir, "reusable-unnamed.yml");
    writeFileSync(
      workflowFile,
      [
        "name: Reusable unnamed",
        "on: push",
        "jobs:",
        "  call:",
        "    uses: single-segment@v1",
      ].join("\n"),
    );

    try {
      const result = githubActionsParser.parse([workflowFile], {
        specVersion: 1.6,
      });
      assert.strictEqual(result.workflows.length, 1);
      const reusable = result.components.find((c) =>
        hasProp(c, "cdx:github:reusableWorkflow:uses", "single-segment@v1"),
      );
      assert.ok(reusable, "expected the reusable workflow component");
      assert.strictEqual(reusable.purl, undefined);
      assert.strictEqual(
        reusable["bom-ref"],
        "github-workflow:single-segment@v1",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("records self-repository and local-path steps without lock identity", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-lock-"));
    const workflowFile = path.join(tmpDir, "local-uses.yml");
    writeFileSync(
      workflowFile,
      [
        "name: Local uses",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: $/shared/action@v1",
        "      - uses: ./.github/actions/local-thing",
        "      - uses: actions/checkout@v4",
      ].join("\n"),
    );

    try {
      const result = githubActionsParser.parse([workflowFile], {
        specVersion: 1.6,
      });
      const selfRepo = result.components.find((c) =>
        hasProp(c, "cdx:github:step:uses", "$/shared/action@v1"),
      );
      assert.ok(selfRepo, "expected the self-repository step component");
      assert.strictEqual(
        getProp(selfRepo, "cdx:github:step:type"),
        "self-repository",
      );
      assert.strictEqual(selfRepo.scope, "excluded");
      assert.deepStrictEqual(selfRepo.tags, ["workflow-step"]);
      assert.strictEqual(selfRepo.purl, undefined);
      assert.strictEqual(
        getProp(selfRepo, "cdx:github:action:isLocked"),
        undefined,
      );
      assert.strictEqual(lockPropertiesOf(selfRepo).length, 0);

      const localPath = result.components.find((c) =>
        hasProp(c, "cdx:github:step:uses", "./.github/actions/local-thing"),
      );
      assert.ok(localPath, "expected the local-path step component");
      assert.strictEqual(
        getProp(localPath, "cdx:github:step:type"),
        "local-path",
      );
      assert.strictEqual(localPath.scope, "excluded");
      assert.strictEqual(
        getProp(localPath, "cdx:github:action:isLocked"),
        undefined,
      );
      assert.strictEqual(lockPropertiesOf(localPath).length, 0);

      const checkout = result.components.find(
        (c) => c.purl === "pkg:github/actions/checkout@v4",
      );
      assert.ok(checkout, "plain action steps keep their component");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("records the lockfile summary on metadata.properties without duplicating it", () => {
    const { result, treeRoot } = parseActionsLockFixture("valid-v0.0.3", [
      "deploy.yml",
    ]);
    const bomJson = {
      specVersion: "1.5",
      components: result.components,
      metadata: {},
    };

    appendActionsLockMetadataProperties(bomJson, treeRoot);
    const properties = bomJson.metadata.properties;
    assert.ok(Array.isArray(properties), "metadata.properties is created");
    assert.deepStrictEqual(
      properties.map((property) => property.name),
      [
        "cdx:github:lockfile:path",
        "cdx:github:lockfile:version",
        "cdx:github:lockfile:onboardedWorkflows",
        "cdx:github:lockfile:dependencies",
        "cdx:github:lockfile:unlockedRefs",
        "cdx:github:lockfile:refMismatches",
        "cdx:github:lockfile:staleEntries",
        "cdx:github:lockfile:unonboardedWorkflows",
      ],
    );
    assert.strictEqual(
      properties.find((p) => p.name === "cdx:github:lockfile:path").value,
      ".github/workflows/actions.lock",
    );
    assert.strictEqual(
      properties.find((p) => p.name === "cdx:github:lockfile:version").value,
      "v0.0.3",
    );
    assert.strictEqual(
      properties.find(
        (p) => p.name === "cdx:github:lockfile:onboardedWorkflows",
      ).value,
      "1",
    );
    assert.strictEqual(
      properties.find((p) => p.name === "cdx:github:lockfile:dependencies")
        .value,
      "3",
    );
    // The joined workflow has no drift and the bomJson carries no workflows,
    // so the workflow-level counts stay zero.
    assert.strictEqual(
      properties.find((p) => p.name === "cdx:github:lockfile:unlockedRefs")
        .value,
      "0",
    );
    assert.strictEqual(
      properties.find((p) => p.name === "cdx:github:lockfile:refMismatches")
        .value,
      "0",
    );
    assert.strictEqual(
      properties.find((p) => p.name === "cdx:github:lockfile:staleEntries")
        .value,
      "0",
    );
    assert.strictEqual(
      properties.find(
        (p) => p.name === "cdx:github:lockfile:unonboardedWorkflows",
      ).value,
      "0",
    );

    appendActionsLockMetadataProperties(bomJson, treeRoot);
    assert.strictEqual(
      bomJson.metadata.properties.length,
      properties.length,
      "a second call rewrites the same names instead of adding duplicates",
    );
  });
});

describe("transitive actions", () => {
  /**
   * Helper: Parse workflow files of an actions-lock fixture tree the way the
   * formulation parser does, with the tree as the project root.
   */
  function parseActionsLockFixture(caseName, filenames) {
    const treeRoot = path.join(actionsLockDir, caseName);
    const files = filenames.map((name) =>
      path.join(treeRoot, ".github", "workflows", name),
    );
    return {
      result: githubActionsParser.parse(
        files,
        { specVersion: 1.6 },
        { rootDir: treeRoot },
      ),
      treeRoot,
    };
  }

  function lockPropertiesOf(component) {
    return (component.properties || []).filter((property) =>
      property.name.startsWith("cdx:github:lock:"),
    );
  }

  function transitiveComponentsOf(result) {
    return result.components.filter(
      (c) => getProp(c, "cdx:github:action:isTransitive") === "true",
    );
  }

  function actionComponentsOf(result) {
    return result.components.filter(
      (c) =>
        getProp(c, "cdx:github:action:isTransitive") === "true" ||
        c.properties?.some((p) => p.name === "cdx:github:action:uses"),
    );
  }

  it("expands the uses lists of an onboarded composite into transitive components", () => {
    const { result } = parseActionsLockFixture("valid-transitive-uses", [
      "ci.yml",
    ]);

    const actionComponents = actionComponentsOf(result);
    assert.strictEqual(actionComponents.length, 3);
    const direct = actionComponents.find(
      (c) => c.purl === "pkg:github/example-org/composite-a@v1.0.0",
    );
    assert.ok(direct, "expected the composite-a direct action component");
    assert.strictEqual(
      getProp(direct, "cdx:github:action:isTransitive"),
      undefined,
      "direct actions carry no isTransitive property",
    );
    assert.strictEqual(getProp(direct, "cdx:github:action:isLocked"), "true");

    const transitive = transitiveComponentsOf(result);
    assert.deepStrictEqual(transitive.map((c) => c.purl).sort(), [
      "pkg:github/example-org/formatter-c@v2.1.0",
      "pkg:github/example-org/helper-b@v3.0.0",
    ]);

    const helpers = transitive.filter(
      (c) => c.purl === "pkg:github/example-org/helper-b@v3.0.0",
    );
    assert.strictEqual(
      helpers.length,
      1,
      "helper-b appears once despite being reachable through composite-a and formatter-c",
    );
    const helper = helpers[0];
    assert.strictEqual(helper.scope, "required");
    assert.deepStrictEqual(helper.tags, ["transitive-action"]);
    assert.strictEqual(getProp(helper, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(
      getProp(helper, "cdx:github:lock:commit"),
      "0123456789abcdef0123456789abcdef01234567",
    );
    assert.strictEqual(getProp(helper, "cdx:github:lock:hashAlgo"), "sha1");
    assert.strictEqual(getProp(helper, "cdx:github:lock:ref"), "v3.0.0");
    assert.strictEqual(getProp(helper, "cdx:github:lock:ownerId"), "9100041");
    assert.strictEqual(getProp(helper, "cdx:github:lock:repoId"), "9100044");
    assert.ok(lockPropertiesOf(helper).length >= 5);
    // The workflow context of the referencing workflow reaches the transitive
    // component, so audit rules can scope it without traversing edges.
    assert.strictEqual(
      getProp(helper, "cdx:github:workflow:file"),
      ".github/workflows/ci.yml",
    );
    assert.strictEqual(
      getProp(helper, "cdx:github:workflow:lockfileOnboarded"),
      "true",
    );
  });

  it("hangs the transitive edges below the direct actions", () => {
    const { result } = parseActionsLockFixture("valid-transitive-uses", [
      "ci.yml",
    ]);

    const dependencies = result.dependencies;
    const compositeEntry = dependencies.find(
      (d) => d.ref === "pkg:github/example-org/composite-a@v1.0.0",
    );
    assert.ok(compositeEntry, "expected a dependency entry for composite-a");
    assert.deepStrictEqual(compositeEntry.dependsOn, [
      "pkg:github/example-org/helper-b@v3.0.0",
      "pkg:github/example-org/formatter-c@v2.1.0",
    ]);
    const formatterEntry = dependencies.find(
      (d) => d.ref === "pkg:github/example-org/formatter-c@v2.1.0",
    );
    assert.ok(formatterEntry, "expected a dependency entry for formatter-c");
    assert.deepStrictEqual(formatterEntry.dependsOn, [
      "pkg:github/example-org/helper-b@v3.0.0",
    ]);

    // The job's edge keeps listing only the direct action, so the hierarchy
    // reads workflow, job, direct action, transitive action.
    const jobEntry = dependencies.find((d) =>
      d.dependsOn?.includes("pkg:github/example-org/composite-a@v1.0.0"),
    );
    assert.ok(jobEntry, "expected the job edge listing composite-a");
    assert.strictEqual(
      jobEntry.dependsOn.includes("pkg:github/example-org/helper-b@v3.0.0"),
      false,
      "the transitive action stays below the direct action",
    );
    assert.strictEqual(
      jobEntry.dependsOn.includes("pkg:github/example-org/formatter-c@v2.1.0"),
      false,
    );
  });

  it("returns the same tree through parseGitHubWorkflowDataWithEdges", () => {
    const treeRoot = path.join(actionsLockDir, "valid-transitive-uses");
    const { components, dependencies } = parseGitHubWorkflowDataWithEdges(
      path.join(treeRoot, ".github", "workflows", "ci.yml"),
      treeRoot,
    );

    // The run-step component is excluded, so the `-t github` scope filter
    // keeps exactly the three action components.
    assert.deepStrictEqual(components.map((c) => c.purl).sort(), [
      "pkg:github/example-org/composite-a@v1.0.0",
      "pkg:github/example-org/formatter-c@v2.1.0",
      "pkg:github/example-org/helper-b@v3.0.0",
    ]);
    const compositeEntry = dependencies.find(
      (d) => d.ref === "pkg:github/example-org/composite-a@v1.0.0",
    );
    assert.ok(compositeEntry, "expected a dependency entry for composite-a");
    assert.deepStrictEqual(compositeEntry.dependsOn, [
      "pkg:github/example-org/helper-b@v3.0.0",
      "pkg:github/example-org/formatter-c@v2.1.0",
    ]);
    const formatterEntry = dependencies.find(
      (d) => d.ref === "pkg:github/example-org/formatter-c@v2.1.0",
    );
    assert.ok(formatterEntry, "expected a dependency entry for formatter-c");
  });

  it("versions a commit-keyed transitive pin by the commit with the tag in the lock ref", () => {
    const { result } = parseActionsLockFixture("transitive-commit-keys", [
      "ci.yml",
    ]);

    const composite = result.components.find(
      (c) => c.purl === "pkg:github/example-org/composite-x@v1",
    );
    assert.ok(composite, "expected the composite-x direct action component");
    assert.strictEqual(
      getProp(composite, "cdx:github:action:isTransitive"),
      undefined,
    );

    const helper = transitiveComponentsOf(result).find(
      (c) => c.name === "pinned-helper",
    );
    assert.ok(helper, "expected the pinned-helper transitive component");
    assert.strictEqual(
      helper.purl,
      "pkg:github/example-org/pinned-helper@aabbccddeeff0011223344556677889900aabbcc",
      "the version is the commit SHA of the pin key",
    );
    assert.strictEqual(
      helper.version,
      "aabbccddeeff0011223344556677889900aabbcc",
    );
    assert.strictEqual(getProp(helper, "cdx:github:lock:ref"), "v2.3.4");
    assert.strictEqual(
      getProp(helper, "cdx:github:lock:commit"),
      "aabbccddeeff0011223344556677889900aabbcc",
    );

    const compositeEntry = result.dependencies.find(
      (d) => d.ref === composite.purl,
    );
    assert.ok(compositeEntry, "expected a dependency entry for composite-x");
    assert.deepStrictEqual(compositeEntry.dependsOn, [helper.purl]);
  });

  it("yields one transitive component and one edge per ref across two workflows sharing a composite", () => {
    const { result } = parseActionsLockFixture("transitive-shared-composite", [
      "build.yml",
      "release.yml",
    ]);

    const helpers = transitiveComponentsOf(result).filter(
      (c) => c.purl === "pkg:github/example-org/helper-b@v3.0.0",
    );
    assert.strictEqual(
      helpers.length,
      1,
      "the shared composite's transitive action is deduplicated across the workflows",
    );
    // Direct actions stay per workflow: each workflow steps composite-a, so
    // each contributes its own component, as without a lockfile.
    const composites = result.components.filter(
      (c) => c.purl === "pkg:github/example-org/composite-a@v1.0.0",
    );
    assert.strictEqual(composites.length, 2);

    // Merging the way applyFormulation does collapses the two workflow's
    // identical direct-action edges into one entry per ref, while the two
    // jobs' own edges stay intact.
    const merged = mergeDependencies(result.dependencies, []);
    const compositeEntries = merged.filter(
      (d) => d.ref === "pkg:github/example-org/composite-a@v1.0.0",
    );
    assert.strictEqual(
      compositeEntries.length,
      1,
      "one dependency entry per action ref after the merge",
    );
    assert.deepStrictEqual(compositeEntries[0].dependsOn, [
      "pkg:github/example-org/helper-b@v3.0.0",
    ]);
    const jobEntries = merged.filter((d) =>
      d.dependsOn?.includes("pkg:github/example-org/composite-a@v1.0.0"),
    );
    assert.strictEqual(
      jobEntries.length,
      2,
      "the two jobs' edges to the direct action survive the merge",
    );
  });

  it("keeps uuid refs out of the -t github dependency tree of the shared composite", () => {
    const treeRoot = path.join(actionsLockDir, "transitive-shared-composite");
    const pkgList = [];
    const edges = [];
    for (const name of ["build.yml", "release.yml"]) {
      const { components, dependencies } = parseGitHubWorkflowDataWithEdges(
        path.join(treeRoot, ".github", "workflows", name),
        treeRoot,
      );
      pkgList.push(...components);
      edges.push(...dependencies);
    }
    // The merge and the component-reachability filter of createGitHubBom:
    // entries whose ref no component carries cannot be expressed in the
    // components tree, and two workflows reaching one composite would
    // otherwise emit two entries with the same ref.
    const componentRefs = new Set(pkgList.map((c) => c["bom-ref"]));
    const dependencies = mergeDependencies(edges, []).filter((dep) =>
      componentRefs.has(dep.ref),
    );

    assert.strictEqual(dependencies.length, 1);
    assert.deepStrictEqual(dependencies[0], {
      ref: "pkg:github/example-org/composite-a@v1.0.0",
      dependsOn: ["pkg:github/example-org/helper-b@v3.0.0"],
    });
    for (const dep of dependencies) {
      assert.ok(
        componentRefs.has(dep.ref),
        "every ref equals one of the returned components' bom-refs",
      );
    }
  });
});

describe("actions.lock drift", () => {
  /**
   * Helper: Collect the drift counts the lockfile summary recorded.
   */
  function metadataCountOf(bomJson, name) {
    return bomJson.metadata.properties?.find(
      (property) => property.name === name,
    )?.value;
  }

  it("reports no drift for the clean tree, including the narrowed version pair", () => {
    const { warnings, result } = captureWarnings(() =>
      parseActionsLockFixture("drift-clean", ["deploy.yml"]),
    );

    const actionComponents = result.result.components.filter((c) =>
      hasProp(c, "cdx:github:action:uses"),
    );
    assert.strictEqual(actionComponents.length, 3);
    for (const component of actionComponents) {
      assert.strictEqual(
        getProp(component, "cdx:github:action:isLocked"),
        "true",
      );
      assert.strictEqual(
        getProp(component, "cdx:github:action:lockRefMismatch"),
        undefined,
      );
    }
    // The workflow writes @v2, the lock records @v2.0.0: the prefix covers
    // the resolved pin, so the join reaches the entry and no finding fires.
    const scanner = result.result.components.find(
      (c) => c.purl === "pkg:github/example-org/tenant-scanner@v2",
    );
    assert.ok(scanner, "expected the tenant-scanner component at the v2 ref");
    assert.strictEqual(
      getProp(scanner, "cdx:github:lock:commit"),
      "111122223333444455556666777788889999aaaa",
    );
    assert.strictEqual(getProp(scanner, "cdx:github:lock:ref"), "v2.0.0");
    const workflow = result.result.workflows[0];
    assert.strictEqual(
      getProp(workflow, "cdx:github:workflow:lockStalePins"),
      undefined,
    );
    assert.deepStrictEqual(warnings, [], "the clean tree produces no warnings");
  });

  it("marks the uncovered reference of an onboarded workflow as unlocked", () => {
    const { warnings, result } = captureWarnings(() =>
      parseActionsLockFixture("drift-missing-pin", ["deploy.yml"]),
    );

    const helper = result.result.components.find(
      (c) => c.purl === "pkg:github/example-org/new-helper@v1.0.0",
    );
    assert.ok(helper, "expected the new-helper component");
    assert.strictEqual(getProp(helper, "cdx:github:action:isLocked"), "false");
    assert.strictEqual(
      getProp(helper, "cdx:github:action:lockRefMismatch"),
      undefined,
      "no entry of the same repository exists, so this is a missing pin, not a ref mismatch",
    );
    assert.strictEqual(lockPropertiesOf(helper).length, 0);
    const scanner = result.result.components.find(
      (c) => c.purl === "pkg:github/example-org/tenant-scanner@v2.0.0",
    );
    assert.strictEqual(
      getProp(scanner, "cdx:github:action:isLocked"),
      "true",
      "the covered references stay locked",
    );
    assert.strictEqual(warnings.length, 1, "one warning for the workflow");
    assert.ok(
      warnings[0].includes(".github/workflows/deploy.yml"),
      "the warning names the workflow",
    );
    assert.match(warnings[0], /1 ref with no lock entry/);
  });

  it("marks the edited reference as a ref mismatch and keeps the locked one", () => {
    const { warnings, result } = captureWarnings(() =>
      parseActionsLockFixture("drift-ref-changed", ["deploy.yml"]),
    );

    const edited = result.result.components.find(
      (c) => c.purl === "pkg:github/example-org/scanner@v2.0.0",
    );
    assert.ok(edited, "expected the edited scanner component");
    assert.strictEqual(getProp(edited, "cdx:github:action:isLocked"), "false");
    assert.strictEqual(
      getProp(edited, "cdx:github:action:lockRefMismatch"),
      "true",
    );
    const pinned = result.result.components.find(
      (c) => c.purl === "pkg:github/example-org/scanner@v1.0.0",
    );
    assert.ok(pinned, "expected the still-locked scanner component");
    assert.strictEqual(getProp(pinned, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(
      getProp(pinned, "cdx:github:action:lockRefMismatch"),
      undefined,
    );
    // The locked pin is still reached by its own step, so the pin list holds
    // no stale entry and the tree isolates the ref mismatch.
    assert.strictEqual(
      getProp(result.result.workflows[0], "cdx:github:workflow:lockStalePins"),
      undefined,
    );
    assert.strictEqual(warnings.length, 1, "one warning for the workflow");
    assert.ok(warnings[0].includes(".github/workflows/deploy.yml"));
    assert.match(warnings[0], /1 ref that differs from the locked ref/);
  });

  it("records the pin keys no step reaches any more on the workflow", () => {
    const { warnings, result } = captureWarnings(() =>
      parseActionsLockFixture("drift-stale-entry", ["deploy.yml"]),
    );

    const workflow = result.result.workflows[0];
    assert.strictEqual(
      getProp(workflow, "cdx:github:workflow:lockStalePins"),
      "example-org/legacy-helper@v1.5.0",
    );
    const scanner = result.result.components.find(
      (c) => c.purl === "pkg:github/example-org/tenant-scanner@v2.0.0",
    );
    assert.strictEqual(
      getProp(scanner, "cdx:github:action:isLocked"),
      "true",
      "the reached references stay locked",
    );
    assert.strictEqual(warnings.length, 1, "one warning for the workflow");
    assert.ok(warnings[0].includes(".github/workflows/deploy.yml"));
    assert.match(warnings[0], /1 lock entry no step uses any more/);
  });

  it("flags the workflow the lockfile leaves out and joins its steps through the fallback", () => {
    const { warnings, result } = captureWarnings(() =>
      parseActionsLockFixture("drift-unonboarded-workflow", [
        "deploy.yml",
        "legacy.yml",
      ]),
    );

    const workflows = result.result.workflows;
    const deploy = workflows.find((w) =>
      hasProp(w, "cdx:github:workflow:file", ".github/workflows/deploy.yml"),
    );
    const legacy = workflows.find((w) =>
      hasProp(w, "cdx:github:workflow:file", ".github/workflows/legacy.yml"),
    );
    assert.ok(deploy && legacy, "both workflows parsed");
    assert.strictEqual(
      getProp(deploy, "cdx:github:workflow:lockfileOnboarded"),
      "true",
    );
    assert.strictEqual(
      getProp(legacy, "cdx:github:workflow:lockfileOnboarded"),
      "false",
    );
    assert.strictEqual(
      getProp(legacy, "cdx:github:workflow:lockfilePresent"),
      "true",
    );
    // The step of the unonboarded workflow joins through the dependency map
    // while the workflow itself stays outside the lockfile.
    const joined = result.result.components.find(
      (c) =>
        c.purl === "pkg:github/example-org/helper-b@v3.0.0" &&
        !hasProp(c, "cdx:github:action:isTransitive"),
    );
    assert.ok(joined, "expected the direct helper-b component of legacy.yml");
    assert.strictEqual(getProp(joined, "cdx:github:action:isLocked"), "true");
    assert.strictEqual(
      getProp(joined, "cdx:github:lock:commit"),
      "0123456789abcdef0123456789abcdef01234567",
    );
    assert.strictEqual(
      getProp(legacy, "cdx:github:workflow:lockStalePins"),
      undefined,
    );
    assert.strictEqual(
      warnings.length,
      1,
      "the onboarded workflow raises no warning",
    );
    assert.ok(warnings[0].includes("legacy.yml"));
    assert.match(warnings[0], /workflow is not onboarded to the lockfile/);
  });

  it("records the drift counts of every drift fixture on metadata.properties", () => {
    const expectations = [
      ["drift-clean", ["deploy.yml"], "0", "0", "0", "0"],
      ["drift-missing-pin", ["deploy.yml"], "1", "0", "0", "0"],
      ["drift-ref-changed", ["deploy.yml"], "0", "1", "0", "0"],
      ["drift-stale-entry", ["deploy.yml"], "0", "0", "1", "0"],
      [
        "drift-unonboarded-workflow",
        ["deploy.yml", "legacy.yml"],
        "0",
        "0",
        "0",
        "1",
      ],
    ];
    for (const [
      tree,
      files,
      unlockedRefs,
      refMismatches,
      staleEntries,
      unonboardedWorkflows,
    ] of expectations) {
      const { result, treeRoot } = parseActionsLockFixture(tree, files);
      // The workflows reach the counter through the formulation section, the
      // place postProcess assembles them into.
      const bomJson = {
        specVersion: "1.5",
        components: [],
        formulation: [
          {
            "bom-ref": `formulation-${tree}`,
            components: result.components,
            workflows: result.workflows,
          },
        ],
        metadata: {},
      };
      appendActionsLockMetadataProperties(bomJson, treeRoot);
      const countOf = (name) => metadataCountOf(bomJson, name);
      assert.strictEqual(
        countOf("cdx:github:lockfile:unlockedRefs"),
        unlockedRefs,
        `${tree} unlockedRefs`,
      );
      assert.strictEqual(
        countOf("cdx:github:lockfile:refMismatches"),
        refMismatches,
        `${tree} refMismatches`,
      );
      assert.strictEqual(
        countOf("cdx:github:lockfile:staleEntries"),
        staleEntries,
        `${tree} staleEntries`,
      );
      assert.strictEqual(
        countOf("cdx:github:lockfile:unonboardedWorkflows"),
        unonboardedWorkflows,
        `${tree} unonboardedWorkflows`,
      );
    }
  });
});

describe("githubActionsParser credential hygiene", () => {
  it("strips URL credentials and tokens from names, conditions and commands", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-gha-secrets-"));
    try {
      const f = path.join(tmpDir, "ci.yml");
      writeFileSync(
        f,
        `on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: https://ci-bot:hunter2@deploy.example.com/prod
    steps:
      - uses: actions/checkout@v4
        if: github.ref == 'https://ci-bot:hunter2@git.example.com/x'
      - name: publish to https://pkgs.example.com/npm/?sig=Zm9vYmFy
        run: curl -fsS https://ci-bot:hunter2@pkgs.example.com/api
      - name: publish to https://pkgs.example.com/npm/?sig=YmFyYmF6
        run: curl -fsS https://ci-bot:hunter2@pkgs.example.com/api
      - run: echo ghp_abcdefghijklmnopqrstuvwxyz0123456789
`,
      );
      for (const result of [
        parseWorkflowFile(f, {}),
        githubActionsParser.parse([f], {}),
      ]) {
        const text = JSON.stringify(result);
        for (const secret of ["hunter2", "Zm9vYmFy", "YmFyYmF6", "ghp_"]) {
          assert.ok(!text.includes(secret), `${secret} must not be recorded`);
        }
        const task = result.workflows[0].tasks[0];
        assert.strictEqual(
          getProp(task, "cdx:github:job:environment"),
          "https://deploy.example.com/prod",
        );
        const stepNames = task.steps.map((step) => step.name);
        assert.ok(
          stepNames.includes("publish to https://pkgs.example.com/npm/"),
        );
        assert.ok(
          stepNames.includes("publish to https://pkgs.example.com/npm/ (2)"),
        );
        const runStep = result.components.find((component) =>
          getProp(component, "cdx:github:step:command")?.startsWith("curl"),
        );
        assert.strictEqual(
          getProp(runStep, "cdx:github:step:command"),
          "curl -fsS https://pkgs.example.com/api",
        );
        assert.strictEqual(
          getProp(runStep, "cdx:github:step:hasOutboundNetworkCommand"),
          "true",
        );
      }
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});

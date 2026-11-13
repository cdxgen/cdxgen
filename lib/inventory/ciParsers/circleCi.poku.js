import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("parses circleci-machine.yml: machine executor components extracted", () => {
    const f = path.join(repoRoot, "test", "data", "circleci-machine.yml");
    const result = circleCiParser.parse([f], {});

    // machine executors produce container components
    const machineComps = result.components.filter(
      (c) => c.type === "container" && c.name?.includes("ubuntu"),
    );
    assert.ok(
      machineComps.length > 0,
      "expected ubuntu machine executor components",
    );
  });

  it("parses circleci-machine.yml: no orbs — orb components absent", () => {
    const f = path.join(repoRoot, "test", "data", "circleci-machine.yml");
    const result = circleCiParser.parse([f], {});
    const orbComps = result.components.filter((c) => c.type === "application");
    assert.strictEqual(orbComps.length, 0, "no orb components expected");
  });

  it("parses circleci-machine.yml: approval gate job present", () => {
    const f = path.join(repoRoot, "test", "data", "circleci-machine.yml");
    const result = circleCiParser.parse([f], {});

    const wf = result.workflows.find((w) => w.name === "ci-cd");
    assert.ok(wf, "expected ci-cd workflow");
    const taskNames = wf.tasks.map((t) => t.name);
    assert.ok(
      taskNames.includes("hold-for-approval"),
      "expected hold-for-approval task",
    );
    assert.ok(
      taskNames.includes("deploy-staging"),
      "expected deploy-staging task",
    );
    assert.ok(
      taskNames.includes("deploy-production"),
      "expected deploy-production task",
    );
  });

  it("parses circleci-machine.yml: requires chain recorded in task properties", () => {
    const f = path.join(repoRoot, "test", "data", "circleci-machine.yml");
    const result = circleCiParser.parse([f], {});

    const wf = result.workflows[0];
    const approvalTask = wf.tasks.find((t) => t.name === "hold-for-approval");
    assert.ok(approvalTask, "hold-for-approval task must exist");
    const requiresProp = approvalTask.properties.find(
      (p) => p.name === "cdx:circleci:job:requires",
    );
    assert.ok(requiresProp, "expected cdx:circleci:job:requires property");
    assert.ok(
      requiresProp.value.includes("integration-test"),
      "requires must include integration-test",
    );
    assert.ok(
      requiresProp.value.includes("security-scan"),
      "requires must include security-scan",
    );
  });

  it("parses circleci-docker-sidecar.yml: multiple workflows extracted", () => {
    const f = path.join(
      repoRoot,
      "test",
      "data",
      "circleci-docker-sidecar.yml",
    );
    const result = circleCiParser.parse([f], {});

    const wfNames = result.workflows.map((w) => w.name);
    assert.ok(wfNames.includes("test-matrix"), "expected test-matrix workflow");
    assert.ok(
      wfNames.includes("scheduled-tests"),
      "expected scheduled-tests workflow",
    );
  });

  it("parses circleci-docker-sidecar.yml: sidecar containers as executor components", () => {
    const f = path.join(
      repoRoot,
      "test",
      "data",
      "circleci-docker-sidecar.yml",
    );
    const result = circleCiParser.parse([f], {});

    // The app-with-db executor has cimg/python as first image
    const pythonComp = result.components.find(
      (c) => c.type === "container" && c.name?.includes("python"),
    );
    assert.ok(pythonComp, "expected Python executor image component");

    // The app-with-mongo executor has cimg/node:20.0 as primary image
    const nodeComp = result.components.find(
      (c) => c.type === "container" && c.name?.includes("node"),
    );
    assert.ok(nodeComp, "expected Node.js executor image component");
  });

  it("parses circleci-docker-sidecar.yml: Slack orb captured as component", () => {
    const f = path.join(
      repoRoot,
      "test",
      "data",
      "circleci-docker-sidecar.yml",
    );
    const result = circleCiParser.parse([f], {});

    const orbComps = result.components.filter((c) => c.type === "application");
    assert.ok(
      orbComps.length > 0,
      "expected at least one circleci orb component",
    );
    assert.ok(
      orbComps.some((c) => c.name === "slack"),
      "expected circleci/slack orb component",
    );
    assert.ok(
      orbComps.some((c) => c.version === "4.12.5"),
      "expected slack orb version 4.12.5",
    );
  });

  it("parses multiple CircleCI files: two files produce combined results", () => {
    const f1 = path.join(repoRoot, "test", "data", "circleci-config.yml");
    const f2 = path.join(repoRoot, "test", "data", "circleci-machine.yml");
    const result = circleCiParser.parse([f1, f2], {});
    // f1 has 1 workflow, f2 has 1 workflow → combined 2
    assert.strictEqual(
      result.workflows.length,
      2,
      "expected workflows from both files",
    );
  });

  it("strips URL credentials from names and properties", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-circleci-"));
    try {
      const f = path.join(tmpDir, "config.yml");
      writeFileSync(
        f,
        `version: 2.1
executors:
  builder:
    docker:
      - image: https://ci-bot:hunter2@registry.example.com/builder:1
jobs:
  build:
    executor: builder
    steps:
      - run:
          name: publish to https://pkgs.example.com/npm/?sig=Zm9vYmFy
          command: npm publish
workflows:
  main:
    jobs:
      - build:
          filters:
            branches:
              only: https://ci-bot:hunter2@example.com/main
`,
      );
      const result = circleCiParser.parse([f], {});
      const text = JSON.stringify(result);
      assert.ok(!text.includes("hunter2"), "expected no URL password");
      assert.ok(!text.includes("Zm9vYmFy"), "expected no URL query");
      assert.strictEqual(
        result.components[0].name,
        "https://registry.example.com/builder:1",
      );
      assert.strictEqual(
        result.workflows[0].tasks[0].steps[0].name,
        "publish to https://pkgs.example.com/npm/",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("bounds the steps copied for a job listed many times", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-circleci-"));
    const f = path.join(tmpDir, "config.yml");
    const entries = 2000;
    writeFileSync(
      f,
      `version: 2.1\njobs:\n a:\n  steps:\n${"  - s\n".repeat(entries)}workflows:\n w:\n  jobs:\n${"  - a\n".repeat(entries)}`,
    );
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const result = circleCiParser.parse([f], {});
      const tasks = result.workflows[0].tasks;
      assert.strictEqual(tasks.length, entries, "every entry is a task");
      assert.strictEqual(tasks[0].steps.length, entries);
      const last = tasks[entries - 1];
      assert.strictEqual(last.steps, undefined);
      assert.ok(
        last.properties.some(
          (p) =>
            p.name === "cdx:circleci:job:stepsOmitted" && p.value === "true",
        ),
      );
      assert.ok(
        !tasks[0].properties.some(
          (p) => p.name === "cdx:circleci:job:stepsOmitted",
        ),
      );
      const size = JSON.stringify(result).length;
      assert.ok(size < 16 * 1024 * 1024, `the result holds ${size} characters`);
      assert.strictEqual(
        warnings.filter((w) => w.includes("config.yml")).length,
        1,
      );
    } finally {
      console.warn = originalWarn;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps the steps of every task in an ordinary config", () => {
    // A parameterised job listed 100 times, whose steps copied into every
    // task add up to more than 32 characters per byte of the file.
    const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-circleci-"));
    const f = path.join(tmpDir, "config.yml");
    const steps = Array.from(
      { length: 21 },
      (_, index) =>
        `      - run:\n          name: step ${index}\n          command: make target-${index} PARAM=<< parameters.p >> ${"FLAG=on ".repeat(24)}\n`,
    ).join("");
    const entries = Array.from(
      { length: 100 },
      (_, index) =>
        `      - build:\n          name: build-${index}\n          p: v${index}\n`,
    ).join("");
    writeFileSync(
      f,
      `version: 2.1\njobs:\n  build:\n    parameters:\n      p:\n        type: string\n    steps:\n${steps}workflows:\n  main:\n    jobs:\n${entries}`,
    );
    try {
      const tasks = circleCiParser.parse([f], {}).workflows[0].tasks;
      assert.strictEqual(tasks.length, 100);
      assert.ok(tasks.every((task) => task.steps?.length === 21));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

import { readFileSync } from "node:fs";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import {
  buildActivitySummaryPayload,
  buildDependencyTreeLegendLines,
  buildDependencyTreeLines,
  printDependencyTree,
  serializeActivitySummary,
} from "./display.js";
import { REGISTRY_PROVENANCE_ICON } from "./provenanceUtils.js";

it("print tree test", () => {
  const bomJson = JSON.parse(
    readFileSync("./test/data/vuln-spring-1.5.bom.json", { encoding: "utf-8" }),
  );
  printDependencyTree(bomJson);
});

it("prints a provenance icon for registry-backed components", async () => {
  const rows = [];
  const consoleLogStub = sinon.stub(console, "log");
  try {
    const { printTable } = await esmock("./display.js", {
      "./table.js": {
        createStream: () => ({
          end() {
            // intentional no-op for stream stub
          },
          write(row) {
            rows.push(row);
          },
        }),
        table: sinon.stub().returns(""),
      },
      "./utils.js": {
        isSecureMode: false,
        safeExistsSync: sinon.stub(),
        toCamel: sinon.stub(),
      },
    });

    printTable(
      {
        components: [
          {
            group: "",
            name: "left-pad",
            properties: [
              {
                name: "cdx:npm:provenanceUrl",
                value:
                  "https://registry.npmjs.org/-/npm/v1/attestations/left-pad",
              },
            ],
            type: "library",
            version: "1.3.0",
          },
          {
            group: "",
            name: "lodash",
            properties: [],
            type: "library",
            version: "4.17.21",
          },
        ],
        dependencies: [],
      },
      undefined,
      undefined,
      "Found 1 trusted component.",
    );

    assert.strictEqual(rows[1][1], `${REGISTRY_PROVENANCE_ICON} left-pad`);
    assert.strictEqual(rows[2][1], "lodash");
    sinon.assert.calledWithExactly(
      consoleLogStub,
      "Found 1 trusted component.",
    );
    sinon.assert.calledWithExactly(
      consoleLogStub,
      `Legend: ${REGISTRY_PROVENANCE_ICON} = registry provenance or trusted publishing evidence`,
    );
    sinon.assert.calledWithExactly(
      consoleLogStub,
      `${REGISTRY_PROVENANCE_ICON} 1 component(s) include registry provenance or trusted publishing metadata.`,
    );
  } finally {
    consoleLogStub.restore();
  }
});

it("renders shared dependencies once while including dangling trees", () => {
  const treeLines = buildDependencyTreeLines([
    {
      ref: "pkg:root/a@1.0.0",
      dependsOn: ["pkg:shared/c@1.0.0"],
    },
    {
      ref: "pkg:root/b@1.0.0",
      dependsOn: ["pkg:shared/c@1.0.0"],
    },
    {
      ref: "pkg:shared/c@1.0.0",
      dependsOn: ["pkg:leaf/d@1.0.0"],
    },
    {
      ref: "pkg:cycle/e@1.0.0",
      dependsOn: ["pkg:cycle/f@1.0.0"],
    },
    {
      ref: "pkg:cycle/f@1.0.0",
      dependsOn: ["pkg:cycle/e@1.0.0"],
    },
  ]);

  assert.deepStrictEqual(treeLines, [
    "pkg:root/a@1.0.0",
    "└── pkg:shared/c@1.0.0",
    "    └── pkg:leaf/d@1.0.0",
    "pkg:root/b@1.0.0",
    "└── ⤴ pkg:shared/c@1.0.0",
    "pkg:cycle/e@1.0.0",
    "└── pkg:cycle/f@1.0.0",
    "    └── ↺ pkg:cycle/e@1.0.0",
  ]);
  assert.deepStrictEqual(buildDependencyTreeLegendLines(treeLines), [
    "Legend: ⤴ = already shown; ↺ = cycle",
  ]);
});

it("omits empty providers while marking shared provides with an icon", () => {
  const treeLines = buildDependencyTreeLines(
    [
      {
        ref: "pkg:npm/app@1.0.0",
        provides: ["crypto/aes", "crypto/sha256"],
      },
      {
        ref: "pkg:npm/helper@1.0.0",
        provides: ["crypto/sha256"],
      },
      {
        ref: "pkg:npm/unused@1.0.0",
      },
    ],
    "provides",
  );

  assert.deepStrictEqual(treeLines, [
    "pkg:npm/app@1.0.0",
    "├── crypto/aes",
    "└── crypto/sha256",
    "pkg:npm/helper@1.0.0",
    "└── ⤴ crypto/sha256",
  ]);
  assert.deepStrictEqual(buildDependencyTreeLegendLines(treeLines), [
    "Legend: ⤴ = already shown",
  ]);
});

it("returns no legend lines when the dependency tree has no markers", () => {
  assert.deepStrictEqual(
    buildDependencyTreeLegendLines([
      "pkg:root/a@1.0.0",
      "└── pkg:shared/c@1.0.0",
      "    └── pkg:leaf/d@1.0.0",
    ]),
    [],
  );
});

it("prints an informative activity summary table", async () => {
  const tableStub = sinon.stub().returns("activity-table");
  try {
    const { printActivitySummary: printActivitySummaryMocked } = await esmock(
      "./display.js",
      {
        "./table.js": {
          createStream: sinon.stub(),
          table: tableStub,
        },
        "./utils.js": {
          getRecordedActivities: sinon.stub().returns([
            {
              identifier: "ACT-0001",
              projectType: "ruby,js,python",
              packageType: "npm",
              kind: "execute",
              reason: "Dry run mode blocks child process execution.",
              status: "blocked",
              target: "npm install",
            },
            {
              identifier: "ACT-0002",
              projectType: "python",
              packageType: "pypi",
              kind: "read",
              status: "completed",
              target: "/workspace/requirements.txt",
            },
          ]),
          isDryRun: true,
          isSecureMode: false,
          safeExistsSync: sinon.stub(),
          toCamel: sinon.stub(),
        },
      },
    );
    printActivitySummaryMocked();
    sinon.assert.calledOnce(tableStub);
    const [data, config] = tableStub.firstCall.args;
    assert.strictEqual(
      config.header.content,
      "cdxgen dry-run activity summary\n1 completed   1 blocked   0 failed",
    );
    assert.deepStrictEqual(data[0], [
      "Identifier",
      "Type",
      "Package Type",
      "Activity",
      "Target",
      "Outcome / Why",
    ]);
    assert.strictEqual(data[1][0], "ACT-0001");
    assert.strictEqual(data[1][1], "js\npython\nruby");
    assert.strictEqual(data[1][2], "npm");
    assert.strictEqual(data[1][3], "execute");
    assert.strictEqual(
      data[1][5],
      "blocked\nDry run mode blocks child process execution.",
    );
  } finally {
    sinon.restore();
  }
});

it("renders known comma-separated activity target properties across lines", async () => {
  const tableStub = sinon.stub().returns("activity-table");
  try {
    const { printActivitySummary: printActivitySummaryMocked } = await esmock(
      "./display.js",
      {
        "./table.js": {
          createStream: sinon.stub(),
          table: tableStub,
        },
        "./utils.js": {
          getRecordedActivities: sinon.stub().returns([
            {
              identifier: "ACT-0001",
              projectType: "oci",
              packageType: "container",
              kind: "read",
              reason: "Collected image metadata.",
              status: "completed",
              target:
                "Image=ghcr.io/cdxgen/cdxgen, SrcFiles=pnpm-lock.yaml,Dockerfile,package.json",
            },
          ]),
          isDryRun: true,
          isSecureMode: false,
          safeExistsSync: sinon.stub(),
          toCamel: sinon.stub(),
        },
      },
    );
    printActivitySummaryMocked();
    const [data] = tableStub.firstCall.args;
    assert.strictEqual(
      data[1][4],
      "Image=ghcr.io/cdxgen/cdxgen\nSrcFiles=\n- Dockerfile\n- package.json\n- pnpm-lock.yaml",
    );
  } finally {
    sinon.restore();
  }
});

it("renders plain comma-separated activity paths one per line sorted by depth", async () => {
  const tableStub = sinon.stub().returns("activity-table");
  try {
    const { printActivitySummary: printActivitySummaryMocked } = await esmock(
      "./display.js",
      {
        "./table.js": {
          createStream: sinon.stub(),
          table: tableStub,
        },
        "./utils.js": {
          getRecordedActivities: sinon.stub().returns([
            {
              identifier: "ACT-0004",
              projectType: "github",
              packageType: "github",
              kind: "read",
              reason: "Collected github component metadata.",
              status: "completed",
              target:
                "/workspace/.github/workflows/deeper/build.yml, /workspace/.github/workflows/test.yml, /workspace/.github/workflows/deeper/nightly/scan.yml",
            },
          ]),
          isDryRun: true,
          isSecureMode: false,
          safeExistsSync: sinon.stub(),
          toCamel: sinon.stub(),
        },
      },
    );
    printActivitySummaryMocked();
    const [data] = tableStub.firstCall.args;
    assert.strictEqual(
      data[1][4],
      "/workspace/.github/workflows/test.yml\n/workspace/.github/workflows/deeper/build.yml\n/workspace/.github/workflows/deeper/nightly/scan.yml",
    );
  } finally {
    sinon.restore();
  }
});

it("prints grouped environment audit findings in a secure-mode panel", async () => {
  const tableStub = sinon.stub().returns("env-audit-table");
  try {
    const {
      printEnvironmentAuditFindings: printEnvironmentAuditFindingsMocked,
    } = await esmock("./display.js", {
      "./table.js": {
        createStream: sinon.stub(),
        table: tableStub,
      },
      "./utils.js": {
        getRecordedActivities: sinon.stub(),
        isDryRun: true,
        isSecureMode: false,
        safeExistsSync: sinon.stub(),
        toCamel: sinon.stub().callsFake((value) => value),
      },
    });
    printEnvironmentAuditFindingsMocked([
      {
        type: "credential-exposure",
        variable: "HF_TOKEN",
        severity: "low",
        message:
          "HF_TOKEN matches a credential naming pattern and is set in the environment. Build tools or install scripts invoked during SBOM generation may read environment variables.",
        mitigation: "Unset HF_TOKEN.",
      },
      {
        type: "environment-variable",
        variable: "NODE_PATH",
        severity: "high",
        message:
          "NODE_PATH is set and may cause unexpected modules to be loaded, enabling module-resolution poisoning.",
        mitigation: "Unset NODE_PATH before processing untrusted repositories.",
      },
      {
        type: "credential-exposure",
        variable: "GITHUB_TOKEN",
        severity: "low",
        message:
          "GITHUB_TOKEN matches a credential naming pattern and is set in the environment. Build tools or install scripts invoked during SBOM generation may read environment variables.",
        mitigation: "Unset GITHUB_TOKEN.",
      },
    ]);
    sinon.assert.calledOnce(tableStub);
    const [data, config] = tableStub.firstCall.args;
    assert.strictEqual(
      config.header.content,
      "SECURE MODE: Environment audit\n1 high   2 low",
    );
    assert.deepStrictEqual(data[1], [
      "Environment Variable",
      "HIGH",
      "NODE_PATH",
      "NODE_PATH is set and may cause unexpected modules to be loaded, enabling module-resolution poisoning.\nMitigation: Unset NODE_PATH before processing untrusted repositories.",
    ]);
    assert.deepStrictEqual(data[2], [
      "Credential Exposure",
      "LOW",
      "GITHUB_TOKEN\nHF_TOKEN",
      "Credential-like environment variables are set. Build tools or install scripts invoked during SBOM generation may read inherited environment variables.\nMitigation: Unset unneeded secrets when scanning untrusted repositories. Prefer ephemeral, scoped CI credentials injected only for the step that needs them.",
    ]);
  } finally {
    sinon.restore();
  }
});

it("prints the activity summary as JSON", async () => {
  const lines = serializeActivitySummary(
    [
      {
        identifier: "ACT-0001",
        projectType: "js",
        packageType: "npm",
        kind: "execute",
        status: "blocked",
        target: "npm install",
      },
    ],
    "json",
    true,
  );
  assert.strictEqual(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.strictEqual(payload.mode, "dry-run");
  assert.strictEqual(payload.summary.total, 1);
  assert.strictEqual(payload.activities[0].identifier, "ACT-0001");
});

it("prints the activity summary as JSON Lines", async () => {
  const lines = serializeActivitySummary(
    [
      {
        identifier: "ACT-0001",
        projectType: "js",
        packageType: "npm",
        kind: "execute",
        status: "blocked",
        target: "npm install",
      },
    ],
    "jsonl",
    true,
  );
  assert.strictEqual(lines.length, 2);
  const summary = JSON.parse(lines[0]);
  const activity = JSON.parse(lines[1]);
  assert.strictEqual(summary.recordType, "summary");
  assert.strictEqual(summary.total, 1);
  assert.strictEqual(activity.recordType, "activity");
  assert.strictEqual(activity.identifier, "ACT-0001");
});

it("builds summary counts for serialized activity reports", () => {
  const payload = buildActivitySummaryPayload(
    [{ status: "blocked" }, { status: "completed" }, { status: "failed" }],
    true,
  );
  assert.deepStrictEqual(payload.summary, {
    blocked: 1,
    completed: 1,
    failed: 1,
    total: 3,
  });
  assert.strictEqual(payload.mode, "dry-run");
});

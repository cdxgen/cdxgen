import { readFileSync } from "node:fs";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import {
  buildActivitySummaryPayload,
  buildAiBomDatasetLines,
  buildAiBomInsightLines,
  buildAiBomPedigreeLines,
  buildAiBomVariantLines,
  buildDependencyTreeLegendLines,
  buildDependencyTreeLines,
  buildTableSummaryLines,
  printDependencyTree,
  serializeActivitySummary,
} from "./display.js";

it("print tree test", () => {
  const bomJson = JSON.parse(
    readFileSync("./test/data/vuln-spring-1.5.bom.json", { encoding: "utf-8" }),
  );
  printDependencyTree(bomJson);
});

it("prints a provenance icon for registry-backed components", async () => {
  const rows = [];
  const bomJson = {
    components: [
      {
        group: "",
        name: "left-pad",
        properties: [
          {
            name: "cdx:npm:provenanceUrl",
            value: "https://registry.npmjs.org/-/npm/v1/attestations/left-pad",
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
  };
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

  printTable(bomJson, undefined, undefined, "Found 1 trusted component.");

  assert.strictEqual(rows[1][1], "🛡 left-pad");
  assert.strictEqual(rows[2][1], "lodash");
  assert.deepStrictEqual(
    buildTableSummaryLines(bomJson, undefined, "Found 1 trusted component.", 1),
    [
      "Found 1 trusted component.",
      "1 component(s) include registry provenance or trusted publishing metadata.",
    ],
  );
});

it("renders HBOM tables with hardware-centric columns and summary lines", async () => {
  const rows = [];
  const consoleLogStub = sinon.stub(console, "log");
  try {
    const bomJson = {
      metadata: {
        component: {
          name: "demo-host",
          type: "device",
          manufacturer: { name: "Example Corp" },
          properties: [
            { name: "cdx:hbom:platform", value: "linux" },
            { name: "cdx:hbom:architecture", value: "amd64" },
            {
              name: "cdx:hbom:identifierPolicy",
              value: "redacted-by-default",
            },
          ],
        },
      },
      components: [
        {
          type: "device",
          name: "eth0",
          manufacturer: { name: "Intel" },
          version: "en0",
          properties: [
            { name: "cdx:hbom:hardwareClass", value: "network-interface" },
            { name: "cdx:hbom:status", value: "active" },
            { name: "cdx:hbom:speedMbps", value: "2500" },
            { name: "cdx:hbom:driver", value: "igc" },
          ],
        },
        {
          type: "device",
          name: "wifi0",
          properties: [
            { name: "cdx:hbom:hardwareClass", value: "wireless-adapter" },
            { name: "cdx:hbom:connected", value: "true" },
            { name: "cdx:hbom:securityMode", value: "wpa3-personal" },
            { name: "cdx:hbom:linkRateMbps", value: "1200" },
            { name: "cdx:hbom:channel", value: "36" },
          ],
        },
        {
          type: "device",
          name: "nvme0",
          manufacturer: { name: "Samsung" },
          properties: [
            { name: "cdx:hbom:hardwareClass", value: "storage" },
            { name: "cdx:hbom:capacity", value: "1 TB" },
            { name: "cdx:hbom:smartStatus", value: "Verified" },
            { name: "cdx:hbom:wearPercentageUsed", value: "2" },
            { name: "cdx:hbom:transport", value: "nvme" },
          ],
        },
        {
          type: "device",
          name: "Internal Battery",
          properties: [
            { name: "cdx:hbom:hardwareClass", value: "power" },
            { name: "cdx:hbom:health", value: "Good" },
            { name: "cdx:hbom:chargePercent", value: "80" },
            { name: "cdx:hbom:maximumCapacity", value: "91%" },
            { name: "cdx:hbom:cycleCount", value: "120" },
          ],
        },
      ],
      properties: [
        { name: "cdx:hbom:collectorProfile", value: "linux-amd64-v1" },
        { name: "cdx:hbom:evidence:commandCount", value: "2" },
        { name: "cdx:hbom:evidence:commandDiagnosticCount", value: "2" },
        {
          name: "cdx:hbom:evidence:commandDiagnostic",
          value: JSON.stringify({
            command: "lsusb",
            installHint:
              "Command not found: install the Linux package providing lsusb (commonly `usbutils`).",
            issue: "missing-command",
          }),
        },
        {
          name: "cdx:hbom:evidence:commandDiagnostic",
          value: JSON.stringify({
            command: "drm_info",
            issue: "permission-denied",
            privilegeHint:
              "Retry with --privileged to allow a non-interactive sudo attempt for permission-sensitive Linux commands.",
          }),
        },
      ],
    };
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
        getRecordedActivities: sinon.stub().returns([]),
        isDryRun: false,
        isSecureMode: false,
        safeExistsSync: sinon.stub(),
        toCamel: sinon.stub(),
      },
    });

    it("renders operator-friendly AI-BOM insight lines with pedigree and quantization context", () => {
      const lines = buildAiBomInsightLines({
        components: [
          {
            type: "machine-learning-model",
            group: "rohitnagareddy",
            name: "Qwen3-0.6B-Coding-Finetuned-v1",
            version: "fixture-sha",
            description: "Instruction-tuned coding model",
            licenses: [
              {
                license: {
                  id: "Apache-2.0",
                  url: "https://huggingface.co/rohitnagareddy/Qwen3-0.6B-Coding-Finetuned-v1/resolve/main/LICENSE",
                },
              },
            ],
            modelCard: {
              modelParameters: {
                datasets: [
                  { name: "rohitnagareddy/python-coding-instructions" },
                ],
                task: "text-generation",
              },
            },
            pedigree: {
              ancestors: [
                {
                  group: "Qwen",
                  name: "Qwen3-0.6B",
                  purl: "pkg:huggingface/Qwen/Qwen3-0.6B",
                },
              ],
              notes:
                "Hugging Face relation: finetune; Quantization: GGUF Q4_K_M",
            },
            properties: [
              { name: "cdx:ai:provider", value: "huggingface" },
              { name: "cdx:ai:quantization", value: "GGUF Q4_K_M" },
              { name: "cdx:ai:variant", value: "fine-tuned" },
              { name: "cdx:ai:variant", value: "quantized" },
            ],
          },
        ],
        services: [
          {
            name: "ollama",
            group: "ollama",
            tags: ["ai"],
            properties: [
              { name: "cdx:ai:kind", value: "inference-service" },
              { name: "cdx:ai:provider", value: "ollama" },
            ],
          },
        ],
      });

      assert.ok(lines.some((line) => line.includes("AI-BOM")));
      assert.ok(lines.some((line) => line.includes("Usage: 1 AI service")));
      assert.ok(
        lines.some((line) =>
          line.includes(
            "rohitnagareddy/Qwen3-0.6B-Coding-Finetuned-v1@fixture-sha",
          ),
        ),
      );
      assert.ok(lines.some((line) => line.includes("Pedigree")));
      assert.ok(lines.some((line) => line.includes("Qwen/Qwen3-0.6B")));
      assert.ok(
        lines.some((line) => line.includes("Variants: fine-tuned, quantized")),
      );
      assert.ok(lines.some((line) => line.includes("Quantization")));
      assert.ok(lines.some((line) => line.includes("License: Apache-2.0")));
    });

    it("builds focused AI pedigree, variant, and dataset views", () => {
      const bomJson = {
        components: [
          {
            type: "machine-learning-model",
            group: "mlabonne",
            name: "NeuralDaredevil-8B",
            version: "variant-sha",
            modelCard: {
              modelParameters: {
                datasets: [
                  { name: "openbmb/UltraFeedback" },
                  { name: "argilla/distilabel-capybara-dpo-7k-binarized" },
                ],
              },
            },
            pedigree: {
              ancestors: [{ name: "Mistral-7B-v0.1", group: "mistralai" }],
              notes:
                "Hugging Face relation: distillation; model marked unlocked and abliterated",
            },
            properties: [
              { name: "cdx:ai:provider", value: "huggingface" },
              { name: "cdx:ai:variant", value: "distilled" },
              { name: "cdx:ai:variant", value: "abliterated" },
              { name: "cdx:ai:variant", value: "unlocked" },
            ],
          },
        ],
      };

      assert.ok(
        buildAiBomPedigreeLines(bomJson).some((line) =>
          line.includes("AI pedigree view"),
        ),
      );
      assert.ok(
        buildAiBomVariantLines(bomJson).some((line) =>
          line.includes("distilled, abliterated, unlocked"),
        ),
      );
      assert.ok(
        buildAiBomDatasetLines(bomJson).some((line) =>
          line.includes("openbmb/UltraFeedback"),
        ),
      );
    });

    printTable(bomJson);

    assert.deepStrictEqual(rows[0], [
      "Hardware Class",
      "Name",
      "Manufacturer / Version",
      "Key Properties",
      "Tags",
    ]);
    assert.strictEqual(rows[1][0], "network-interface");
    assert.strictEqual(rows[1][1], "eth0");
    assert.strictEqual(rows[1][2], "Intel / en0");
    assert.match(rows[1][3], /status=active/u);
    assert.match(rows[1][3], /speedMbps=2500/u);
    assert.match(rows[1][3], /driver=igc/u);
    assert.strictEqual(rows[2][0], "wireless-adapter");
    assert.match(
      rows[2][3],
      /^connected=true, security=wpa3-personal, linkMbps=1200$/u,
    );
    assert.strictEqual(rows[3][0], "storage");
    assert.match(rows[3][3], /^capacity=1 TB, smart=Verified, wearUsed=2$/u);
    assert.strictEqual(rows[4][0], "power");
    assert.match(rows[4][3], /^health=Good, charge%=80, maxCapacity=91%$/u);
    assert.deepStrictEqual(buildTableSummaryLines(bomJson), [
      "HBOM includes 4 hardware component(s) across 4 hardware class(es)",
      "Top hardware classes: network-interface (1), power (1), storage (1), wireless-adapter (1)",
      "Collector profile: linux-amd64-v1; command evidence: 2; observed files: 0",
      "Collector diagnostics: 2 issue(s); missing commands: 1, permission denied: 1",
      "Permission-sensitive enrichments were skipped or blocked. Re-run with --privileged where policy allows.",
    ]);
  } finally {
    consoleLogStub.restore();
  }
});

it("displaySelfThreatModel does not assume a default TLP classification", async () => {
  const tableStub = sinon.stub().returns("table-output");
  try {
    const { displaySelfThreatModel } = await esmock("./display.js", {
      "./table.js": {
        createStream: sinon.stub(),
        table: tableStub,
      },
      "./utils.js": {
        isSecureMode: false,
        safeExistsSync: sinon.stub(),
        toCamel: sinon.stub().callsFake((value) => value),
      },
    });
    displaySelfThreatModel("/workspace/project", {}, {}, []);
    const [headerData] = tableStub.firstCall.args;
    assert.deepStrictEqual(headerData[0], [
      "TLP Classification",
      "Not set — no distribution constraints recorded.",
    ]);
  } finally {
    sinon.restore();
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

it("highlights suspicious shell-metacharacter paths in the activity summary", async () => {
  const tableStub = sinon.stub().returns("activity-table");
  const shellIfs = "$" + "{IFS}";
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
              identifier: "ACT-0005",
              kind: "inspect",
              reason: "Suspicious path contains shell metacharacters.",
              risk: "shell-metacharacters",
              status: "completed",
              target: `/tmp/repo/evil;cd${shellIfs}..;printf${shellIfs}marker>CDXGEN_GITURL_E2E_MARKER;#/pom.xml`,
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
    assert.ok(data[1][4].startsWith("⚠ shell-metacharacters\n"));
    assert.ok(data[1][4].includes(`evil;cd${shellIfs}..`));
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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, it } from "poku";

// Test helper to create a temporary directory
const createTempDir = () => {
  return mkdtempSync(join(tmpdir(), "cdxgen-ai-test-"));
};

it("evaluates AI provenance with empty / no signals", async () => {
  const tempDir = createTempDir();
  try {
    const mockCollector = await esmock("./aiProvenanceCollector.js", {
      "./envcontext.js": {
        getBranch: () => null,
        gitLogAuthors: () => [],
        gitLogTrailers: () => [],
      },
    });

    const result = await mockCollector.collectAiProvenance(tempDir);
    assert.strictEqual(result.detected, false);
    assert.strictEqual(result.confidence, "0.00");
    assert.strictEqual(result.band, "low");
    assert.deepStrictEqual(result.tools, []);
    assert.deepStrictEqual(result.phases, []);

    // When nothing is detected, no properties are emitted so BOMs stay clean.
    assert.deepStrictEqual(result.properties, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("detects configuration files and directories", async () => {
  const tempDir = createTempDir();
  try {
    // Create CLAUDE.md
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Claude instruction");
    // Create .cursorrules
    writeFileSync(join(tempDir, ".cursorrules"), "");
    // Create .pre-commit-config.yaml with copilot hook
    writeFileSync(
      join(tempDir, ".pre-commit-config.yaml"),
      "- repo: local\n  hooks:\n    - id: copilot-check\n",
    );
    // Create .zed/settings.json with openai assistant config
    mkdirSync(join(tempDir, ".zed"));
    writeFileSync(
      join(tempDir, ".zed/settings.json"),
      '{"assistant": {"provider": "openai"}}',
    );
    // Create .claude/settings.json
    mkdirSync(join(tempDir, ".claude"));
    writeFileSync(join(tempDir, ".claude/settings.json"), "{}");

    const mockCollector = await esmock("./aiProvenanceCollector.js", {
      "./envcontext.js": {
        getBranch: () => null,
        gitLogAuthors: () => [],
        gitLogTrailers: () => [],
      },
    });

    const result = await mockCollector.collectAiProvenance(tempDir);
    assert.strictEqual(result.detected, true);
    assert.ok(result.tools.includes("claude-code"));
    assert.ok(result.tools.includes("cursor"));
    assert.ok(result.tools.includes("zed"));
    // Pseudo-tools are excluded from the tools inventory (the .pre-commit AI
    // hook signal is bucketed as `unattributed`).
    assert.ok(!result.tools.includes("unattributed"));
    // ...but its signal still contributes to detection and confidence.
    assert.ok(result.signals.some((s) => s.tool === "unattributed"));
    assert.strictEqual(result.band, "high"); // noisy-OR of multiple 0.70/0.60/0.50 files is high

    // Pseudo-tools do not get per-tool properties, real tools do.
    assert.ok(
      !result.properties.some(
        (p) => p.name === "cdx:ai:codegen:tool:unattributed",
      ),
    );
    assert.ok(
      result.properties.some(
        (p) => p.name === "cdx:ai:codegen:tool:claude-code",
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("buckets AGENTS.md as the multi-agent pseudo-tool and excludes it from tools", async () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(join(tempDir, "AGENTS.md"), "# Agent instructions");

    const mockCollector = await esmock("./aiProvenanceCollector.js", {
      "./envcontext.js": {
        getBranch: () => null,
        gitLogAuthors: () => [],
        gitLogTrailers: () => [],
      },
    });

    const result = await mockCollector.collectAiProvenance(tempDir);
    assert.strictEqual(result.detected, true);
    // The signal exists and contributes to detection...
    assert.ok(result.signals.some((s) => s.tool === "multi-agent"));
    // ...but is not surfaced as a concrete tool.
    assert.ok(!result.tools.includes("multi-agent"));
    assert.ok(
      !result.properties.some(
        (p) => p.name === "cdx:ai:codegen:tool:multi-agent",
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("detects GitHub workflows CI signals", async () => {
  const tempDir = createTempDir();
  try {
    mkdirSync(join(tempDir, ".github"));
    mkdirSync(join(tempDir, ".github/workflows"));
    writeFileSync(
      join(tempDir, ".github/workflows/ci.yml"),
      "steps:\n  - name: Claude Code Action\n    uses: anthropics/claude-code-action@v1\n",
    );

    const mockCollector = await esmock("./aiProvenanceCollector.js", {
      "./envcontext.js": {
        getBranch: () => null,
        gitLogAuthors: () => [],
        gitLogTrailers: () => [],
      },
    });

    const result = await mockCollector.collectAiProvenance(tempDir);
    assert.strictEqual(result.detected, true);
    assert.ok(result.tools.includes("claude-code"));
    assert.ok(result.phases.includes("ci"));
    assert.strictEqual(result.confidence, "0.90");
    assert.strictEqual(result.band, "high");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("detects Git branch, authors and commit logs", async () => {
  const tempDir = createTempDir();
  try {
    const mockCollector = await esmock("./aiProvenanceCollector.js", {
      "./envcontext.js": {
        getBranch: () => "cursor-branch-test",
        gitLogAuthors: () => [
          { name: "Devin Bot", email: "devin-ai-integration@example.com" },
        ],
        gitLogTrailers: () => [
          {
            hash: "1234567890",
            message:
              "feat: add super feature\nCo-authored-by: Copilot <copilot@github.com>",
          },
        ],
      },
    });

    const result = await mockCollector.collectAiProvenance(tempDir);
    assert.strictEqual(result.detected, true);
    assert.ok(result.tools.includes("cursor")); // from branch
    assert.ok(result.tools.includes("devin")); // from bot author
    assert.ok(result.tools.includes("github-copilot")); // from commit message
    assert.strictEqual(result.band, "high");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

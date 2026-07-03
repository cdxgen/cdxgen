import { assert, describe, it } from "poku";

import { collectAiOversight } from "./aiOversightCollector.js";
import { collectAiProvenance } from "./aiProvenanceCollector.js";

// Integration tests that run the AI provenance/oversight collectors against the
// cdxgen repository itself (process.cwd() when poku executes). The repo commits
// AI-assistant config files (AGENTS.md, .github/copilot-instructions.md), so
// code-authorship detection is deterministic regardless of git history depth or
// network access. Oversight is asserted only for structural validity because it
// depends on git-ai notes / forge data that may be absent in CI.
const REPO_DIR = process.cwd();

describe("AI provenance collector (cdxgen repo)", () => {
  it("detects AI authorship from committed config files", () => {
    const result = collectAiProvenance(REPO_DIR);
    assert.strictEqual(
      result.detected,
      true,
      "AI provenance should be detected",
    );
    assert.ok(Array.isArray(result.tools), "tools should be an array");
    assert.ok(
      result.tools.length > 0,
      "at least one AI tool should be detected",
    );
    assert.ok(
      result.tools.includes("github-copilot"),
      "github-copilot should be detected from .github/copilot-instructions.md",
    );
    assert.ok(
      ["low", "medium", "high"].includes(result.band),
      `confidence band should be a known value, got ${result.band}`,
    );
  });

  it("emits well-formed cdx:ai:codegen properties", () => {
    const result = collectAiProvenance(REPO_DIR);
    const byName = new Map(result.properties.map((p) => [p.name, p.value]));
    assert.strictEqual(byName.get("cdx:ai:codegen:detected"), "true");
    const confidence = Number.parseFloat(
      byName.get("cdx:ai:codegen:confidence"),
    );
    assert.ok(
      confidence > 0 && confidence <= 0.99,
      `confidence should be within (0, 0.99], got ${confidence}`,
    );
    assert.ok(
      byName.has("cdx:ai:codegen:tools"),
      "tools property should be present",
    );

    // The evidence blob must be a valid, non-empty JSON array of signals.
    const evidence = byName.get("cdx:ai:codegen:evidence:json");
    assert.ok(evidence, "evidence:json property should be present");
    const signals = JSON.parse(evidence);
    assert.ok(Array.isArray(signals) && signals.length > 0);
    for (const sig of signals) {
      assert.ok(sig.channel && sig.tool, "each signal has a channel and tool");
    }
  });

  it("computes structurally valid oversight results (git-only)", async () => {
    // Force git-only mode so the test never depends on forge network access.
    const prevGh = process.env.GITHUB_TOKEN;
    const prevGl = process.env.GITLAB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    try {
      const result = await collectAiOversight(REPO_DIR);
      assert.ok(
        ["strong", "moderate", "weak"].includes(result.band),
        `band should be a known value, got ${result.band}`,
      );
      assert.ok(
        typeof result.score === "number" &&
          result.score >= 0 &&
          result.score <= 1,
        "score should be within [0, 1]",
      );
      // When AI commits are found, review-dependent metrics must be honest
      // (unavailable) in git-only mode and properties must be well-formed.
      if (result.properties.length > 0) {
        const byName = new Map(result.properties.map((p) => [p.name, p.value]));
        assert.strictEqual(
          byName.get("cdx:ai:oversight:reviewCoverage"),
          "unavailable",
          "review coverage must be unavailable without forge data",
        );
        const dataSources = byName.get("cdx:ai:oversight:dataSources") || "";
        assert.ok(
          dataSources.split(",").includes("git"),
          "git must be listed as a data source",
        );
        assert.ok(
          !dataSources.includes("github-api") &&
            !dataSources.includes("gitlab-api"),
          "no forge data sources in git-only mode",
        );
      }
    } finally {
      if (prevGh !== undefined) process.env.GITHUB_TOKEN = prevGh;
      if (prevGl !== undefined) process.env.GITLAB_TOKEN = prevGl;
    }
  });
});

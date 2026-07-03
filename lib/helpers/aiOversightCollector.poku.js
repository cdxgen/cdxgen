import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";

const createTempDir = () => {
  return mkdtempSync(join(tmpdir(), "cdxgen-ai-oversight-test-"));
};

const emptyDiff = () => ({
  testFilesDeleted: [],
  weakeningTokens: [],
  touchedFiles: [],
  addedLinesCount: 0,
  deletedLinesCount: 0,
});

describe("collectAiOversight()", () => {
  it("returns default neutral results and empty properties when no commits exist", async () => {
    const tempDir = createTempDir();
    try {
      const mockCollector = await esmock("./aiOversightCollector.js", {
        "./envcontext.js": {
          gitLogCommitsDetailed: () => [],
          gitAiNotes: () => [],
          gitCommitDiffAnalysis: () => emptyDiff(),
          gitRevertsAndHotfixes: () => [],
        },
        "./forgeEnricher.js": {
          enrichFromForge: async () => ({ dataSources: [], prReviews: [] }),
        },
      });

      const result = await mockCollector.collectAiOversight(tempDir);
      assert.strictEqual(result.score, 1.0);
      assert.strictEqual(result.band, "strong");
      assert.deepStrictEqual(result.properties, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns empty properties when no AI-authored commits are present", async () => {
    const tempDir = createTempDir();
    try {
      const mockCollector = await esmock("./aiOversightCollector.js", {
        "./envcontext.js": {
          gitLogCommitsDetailed: () => [
            {
              hash: "sha000",
              authorName: "Human Dev",
              authorEmail: "dev@company.com",
              committerName: "Human Dev",
              committerEmail: "dev@company.com",
              parents: ["parent000"],
              signatureStatus: "N",
              // Mentions "ai" but has no strong AI-authorship marker
              message: "feat: add ai-related docs and gpt notes",
              hasSignedOff: false,
            },
          ],
          gitAiNotes: () => [],
          gitCommitDiffAnalysis: () => ({
            ...emptyDiff(),
            touchedFiles: ["docs/ai.md"],
            addedLinesCount: 3,
          }),
          gitRevertsAndHotfixes: () => [],
        },
        "./forgeEnricher.js": {
          enrichFromForge: async () => ({ dataSources: [], prReviews: [] }),
        },
      });

      const result = await mockCollector.collectAiOversight(tempDir);
      assert.deepStrictEqual(result.properties, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("marks review-dependent metrics unavailable in git-only mode", async () => {
    const tempDir = createTempDir();
    try {
      const mockCollector = await esmock("./aiOversightCollector.js", {
        "./envcontext.js": {
          gitLogCommitsDetailed: () => [
            {
              hash: "sha123",
              authorName: "Claude",
              authorEmail: "noreply@anthropic.com",
              committerName: "Claude",
              committerEmail: "noreply@anthropic.com",
              parents: ["parent123"],
              signatureStatus: "N",
              message: "Generated with Claude Code\nCo-authored-by: Claude",
              hasSignedOff: false,
            },
          ],
          gitAiNotes: () => [],
          gitCommitDiffAnalysis: () => ({
            ...emptyDiff(),
            touchedFiles: ["lib/foo.js"],
            addedLinesCount: 10,
            deletedLinesCount: 2,
          }),
          gitRevertsAndHotfixes: () => [],
        },
        "./forgeEnricher.js": {
          enrichFromForge: async () => ({ dataSources: [], prReviews: [] }),
        },
      });

      const result = await mockCollector.collectAiOversight(tempDir);
      const propsMap = new Map(result.properties.map((p) => [p.name, p.value]));

      // Local git cannot observe reviews -> honestly unavailable, not "0" or "1"
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:reviewCoverage"),
        "unavailable",
      );
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:selfMergeRate"),
        "unavailable",
      );
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:verificationDebtRatio"),
        "unavailable",
      );
      // No CODEOWNERS file -> coverage is unavailable, not 0
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:codeownersCoverage"),
        "unavailable",
      );
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:ciWeakeningEvents"),
        "0",
      );
      assert.strictEqual(propsMap.get("cdx:ai:oversight:dataSources"), "git");
      // Clean git-only signals should not produce a weak (false-positive) band
      assert.strictEqual(result.band, "strong");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("evaluates CODEOWNERS and sign-off coverage correctly", async () => {
    const tempDir = createTempDir();
    try {
      mkdirSync(join(tempDir, ".github"));
      writeFileSync(
        join(tempDir, ".github", "CODEOWNERS"),
        "lib/**/*.js @review-team\n",
      );

      const mockCollector = await esmock("./aiOversightCollector.js", {
        "./envcontext.js": {
          gitLogCommitsDetailed: () => [
            {
              hash: "sha123",
              authorName: "developer",
              authorEmail: "dev@company.com",
              committerName: "reviewer",
              committerEmail: "rev@company.com",
              parents: ["parent123"],
              signatureStatus: "G",
              message: "Co-authored-by: Copilot\nSigned-off-by: developer",
              hasSignedOff: true,
            },
          ],
          gitAiNotes: () => [],
          gitCommitDiffAnalysis: () => ({
            ...emptyDiff(),
            touchedFiles: ["lib/foo.js", "README.md"],
            addedLinesCount: 20,
            deletedLinesCount: 5,
          }),
          gitRevertsAndHotfixes: () => [],
        },
        "./forgeEnricher.js": {
          enrichFromForge: async () => ({ dataSources: [], prReviews: [] }),
        },
      });

      const result = await mockCollector.collectAiOversight(tempDir);
      const propsMap = new Map(result.properties.map((p) => [p.name, p.value]));

      // 1 of 2 files (lib/foo.js) matches "lib/**/*.js", so 50% coverage
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:codeownersCoverage"),
        "0.5000",
      );
      // Verified signature (G) and signoff trailer => 100% signoff coverage
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:signoffCoverage"),
        "1.0000",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses git-ai notes and calculates exact AI line ratios", async () => {
    const tempDir = createTempDir();
    try {
      const mockCollector = await esmock("./aiOversightCollector.js", {
        "./envcontext.js": {
          gitLogCommitsDetailed: () => [
            {
              hash: "sha123",
              authorName: "developer",
              authorEmail: "dev@company.com",
              committerName: "reviewer",
              committerEmail: "rev@company.com",
              parents: ["parent123"],
              signatureStatus: "N",
              message: "Refactor logic",
              hasSignedOff: false,
            },
          ],
          gitAiNotes: () => [
            {
              hash: "sha123",
              note: JSON.stringify({
                agent: "claude-code",
                lines: [5, 6, 7, 8, 9],
              }),
            },
          ],
          gitCommitDiffAnalysis: () => ({
            ...emptyDiff(),
            touchedFiles: ["lib/foo.js"],
            addedLinesCount: 10,
            deletedLinesCount: 0,
          }),
          gitRevertsAndHotfixes: () => [],
        },
        "./forgeEnricher.js": {
          enrichFromForge: async () => ({ dataSources: [], prReviews: [] }),
        },
      });

      const result = await mockCollector.collectAiOversight(tempDir);
      const propsMap = new Map(result.properties.map((p) => [p.name, p.value]));

      // 5 lines in git-ai note ÷ 10 lines changed total = 0.5000
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:aiLineRatio"),
        "0.5000",
      );
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:dataSources"),
        "git,git-ai-notes",
      );
      // New git-ai derived detail properties
      assert.strictEqual(propsMap.get("cdx:ai:codegen:agents"), "claude-code");
      assert.strictEqual(propsMap.get("cdx:ai:codegen:noteCount"), "1");
      assert.strictEqual(propsMap.get("cdx:ai:codegen:attributionCount"), "5");
      assert.strictEqual(propsMap.get("cdx:ai:codegen:sessionCount"), "0");
      // No model in the flat JSON fixture, so models should be absent
      assert.strictEqual(propsMap.has("cdx:ai:codegen:models"), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("integrates forge review details when tokens are present", async () => {
    const tempDir = createTempDir();
    try {
      const mockCollector = await esmock("./aiOversightCollector.js", {
        "./envcontext.js": {
          gitLogCommitsDetailed: () => [
            {
              hash: "sha123",
              authorName: "developer",
              authorEmail: "dev@company.com",
              committerName: "developer",
              committerEmail: "dev@company.com",
              parents: ["parent123"],
              signatureStatus: "N",
              message: "Co-authored-by: Claude",
              hasSignedOff: false,
            },
          ],
          gitAiNotes: () => [],
          gitCommitDiffAnalysis: () => ({
            ...emptyDiff(),
            touchedFiles: ["lib/foo.js"],
            addedLinesCount: 5,
            deletedLinesCount: 0,
          }),
          gitRevertsAndHotfixes: () => [],
        },
        "./forgeEnricher.js": {
          enrichFromForge: async () => ({
            dataSources: ["github-api"],
            prReviews: [
              {
                commitHash: "sha123",
                hasIndependentApproval: true,
                selfApproved: false,
                reviewLatencySeconds: 3600,
              },
            ],
          }),
        },
      });

      const result = await mockCollector.collectAiOversight(tempDir);
      const propsMap = new Map(result.properties.map((p) => [p.name, p.value]));

      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:reviewCoverage"),
        "1.0000",
      );
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:selfMergeRate"),
        "0.0000",
      );
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:verificationDebtRatio"),
        "0.0000",
      );
      assert.ok(
        propsMap.get("cdx:ai:oversight:dataSources").includes("github-api"),
      );
      assert.ok(result.score >= 0.75);
      assert.strictEqual(result.band, "strong");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("applies hard penalty for CI weakening events", async () => {
    const tempDir = createTempDir();
    try {
      const mockCollector = await esmock("./aiOversightCollector.js", {
        "./envcontext.js": {
          gitLogCommitsDetailed: () => [
            {
              hash: "sha123",
              authorName: "developer",
              authorEmail: "dev@company.com",
              committerName: "reviewer",
              committerEmail: "rev@company.com",
              parents: ["parent123"],
              signatureStatus: "G",
              message: "Co-authored-by: Claude",
              hasSignedOff: true,
            },
          ],
          gitAiNotes: () => [],
          gitCommitDiffAnalysis: () => ({
            ...emptyDiff(),
            testFilesDeleted: ["test/foo.test.js"],
            weakeningTokens: ["npm run test || true"],
            touchedFiles: ["lib/foo.js", "test/foo.test.js", "package.json"],
            addedLinesCount: 5,
            deletedLinesCount: 5,
          }),
          gitRevertsAndHotfixes: () => [],
        },
        "./forgeEnricher.js": {
          enrichFromForge: async () => ({ dataSources: [], prReviews: [] }),
        },
      });

      const result = await mockCollector.collectAiOversight(tempDir);
      const propsMap = new Map(result.properties.map((p) => [p.name, p.value]));

      // 1 test file deleted + 1 weakening token = 2 weakening events
      assert.strictEqual(
        propsMap.get("cdx:ai:oversight:ciWeakeningEvents"),
        "2",
      );
      // Hard penalty should drag the score down materially
      assert.ok(result.score < 0.75);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

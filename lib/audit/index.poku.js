import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "poku";

import { finalizeAuditReport, loadInputBoms } from "./index.js";
import { formatPredictiveAnnotations } from "./reporters.js";

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

describe("loadInputBoms()", () => {
  it("loads valid BOMs from a directory and skips unrelated JSON files", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdx-audit-"));
    const bomPath = path.join(tmpDir, "bom.json");
    const otherPath = path.join(tmpDir, "notes.json");

    writeJson(bomPath, {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      components: [],
    });
    writeJson(otherPath, {
      hello: "world",
    });

    try {
      const inputBoms = loadInputBoms({ bomDir: tmpDir });
      assert.strictEqual(inputBoms.length, 1);
      assert.strictEqual(inputBoms[0].source, bomPath);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});

describe("finalizeAuditReport()", () => {
  it("returns exit code 3 when a target meets the fail severity", () => {
    const finalized = finalizeAuditReport(
      {
        results: [
          {
            assessment: {
              severity: "high",
            },
            findings: [],
            target: {
              name: "left-pad",
              type: "npm",
            },
          },
        ],
        summary: {
          erroredTargets: 0,
          inputBomCount: 1,
          scannedTargets: 1,
          skippedTargets: 0,
          totalTargets: 1,
        },
      },
      {
        failSeverity: "high",
        minSeverity: "low",
        report: "console",
      },
    );

    assert.strictEqual(finalized.exitCode, 3);
    assert.match(finalized.output, /left-pad/);
  });

  it("returns exit code 0 when no target crosses the fail threshold", () => {
    const finalized = finalizeAuditReport(
      {
        results: [
          {
            assessment: {
              confidenceLabel: "medium",
              reasons: ["Only one mild signal observed."],
              score: 18,
              severity: "low",
            },
            findings: [
              {
                message: "Deprecated package",
                ruleId: "INT-005",
              },
            ],
            target: {
              name: "requests",
              type: "pypi",
            },
          },
        ],
        summary: {
          erroredTargets: 0,
          inputBomCount: 1,
          scannedTargets: 1,
          skippedTargets: 0,
          totalTargets: 1,
        },
      },
      {
        failSeverity: "high",
        minSeverity: "low",
        report: "console",
      },
    );

    assert.strictEqual(finalized.exitCode, 0);
    assert.match(finalized.output, /requests/);
  });
});

describe("formatPredictiveAnnotations()", () => {
  it("creates component-scoped annotations for predictive audit results", () => {
    const annotations = formatPredictiveAnnotations(
      {
        results: [
          {
            assessment: {
              confidenceLabel: "medium",
              reasons: ["Two signals corroborated the risk posture."],
              score: 58,
              severity: "high",
            },
            findings: [
              {
                message: "Install script from non-registry source",
                ruleId: "PKG-001",
              },
            ],
            repoUrl: "https://github.com/example/left-pad",
            target: {
              bomRefs: ["pkg:npm/left-pad@1.3.0"],
              purl: "pkg:npm/left-pad@1.3.0",
            },
          },
        ],
      },
      {
        metadata: {
          tools: {
            components: [
              {
                name: "cdxgen",
                type: "application",
                version: "12.3.0",
              },
            ],
          },
        },
        serialNumber: "urn:uuid:test-bom",
      },
      {
        minSeverity: "medium",
      },
    );

    assert.strictEqual(annotations.length, 1);
    assert.deepStrictEqual(annotations[0].subjects, ["pkg:npm/left-pad@1.3.0"]);
    assert.match(annotations[0].text, /Predictive audit score 58/);
    assert.match(annotations[0].text, /cdx:audit:engine/);
  });
});

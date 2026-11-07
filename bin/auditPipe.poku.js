/**
 * The stdout truncation only exists at process exit, so every case here
 * drives the real `bin/audit.js` CLI through a spawned pipe instead of
 * calling its functions in-process. A piped json report must arrive
 * complete, while `--report-file` keeps stdout empty. Issue #4762
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const auditArgs = [
  join(repoRoot, "bin", "audit.js"),
  "--bom",
  join(repoRoot, "test", "data", "bom-java.json"),
  "--direct-bom-audit",
  "--report",
  "json",
];

/**
 * Run cdx-audit on the java fixture with stdout piped, which is the path
 * that used to lose the tail of the report.
 *
 * @param {string[]} extraArgs Additional CLI arguments.
 * @param {string} reportFile Optional `--report-file` path.
 * @returns {Object} The spawn result.
 */
function runAuditCli(extraArgs, reportFile) {
  return spawnSync(
    process.execPath,
    [
      ...auditArgs,
      ...(reportFile ? ["--report-file", reportFile] : []),
      ...extraArgs,
    ],
    {
      encoding: "utf-8",
      timeout: 120000,
      env: { ...process.env, CI: "true" },
    },
  );
}

describe("cdx-audit keeps piped stdout complete", () => {
  it("writes the full report to a pipe and still exits with the verdict", () => {
    const result = runAuditCli([]);
    assert.equal(
      result.status,
      0,
      `expected the audit exit code, got ${result.status}: ${result.stderr?.slice(-1500)}`,
    );
    assert.ok(
      result.stdout.length > 400000,
      `a piped report must not be cut off at the pipe buffer, got ${result.stdout.length} characters`,
    );
    const report = JSON.parse(result.stdout);
    assert.ok(
      report.summary && typeof report.summary.totalFindings === "number",
      "the piped json report keeps its summary section",
    );
  });

  it("still exits 3 on a fail-severity hit, with the report drained", () => {
    const result = runAuditCli(["--fail-severity", "low"]);
    assert.equal(
      result.status,
      3,
      `expected the fail-severity verdict, got ${result.status}: ${result.stderr?.slice(-1500)}`,
    );
    assert.ok(
      result.stdout.length > 400000,
      `the verdict must not cost the report its tail, got ${result.stdout.length} characters`,
    );
    JSON.parse(result.stdout);
  });

  it("keeps stdout empty when the report goes to --report-file", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cdxgen-audit-pipe-"));
    try {
      const reportFile = join(tmpRoot, "audit.json");
      const result = runAuditCli([], reportFile);
      assert.equal(
        result.status,
        0,
        `expected the audit exit code, got ${result.status}: ${result.stderr?.slice(-1500)}`,
      );
      assert.equal(
        result.stdout,
        "",
        "stdout stays empty when the report goes to a file",
      );
      const report = JSON.parse(readFileSync(reportFile, "utf-8"));
      assert.ok(
        report.summary && typeof report.summary.totalFindings === "number",
        "the report file keeps its summary section",
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

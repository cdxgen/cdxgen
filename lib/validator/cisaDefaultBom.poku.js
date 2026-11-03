/**
 * Locks in the `cisa` benchmark score docs/CDX_VALIDATE.md states for a
 * default cdxgen BOM. Each case runs `node bin/cdxgen.js` offline on an
 * in-repo npm project (no install, no network) and scores the real output.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { buildBenchmarkReports, evaluateAll } from "./complianceEngine.js";

const repoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdxgen-cisa-default-"));
process.on("exit", () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Generate a BOM with the cdxgen CLI defaults and score it against `cisa`.
 *
 * @param {string} fixture fixture directory relative to the repository root
 * @param {string} tag output file name tag
 * @param {string[]} extraArgs additional CLI arguments
 * @returns {{ bom: object, statuses: Record<string, string>, score: object }}
 */
function scoreDefaultBom(fixture, tag, extraArgs = []) {
  const outFile = path.join(tmpDir, `${tag}.json`);
  const env = { ...process.env, CDXGEN_NO_CACHE: "true" };
  // License fetching would change the license outcome; keep the default.
  delete env.FETCH_LICENSE;
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "bin", "cdxgen.js"),
      "-t",
      "js",
      path.join(repoRoot, fixture),
      "--no-install-deps",
      "-o",
      outFile,
      ...extraArgs,
    ],
    { cwd: repoRoot, env, encoding: "utf-8" },
  );
  assert.strictEqual(
    result.status,
    0,
    `cdxgen exited with ${result.status}: ${result.stderr}`,
  );
  const bom = JSON.parse(fs.readFileSync(outFile, "utf-8"));
  const findings = evaluateAll(bom, { benchmarks: ["cisa"] });
  const statuses = Object.fromEntries(
    findings.map((f) => [f.ruleId, f.status]),
  );
  const [score] = buildBenchmarkReports(findings, ["cisa"]);
  return { bom, statuses, score };
}

/**
 * The expected status of every cisa rule: pass unless listed.
 *
 * @param {Record<string, string>} exceptions rule id to non-pass status
 * @returns {Record<string, string>}
 */
function expectedStatuses(exceptions) {
  const expected = {};
  for (let i = 1; i <= 15; i++) {
    const id = `CISA-MIN-${String(i).padStart(3, "0")}`;
    expected[id] = exceptions[id] || "pass";
  }
  return expected;
}

describe("cisa benchmark on a default cdxgen BOM", () => {
  it("scores 11 pass, 3 fail, 1 manual on test/data/svelte-precision (lockfile v3)", () => {
    const { bom, statuses, score } = scoreDefaultBom(
      "test/data/svelte-precision",
      "svelte-precision",
    );
    assert.deepStrictEqual(
      bom.metadata.authors,
      [{ name: "OWASP Foundation" }],
      "the run must use the --author default",
    );
    assert.deepStrictEqual(
      statuses,
      expectedStatuses({
        "CISA-MIN-001": "fail",
        "CISA-MIN-002": "fail",
        "CISA-MIN-010": "fail",
        "CISA-MIN-015": "manual",
      }),
    );
    assert.strictEqual(score.pass, 11);
    assert.strictEqual(score.fail, 3);
    assert.strictEqual(score.manual, 1);
    // The lockfile's integrity values become SHA-512 hashes.
    for (const c of bom.components) {
      assert.ok(
        c.hashes?.some((h) => h.alg === "SHA-512"),
        `${c.purl} should carry a SHA-512 hash`,
      );
    }
  });

  it("passes the author element once --author names the SBOM author", () => {
    const { statuses } = scoreDefaultBom(
      "test/data/svelte-precision",
      "svelte-precision-author",
      ["--author", "Acme SBOM Team"],
    );
    assert.deepStrictEqual(
      statuses,
      expectedStatuses({
        "CISA-MIN-002": "fail",
        "CISA-MIN-010": "fail",
        "CISA-MIN-015": "manual",
      }),
    );
  });

  it("also fails the license element when the lockfile records no licenses", () => {
    const { statuses } = scoreDefaultBom(
      "test/data/package-json/v3",
      "package-json-v3",
    );
    assert.deepStrictEqual(
      statuses,
      expectedStatuses({
        "CISA-MIN-001": "fail",
        "CISA-MIN-002": "fail",
        "CISA-MIN-010": "fail",
        "CISA-MIN-013": "fail",
        "CISA-MIN-015": "manual",
      }),
    );
  });
});

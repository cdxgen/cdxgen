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

import { generateSigningKeyPair, signBom } from "../helpers/bomSigner.js";
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

/** The practices the profile reports for manual review on every BOM. */
const MANUAL_PRACTICES = [
  "CISA-MIN-015",
  "CISA-MIN-016",
  "CISA-MIN-017",
  "CISA-MIN-018",
];

/**
 * The expected status of every cisa rule: manual for the practices, pass for
 * the rest unless listed.
 *
 * @param {Record<string, string>} exceptions rule id to non-pass status
 * @returns {Record<string, string>}
 */
function expectedStatuses(exceptions) {
  const expected = {};
  for (let i = 1; i <= 18; i++) {
    const id = `CISA-MIN-${String(i).padStart(3, "0")}`;
    expected[id] =
      exceptions[id] || (MANUAL_PRACTICES.includes(id) ? "manual" : "pass");
  }
  return expected;
}

describe("cisa benchmark on a default cdxgen BOM", () => {
  it("scores 10 pass, 4 fail, 4 manual on test/data/svelte-precision (lockfile v3)", () => {
    const { bom, statuses, score } = scoreDefaultBom(
      "test/data/svelte-precision",
      "svelte-precision",
    );
    assert.deepStrictEqual(
      bom.metadata.authors,
      [{ name: "OWASP Foundation" }],
      "the run must use the --author default",
    );
    // The project's own package.json declares no license, so the target
    // component fails the license element although every dependency passes.
    assert.strictEqual(bom.metadata.component.licenses, undefined);
    assert.ok(bom.components.every((c) => c.licenses?.length));
    assert.deepStrictEqual(
      statuses,
      expectedStatuses({
        "CISA-MIN-001": "fail",
        "CISA-MIN-002": "fail",
        "CISA-MIN-010": "fail",
        "CISA-MIN-013": "fail",
      }),
    );
    assert.strictEqual(score.pass, 10);
    assert.strictEqual(score.fail, 4);
    assert.strictEqual(score.manual, 4);
    // The lockfile's integrity values become SHA-512 hashes.
    for (const c of bom.components) {
      assert.ok(
        c.hashes?.some((h) => h.alg === "SHA-512"),
        `${c.purl} should carry a SHA-512 hash`,
      );
    }
  });

  it("passes the author and signature elements once --author is given and cdx-sign signs the BOM", () => {
    const { bom, statuses } = scoreDefaultBom(
      "test/data/svelte-precision",
      "svelte-precision-author",
      ["--author", "Acme SBOM Team"],
    );
    assert.deepStrictEqual(
      statuses,
      expectedStatuses({
        "CISA-MIN-002": "fail",
        "CISA-MIN-010": "fail",
        "CISA-MIN-013": "fail",
      }),
    );
    const { privateKey } = generateSigningKeyPair("ES256");
    const signed = signBom(bom, { privateKey, algorithm: "ES256" });
    const signedStatuses = Object.fromEntries(
      evaluateAll(signed, { benchmarks: ["cisa"] }).map((f) => [
        f.ruleId,
        f.status,
      ]),
    );
    assert.strictEqual(signedStatuses["CISA-MIN-002"], "pass");
  });

  it("also fails the license element when the lockfile records no licenses", () => {
    const { bom, statuses } = scoreDefaultBom(
      "test/data/package-json/v3",
      "package-json-v3",
    );
    assert.strictEqual(
      bom.metadata.component.licenses?.[0]?.license?.id,
      "ISC",
    );
    assert.deepStrictEqual(
      statuses,
      expectedStatuses({
        "CISA-MIN-001": "fail",
        "CISA-MIN-002": "fail",
        "CISA-MIN-010": "fail",
        "CISA-MIN-013": "fail",
      }),
    );
  });

  it("scores a CycloneDX 2.0 BOM the same way", () => {
    const { bom, statuses } = scoreDefaultBom(
      "test/data/svelte-precision",
      "svelte-precision-2.0",
      ["--spec-version", "2.0"],
    );
    assert.strictEqual(bom.specFormat, "CycloneDX");
    assert.strictEqual(bom.bomFormat, undefined);
    assert.deepStrictEqual(
      statuses,
      expectedStatuses({
        "CISA-MIN-001": "fail",
        "CISA-MIN-002": "fail",
        "CISA-MIN-010": "fail",
        "CISA-MIN-013": "fail",
      }),
    );
  });
});

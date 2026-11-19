import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";

// The source argument can be a git URL or purl that holds a credential. The
// dry-run activity table and the environment audit name the source, and the
// default project name comes from it.

const CDXGEN = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "bin",
  "cdxgen.js",
);
const TOKEN = "SECRETTOKEN4711";

function runDryRun(source) {
  const cwd = mkdtempSync(path.join(tmpdir(), "cdxgen-source-label-"));
  const env = { ...process.env, CDXGEN_NO_CACHE: "true", CI: "" };
  for (const name of ["CDXGEN_DEBUG_MODE", "CDXGEN_DRY_RUN", "CDXGEN_TYPE"]) {
    delete env[name];
  }
  try {
    const result = spawnSync(
      process.execPath,
      [CDXGEN, "--dry-run", "--env-audit", "-t", "js", source],
      { cwd, env, encoding: "utf-8", timeout: 120000 },
    );
    // Tables wrap long values, so compare with the table drawing and white
    // space removed.
    return `${result.stdout}${result.stderr}`.replace(/[^A-Za-z0-9]/gu, "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

it("keeps a git URL credential out of the dry-run and audit output", () => {
  const output = runDryRun(
    `https://ci:${TOKEN}@git.example.invalid/acme/demo.git?x=${TOKEN}`,
  );
  assert.ok(output.includes("demogit"), "the run did not name the source");
  assert.ok(!output.includes(TOKEN));
});

it("keeps a purl credential out of the dry-run and audit output", () => {
  const output = runDryRun(
    `pkg:generic/demo@1.0?vcs_url=git%2Bhttps:%2F%2Fci:${TOKEN}%40git.example.invalid%2Fdemo.git`,
  );
  assert.ok(output.includes("demo10"), "the run did not name the source");
  assert.ok(!output.includes(TOKEN));
});

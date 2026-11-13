import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import { denoClearEnvSpawnSync, safeSpawnSync } from "./fs.js";

// These tests check the environment a child actually receives. Deno's
// spawnSync merges the parent environment under the env option, so
// safeSpawnSync starts children whose option drops or overrides a variable
// through Deno.Command with clearEnv there, while node replaces the
// environment natively. They live apart from fs.poku.js, which imports
// esmock: contrib/alt-runtime-tests.js holds every esmock file back from the
// deno job, and the deno path is the one these tests exist for. sh spells
// the probe in POSIX shell, so Windows skips these the way other POSIX-only
// tests do.
const ENV_MARKER = "CDXGEN_SPAWN_ENV_MARKER";

/**
 * Run a check with a marker variable set in the parent environment, so a
 * child that receives it can be told from one that does not.
 */
function withEnvMarker(check) {
  const previous = process.env[ENV_MARKER];
  process.env[ENV_MARKER] = "leaked";
  try {
    check();
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_MARKER];
    } else {
      process.env[ENV_MARKER] = previous;
    }
  }
}

it("safeSpawnSync() keeps a variable the env option dropped away from the child", () => {
  if (process.platform === "win32") {
    return;
  }
  withEnvMarker(() => {
    const result = safeSpawnSync(
      "sh",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell default-value expansion, not a JS template
      ["-c", "echo ${CDXGEN_SPAWN_ENV_MARKER-unset}"],
      { env: { PATH: process.env.PATH } },
    );
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), "unset");
  });
});

it("safeSpawnSync() still delivers an additive env option to the child", () => {
  if (process.platform === "win32") {
    return;
  }
  const result = safeSpawnSync(
    "sh",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell default-value expansion, not a JS template
    ["-c", "echo ${CDXGEN_SPAWN_ADDITIVE-unset}"],
    { env: { ...process.env, CDXGEN_SPAWN_ADDITIVE: "kept" } },
  );
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim(), "kept");
});

it("safeSpawnSync() keeps a variable the env option dropped away from a shell child", () => {
  if (process.platform === "win32") {
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "cdxgen-spawn-env-"));
  const probe = path.join(dir, "probe.sh");
  writeFileSync(
    probe,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell default-value expansion, not a JS template
    '#!/bin/sh\necho "${CDXGEN_SPAWN_ENV_MARKER-unset}"\n',
    { mode: 0o755 },
  );
  try {
    withEnvMarker(() => {
      const result = safeSpawnSync(probe, undefined, {
        shell: true,
        env: { PATH: process.env.PATH },
      });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout.trim(), "unset");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("safeSpawnSync() reports a missing binary the way node does under every runtime", () => {
  const result = safeSpawnSync("cdxgen-no-such-binary-4788", ["--version"], {
    env: { PATH: process.env.PATH },
  });
  assert.strictEqual(result.status, null);
  assert.ok(result.error, "a missing binary must report an error");
  assert.strictEqual(result.error.code, "ENOENT");
});

it("safeSpawnSync() returns stdout as a string by default and as a Buffer for encoding buffer", () => {
  if (process.platform === "win32") {
    return;
  }
  const env = { PATH: process.env.PATH };
  const asText = safeSpawnSync("sh", ["-c", "echo hi"], { env });
  assert.strictEqual(asText.status, 0);
  assert.strictEqual(typeof asText.stdout, "string");
  assert.strictEqual(asText.stdout.trim(), "hi");
  const asBuffer = safeSpawnSync("sh", ["-c", "echo hi"], {
    env,
    encoding: "buffer",
  });
  assert.strictEqual(asBuffer.status, 0);
  assert.ok(Buffer.isBuffer(asBuffer.stdout));
  assert.strictEqual(asBuffer.stdout.toString("utf-8").trim(), "hi");
});

it("denoClearEnvSpawnSync() refuses shell arguments with metacharacters on every runtime", () => {
  // & separates commands in both a POSIX shell and cmd.exe, so the refusal
  // fires on every platform; a ; would pass the Windows metacharacter set.
  const result = denoClearEnvSpawnSync("echo", ["one&echo two"], {
    shell: true,
    env: { PATH: process.env.PATH },
  });
  assert.strictEqual(result.status, 1);
  assert.ok(result.error, "a metacharacter argument must report an error");
  assert.match(result.error.message, /metacharacters/);
});

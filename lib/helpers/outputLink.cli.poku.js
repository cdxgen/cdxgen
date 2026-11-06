import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";

// A scanned checkout can hold a bom.json that is a symbolic link to a file
// outside it. cdxgen writes its default output there, so the link must be
// replaced rather than followed, with and without the Node.js permission
// model. The project is test/data/output-symlink.

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CDXGEN = path.join(REPO_ROOT, "bin", "cdxgen.js");

function makeCheckout() {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "cdxgen-output-link-")),
  );
  const project = path.join(root, "project");
  const victim = path.join(root, "victim.txt");
  mkdirSync(project);
  copyFileSync(
    path.join(REPO_ROOT, "test", "data", "output-symlink", "package.json"),
    path.join(project, "package.json"),
  );
  writeFileSync(victim, "SENTINEL\n");
  try {
    symlinkSync(path.join("..", "victim.txt"), path.join(project, "bom.json"));
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    console.log(`Skipping the output link checks: ${err.code}`);
    return undefined;
  }
  return { project, root, victim };
}

function childEnv(extra = {}) {
  const env = { ...process.env, CDXGEN_NO_CACHE: "true", ...extra };
  // pnpm sets NODE_PATH for scripts, and secure mode stops on that finding
  // of the environment audit before it writes a BOM.
  for (const name of [
    "CDXGEN_DEBUG_MODE",
    "CDXGEN_DRY_RUN",
    "CDXGEN_TYPE",
    "NODE_PATH",
  ]) {
    if (!(name in extra)) {
      delete env[name];
    }
  }
  return env;
}

function assertLinkReplaced({ project, victim }, output) {
  assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n", output);
  const bomFile = path.join(project, "bom.json");
  assert.strictEqual(lstatSync(bomFile).isSymbolicLink(), false);
  assert.strictEqual(
    JSON.parse(readFileSync(bomFile, "utf-8")).bomFormat,
    "CycloneDX",
  );
}

it("does not write the default output through a bom.json link", () => {
  const checkout = makeCheckout();
  if (!checkout) {
    return;
  }
  try {
    const result = spawnSync(
      process.execPath,
      [CDXGEN, "--no-install-deps", "-t", "js", "."],
      { cwd: checkout.project, encoding: "utf-8", env: childEnv() },
    );
    const output = `${result.stdout}${result.stderr}`;
    assertLinkReplaced(checkout, output);
    assert.ok(output.includes("was a symbolic link"), output);
  } finally {
    rmSync(checkout.root, { recursive: true, force: true });
  }
});

it("does not write through a bom.json link under the permission model", () => {
  // Deno and Bun report process.versions.node too, but not Node's
  // permission flags.
  if (process.platform === "win32" || process.versions.bun || globalThis.Deno) {
    return;
  }
  const checkout = makeCheckout();
  if (!checkout) {
    return;
  }
  try {
    // Secure mode puts the default output in the scanned directory even
    // when cdxgen runs elsewhere, and grants writes to that one path. The
    // permission model follows links, so the grant alone does not keep the
    // write inside it.
    const tempDir = realpathSync(tmpdir());
    // Node.js 20 names the permission model --experimental-permission.
    const permissionFlag = process.allowedNodeEnvironmentFlags.has(
      "--permission",
    )
      ? "--permission"
      : "--experimental-permission";
    const result = spawnSync(
      process.execPath,
      [
        permissionFlag,
        "--allow-fs-read=*",
        `--allow-fs-write=${path.join(checkout.project, "bom.json")}`,
        `--allow-fs-write=${path.join(tempDir, "*")}`,
        "--allow-child-process",
        CDXGEN,
        "-t",
        "js",
        checkout.project,
      ],
      {
        cwd: checkout.root,
        encoding: "utf-8",
        env: childEnv({ CDXGEN_SECURE_MODE: "true" }),
      },
    );
    assertLinkReplaced(checkout, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(checkout.root, { recursive: true, force: true });
  }
});

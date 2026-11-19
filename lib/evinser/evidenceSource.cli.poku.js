import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { assert, describe, it } from "poku";

// For a git URL or purl source cdxgen scans a clone. The evidence step has to
// be given that clone too. The command-line argument names no directory, and
// it can carry the credentials of the repository, which the step would print
// and put in the name of its temporary input file.

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CDXGEN = path.join(REPO_ROOT, "bin", "cdxgen.js");

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.strictEqual(result.status, 0, result.stderr);
}

function makeWorkspace() {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "cdxgen-evidence-source-")),
  );
  const upstream = path.join(root, "upstream");
  for (const dir of ["cwd", "out", "tmp", "upstream"]) {
    mkdirSync(path.join(root, dir));
  }
  writeFileSync(
    path.join(upstream, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
  );
  git(upstream, ["init", "-q"]);
  git(upstream, ["add", "package.json"]);
  git(upstream, [
    "-c",
    "user.name=cdxgen",
    "-c",
    "user.email=cdxgen@example.com",
    "commit",
    "-q",
    "-m",
    "test",
  ]);
  // The slices are not needed, only the directory they are asked for, so atom
  // is replaced with a command that fails at once.
  const atomStub = path.join(root, "atom-stub.js");
  writeFileSync(atomStub, "process.exit(1);\n");
  return { atomStub, root, upstream };
}

function scan({ atomStub, root }, source, extraArgs = []) {
  const env = {
    ...process.env,
    ATOM_CMD: `${process.execPath} ${atomStub}`,
    CDXGEN_GIT_ALLOW_PROTOCOL: "file",
    CDXGEN_NO_CACHE: "true",
    CDXGEN_TEMP_DIR: path.join(root, "tmp"),
  };
  for (const name of [
    "CDXGEN_DEBUG_MODE",
    "CDXGEN_DRY_RUN",
    "CDXGEN_THINK_MODE",
    "CDXGEN_THOUGHT_LOG",
    "CDXGEN_TYPE",
    "NODE_PATH",
  ]) {
    delete env[name];
  }
  const result = spawnSync(
    process.execPath,
    [
      CDXGEN,
      "-t",
      "js",
      "--no-install-deps",
      "--no-include-formulation",
      "--evidence",
      ...extraArgs,
      "-o",
      path.join(root, "out", "bom.json"),
      source,
    ],
    { cwd: path.join(root, "cwd"), encoding: "utf-8", env, timeout: 120000 },
  );
  return `${result.stdout}\n${result.stderr}`;
}

function sliceDirs(output) {
  return [...output.matchAll(/slice for (.+?)\. Please wait/gu)].map(
    (match) => match[1],
  );
}

describe("cdxgen --evidence on a git URL or purl source", () => {
  it("analyzes the clone of a git URL", () => {
    if (!gitAvailable) {
      return;
    }
    const workspace = makeWorkspace();
    try {
      const url = pathToFileURL(workspace.upstream).href;
      const output = scan(workspace, url);
      const dirs = sliceDirs(output);
      assert.ok(dirs.length, output);
      for (const dir of dirs) {
        assert.ok(
          dir.startsWith(path.join(workspace.root, "tmp") + path.sep),
          output,
        );
      }
    } finally {
      rmSync(workspace.root, { recursive: true, force: true });
    }
  });

  it("keeps a purl out of the evidence log and the temporary BOM name", () => {
    if (!gitAvailable) {
      return;
    }
    const workspace = makeWorkspace();
    try {
      const url = pathToFileURL(workspace.upstream).href;
      const purl = `pkg:generic/demo@1.0.0?vcs_url=${encodeURIComponent(`git+${url}`)}`;
      // Without a CycloneDX output file the evidence step reads its input
      // from a temporary file, which must not be named after the argument.
      const output = scan(workspace, purl, ["--format", "spdx"]);
      const dirs = sliceDirs(output);
      assert.ok(dirs.length, output);
      assert.ok(!output.includes("vcs_url"), output);
      const tempNames = readdirSync(path.join(workspace.root, "tmp"));
      assert.ok(
        tempNames.some((name) => name.endsWith(".cdx.json")),
        tempNames.join("\n"),
      );
      assert.deepStrictEqual(
        tempNames.filter((name) => name.includes("vcs_url")),
        [],
      );
    } finally {
      rmSync(workspace.root, { recursive: true, force: true });
    }
  });
});

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

import { assert, it, log } from "poku";

import {
  gitLogAuthors,
  gitLogCommitsDetailed,
  gitLogTrailers,
} from "./envcontext.js";

it("verifies gitLogAuthors retrieves authors from current repository", () => {
  const authors = gitLogAuthors(process.cwd(), 50);
  assert.ok(Array.isArray(authors));
  if (authors.length > 0) {
    const first = authors[0];
    assert.ok(first.name);
    assert.ok(first.email);
  }
});

it("verifies gitLogTrailers retrieves commits from current repository", () => {
  const commits = gitLogTrailers(process.cwd(), 50);
  assert.ok(Array.isArray(commits));
  if (commits.length > 0) {
    const first = commits[0];
    assert.ok(first.hash);
    assert.ok(typeof first.message === "string");
  }
});

// gpgsm stores the certificates of a signature in the user's keyring and has
// dirmngr download the revocation list from the URL the signer's certificate
// names, so reading the log of a scanned repository must not start it.
it("does not run gpgsm for a commit with an X.509 signature", () => {
  if (process.platform === "win32") {
    log("the gpgsm stand-in is a shell script");
    return;
  }
  const workDir = mkdtempSync(join(tmpdir(), "cdxgen-git-x509-"));
  const repoDir = join(workDir, "repo");
  const binDir = join(workDir, "bin");
  const marker = join(workDir, "gpgsm-ran");
  const git = (args, input) => {
    const result = spawnSync("git", args, {
      cwd: repoDir,
      encoding: "utf-8",
      input,
    });
    assert.ok(
      result.status === 0,
      `git ${args[0]} failed: ${result.stderr || result.error}`,
    );
    return result.stdout.trim();
  };
  const originalPath = process.env.PATH;
  try {
    mkdirSync(repoDir);
    mkdirSync(binDir);
    writeFileSync(join(binDir, "gpgsm"), `#!/bin/sh\n: > '${marker}'\n`);
    chmodSync(join(binDir, "gpgsm"), 0o755);
    git(["init", "-q"]);
    const tree = git(["mktree"], "");
    const commit = git(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      [
        `tree ${tree}`,
        "author dev <dev@example.com> 0 +0000",
        "committer dev <dev@example.com> 0 +0000",
        "gpgsig -----BEGIN SIGNED MESSAGE-----",
        " AAAA",
        " -----END SIGNED MESSAGE-----",
        "",
        "initial",
        "",
      ].join("\n"),
    );
    git(["update-ref", "HEAD", commit]);
    process.env.PATH = `${binDir}${delimiter}${originalPath}`;
    const commits = gitLogCommitsDetailed(repoDir, 1);
    assert.strictEqual(commits.length, 1, "the signed commit was not read");
    assert.strictEqual(commits[0].hash, commit);
    assert.strictEqual(commits[0].signatureStatus, "N");
    assert.ok(!existsSync(marker), "git started gpgsm to verify the commit");
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { force: true, recursive: true });
  }
});

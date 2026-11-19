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
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it, log } from "poku";

import { gitLogAuthors } from "./envcontext.js";
import { buildReleaseNotesFromGit } from "./source.js";

// A scanned tree can arrive with its own .git/config. log.showSignature=true
// there makes every git log verify the commits it prints, and gpg.program
// names the verifier, so the two together run a program of the tree's choice.
// These tests run real git on such a repository.

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

function git(repoDir, args, input) {
  const result = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf-8",
    input,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// git picks the verifier from the armor line alone, so the header needs no
// real signature.
function signedCommit(repoDir, tree, parent, seconds, subject) {
  return git(
    repoDir,
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    [
      `tree ${tree}`,
      ...(parent ? [`parent ${parent}`] : []),
      `author dev <dev@example.com> ${seconds} +0000`,
      `committer dev <dev@example.com> ${seconds} +0000`,
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " -----END PGP SIGNATURE-----",
      "",
      subject,
      "",
    ].join("\n"),
  );
}

function withSignatureCheckingRepo(fn) {
  const workDir = mkdtempSync(join(tmpdir(), "cdxgen-git-signature-"));
  try {
    const repoDir = join(workDir, "repo");
    const marker = join(workDir, "verifier-ran");
    const verifier = join(workDir, "verifier.sh");
    writeFileSync(verifier, `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(verifier, 0o755);
    mkdirSync(repoDir);
    git(repoDir, ["init", "-q"]);
    const tree = git(repoDir, ["write-tree"]);
    const first = signedCommit(repoDir, tree, undefined, 1760000000, "one");
    const second = signedCommit(repoDir, tree, first, 1760000100, "fix: two");
    git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(repoDir, ["update-ref", "refs/heads/main", second]);
    git(repoDir, ["update-ref", "refs/tags/v1.0.0", first]);
    git(repoDir, ["update-ref", "refs/tags/v1.1.0", second]);
    git(repoDir, ["config", "log.showSignature", "true"]);
    git(repoDir, ["config", "gpg.program", verifier]);
    fn(repoDir, marker, second);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
}

describe("git log and a repository that asks for signature checks", () => {
  it("runs the repository's gpg.program without the hardening", () => {
    if (!gitAvailable || process.platform === "win32") {
      log("git or a POSIX shell is missing; the signature checks did not run.");
      return;
    }
    // The control: plain git starts the verifier, which is what the hardened
    // calls below must not do.
    withSignatureCheckingRepo((repoDir, marker) => {
      git(repoDir, ["log", "-1", "--format=%cI", "v1.1.0"]);
      assert.ok(existsSync(marker), "plain git log runs gpg.program");
    });
  });

  it("builds release notes without verifying signatures", () => {
    if (!gitAvailable || process.platform === "win32") {
      return;
    }
    withSignatureCheckingRepo((repoDir, marker, head) => {
      const releaseNotes = buildReleaseNotesFromGit(repoDir, {});
      assert.ok(!existsSync(marker), "gpg.program must not run");
      // A verifier's messages would otherwise sit next to the date and the
      // commit list on git's standard output.
      assert.strictEqual(Date.parse(releaseNotes.timestamp), 1760000100000);
      assert.deepStrictEqual(releaseNotes.tags, ["v1.1.0", "v1.0.0"]);
      assert.deepStrictEqual(releaseNotes.resolves, [
        {
          type: "defect",
          id: head.substring(0, 12),
          name: "fix: two",
          description: "fix: two",
        },
      ]);
    });
  });

  it("reads the commit log without verifying signatures", () => {
    if (!gitAvailable || process.platform === "win32") {
      return;
    }
    withSignatureCheckingRepo((repoDir, marker) => {
      assert.deepStrictEqual(gitLogAuthors(repoDir), [
        { name: "dev", email: "dev@example.com" },
      ]);
      assert.ok(!existsSync(marker), "gpg.program must not run");
    });
  });
});

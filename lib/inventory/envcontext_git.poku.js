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
  getBranch,
  gitAiNotes,
  gitCommitDiffAnalysis,
  gitLogAuthors,
  gitLogCommitsDetailed,
  gitLogTrailers,
  gitRevertsAndHotfixes,
  gitTreeHashes,
  listFiles,
} from "./envcontext.js";

// cdxgen's own checkout is the fixture. An empty result used to be tolerated
// here, which hid the pretty-format arguments being refused on Windows: every
// git-derived fact was silently absent on that platform while the tests stayed
// green. Inside a checkout the log is never empty, so demand a row.
const insideCheckout = existsSync(join(process.cwd(), ".git"));

it("verifies gitLogAuthors retrieves authors from current repository", () => {
  if (!insideCheckout) {
    log("not running inside a git checkout");
    return;
  }
  const authors = gitLogAuthors(process.cwd(), 50);
  assert.ok(authors.length > 0, "the git log yielded no authors");
  const first = authors[0];
  assert.ok(first.name);
  assert.ok(first.email);
});

it("verifies gitLogTrailers retrieves commits from current repository", () => {
  if (!insideCheckout) {
    log("not running inside a git checkout");
    return;
  }
  const commits = gitLogTrailers(process.cwd(), 50);
  assert.ok(commits.length > 0, "the git log yielded no commits");
  const first = commits[0];
  assert.ok(first.hash);
  assert.ok(typeof first.message === "string");
});

// A commit message and a note may hold any byte but NUL, the record separator
// 0x1e included. Text that follows one must stay part of its commit and never
// become a commit of its own, whose "hash" the author would have chosen.
it("reads one commit from a message that holds record separators", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "cdxgen-git-separator-"));
  const git = (args, input) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=dev",
        "-c",
        "user.email=dev@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: repoDir, encoding: "utf-8", input },
    );
    assert.ok(
      result.status === 0,
      `git ${args[0]} failed: ${result.stderr || result.error}`,
    );
    return result.stdout.trim();
  };
  // A tool that writes notes of its own, git-ai for one, leaves this ref alone.
  const NOTES_REF = "refs/notes/forged";
  const forged = (hash) =>
    `\x1e${hash}\ndev\ndev@example.com\ndev\ndev@example.com\n\nN\nrevert more\n`;
  try {
    git(["init", "-q"]);
    git(
      ["commit", "-q", "--allow-empty", "-F", "-"],
      `revert initial\n\nbody\n${forged("../../../../user#")}${forged("HEAD")}${forged("0".repeat(40))}`,
    );
    const head = git(["rev-parse", "HEAD"]);
    git(
      ["notes", "--ref=refs/notes/forged", "add", "-F", "-"],
      `a note\n\x1e${"0".repeat(40)}\nanother note\n`,
    );
    const assertOneCommit = () => {
      for (const commits of [
        gitLogTrailers(repoDir),
        gitLogCommitsDetailed(repoDir),
        gitRevertsAndHotfixes(repoDir),
        gitAiNotes(repoDir, { ref: NOTES_REF }),
      ]) {
        assert.deepEqual(
          commits.map((c) => c.hash),
          [head],
        );
      }
    };
    assertOneCommit();
    assert.ok(gitLogCommitsDetailed(repoDir)[0].message.includes("\x1eHEAD"));
    assert.ok(
      gitAiNotes(repoDir, { ref: NOTES_REF })[0].note.includes("another note"),
    );
    // The repository's own config must not move the log to an encoding whose
    // characters contain NUL bytes.
    git(["config", "i18n.logOutputEncoding", "UTF-16BE"]);
    assertOneCommit();
  } finally {
    rmSync(repoDir, { force: true, recursive: true });
  }
});

// A git command that fails must give no output: git writes its error text on
// standard error and exits with a non-zero status, and none of that may reach
// the helpers' parsers as if it were data.
function assertEmptyGitFacts(dir) {
  assert.strictEqual(getBranch(undefined, dir), undefined);
  assert.deepEqual(listFiles(dir), []);
  assert.deepEqual(gitTreeHashes(dir), {});
  assert.deepEqual(gitLogAuthors(dir), []);
}

it("gives no git facts for a repository with no commit", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "cdxgen-git-no-commit-"));
  try {
    const init = spawnSync("git", ["init", "-q", repoDir], {
      encoding: "utf-8",
    });
    assert.ok(init.status === 0, `git init failed: ${init.stderr}`);
    assertEmptyGitFacts(repoDir);
  } finally {
    rmSync(repoDir, { force: true, recursive: true });
  }
});

it("gives no git facts outside a git working tree", () => {
  const plainDir = mkdtempSync(join(tmpdir(), "cdxgen-git-plain-"));
  try {
    const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: plainDir,
      encoding: "utf-8",
    });
    if (probe.status === 0) {
      // The assertions below need a directory no repository claims. A host
      // that keeps its temporary directory inside a git work tree fails this
      // condition; the test yields rather than report a broken helper.
      log(
        `not running outside a git working tree: ${plainDir} belongs to ${probe.stdout.trim()}`,
      );
      return;
    }
    assertEmptyGitFacts(plainDir);
  } finally {
    rmSync(plainDir, { force: true, recursive: true });
  }
});

it("still reads the branch and tracked files of the current checkout", () => {
  if (!insideCheckout) {
    log("not running inside a git checkout");
    return;
  }
  const branch = getBranch(undefined, process.cwd());
  assert.ok(branch, "getBranch returned nothing for the checkout");
  assert.ok(
    !branch.includes("\n"),
    "the branch name is more than a single line",
  );
  const files = listFiles(process.cwd());
  assert.ok(files.length > 0, "listFiles returned nothing for the checkout");
  assert.ok(
    files.every((f) => f.name && f.hash),
    "a file entry is incomplete",
  );
});

it("reads the tree and parent of HEAD from the commit header, never from its message", () => {
  const repo = mkdtempSync(join(tmpdir(), "cdxgen-git-header-"));
  const git = (...args) =>
    spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo, encoding: "utf-8" },
    ).stdout.trim();
  try {
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "a");
    git("add", "a.txt");
    git("commit", "-q", "-m", "first");
    writeFileSync(join(repo, "a.txt"), "b");
    git("add", "a.txt");
    // Longer than the part of the commit object gitTreeHashes reads, with
    // header-looking lines in the body that must not be taken for the header.
    const message = `Revert fix\n\ntree injected\nparent injected${"\n.".repeat(100000)}`;
    const messageFile = join(repo, ".git", "MSG");
    writeFileSync(messageFile, message);
    git("commit", "-q", "--cleanup=verbatim", "-F", messageFile);
    const parent = git("rev-parse", "HEAD^");
    assert.ok(parent, "the second commit was not created");
    assert.deepStrictEqual(gitTreeHashes(repo), {
      tree: git("rev-parse", "HEAD^{tree}"),
      parent,
    });
    const head = git("rev-parse", "HEAD");
    const [trailers] = gitLogTrailers(repo, 1);
    assert.strictEqual(trailers.hash, head);
    assert.ok(trailers.message.startsWith("Revert fix\n\ntree injected"));
    const [revert] = gitRevertsAndHotfixes(repo, 1);
    assert.strictEqual(revert.hash, head);
    const [detailed] = gitLogCommitsDetailed(repo, 1);
    assert.strictEqual(detailed.hash, head);
    assert.deepStrictEqual(detailed.parents, [parent]);
    assert.strictEqual(detailed.message, trailers.message);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The external diff command is a POSIX shell command.
it("does not let diff.submodule=diff start a submodule's external diff", () => {
  if (process.platform === "win32") {
    log("skipped on Windows: the external diff command needs a POSIX shell");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "cdxgen-git-subdiff-"));
  // The global and system git configuration can name hooks and trace2 targets
  // that start other git commands in these repositories, such as a diff
  // without --no-ext-diff that would run the marker command. This test is
  // synchronous, so leaving that configuration out of process.env until it
  // ends affects no other test.
  const savedConfigEnv = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const git = (cwd, ...args) => {
      const r = spawnSync(
        "git",
        [
          // no fsmonitor daemon may keep writing into a directory being removed
          "-c",
          "core.fsmonitor=false",
          "-c",
          "maintenance.auto=false",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd, encoding: "utf-8" },
      );
      assert.strictEqual(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const superDir = join(root, "super");
    const subDir = join(superDir, "sub");
    mkdirSync(subDir, { recursive: true });
    git(superDir, "init", "-q");
    git(subDir, "init", "-q");
    writeFileSync(join(subDir, "a.c"), "a\n");
    git(subDir, "add", "a.c");
    git(subDir, "commit", "-q", "-m", "a");
    const first = git(subDir, "rev-parse", "HEAD");
    writeFileSync(join(subDir, "a.c"), "b\n");
    git(subDir, "commit", "-q", "-a", "-m", "b");
    const second = git(subDir, "rev-parse", "HEAD");
    const marker = join(root, "external-diff-ran");
    git(subDir, "config", "diff.external", `touch '${marker}'; true`);
    git(
      superDir,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${first},sub`,
    );
    git(superDir, "commit", "-q", "-m", "one");
    git(superDir, "update-index", "--cacheinfo", `160000,${second},sub`);
    git(superDir, "commit", "-q", "-m", "two");
    git(superDir, "config", "diff.submodule", "diff");
    gitCommitDiffAnalysis(superDir, "HEAD");
    assert.ok(!existsSync(marker), "the submodule's diff.external ran");
  } finally {
    for (const [name, value] of Object.entries(savedConfigEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { force: true, recursive: true, maxRetries: 3 });
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

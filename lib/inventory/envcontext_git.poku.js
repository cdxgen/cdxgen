import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it, log } from "poku";

import {
  getBranch,
  gitCommitDiffAnalysis,
  gitLogAuthors,
  gitLogTrailers,
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

// The external diff command is a POSIX shell command.
it("does not let diff.submodule=diff start a submodule's external diff", () => {
  if (process.platform === "win32") {
    log("skipped on Windows: the external diff command needs a POSIX shell");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "cdxgen-git-subdiff-"));
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
    rmSync(root, { force: true, recursive: true, maxRetries: 3 });
  }
});

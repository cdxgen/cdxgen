import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it, log } from "poku";

import {
  getBranch,
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

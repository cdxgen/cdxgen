import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

import { assert, it, log } from "poku";

import { isWin } from "../core/paths.js";
import { resetRunState } from "../core/runState.js";
import {
  getBranch,
  getOriginUrl,
  gitAiNotes,
  gitCommitDiffAnalysis,
  gitLogAuthors,
  gitLogCommitsDetailed,
  gitLogTrailers,
  gitRevertsAndHotfixes,
  gitTreeHashes,
  isOwnGitRepository,
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

// git finds renames by comparing every removed file with every added one. The
// analysis must keep that for an ordinary commit, where a moved and edited
// test file is not a deleted one, and must not let a commit that replaces many
// files by similar ones decide how many pairs git compares.
it("bounds the rename detection of gitCommitDiffAnalysis", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "cdxgen-git-renames-"));
  const git = (...args) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd: repoDir, encoding: "utf-8" },
    );
    assert.ok(result.status === 0, `git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "--no-gpg-sign", "--no-verify", "-m", message);
    return git("rev-parse", "HEAD");
  };
  // One file more than the limit on each side; all alike but for a line.
  const fileCount = 101;
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  try {
    git("init", "-q");
    for (const d of ["test", "spec", "old", "new"]) {
      mkdirSync(join(repoDir, d));
    }
    writeFileSync(join(repoDir, "test", "alpha.test.js"), `alpha\n${body}\n`);
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(repoDir, "old", `a${i}.txt`), `a${i}\n${body}\n`);
    }
    commit("initial");

    // Under the limit: the moved and edited test file is a rename.
    rmSync(join(repoDir, "test", "alpha.test.js"));
    writeFileSync(join(repoDir, "spec", "beta.spec.js"), `beta\n${body}\n`);
    const moved = gitCommitDiffAnalysis(repoDir, commit("move a test"));
    assert.deepEqual(moved.touchedFiles, ["test/alpha.test.js"]);
    assert.deepEqual(moved.testFilesDeleted, []);

    // Over the limit: the files are reported as removed and added instead of
    // being compared with each other. The test file that moved unchanged is
    // still paired, so it is not counted as deleted.
    renameSync(
      join(repoDir, "spec", "beta.spec.js"),
      join(repoDir, "spec", "gamma.spec.js"),
    );
    for (let i = 0; i < fileCount; i++) {
      rmSync(join(repoDir, "old", `a${i}.txt`));
      writeFileSync(join(repoDir, "new", `b${i}.txt`), `b${i}\n${body}\n`);
    }
    const replaced = gitCommitDiffAnalysis(repoDir, commit("replace files"));
    assert.strictEqual(replaced.touchedFiles.length, 2 * fileCount + 1);
    assert.deepEqual(replaced.testFilesDeleted, []);
  } finally {
    rmSync(repoDir, { force: true, recursive: true });
  }
});

// Which repository git reads from a directory is decided by files of that
// directory. A scanned tree must not get the facts of another repository of
// the host into the BOM by pointing its `.git` there.
function git(cwd, ...args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=cdxgen",
      "-c",
      "user.email=cdxgen@example.org",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    { cwd, encoding: "utf-8" },
  );
  assert.ok(result.status === 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function createRepo(repoDir, branch, fileName) {
  mkdirSync(join(repoDir, "pkg"), { recursive: true });
  writeFileSync(join(repoDir, "pkg", fileName), `${branch}\n`);
  git(repoDir, "init", "-q");
  git(repoDir, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-q", "-m", `${branch} commit`);
  git(repoDir, "config", "remote.origin.url", `https://example.org/${branch}`);
}

// Runs a test with console.warn collected instead of printed.
function withWarnings(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    fn(warnings);
  } finally {
    console.warn = originalWarn;
  }
}

function assertNoFactsOfOther(dir, name) {
  assert.notStrictEqual(getBranch(undefined, dir), "other", name);
  assert.notStrictEqual(getOriginUrl(dir), "https://example.org/other", name);
  assert.ok(!listFiles(dir).some((f) => f.name.endsWith("other.txt")), name);
  assert.ok(
    !gitLogTrailers(dir).some((c) => c.message.includes("other commit")),
    name,
  );
}

it("reads no git facts from a repository the directory points its .git at", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "cdxgen-git-own-"));
  try {
    const otherDir = join(baseDir, "other");
    createRepo(otherDir, "other", "other.txt");
    const otherGitDir = join(otherDir, ".git");
    const otherHead = git(otherDir, "rev-parse", "HEAD");
    // The other host repositories a pointer may name: a bare one, one with a
    // linked worktree, and a superproject with a submodule.
    git(baseDir, "clone", "-q", "--bare", otherDir, "other-bare.git");
    git(otherDir, "worktree", "add", "-q", "-b", "other-wt", "../other-wt");
    const superDir = join(baseDir, "other-super");
    mkdirSync(superDir);
    git(superDir, "init", "-q");
    git(superDir, "submodule", "add", "-q", otherDir, "sub");
    const headRef = "ref: refs/heads/other\n";
    const silentLayout = "config that stops rev-parse";
    const layouts = {
      "relative gitdir file": (dir) =>
        writeFileSync(join(dir, ".git"), "gitdir: ../other/.git\n"),
      "absolute gitdir file": (dir) =>
        writeFileSync(join(dir, ".git"), `gitdir: ${otherGitDir}\n`),
      "gitdir file naming a bare repository": (dir) =>
        writeFileSync(join(dir, ".git"), "gitdir: ../other-bare.git\n"),
      "gitdir file naming the git directory of a linked worktree": (dir) =>
        writeFileSync(
          join(dir, ".git"),
          `gitdir: ${join(otherGitDir, "worktrees", "other-wt")}\n`,
        ),
      "gitdir file naming the git directory of a submodule": (dir) =>
        writeFileSync(
          join(dir, ".git"),
          `gitdir: ${join(superDir, ".git", "modules", "sub")}\n`,
        ),
      commondir: (dir) => {
        mkdirSync(join(dir, ".git"));
        writeFileSync(join(dir, ".git", "HEAD"), headRef);
        writeFileSync(join(dir, ".git", "commondir"), "../../other/.git\n");
      },
      "commondir of a git directory that names the directory": (dir) => {
        const gitDir = join(baseDir, "gitdir-for-commondir");
        mkdirSync(gitDir);
        writeFileSync(join(dir, ".git"), `gitdir: ${gitDir}\n`);
        writeFileSync(join(gitDir, "HEAD"), headRef);
        writeFileSync(join(gitDir, "commondir"), "../other/.git\n");
        writeFileSync(join(gitDir, "gitdir"), `${join(dir, ".git")}\n`);
      },
      "core.worktree": (dir) => {
        git(dir, "init", "-q");
        git(dir, "config", "core.worktree", otherDir);
      },
      alternates: (dir) => {
        git(dir, "init", "-q");
        writeFileSync(join(dir, ".git", "HEAD"), `${otherHead}\n`);
        writeFileSync(
          join(dir, ".git", "objects", "info", "alternates"),
          `${join(otherGitDir, "objects")}\n`,
        );
      },
      "include.path": (dir) => {
        git(dir, "init", "-q");
        git(dir, "config", "include.path", join(otherGitDir, "config"));
      },
    };
    if (!isWin) {
      layouts[".git link"] = (dir) =>
        symlinkSync(otherGitDir, join(dir, ".git"));
      layouts["objects and refs links"] = (dir) => {
        mkdirSync(join(dir, ".git"));
        writeFileSync(join(dir, ".git", "HEAD"), headRef);
        for (const name of ["objects", "refs"]) {
          symlinkSync(join(otherGitDir, name), join(dir, ".git", name));
        }
      };
      layouts["pack directory and branch links"] = (dir) => {
        git(dir, "init", "-q");
        git(otherDir, "repack", "-a", "-d", "-q");
        rmSync(join(dir, ".git", "objects", "pack"), { recursive: true });
        symlinkSync(
          join(otherGitDir, "objects", "pack"),
          join(dir, ".git", "objects", "pack"),
        );
        writeFileSync(join(dir, ".git", "HEAD"), headRef);
        writeFileSync(
          join(dir, ".git", "refs", "heads", "other"),
          `${otherHead}\n`,
        );
      };
      layouts["config link"] = (dir) => {
        git(dir, "init", "-q");
        rmSync(join(dir, ".git", "config"));
        symlinkSync(join(otherGitDir, "config"), join(dir, ".git", "config"));
      };
      // A ref may name a file at the top of the git directory.
      layouts["link that a ref names"] = (dir) => {
        git(dir, "init", "-q");
        git(dir, "commit", "-q", "--allow-empty", "-m", "own");
        git(dir, "branch", "other");
        writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/probe\n");
        writeFileSync(
          join(dir, ".git", "refs", "heads", "probe"),
          "ref: ORIG_HEAD\n",
        );
        symlinkSync(join(otherGitDir, "HEAD"), join(dir, ".git", "ORIG_HEAD"));
      };
      // So may it name one below any directory there, such as a shared hooks
      // directory, which is why no entry is exempt.
      layouts["linked directory that a ref names"] = (dir) => {
        git(dir, "init", "-q");
        git(dir, "commit", "-q", "--allow-empty", "-m", "own");
        git(dir, "branch", "other");
        writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/probe\n");
        writeFileSync(
          join(dir, ".git", "refs", "heads", "probe"),
          "ref: hooks/HEAD\n",
        );
        rmSync(join(dir, ".git", "hooks"), { force: true, recursive: true });
        symlinkSync(otherGitDir, join(dir, ".git", "hooks"));
      };
      // rev-parse refuses this config, `git config` reads it all the same.
      layouts[silentLayout] = (dir) => {
        for (const name of ["objects", "refs"]) {
          mkdirSync(join(dir, ".git", name), { recursive: true });
        }
        writeFileSync(join(dir, ".git", "HEAD"), headRef);
        writeFileSync(
          join(dir, ".git", "config"),
          "[core]\n\trepositoryformatversion = 1\n\tcompression = 99\n[extensions]\n\tworktreeConfig = true\n",
        );
        symlinkSync(
          join(otherGitDir, "config"),
          join(dir, ".git", "config.worktree"),
        );
      };
      // Reading what is not a regular file may never return.
      layouts["reftable list that is a named pipe"] = (dir) => {
        git(dir, "init", "-q");
        const pipe = join(dir, ".git", "tables.list");
        assert.ok(spawnSync("mkfifo", [pipe]).status === 0, "mkfifo");
      };
      // git and the check must not read two different names out of one answer.
      layouts["common directory whose name ends in a carriage return"] = (
        dir,
      ) => {
        const commonDir = join(dir, ".git\r");
        mkdirSync(join(dir, ".git", "refs", "worktree"), { recursive: true });
        mkdirSync(commonDir);
        writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/worktree/x\n");
        writeFileSync(
          join(dir, ".git", "refs", "worktree", "x"),
          "ref: main-worktree/HEAD\n",
        );
        writeFileSync(join(dir, ".git", "commondir"), "../.git\r/\n");
        for (const name of ["HEAD", "config", "objects", "refs"]) {
          symlinkSync(join(otherGitDir, name), join(commonDir, name));
        }
      };
    }
    if (process.platform === "linux") {
      // A name that is not valid UTF-8 reads back as U+FFFD, which is the
      // name of the harmless directory next to it.
      layouts["git directory whose name is not valid UTF-8"] = (dir) => {
        const bytes = (...parts) => Buffer.concat(parts.map(Buffer.from));
        const dotGit = `${join(dir, ".git")}\n`;
        const decoy = join(dir, "c\uFFFD");
        git(dir, "init", "-q", "--bare", decoy);
        mkdirSync(join(decoy, "worktrees", "w"), { recursive: true });
        writeFileSync(join(decoy, "worktrees", "w", "gitdir"), dotGit);
        const commonDir = bytes(join(dir, "c"), [0xff]);
        const gitDir = bytes(commonDir, "/worktrees/w");
        mkdirSync(bytes(gitDir, "/refs/worktree"), { recursive: true });
        for (const name of ["HEAD", "config", "objects", "refs"]) {
          symlinkSync(join(otherGitDir, name), bytes(commonDir, "/", name));
        }
        writeFileSync(bytes(gitDir, "/commondir"), "../..\n");
        writeFileSync(bytes(gitDir, "/gitdir"), dotGit);
        writeFileSync(bytes(gitDir, "/HEAD"), "ref: refs/worktree/x\n");
        writeFileSync(
          bytes(gitDir, "/refs/worktree/x"),
          "ref: main-worktree/HEAD\n",
        );
        writeFileSync(join(dir, ".git"), bytes("gitdir: ", gitDir, "\n"));
      };
    }
    withWarnings((warnings) => {
      let index = 0;
      for (const [name, createLayout] of Object.entries(layouts)) {
        const dir = join(baseDir, `scanned-${index++}`);
        mkdirSync(join(dir, "pkg"), { recursive: true });
        createLayout(dir);
        resetRunState();
        warnings.length = 0;
        // The pointer also applies to the directories below it.
        for (const scanned of [dir, join(dir, "pkg")]) {
          assertNoFactsOfOther(scanned, name);
          assert.deepStrictEqual(gitTreeHashes(scanned), {}, name);
          assert.deepStrictEqual(gitLogAuthors(scanned), [], name);
          // include.path is closed where the config is read, so that
          // repository stays the directory's own.
          assert.strictEqual(
            isOwnGitRepository(scanned),
            name === "include.path",
            name,
          );
        }
        // A repository git cannot open is passed over like a directory
        // without one.
        assert.strictEqual(
          warnings.filter((w) => w.includes("CDXGEN_GIT_ALLOW_EXTERNAL_GITDIR"))
            .length,
          name === "include.path" || name === silentLayout ? 0 : 2,
          `${name}: one warning for each directory that is skipped`,
        );
      }
    });
  } finally {
    resetRunState();
    rmSync(baseDir, { force: true, recursive: true });
  }
});

it("does not open the repository of a submodule to diff a commit", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "cdxgen-git-own-"));
  try {
    const otherDir = join(baseDir, "other");
    createRepo(otherDir, "other", "other.txt");
    const firstCommit = git(otherDir, "rev-parse", "HEAD");
    git(otherDir, "commit", "-q", "--allow-empty", "-m", "second");
    git(otherDir, "rm", "-q", "pkg/other.txt");
    git(otherDir, "commit", "-q", "-m", "third");
    // The scanned repository moves a submodule between two commits of the
    // other repository, and asks git to show that as a diff.
    const repoDir = join(baseDir, "repo");
    mkdirSync(join(repoDir, "sub"), { recursive: true });
    git(repoDir, "init", "-q");
    const url = "https://example.org/sub.git";
    git(repoDir, "config", "-f", ".gitmodules", "submodule.sub.path", "sub");
    git(repoDir, "config", "-f", ".gitmodules", "submodule.sub.url", url);
    git(repoDir, "add", ".gitmodules");
    for (const commit of [firstCommit, git(otherDir, "rev-parse", "HEAD")]) {
      const gitlink = `160000,${commit},sub`;
      git(repoDir, "update-index", "--add", "--cacheinfo", gitlink);
      git(repoDir, "commit", "-q", "-m", "move sub");
    }
    git(repoDir, "config", "submodule.sub.url", url);
    git(repoDir, "config", "diff.submodule", "diff");
    writeFileSync(join(repoDir, "sub", ".git"), "gitdir: ../../other/.git\n");
    const analysis = gitCommitDiffAnalysis(repoDir, "HEAD");
    assert.deepStrictEqual(analysis.touchedFiles, ["sub"]);
  } finally {
    rmSync(baseDir, { force: true, recursive: true });
  }
});

it("reads a directory's own repository wherever git keeps it", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "cdxgen-git-own-"));
  try {
    const repoDir = join(baseDir, "repo");
    createRepo(repoDir, "own", "own.txt");
    const worktreeDir = join(baseDir, "worktree");
    git(repoDir, "worktree", "add", "-q", "-b", "wt", worktreeDir);
    const superDir = join(baseDir, "super");
    mkdirSync(superDir);
    git(superDir, "init", "-q");
    git(superDir, "submodule", "add", "-q", repoDir, "third_party/repo");
    const subDir = join(superDir, "third_party", "repo");
    git(subDir, "worktree", "add", "-q", "-b", "sub-wt", "../sub-worktree");
    // Links that stay inside the git directory or lead into the working
    // tree, where hooks are often kept, borrow nothing. Nor does one that
    // leads nowhere.
    const linksDir = join(baseDir, "links");
    createRepo(linksDir, "own", "own.txt");
    if (!isWin) {
      const hooksDir = join(linksDir, ".git", "hooks");
      symlinkSync(
        join("heads", "own"),
        join(linksDir, ".git", "refs", "own-link"),
      );
      rmSync(hooksDir, { force: true, recursive: true });
      mkdirSync(hooksDir);
      symlinkSync(join(linksDir, "pkg", "own.txt"), join(hooksDir, "pre-push"));
      symlinkSync(join(linksDir, "pkg", "gone"), join(hooksDir, "pre-commit"));
    }
    if (process.platform === "linux") {
      // A branch whose name is not valid UTF-8 is still only a file.
      writeFileSync(
        Buffer.concat([
          Buffer.from(join(repoDir, ".git", "refs", "heads", "caf")),
          Buffer.from([0xe9]),
        ]),
        `${git(repoDir, "rev-parse", "HEAD")}\n`,
      );
    }
    withWarnings((warnings) => {
      resetRunState();
      for (const dir of [
        repoDir,
        linksDir,
        worktreeDir,
        subDir,
        join(superDir, "third_party", "sub-worktree"),
      ]) {
        assert.ok(isOwnGitRepository(dir), dir);
        assert.ok(getBranch(undefined, dir), dir);
        assert.deepStrictEqual(
          listFiles(dir).map((f) => f.name),
          ["pkg/own.txt"],
          dir,
        );
        assert.deepStrictEqual(
          listFiles(join(dir, "pkg")).map((f) => f.name),
          ["own.txt"],
          dir,
        );
        assert.strictEqual(gitLogTrailers(dir)[0]?.message, "own commit", dir);
      }
      assert.strictEqual(getOriginUrl(worktreeDir), "https://example.org/own");
      assert.deepStrictEqual(warnings, []);
    });
  } finally {
    resetRunState();
    rmSync(baseDir, { force: true, recursive: true });
  }
});

it("reads a repository kept outside the tree only when the operator allows it", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "cdxgen-git-own-"));
  const allowed = process.env.CDXGEN_GIT_ALLOW_EXTERNAL_GITDIR;
  try {
    const repoDir = join(baseDir, "repo");
    createRepo(repoDir, "own", "own.txt");
    const sharedDir = join(baseDir, "shared-clone");
    git(baseDir, "clone", "-q", "--shared", repoDir, sharedDir);
    const separateDir = join(baseDir, "separate-clone");
    git(
      baseDir,
      "clone",
      "-q",
      "--separate-git-dir",
      join(baseDir, "separate.git"),
      repoDir,
      separateDir,
    );
    withWarnings((warnings) => {
      for (const dir of [sharedDir, separateDir]) {
        delete process.env.CDXGEN_GIT_ALLOW_EXTERNAL_GITDIR;
        resetRunState();
        warnings.length = 0;
        assert.deepStrictEqual(listFiles(dir), [], dir);
        assert.strictEqual(getBranch(undefined, dir), undefined, dir);
        assert.strictEqual(warnings.length, 1, dir);
        assert.ok(warnings[0].includes(dir), warnings[0]);
        process.env.CDXGEN_GIT_ALLOW_EXTERNAL_GITDIR = "true";
        assert.deepStrictEqual(
          listFiles(dir).map((f) => f.name),
          ["pkg/own.txt"],
          dir,
        );
        assert.strictEqual(getBranch(undefined, dir), "own", dir);
        assert.strictEqual(warnings.length, 1, dir);
      }
    });
  } finally {
    if (allowed === undefined) {
      delete process.env.CDXGEN_GIT_ALLOW_EXTERNAL_GITDIR;
    } else {
      process.env.CDXGEN_GIT_ALLOW_EXTERNAL_GITDIR = allowed;
    }
    resetRunState();
    rmSync(baseDir, { force: true, recursive: true });
  }
});

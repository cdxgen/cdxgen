import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

import { assert, it, log } from "poku";

import {
  getBranch,
  getOriginUrl,
  gitLogAuthors,
  gitLogCommitsDetailed,
  gitLogTrailers,
  gitTreeHashes,
  isOwnGitRepository,
  listFiles,
  resetSkippedGitDirs,
} from "./envcontext.js";
import { isWin } from "./utils.js";

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
        resetSkippedGitDirs();
        warnings.length = 0;
        // The pointer also applies to the directories below it.
        for (const scanned of [dir, join(dir, "pkg")]) {
          assertNoFactsOfOther(scanned, name);
          assert.deepStrictEqual(gitTreeHashes(scanned), {}, name);
          if (name !== "include.path") {
            // The include.path layout is the directory's own repository,
            // which has no commits here.
            assert.deepStrictEqual(gitLogAuthors(scanned), [], name);
          }
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
    resetSkippedGitDirs();
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
      resetSkippedGitDirs();
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
        // On Windows git runs through a shell, which refuses the log format
        // of gitLogTrailers.
        if (!isWin) {
          assert.strictEqual(
            gitLogTrailers(dir)[0]?.message,
            "own commit",
            dir,
          );
        }
      }
      assert.strictEqual(getOriginUrl(worktreeDir), "https://example.org/own");
      assert.deepStrictEqual(warnings, []);
    });
  } finally {
    resetSkippedGitDirs();
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
        resetSkippedGitDirs();
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
    resetSkippedGitDirs();
    rmSync(baseDir, { force: true, recursive: true });
  }
});

// Throwaway git repositories for tests that read git metadata.
//
// The formulation section and the envcontext git helpers read the repository
// that holds the scanned path. A test that scans a fixture inside the cdxgen
// checkout would depend on that checkout being a git working tree, which a
// copy of the sources is not, so these tests commit the files they need into
// a repository of their own.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * Run git in `dir` with a fixed identity and no signing, failing the test on
 * a non-zero exit. The global and system configuration are left out, so
 * hooks and trace2 targets configured there do not start other git commands
 * in the repository. Git for Windows also reads "/dev/null" as the null
 * device, which it does not accept in its Win32 spelling.
 *
 * @param {string} dir Working directory
 * @param {...string} args git arguments
 * @returns {string} Trimmed standard output
 */
export function git(dir, ...args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=cdxgen tests",
      "-c",
      "user.email=tests@cdxgen.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${dir}: ${result.error?.message || result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Turn `dir` into a repository on branch `main` with two commits: the first
 * holds every file in `dir`, the second is empty, so HEAD has a parent.
 *
 * @param {string} dir Directory holding the files to commit
 * @param {Object} [opts]
 * @param {string} [opts.origin] URL to register as the origin remote
 * @returns {string} `dir`
 */
export function initGitRepo(dir, opts = {}) {
  git(dir, "init", "-q", "-b", "main");
  if (opts.origin) {
    git(dir, "remote", "add", "origin", opts.origin);
  }
  git(dir, "add", "--all");
  git(dir, "commit", "-q", "--no-verify", "-m", "Add the fixture");
  git(dir, "commit", "-q", "--no-verify", "--allow-empty", "-m", "Second commit");
  return dir;
}

/**
 * Copy a fixture directory into a new temporary repository.
 *
 * @param {string} fixtureDir Directory to copy
 * @param {string} prefix Prefix of the temporary directory name
 * @returns {{ dir: string, cleanup: () => void }} The repository and a
 *   function that removes it
 */
export function copyIntoGitRepo(fixtureDir, prefix = "cdxgen-git-fixture-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(fixtureDir, dir, { recursive: true });
  initGitRepo(dir);
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

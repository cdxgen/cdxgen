import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { checkoutClonedRepository } from "./source.js";

// git stores a blob or a tree once however often a tree names it, so a pack
// of a few kilobytes can stand for any number of files. These tests run real
// git on such a repository: it is cloned with --no-checkout, the way
// gitClone() and the predictive audit clone, and then handed to
// checkoutClonedRepository().

const LIMIT_ENV_NAMES = [
  "CDXGEN_GIT_MAX_CHECKOUT_BYTES",
  "CDXGEN_GIT_MAX_CHECKOUT_FILES",
];

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

function git(cwd, args, input) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", input });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * Create a repository whose tree is `data/d<n>/f<n>` for the given number of
 * directories and files, every file being the same blob and every directory
 * the same tree, and clone it without checking it out.
 *
 * @param {string} baseDir directory to work in
 * @param {Object} shape content of the repository
 * @returns {string} the clone
 */
function cloneWithoutCheckout(baseDir, shape) {
  const upstream = path.join(baseDir, "upstream");
  const cloneDir = path.join(baseDir, "clone");
  git(baseDir, ["init", "-q", upstream]);
  if (shape) {
    const mktree = (entries) =>
      git(upstream, ["mktree"], entries.map((entry) => `${entry}\n`).join(""));
    const blob = git(upstream, ["hash-object", "-w", "--stdin"], shape.content);
    const directory = mktree(
      Array.from(
        { length: shape.files },
        (_, index) => `100644 blob ${blob}\tf${index}`,
      ),
    );
    const rootEntries = Array.from(
      { length: shape.directories },
      (_, index) => `040000 tree ${directory}\td${index}`,
    );
    if (shape.attributes) {
      const attributes = git(
        upstream,
        ["hash-object", "-w", "--stdin"],
        shape.attributes,
      );
      rootEntries.unshift(`100644 blob ${attributes}\t.gitattributes`);
    }
    const commit = git(upstream, [
      "-c",
      "user.name=cdxgen",
      "-c",
      "user.email=cdxgen@example.com",
      "commit-tree",
      mktree(rootEntries),
      "-m",
      "test",
    ]);
    git(upstream, ["update-ref", "HEAD", commit]);
  }
  git(baseDir, [
    "clone",
    "-q",
    "--template=",
    "--no-checkout",
    upstream,
    cloneDir,
  ]);
  return cloneDir;
}

function withClone(shape, limits, fn, options = {}) {
  if (!gitAvailable) {
    console.log("git is not installed; the checkout checks did not run.");
    return;
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdxgen-checkout-"));
  const saved = Object.fromEntries(
    LIMIT_ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  for (const name of LIMIT_ENV_NAMES) {
    delete process.env[name];
  }
  Object.assign(process.env, limits);
  try {
    const cloneDir = cloneWithoutCheckout(baseDir, shape);
    fn(cloneDir, checkoutClonedRepository(cloneDir, options));
  } finally {
    for (const name of LIMIT_ENV_NAMES) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    fs.rmSync(baseDir, {
      force: true,
      recursive: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

// 100 names for one blob of 64 KiB: 6.4 MiB of files from one small pack.
const MANY_NAMES = { content: "A".repeat(65536), directories: 10, files: 10 };

describe("checkoutClonedRepository()", () => {
  it("checks out a tree that is within the ceilings", () => {
    withClone(MANY_NAMES, {}, (cloneDir, result) => {
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.readdirSync(cloneDir).length, 11);
      assert.strictEqual(
        fs.statSync(path.join(cloneDir, "d9", "f9")).size,
        65536,
      );
    });
  });

  it("applies the default ceilings to the server only", () => {
    // 1100 names for one blob of 1 MiB stand for more than 1 GiB.
    const huge = { content: "A".repeat(1048576), directories: 1, files: 1100 };
    withClone(
      huge,
      {},
      (cloneDir, result) => {
        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /1153433600 bytes/);
        assert.deepStrictEqual(fs.readdirSync(cloneDir), [".git"]);
      },
      { forServer: true },
    );
  });

  it("refuses a tree that holds more bytes than the ceiling before writing any of it", () => {
    withClone(
      MANY_NAMES,
      { CDXGEN_GIT_MAX_CHECKOUT_BYTES: "1048576" },
      (cloneDir, result) => {
        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /110 files and directories/);
        assert.match(result.stderr, /6553600 bytes/);
        assert.match(result.stderr, /CDXGEN_GIT_MAX_CHECKOUT_BYTES/);
        assert.deepStrictEqual(fs.readdirSync(cloneDir), [".git"]);
      },
    );
  });

  it("refuses a tree that names more files and directories than the ceiling", () => {
    // The files are empty, so only their number can stop the checkout.
    withClone(
      { content: "", directories: 10, files: 10 },
      { CDXGEN_GIT_MAX_CHECKOUT_FILES: "100" },
      (cloneDir, result) => {
        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /110 files and directories/);
        assert.deepStrictEqual(fs.readdirSync(cloneDir), [".git"]);
      },
    );
  });

  it("writes the files as the blobs hold them, whatever .gitattributes asks for", () => {
    // Keyword expansion and CRLF line endings would otherwise write more
    // bytes than were measured.
    const content = "$Id$\n".repeat(1000);
    withClone(
      {
        attributes: "* text eol=crlf ident\n",
        content,
        directories: 1,
        files: 1,
      },
      {},
      (cloneDir, result) => {
        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(
          fs.readFileSync(path.join(cloneDir, "d0", "f0"), "utf-8"),
          content,
        );
      },
    );
  });

  it("has nothing to check out in a repository without a commit", () => {
    withClone(undefined, {}, (cloneDir, result) => {
      assert.strictEqual(result.status, 0, result.stderr);
      assert.deepStrictEqual(fs.readdirSync(cloneDir), [".git"]);
    });
  });
});

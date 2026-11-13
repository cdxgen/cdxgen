import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import {
  isExistingPathInsideProject,
  isLinkedOutsideProject,
  isPathInsideProject,
  isRealPathInsideProject,
} from "./lockPaths.js";

// A junction needs no extra privilege on Windows, unlike a directory symlink.
const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

describe("isPathInsideProject", () => {
  const root = resolve("cdxgen-lockpath-project");

  it("accepts relative and absolute paths inside the project", () => {
    assert.strictEqual(isPathInsideProject("packages/foo", root), true);
    assert.strictEqual(isPathInsideProject("./packages/foo", root), true);
    assert.strictEqual(isPathInsideProject("a/../b", root), true);
    // a name that merely starts with dots is a normal file name
    assert.strictEqual(isPathInsideProject("...foo", root), true);
    assert.strictEqual(
      isPathInsideProject(join(root, "vendor", "x"), root),
      true,
    );
    // the project root itself
    assert.strictEqual(isPathInsideProject(".", root), true);
    assert.strictEqual(isPathInsideProject(root, root), true);
  });

  it("rejects escapes, foreign absolute paths, and junk", () => {
    assert.strictEqual(isPathInsideProject("../outside", root), false);
    assert.strictEqual(isPathInsideProject("..", root), false);
    assert.strictEqual(
      isPathInsideProject("packages/../../outside", root),
      false,
    );
    assert.strictEqual(
      isPathInsideProject(join("..", "..", "..", "tmp", "evil"), root),
      false,
    );
    assert.strictEqual(
      isPathInsideProject(resolve(root, "..", "sibling"), root),
      false,
    );
    // a sibling whose name extends the root's name is still outside
    assert.strictEqual(isPathInsideProject(`${root}-evil`, root), false);
    assert.strictEqual(isPathInsideProject("evil\0target", root), false);
    assert.strictEqual(isPathInsideProject("", root), false);
    assert.strictEqual(isPathInsideProject(undefined, root), false);
  });

  if (process.platform === "win32") {
    it("rejects a path on another Windows drive", () => {
      const otherDrive = root.toUpperCase().startsWith("Z:")
        ? "Y:\\x"
        : "Z:\\x";
      assert.strictEqual(isPathInsideProject(otherDrive, root), false);
    });
  }
});

describe("isExistingPathInsideProject", () => {
  it("accepts only a path that exists inside the project, symlinks resolved", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-lockpath-real-"));
    try {
      const root = join(tempDir, "project");
      const outside = join(tempDir, "outside");
      mkdirSync(join(root, "src", "Api"), { recursive: true });
      mkdirSync(outside);
      assert.strictEqual(isExistingPathInsideProject(root, root), true);
      assert.strictEqual(
        isExistingPathInsideProject(join(root, "src", "Api"), root),
        true,
      );
      assert.strictEqual(isExistingPathInsideProject("src/Api", root), true);
      // Inside but absent: nothing to use
      assert.strictEqual(
        isExistingPathInsideProject(join(root, "src", "Missing"), root),
        false,
      );
      // Outside the project, whether or not the path exists, the answer is
      // the same, so nothing about the host is revealed
      assert.strictEqual(isExistingPathInsideProject(outside, root), false);
      assert.strictEqual(
        isExistingPathInsideProject(join(tempDir, "missing"), root),
        false,
      );
      assert.strictEqual(
        isExistingPathInsideProject("../outside", root),
        false,
      );
      if (process.platform !== "win32") {
        // A symlink in the tree that leads out of it is outside as well
        symlinkSync(outside, join(root, "link"));
        assert.strictEqual(
          isExistingPathInsideProject(join(root, "link"), root),
          false,
        );
        assert.strictEqual(
          isExistingPathInsideProject("link/../../outside", root),
          false,
        );
        // One that stays inside is fine
        symlinkSync(join(root, "src"), join(root, "alias"));
        assert.strictEqual(
          isExistingPathInsideProject(join(root, "alias", "Api"), root),
          true,
        );
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("isRealPathInsideProject", () => {
  it("follows symbolic links before deciding", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cdxgen-lockpath-"));
    try {
      const root = join(tmpRoot, "project");
      mkdirSync(join(root, "node_modules", "inside"), { recursive: true });
      mkdirSync(join(tmpRoot, "outside"));
      symlinkSync(
        join(tmpRoot, "outside"),
        join(root, "node_modules", "escape"),
        DIR_LINK_TYPE,
      );
      symlinkSync(
        join(root, "node_modules", "inside"),
        join(root, "node_modules", "alias"),
        DIR_LINK_TYPE,
      );
      assert.strictEqual(
        isRealPathInsideProject("node_modules/inside", root),
        true,
      );
      assert.strictEqual(
        isRealPathInsideProject("node_modules/alias", root),
        true,
      );
      assert.strictEqual(isRealPathInsideProject(root, root), true);
      // lexically inside, really outside
      assert.strictEqual(
        isRealPathInsideProject(join(root, "node_modules", "escape"), root),
        false,
      );
      assert.strictEqual(
        isRealPathInsideProject("node_modules/escape/package.json", root),
        false,
      );
      // lexically outside, or not there at all
      assert.strictEqual(isRealPathInsideProject("../outside", root), false);
      assert.strictEqual(
        isRealPathInsideProject("node_modules/missing", root),
        false,
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("isLinkedOutsideProject", () => {
  it("flags an in-project path that reaches outside through a link", () => {
    const work = mkdtempSync(join(tmpdir(), "cdxgen-lockpath-linked-"));
    try {
      const root = join(work, "project");
      const outside = join(work, "outside");
      mkdirSync(join(root, "packages", "a"), { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, join(root, "packages", "b"), DIR_LINK_TYPE);
      assert.strictEqual(isLinkedOutsideProject("packages/b", root), true);
      assert.strictEqual(isLinkedOutsideProject("packages/a", root), false);
      // Missing paths and paths outside as written are left to the lexical test.
      assert.strictEqual(isLinkedOutsideProject("packages/c", root), false);
      assert.strictEqual(isLinkedOutsideProject("../outside", root), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

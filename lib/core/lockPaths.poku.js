import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { isPathInsideProject, isRealPathInsideProject } from "./lockPaths.js";

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

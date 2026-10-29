import { join, resolve } from "node:path";

import { assert, describe, it } from "poku";

import { isPathInsideProject } from "./lockPaths.js";

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

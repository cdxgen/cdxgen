import { join, resolve, sep } from "node:path";

import { assert, describe, it } from "poku";

import { isSafeLockfilePath } from "./lockPaths.js";

describe("isSafeLockfilePath", () => {
  const root = resolve("/tmp/cdxgen-lockpath-project");

  it("accepts safe relative paths inside the project", () => {
    assert.strictEqual(isSafeLockfilePath("packages/foo", root), true);
    assert.strictEqual(isSafeLockfilePath("packages/foo/bar", root), true);
    assert.strictEqual(isSafeLockfilePath("./packages/foo", root), true);
    assert.strictEqual(isSafeLockfilePath("a/../b", root), true);
    // a name that merely starts with dots is a normal file name
    assert.strictEqual(isSafeLockfilePath("...foo", root), true);
    assert.strictEqual(isSafeLockfilePath("foo.tgz", root), true);
  });

  it("rejects escapes, absolutes, drive letters, and junk", () => {
    assert.strictEqual(isSafeLockfilePath("../outside", root), false);
    assert.strictEqual(
      isSafeLockfilePath("../../../../../../tmp/evil-target2", root),
      false,
    );
    assert.strictEqual(
      isSafeLockfilePath("packages/../../outside", root),
      false,
    );
    assert.strictEqual(isSafeLockfilePath("/etc/passwd", root), false);
    assert.strictEqual(isSafeLockfilePath("\\Windows\\temp", root), false);
    assert.strictEqual(
      isSafeLockfilePath("\\\\server\\share\\pkg", root),
      false,
    );
    assert.strictEqual(
      isSafeLockfilePath("C:\\Windows\\temp\\pkg", root),
      false,
    );
    assert.strictEqual(isSafeLockfilePath("C:Windows", root), false);
    assert.strictEqual(isSafeLockfilePath("evil\0target", root), false);
    assert.strictEqual(isSafeLockfilePath("", root), false);
    assert.strictEqual(isSafeLockfilePath(undefined, root), false);
    // the root itself is not a usable link target
    assert.strictEqual(isSafeLockfilePath(".", root), false);
  });

  it("honours the given project root", () => {
    assert.strictEqual(isSafeLockfilePath(join("packages", "foo"), root), true);
    assert.strictEqual(
      isSafeLockfilePath("pkg", resolve(root, "packages")),
      true,
    );
    // a sibling of the project root is outside it
    assert.strictEqual(isSafeLockfilePath(`..${sep}other`, root), false);
  });
});

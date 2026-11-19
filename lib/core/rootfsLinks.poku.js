import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import {
  isSameInRootfs,
  resolveInRootfs,
  rootfsEntryPath,
  rootfsReadPath,
} from "./rootfsLinks.js";

// Creating symbolic links needs a privilege on Windows runners.
const canLink = process.platform !== "win32";

function withRoot(callback) {
  const workDir = mkdtempSync(join(tmpdir(), "cdxgen-rootfs-links-"));
  try {
    const root = join(workDir, "root");
    mkdirSync(root, { recursive: true });
    callback(root, workDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

describe("resolveInRootfs()", () => {
  it("reads an absolute link target from the root of the image", () => {
    if (!canLink) {
      return;
    }
    withRoot((root) => {
      mkdirSync(join(root, "bin"), { recursive: true });
      mkdirSync(join(root, "usr", "bin"), { recursive: true });
      writeFileSync(join(root, "bin", "sh"), "shell");
      symlinkSync("/bin/sh", join(root, "usr", "bin", "sh"));
      const resolved = resolveInRootfs(root, "usr/bin/sh");
      assert.ok(resolved);
      assert.ok(resolved.endsWith(join("bin", "sh")));
      assert.ok(!resolved.endsWith(join("usr", "bin", "sh")));
    });
  });

  it("never resolves to the host", () => {
    if (!canLink) {
      return;
    }
    withRoot((root, workDir) => {
      mkdirSync(join(workDir, "host"), { recursive: true });
      writeFileSync(join(workDir, "host", "secret"), "host");
      symlinkSync(join(workDir, "host"), join(root, "etc"));
      symlinkSync("/", join(root, "node_modules"));
      symlinkSync("../../../../host", join(root, "up"));
      // The image has no such directory, so there is nothing to read.
      assert.strictEqual(resolveInRootfs(root, "etc/secret"), undefined);
      assert.strictEqual(
        resolveInRootfs(root, "node_modules/host/secret"),
        undefined,
      );
      assert.strictEqual(resolveInRootfs(root, "up/secret"), undefined);
      // The root stands in for "/", so the link leads back into the image.
      const resolved = resolveInRootfs(root, "node_modules");
      assert.ok(resolved);
      assert.strictEqual(resolved, resolveInRootfs(root, ""));
      assert.ok(!existsSync(rootfsReadPath(root, "etc/secret")));
    });
  });

  it("stops at links that loop and at the hop limit", () => {
    if (!canLink) {
      return;
    }
    withRoot((root) => {
      symlinkSync("b", join(root, "a"));
      symlinkSync("a", join(root, "b"));
      assert.strictEqual(resolveInRootfs(root, "a"), undefined);
      mkdirSync(join(root, "d"));
      symlinkSync("d", join(root, "l0"));
      symlinkSync("l0", join(root, "l1"));
      symlinkSync("l1", join(root, "l2"));
      assert.ok(resolveInRootfs(root, "l2"));
      assert.strictEqual(resolveInRootfs(root, "l2", 2), undefined);
    });
  });

  it("answers a path of plain directories without links", () => {
    withRoot((root) => {
      mkdirSync(join(root, "usr", "lib"), { recursive: true });
      const resolved = resolveInRootfs(root, "/usr/lib/../lib/");
      assert.ok(resolved?.endsWith(join("usr", "lib")));
      assert.strictEqual(resolveInRootfs(root, "usr/missing"), undefined);
      assert.ok(isSameInRootfs(root, join(root, "usr", "lib")));
    });
  });

  it("keeps the last link of an entry and resolves its directory", () => {
    if (!canLink) {
      return;
    }
    withRoot((root) => {
      mkdirSync(join(root, "usr", "bin"), { recursive: true });
      writeFileSync(join(root, "usr", "bin", "tool"), "tool");
      symlinkSync("usr/bin", join(root, "bin"));
      symlinkSync("tool", join(root, "usr", "bin", "alias"));
      const entry = rootfsEntryPath(root, "bin/alias");
      assert.ok(entry.endsWith(join("usr", "bin", "alias")));
      assert.ok(isSameInRootfs(root, join(root, "bin")));
    });
  });
});

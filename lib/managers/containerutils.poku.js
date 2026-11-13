import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { getOnlyDirs, getOnlyDirsMulti } from "./containerutils.js";

// chmod is a no-op for the superuser and unsupported on Windows
const canTestUnreadableDirs =
  process.platform !== "win32" &&
  typeof process.getuid === "function" &&
  process.getuid() !== 0;

function withUnreadableDir(fn) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-eacces-"));
  const readable = join(root, "readable");
  const unreadable = join(root, "unreadable");
  mkdirSync(join(readable, "node_modules"), { recursive: true });
  mkdirSync(join(unreadable, "node_modules"), { recursive: true });
  chmodSync(unreadable, 0o000);
  try {
    fn(root, readable, unreadable);
  } finally {
    chmodSync(unreadable, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("directory walks with unreadable directories", () => {
  it("getOnlyDirs skips directories that cannot be read", () => {
    if (!canTestUnreadableDirs) {
      return;
    }
    withUnreadableDir((root, readable) => {
      const dirs = getOnlyDirs(root, "node_modules");
      assert.deepStrictEqual(dirs, [join(readable, "node_modules")]);
    });
  });

  // Bug #4310: an unreadable path passed in directly, such as /root when
  // generating an OBOM as a non-root user
  it("getOnlyDirs tolerates an unreadable root path", () => {
    if (!canTestUnreadableDirs) {
      return;
    }
    withUnreadableDir((_root, _readable, unreadable) => {
      assert.deepStrictEqual(getOnlyDirs(unreadable, "node_modules"), []);
      assert.deepStrictEqual(
        getOnlyDirsMulti(unreadable, ["node_modules"]).node_modules,
        [],
      );
    });
  });

  it("getOnlyDirsMulti skips directories that cannot be read", () => {
    if (!canTestUnreadableDirs) {
      return;
    }
    withUnreadableDir((root, readable) => {
      const dirs = getOnlyDirsMulti(root, ["node_modules", "site-packages"]);
      assert.deepStrictEqual(dirs.node_modules, [
        join(readable, "node_modules"),
      ]);
      assert.deepStrictEqual(dirs["site-packages"], []);
    });
  });
});

// Every collected directory becomes a scan path that is searched recursively,
// so a chain of nested matches must not turn into one scan path per level.
describe("directory walks with nested matches", () => {
  it("do not collect a match that lies inside a match of the same name", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-nested-"));
    try {
      const cargo = join(root, "opt", ".cargo");
      const sitePackages = join(cargo, "site-packages");
      mkdirSync(join(sitePackages, ".cargo", "site-packages", "x", ".cargo"), {
        recursive: true,
      });
      mkdirSync(join(root, "opt", "other", ".cargo"), { recursive: true });
      const dirs = getOnlyDirsMulti(root, [".cargo", "site-packages"]);
      assert.deepStrictEqual(dirs[".cargo"].sort(), [
        cargo,
        join(root, "opt", "other", ".cargo"),
      ]);
      assert.deepStrictEqual(dirs["site-packages"], [sitePackages]);
      assert.deepStrictEqual(getOnlyDirs(root, "site-packages"), [
        sitePackages,
      ]);
      assert.deepStrictEqual(getOnlyDirs(cargo, ".cargo"), [cargo]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

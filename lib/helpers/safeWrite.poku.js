import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import { safeWriteSync } from "./utils.js";

/**
 * Run a check in a temporary directory holding a "victim" file outside a
 * "project" directory, the layout of a scanned checkout whose bom.json is a
 * symbolic link. Returns early, with a note, where the platform refuses to
 * create the link; a checkout there cannot contain one either.
 */
function withLinkedOutput(linkTarget, check, type = undefined) {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-write-link-"));
  const originalWarn = console.warn;
  const warnings = [];
  try {
    const project = path.join(root, "project");
    const victim = path.join(root, "victim.txt");
    mkdirSync(project);
    writeFileSync(victim, "SENTINEL\n");
    const output = path.join(project, "bom.json");
    try {
      symlinkSync(linkTarget(root, victim), output, type);
    } catch (err) {
      console.log(`Skipping a symbolic link check: ${err.code}`);
      return;
    }
    console.warn = (message) => warnings.push(message);
    check({ output, project, root, victim, warnings });
  } finally {
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
}

it("safeWriteSync() replaces a link to another file instead of writing to it", () => {
  withLinkedOutput(
    (_root, victim) => victim,
    ({ output, victim, warnings }) => {
      safeWriteSync(output, '{"bomFormat":"CycloneDX"}');
      assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n");
      assert.strictEqual(lstatSync(output).isSymbolicLink(), false);
      assert.strictEqual(
        readFileSync(output, "utf-8"),
        '{"bomFormat":"CycloneDX"}',
      );
      assert.ok(warnings.some((w) => w.includes("was a symbolic link")));
    },
  );
});

it("safeWriteSync() follows no relative link out of the directory", () => {
  withLinkedOutput(
    () => path.join("..", "victim.txt"),
    ({ output, victim }) => {
      safeWriteSync(output, "bom", "utf-8");
      assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n");
      assert.strictEqual(readFileSync(output, "utf-8"), "bom");
    },
  );
});

it("safeWriteSync() does not create the target of a dangling link", () => {
  withLinkedOutput(
    (root) => path.join(root, "created-by-link.txt"),
    ({ output, root }) => {
      safeWriteSync(output, "bom");
      assert.strictEqual(
        existsSync(path.join(root, "created-by-link.txt")),
        false,
      );
      assert.strictEqual(readFileSync(output, "utf-8"), "bom");
    },
  );
});

it("safeWriteSync() replaces a link to a directory", () => {
  withLinkedOutput(
    (root) => {
      mkdirSync(path.join(root, "elsewhere"));
      return path.join(root, "elsewhere");
    },
    ({ output, root }) => {
      safeWriteSync(output, "bom");
      assert.deepStrictEqual(readdirSync(path.join(root, "elsewhere")), []);
      assert.strictEqual(statSync(output).isFile(), true);
    },
    "junction",
  );
});

it("safeWriteSync() appends to a new file in place of a link", () => {
  withLinkedOutput(
    (_root, victim) => victim,
    ({ output, victim }) => {
      safeWriteSync(output, "appended\n", { flag: "a" });
      assert.strictEqual(readFileSync(victim, "utf-8"), "SENTINEL\n");
      assert.strictEqual(readFileSync(output, "utf-8"), "appended\n");
    },
  );
});

it("safeWriteSync() still truncates, appends and sets modes on regular files", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-write-plain-"));
  try {
    const target = path.join(tempDir, "out.json");
    writeFileSync(target, "a much longer previous content");
    safeWriteSync(target, "short");
    assert.strictEqual(readFileSync(target, "utf-8"), "short");
    safeWriteSync(target, "+more", { flag: "a" });
    assert.strictEqual(readFileSync(target, "utf-8"), "short+more");
    safeWriteSync(target, Buffer.from("bytes"));
    assert.strictEqual(readFileSync(target, "utf-8"), "bytes");
    assert.throws(() => safeWriteSync(target, "x", { flag: "wx" }), {
      code: "EEXIST",
    });
    const privateFile = path.join(tempDir, "private.key");
    safeWriteSync(privateFile, "key", { mode: 0o600 });
    if (process.platform !== "win32") {
      assert.strictEqual(statSync(privateFile).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("safeWriteSync() writes through device paths such as /dev/null", () => {
  if (process.platform === "win32") {
    return;
  }
  safeWriteSync("/dev/null", "discarded");
  assert.strictEqual(statSync("/dev/null").isCharacterDevice(), true);
});

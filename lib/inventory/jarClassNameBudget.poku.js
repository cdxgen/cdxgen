import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, it } from "poku";

import { resetRunState } from "../core/runState.js";
import { getJarClasses } from "./deps.js";

// The class names kept for a run are counted in module state, so this file
// holds one sequential test.

/**
 * Write a stored zip archive of empty entries with the given names.
 *
 * @param {string} out Path of the archive to write.
 * @param {string[]} names Entry names.
 * @returns {void}
 */
function writeEmptyEntriesZip(out, names) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const nameBuf = Buffer.from(name, "utf-8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(out, Buffer.concat([...locals, centralBuf, end]));
}

it("getJarClasses stops listing names once the run holds its share", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-jar-run-classes-"));
  const first = path.join(root, "first-1.0.jar");
  const second = path.join(root, "second-1.0.jar");
  // Each name is 17 characters as an entry name.
  const names = ["org/ex/Lib1.class", "org/ex/Lib2.class", "org/ex/Lib3.class"];
  writeEmptyEntriesZip(first, names);
  writeEmptyEntriesZip(second, names);
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    resetRunState();
    const limits = { maxRunClassNamesLength: 40 };
    assert.deepStrictEqual(await getJarClasses(first, limits), [
      "org.ex.Lib1",
      "org.ex.Lib2",
    ]);
    // What the first jar kept is spent: 34 of 40 characters.
    assert.deepStrictEqual(await getJarClasses(second, limits), []);
    assert.strictEqual(warnings.length, 1);
    // A new run starts with the whole share.
    resetRunState();
    assert.strictEqual((await getJarClasses(second, limits)).length, 2);
  } finally {
    console.warn = warn;
    resetRunState();
    rmSync(root, { force: true, recursive: true });
  }
});

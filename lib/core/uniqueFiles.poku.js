import {
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { uniqueFiles } from "./uniqueFiles.js";

function withDirectory(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-unique-files-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe("uniqueFiles()", () => {
  it("keeps one path for hard links and repeated paths", () =>
    withDirectory((dir) => {
      const file = join(dir, "Jenkinsfile");
      const other = join(dir, "Jenkinsfile.other");
      writeFileSync(file, "pipeline {}");
      writeFileSync(other, "pipeline {}");
      linkSync(file, join(dir, "Jenkinsfile.hard"));
      assert.deepStrictEqual(
        uniqueFiles([
          file,
          join(dir, "Jenkinsfile.hard"),
          file,
          other,
          join(dir, "missing"),
          join(dir, "missing"),
        ]),
        [file, other, join(dir, "missing")],
      );
    }));

  it("keeps one path for symbolic links and prefers the file itself", () =>
    withDirectory((dir) => {
      const file = join(dir, "README.md");
      writeFileSync(file, "# demo");
      const links = [];
      for (const name of ["a.md", "b.md"]) {
        try {
          symlinkSync("README.md", join(dir, name));
          links.push(join(dir, name));
        } catch {
          // Creating a symbolic link needs a privilege on Windows.
        }
      }
      assert.deepStrictEqual(uniqueFiles([...links, file]), [file]);
      assert.deepStrictEqual(uniqueFiles(undefined), []);
    }));
});

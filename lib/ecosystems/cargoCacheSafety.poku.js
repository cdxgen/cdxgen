import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

import { assert, it } from "poku";

import {
  readCargoCacheMetadata,
  readCrateArchiveValues,
  resetCargoCacheState,
} from "./cargoCache.js";

// A crate's manifest is its author's, so its license-file must not reach
// outside the crate, and a .crate archive must not unpack without bound.
// CARGO_HOME is process-wide, so this file holds one sequential test.

it("the Cargo cache reads only inside a crate, within bounds", async () => {
  const previousCargoHome = process.env.CARGO_HOME;
  const root = mkdtempSync(join(tmpdir(), "cdxgen-cargo-safety-"));
  try {
    const crateDir = join(
      root,
      "registry",
      "src",
      "index.crates.io-0000000000000000",
    );
    for (const [name, licenseFile] of [
      ["escapes", "../../../../secret.txt"],
      ["absolute", join(root, "secret.txt")],
      ["inside", "LICENSE-OTHER"],
    ]) {
      const dir = join(crateDir, `${name}-1.0.0`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "Cargo.toml"),
        `[package]\nname = "${name}"\nversion = "1.0.0"\ndescription = "d"\nlicense-file = ${JSON.stringify(licenseFile)}\n`,
      );
      writeFileSync(join(dir, "LICENSE-OTHER"), "the crate's own notice");
    }
    writeFileSync(join(root, "secret.txt"), "not the crate's");
    process.env.CARGO_HOME = root;
    resetCargoCacheState();

    for (const name of ["escapes", "absolute"]) {
      const local = await readCargoCacheMetadata(name, "1.0.0");
      assert.strictEqual(local.description, "d", name);
      assert.strictEqual(local.licenses, undefined, name);
    }
    const inside = await readCargoCacheMetadata("inside", "1.0.0");
    assert.strictEqual(
      inside.licenses[0].license.text.content,
      "the crate's own notice",
    );

    // An archive that unpacks past the bound is not read.
    const bomb = join(root, "bomb-1.0.0.crate");
    writeFileSync(bomb, gzipSync(Buffer.alloc(65 * 1024 * 1024)));
    assert.strictEqual(
      await readCrateArchiveValues(bomb, "bomb", "1.0.0"),
      undefined,
    );
  } finally {
    if (previousCargoHome === undefined) {
      delete process.env.CARGO_HOME;
    } else {
      process.env.CARGO_HOME = previousCargoHome;
    }
    resetCargoCacheState();
    rmSync(root, { force: true, recursive: true });
  }
});

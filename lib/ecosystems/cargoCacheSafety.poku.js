import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import zlib, { gunzipSync, gzipSync } from "node:zlib";

import { assert, it } from "poku";
import { Pax, Header as TarHeader } from "tar";

import {
  readCargoCacheMetadata,
  readCrateArchiveValues,
  resetCargoCacheState,
} from "./cargoCache.js";

// A crate's manifest is its author's, so its license-file must not reach
// outside the crate, and a .crate archive must not unpack without bound.
// CARGO_HOME is process-wide, so this file holds one sequential test.

const CRATE_FILE = join(
  import.meta.dirname,
  "../../test/data/cargo-local-first/registry/cache/index.crates.io-1949cf8c6b5b557f/rustls-webpki-0.103.13.crate",
);

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

    // The name and version are the scanned project's, so neither may move the
    // lookup out of the registry, whether to a manifest or to an index file.
    const planted = join(root, "planted", "crate-1.0.0");
    mkdirSync(planted, { recursive: true });
    writeFileSync(
      join(planted, "Cargo.toml"),
      '[package]\nname = "crate"\nversion = "1.0.0"\nlicense = "MIT"\n',
    );
    writeFileSync(join(root, "planted", "index"), '{"vers":"1.0.0"}');
    mkdirSync(join(root, "registry", "index", "index.crates.io-0"), {
      recursive: true,
    });
    resetCargoCacheState();
    for (const [name, version] of [
      ["inside", "1/../../../../planted/crate-1.0.0"],
      ["inside", "1\\..\\..\\..\\..\\planted\\crate-1.0.0"],
      ["../../../planted/crate", "1.0.0"],
      ["abcd/../../../../../../../planted/index", "1.0.0"],
      ["inside", ["1.0.0"]],
    ]) {
      assert.strictEqual(
        await readCargoCacheMetadata(name, version),
        undefined,
        `${name} ${version}`,
      );
    }

    // An archive that unpacks past the bound is not read.
    const bomb = join(root, "bomb-1.0.0.crate");
    writeFileSync(bomb, gzipSync(Buffer.alloc(65 * 1024 * 1024)));
    assert.strictEqual(
      await readCrateArchiveValues(bomb, "bomb", "1.0.0"),
      undefined,
    );

    // The bound on one entry holds for the bytes the entry delivers, whatever
    // size a pax global header states for it.
    const understated = (name, manifest) => {
      const data = Buffer.from(manifest);
      const header = Buffer.alloc(512);
      new TarHeader({
        path: `${name}-1.0.0/Cargo.toml`,
        mode: 0o644,
        size: data.length,
        type: "File",
      }).encode(header);
      const crateFile = join(root, `${name}-1.0.0.crate`);
      writeFileSync(
        crateFile,
        gzipSync(
          Buffer.concat([
            new Pax({ size: 1 }, true).encode(),
            new Pax({ size: data.length }).encode(),
            header,
            data,
            Buffer.alloc(512 * Math.ceil(data.length / 512) - data.length),
            Buffer.alloc(1024),
          ]),
        ),
      );
      return crateFile;
    };
    const manifest = '[package]\nname = "n"\nversion = "1.0.0"\n';
    const small = await readCrateArchiveValues(
      understated("small", `${manifest}description = "d"\n`),
      "small",
      "1.0.0",
    );
    assert.strictEqual(small.values.description, "d");
    const large = await readCrateArchiveValues(
      understated(
        "large",
        `${manifest}description = "${"d".repeat(2 * 1024 * 1024)}"\n`,
      ),
      "large",
      "1.0.0",
    );
    assert.ok(large === undefined, "an entry past the bound is not read");

    // Nor is one whose unpacked data is compressed again: the tar parser
    // would unpack that second layer itself, with no bound.
    const crate = readFileSync(CRATE_FILE);
    const nested = join(root, "rustls-webpki-0.103.13.crate");
    const archives = [
      [crate, "Web PKI X.509 Certificate Verification."],
      [gzipSync(crate), undefined],
    ];
    // Not every runtime the suite runs under can write zstd.
    if (zlib.zstdCompressSync) {
      archives.push([
        gzipSync(zlib.zstdCompressSync(gunzipSync(crate))),
        undefined,
      ]);
    }
    for (const [data, description] of archives) {
      writeFileSync(nested, data);
      const archive = await readCrateArchiveValues(
        nested,
        "rustls-webpki",
        "0.103.13",
      );
      assert.strictEqual(archive?.values.description, description);
    }
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

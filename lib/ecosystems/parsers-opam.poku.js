import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { parseOpamLockedFile } from "./parsers-opam.js";

describe("parseOpamLockedFile", () => {
  it("parses pinned dependencies and sanitises pin URLs", () => {
    const { pkgList, pins } = parseOpamLockedFile(
      "./test/data/opam-smoke/example.opam.locked",
    );
    assert.strictEqual(pkgList.length, 6);

    const dune = pkgList.find((p) => p.name === "dune");
    assert.strictEqual(dune.version, "3.16.0");
    assert.strictEqual(dune.purl, "pkg:opam/dune@3.16.0");

    const confLibssl = pkgList.find((p) => p.name === "conf-libssl");
    assert.strictEqual(confLibssl.version, "4");

    // A pin-depends entry names `<package>.<version>` while the matching
    // depends entry carries the bare name, so the suffix must be split off
    // for the two to line up.
    assert.strictEqual(pins.length, 1);
    assert.strictEqual(pins[0].name, "mylib");
    const mylib = pkgList.find((p) => p.name === "mylib");
    assert.ok(mylib, "the pinned package must be inventoried");
    assert.strictEqual(
      mylib.properties.find((p) => p.name === "cdx:opam:pinned").value,
      "true",
    );
    assert.strictEqual(
      mylib.properties.find((p) => p.name === "cdx:opam:pinSource").value,
      "git+https://github.com/example/mylib.git",
    );

    for (const pkg of pkgList) {
      assert.ok(pkg.purl.startsWith("pkg:opam/"), pkg.purl);
    }
  });

  it("collapses repeated entries and pins the first record per name", () => {
    const { pkgList, pins } = parseOpamLockedFile(
      "./test/data/opam-smoke/duplicates.opam.locked",
    );
    // Same name and version once; distinct versions and the unversioned
    // constraint-only entry each stand on their own.
    assert.deepStrictEqual(
      pkgList.map((p) => p["bom-ref"]),
      [
        "pkg:opam/dune@3.16.0",
        "pkg:opam/dune@3.15.0",
        "pkg:opam/ocaml",
        "pkg:opam/mylib@dev",
        "pkg:opam/mylib@0.1",
      ],
    );
    // A pin lands on the first record carrying its name and nowhere else.
    assert.strictEqual(pins.length, 2);
    const [mylibDev, mylibStable] = pkgList.filter((p) => p.name === "mylib");
    assert.strictEqual(
      mylibDev.properties.find((p) => p.name === "cdx:opam:pinned").value,
      "true",
    );
    assert.strictEqual(
      mylibStable.properties.find((p) => p.name === "cdx:opam:pinned"),
      undefined,
    );
  });

  it("keeps two entries whose name and version join to the same text", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-opam-keys-"));
    try {
      const lockFile = join(dir, "demo.opam.locked");
      writeFileSync(
        lockFile,
        'opam-version: "2.0"\ndepends: [\n  "a@b"\n  "a" {= "b@"}\n]\n',
      );
      const { pkgList } = parseOpamLockedFile(lockFile);
      assert.deepStrictEqual(
        pkgList.map((p) => [p.name, p.version]),
        [
          ["a@b", undefined],
          ["a", "b@"],
        ],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads many depends entries and pins in linear time", () => {
    // Every distinct entry, and every pin that names no entry, would be
    // compared with all the entries before it if each were checked by
    // searching the list.
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-opam-many-"));
    try {
      const lockFile = join(dir, "demo.opam.locked");
      const count = 30000;
      const lines = ['opam-version: "2.0"', "depends: ["];
      for (let i = 0; i < count; i++) {
        lines.push(`  "p${i}" {= "1.0.${i}"}`);
      }
      lines.push("]", "pin-depends: [");
      for (let i = 0; i < count; i++) {
        lines.push(`  [ "q${i}.dev" "git+https://example.com/q${i}.git" ]`);
      }
      lines.push('  [ "p7.dev" "git+https://example.com/p7.git" ]', "]");
      writeFileSync(lockFile, `${lines.join("\n")}\n`);
      const start = Date.now();
      const { pkgList } = parseOpamLockedFile(lockFile);
      const elapsed = Date.now() - start;
      assert.strictEqual(pkgList.length, count);
      assert.deepStrictEqual(
        pkgList
          .filter((p) => p.properties.some((q) => q.name === "cdx:opam:pinned"))
          .map((p) => p.name),
        ["p7"],
      );
      assert.ok(elapsed < 2000, `took ${elapsed}ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a plain .opam manifest without pinned versions", () => {
    const { pkgList, pins } = parseOpamLockedFile(
      "./test/data/opam-smoke/plain/example.opam",
    );
    assert.deepStrictEqual(pins, []);
    assert.strictEqual(pkgList.length, 2);
    // Constraint-only entries are inventoried without a version.
    const dune = pkgList.find((p) => p.name === "dune");
    assert.strictEqual(dune.version, undefined);
    assert.strictEqual(dune.purl, "pkg:opam/dune");
  });

  it("reads a depends line of unclosed braces in linear time", () => {
    // From every `{` that is never closed, a `{[^}]*}` pattern scans to the
    // end of the line, which is quadratic in the line length.
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-opam-braces-"));
    try {
      const lockFile = join(dir, "demo.opam.locked");
      writeFileSync(
        lockFile,
        `opam-version: "2.0"\ndepends: [\n  "dune" ${"{".repeat(100000)}\n  "ocaml" {= "5.1.1"} {build}\n]\n`,
      );
      const start = Date.now();
      const { pkgList } = parseOpamLockedFile(lockFile);
      const elapsed = Date.now() - start;
      assert.deepStrictEqual(
        pkgList.map((p) => p["bom-ref"]),
        ["pkg:opam/dune", "pkg:opam/ocaml@5.1.1"],
      );
      assert.ok(elapsed < 2000, `took ${elapsed}ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns no packages for unreadable input", () => {
    const { pkgList } = parseOpamLockedFile("./test/data/opam-smoke/missing");
    assert.deepStrictEqual(pkgList, []);
  });
});

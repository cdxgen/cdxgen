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
        'opam-version: "2.0"\ndepends: [\n  "a-b"\n  "a" {= "b-"}\n]\n',
      );
      const { pkgList } = parseOpamLockedFile(lockFile);
      assert.deepStrictEqual(
        pkgList.map((p) => [p.name, p.version]),
        [
          ["a-b", undefined],
          ["a", "b-"],
        ],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads many depends entries and pins", () => {
    // Many distinct entries, and many pins that name no entry: only the pin
    // that names an entry marks it as pinned.
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
      const { pkgList } = parseOpamLockedFile(lockFile);
      assert.strictEqual(pkgList.length, count);
      assert.deepStrictEqual(
        pkgList
          .filter((p) => p.properties.some((q) => q.name === "cdx:opam:pinned"))
          .map((p) => p.name),
        ["p7"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops userinfo, query and fragment from every form of pin address", () => {
    const expected = {
      "ssh://oauth2:s3cret@git.example.com/acme/a.git":
        "ssh://git.example.com/acme/a.git",
      "oauth2:s3cret@git.example.com:acme/b.git": "git.example.com:acme/b.git",
      "git@git.example.com:acme/c.git#main": "git.example.com:acme/c.git",
      "artifacts.example.com/d.tgz?token=s3cret": "artifacts.example.com/d.tgz",
      "https://artifacts.example.com?token=s3cret/e.tgz":
        "https://artifacts.example.com",
      "artifacts.example.com/f?token=s3cret&next=https://example.com/f":
        "artifacts.example.com/f",
      "oauth2:s3cret@git.example.com/g://example.com":
        "git.example.com/g://example.com",
      "file:///srv/vendor/g": "file:///srv/vendor/g",
      "/srv/vendor/h": "/srv/vendor/h",
      // An `@` that is not in front of the host: no source is reported.
      "https://oauth2:s3/cret@git.example.com/acme/i.git": undefined,
      "https://oauth2:s3#cret@git.example.com/acme/j.git": undefined,
      "https:///oauth2:s3cret@git.example.com/acme/k.git": undefined,
    };
    const addresses = Object.keys(expected);
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-opam-"));
    try {
      const lockFile = join(tmpDir, "app.opam.locked");
      writeFileSync(
        lockFile,
        [
          "depends: [",
          ...addresses.map((_address, i) => `  "lib${i}" {= "1.0"}`),
          "]",
          "pin-depends: [",
          ...addresses.map((address, i) => `  ["lib${i}.1.0" "${address}"]`),
          "]",
          "",
        ].join("\n"),
      );
      const { pkgList, pins } = parseOpamLockedFile(lockFile);
      assert.strictEqual(pins.length, addresses.length);
      addresses.forEach((address, i) => {
        const properties = pkgList.find((p) => p.name === `lib${i}`).properties;
        assert.strictEqual(
          properties.find((p) => p.name === "cdx:opam:pinned").value,
          "true",
        );
        assert.strictEqual(
          properties.find((p) => p.name === "cdx:opam:pinSource")?.value,
          expected[address],
          address,
        );
      });
      assert.ok(!JSON.stringify({ pkgList, pins }).includes("s3"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
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

  it("reads a depends line of unclosed braces", () => {
    // A long run of `{` that is never closed must not hide the entry on the
    // next line or attach a version to the entry before it.
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-opam-braces-"));
    try {
      const lockFile = join(dir, "demo.opam.locked");
      writeFileSync(
        lockFile,
        `opam-version: "2.0"\ndepends: [\n  "dune" ${"{".repeat(100000)}\n  "ocaml" {= "5.1.1"} {build}\n]\n`,
      );
      const { pkgList } = parseOpamLockedFile(lockFile);
      assert.deepStrictEqual(
        pkgList.map((p) => p["bom-ref"]),
        ["pkg:opam/dune", "pkg:opam/ocaml@5.1.1"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ends a list section at its closing bracket", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-opam-"));
    const parse = (text) => {
      const opamFile = join(tmpDir, "app.opam");
      writeFileSync(opamFile, text);
      return parseOpamLockedFile(opamFile);
    };
    try {
      // White space before the colon is valid opam, and must neither hide a
      // field nor leave the list before it open.
      let result = parse(
        [
          "depends : [",
          '  "ocaml" {>= "4.14"}',
          '  "dune" {= "3.16.0"}',
          "]",
          "build : [",
          "  [",
          '    "./configure"',
          '    "--license-key=s3cret"',
          '    "s3cret"',
          "  ]",
          "]",
        ].join("\n"),
      );
      assert.deepStrictEqual(
        result.pkgList.map((p) => p.purl),
        ["pkg:opam/ocaml", "pkg:opam/dune@3.16.0"],
      );

      // The bracket closes the list wherever it is written, and whatever
      // follows: a field split over two lines, or a comment. Brackets in
      // strings and comments do not count.
      for (const text of [
        'depends: [\n  "ocaml"\n  "dune" {= "3.16.0"} ]\nbuild\n: [\n"s3cret"\n]',
        'depends: [\n  "ocaml"\n  "dune" {= "3.16.0"}\n]\n(*\n"s3cret"\n*)',
        'depends:\n[\n  "ocaml" # ]\n  "dune" {= "3.16.0" & os != "]"}\n]\n"s3cret"',
        'depends: [\n  "ocaml" (* [ \r [\n  "dune" {= "3.16.0"}\n]\n"s3cret"',
      ]) {
        result = parse(text);
        assert.deepStrictEqual(
          result.pkgList.map((p) => p.purl),
          ["pkg:opam/ocaml", "pkg:opam/dune@3.16.0"],
        );
      }
      for (const text of [
        'depends: ["ocaml"]\nbuild\n: [\n"s3cret"\n]',
        'depends: "ocaml"\nbuild\n: [\n"s3cret"\n]',
      ]) {
        assert.deepStrictEqual(parse(text).pkgList, []);
      }

      // The same holds for pin-depends, whose entries are lists themselves.
      result = parse(
        [
          "depends: [",
          '  "dune" {= "3.16.0"}',
          '  "mylib" {= "dev"}',
          "]",
          "pin-depends: [",
          '  [ "mylib.dev" "git+https://example.com/mylib.git#a]b" ]',
          "]",
          "build : [",
          '  ["dune" "--token=s3cret"]',
          "]",
        ].join("\n"),
      );
      assert.deepStrictEqual(result.pins, [
        { name: "mylib", url: "git+https://example.com/mylib.git" },
      ]);
      assert.ok(!JSON.stringify(result).includes("s3cret"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns no packages for unreadable input", () => {
    const { pkgList } = parseOpamLockedFile("./test/data/opam-smoke/missing");
    assert.deepStrictEqual(pkgList, []);
  });
});

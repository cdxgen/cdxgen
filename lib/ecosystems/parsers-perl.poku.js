import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  directRequirementsFromCpanfile,
  parseCpanSnapshot,
} from "./parsers-perl.js";

describe("parseCpanSnapshot", () => {
  it("parses distributions with author namespaces and a requirement graph", () => {
    const { pkgList, dependencies } = parseCpanSnapshot(
      "./test/data/perl-smoke/cpanfile.snapshot",
      "./test/data/perl-smoke/cpanfile",
    );
    assert.strictEqual(pkgList.length, 3);

    const plack = pkgList.find((p) => p.name === "Plack");
    assert.strictEqual(plack.version, "1.0051");
    assert.strictEqual(plack.purl, "pkg:cpan/MIYAGAWA/Plack@1.0051");
    // Plack is declared in cpanfile, so it is direct.
    assert.strictEqual(
      plack.properties.find((p) => p.name === "cdx:cpan:dependency").value,
      "direct",
    );

    // parent is only a build requirement of Plack, not declared in cpanfile.
    const parent = pkgList.find((p) => p.name === "parent");
    assert.strictEqual(parent.purl, "pkg:cpan/CORION/parent@0.238");
    assert.strictEqual(
      parent.properties.find((p) => p.name === "cdx:cpan:dependency").value,
      "transitive",
    );

    // URI is declared directly and also provided by URI-1.76.
    const uri = pkgList.find((p) => p.name === "URI");
    assert.strictEqual(uri.purl, "pkg:cpan/ETHER/URI@1.76");
    assert.strictEqual(
      uri.properties.find((p) => p.name === "cdx:cpan:dependency").value,
      "direct",
    );

    // Plack depends on URI and parent, both resolved through provides.
    const plackEdge = dependencies.find((d) => d.ref === plack["bom-ref"]);
    assert.deepStrictEqual(
      plackEdge.dependsOn.sort(),
      [uri["bom-ref"], parent["bom-ref"]].sort(),
    );

    for (const pkg of pkgList) {
      assert.ok(pkg.purl.startsWith("pkg:cpan/"), pkg.purl);
    }
  });

  it("refuses a distribution line holding a space in linear time", () => {
    // Matched with the pattern alone, the crafted line needs tens of seconds
    // and with the space check milliseconds, so the bound leaves room for
    // slow runners.
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-perl-"));
    try {
      const snapshotFile = join(tmpDir, "cpanfile.snapshot");
      writeFileSync(
        snapshotFile,
        [
          "# carton snapshot format: version 1.0",
          "DISTRIBUTIONS",
          "  Plack-1.0051",
          "    pathname: M/MI/MIYAGAWA/Plack-1.0051.tar.gz",
          `  ${"-1".repeat(40000)} x`,
          "  URI-1.76 x",
          "",
        ].join("\n"),
      );
      const started = performance.now();
      const { pkgList } = parseCpanSnapshot(snapshotFile);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 1500, `took ${Math.round(elapsed)} ms`);
      assert.deepStrictEqual(
        pkgList.map((pkg) => pkg.purl),
        ["pkg:cpan/MIYAGAWA/Plack@1.0051"],
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("collects requires lines from cpanfile while ignoring phase blocks", () => {
    const names = directRequirementsFromCpanfile(
      "./test/data/perl-smoke/cpanfile",
    );
    assert.ok(names.has("Plack"));
    assert.ok(names.has("URI"));
    assert.ok(!names.has("Test::More"), "test phase must be excluded");
  });
});

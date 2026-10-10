import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { findVendoredCode, isLicenseFileName } from "./vendoredCode.js";

const APACHE =
  "                                 Apache License\n                           Version 2.0, January 2004\n";
const GPL3 =
  "                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n ... use the GNU Lesser General Public License instead of this License.\n";
const MIT =
  "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n";

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "vendored-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return root;
}

describe("isLicenseFileName()", () => {
  it("knows the license file names", () => {
    for (const name of [
      "LICENSE",
      "LICENSE.txt",
      "license.md",
      "LICENCE",
      "COPYING",
      "COPYING.LIB",
      "LICENSE-MIT",
      "LICENSE-APACHE",
    ]) {
      assert.ok(isLicenseFileName(name), name);
    }
    for (const name of ["license-checker.js", "Licenses.cpp", "COPYINGNOTES"]) {
      assert.ok(!isLicenseFileName(name), name);
    }
  });
});

describe("findVendoredCode()", () => {
  it("reports directories licensed differently from the project, once per tree", () => {
    const root = tree({
      "LICENSE.txt": APACHE,
      "tests/imported/gnu/LICENSE.txt": GPL3,
      "tests/imported/gnu/sub/COPYING": MIT,
      "tests/imported/clang/LICENSE.txt": APACHE,
      "third_party/json/LICENSE.MIT": MIT,
      "third_party/json/LICENSE-MIT": MIT,
      "deps/zlib/LICENSE": MIT,
      "docs/LICENSE": "Some custom terms",
    });
    try {
      const { components, dirs } = findVendoredCode(root, {}, [
        join(root, "deps", "zlib"),
      ]);
      const byPath = Object.fromEntries(
        components.map((c) => [
          c.properties.find((p) => p.name === "cdx:vendored:path").value,
          c,
        ]),
      );
      assert.deepStrictEqual(Object.keys(byPath).sort(), [
        "tests/imported/gnu",
        "third_party/json",
      ]);
      const gnu = byPath["tests/imported/gnu"];
      assert.strictEqual(gnu.name, "gnu");
      assert.deepStrictEqual(gnu.licenses, [
        { license: { id: "GPL-3.0-only" } },
      ]);
      assert.strictEqual(gnu.purl, "pkg:generic/gnu#tests/imported/gnu");
      assert.ok(
        gnu.properties.some(
          (p) =>
            p.name === "cdx:vendored:licenseFile" &&
            p.value === "tests/imported/gnu/LICENSE.txt",
        ),
      );
      assert.deepStrictEqual(gnu.evidence.licenses, gnu.licenses);
      assert.strictEqual(dirs.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats every identified license as different when the project has none", () => {
    const root = tree({ "vendor/lib/LICENSE": MIT });
    try {
      assert.strictEqual(findVendoredCode(root).components.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a license with an exception as an expression", () => {
    const root = tree({
      LICENSE: MIT,
      "llvm/LICENSE.TXT":
        "The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:\n Apache License\n Version 2.0, January 2004\n",
    });
    try {
      const [c] = findVendoredCode(root).components;
      assert.deepStrictEqual(c.licenses, [
        { expression: "Apache-2.0 WITH LLVM-exception" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves Terraform and Terragrunt download caches to the Terraform collector", () => {
    const root = tree({
      LICENSE: MIT,
      ".terraform/modules/vpc/LICENSE": APACHE,
      ".terraform/providers/registry.terraform.io/hashicorp/aws/5.80.0/linux_amd64/LICENSE":
        GPL3,
      "live/.terragrunt-cache/abc/def/LICENSE": APACHE,
      "third_party/json/LICENSE": APACHE,
    });
    try {
      // A multi-type scan can widen the shared options to dot directories.
      const { components } = findVendoredCode(root, { includeDot: true });
      assert.deepStrictEqual(
        components.map(
          (c) => c.properties.find((p) => p.name === "cdx:vendored:path").value,
        ),
        ["third_party/json"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

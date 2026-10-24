import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  findVendoredCode,
  isInVendoredDir,
  isLicenseFileName,
  vendoredVersionOf,
} from "./vendoredCode.js";

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

describe("vendoredVersionOf()", () => {
  it("reads the library's own version header and its CPE", () => {
    const root = tree({
      "brotli/c/common/version.h":
        "#define BROTLI_VERSION_MAJOR 1\n#define BROTLI_VERSION_MINOR 2\n#define BROTLI_VERSION_PATCH 0\n",
      "brotli/c/include/brotli/decode.h":
        "  BROTLI_ERROR_CODE(_ERROR_FORMAT_, EXUBERANT_NIBBLE, -1) SEPARATOR \\\n",
      "zlib/zlib.h": '#define ZLIB_VERSION "1.3.1"\n',
      "zstd/lib/zstd.h":
        "#define ZSTD_VERSION_MAJOR    1\n#define ZSTD_VERSION_MINOR    5\n#define ZSTD_VERSION_RELEASE  6\n",
      "mylib/CMakeLists.txt": "project(mylib VERSION 2.4.1 LANGUAGES C)\n",
      // A CMake variable, not a version.
      "odd/CMakeLists.txt": `project(odd VERSION ${"$"}{PROJECT_VERSION})\n`,
      "halfdone/c/common/version.h": "#define BROTLI_VERSION_MAJOR 1\n",
    });
    try {
      assert.deepStrictEqual(vendoredVersionOf(join(root, "brotli")), {
        version: "1.2.0",
        source: "c/common/version.h",
        cpe: "cpe:2.3:a:google:brotli:1.2.0:*:*:*:*:*:*:*",
        properties: [{ name: "cdx:brotli:c:blockSwitchFix", value: "false" }],
      });
      assert.strictEqual(
        vendoredVersionOf(join(root, "zlib")).cpe,
        "cpe:2.3:a:zlib:zlib:1.3.1:*:*:*:*:*:*:*",
      );
      assert.strictEqual(
        vendoredVersionOf(join(root, "zstd")).version,
        "1.5.6",
      );
      assert.deepStrictEqual(vendoredVersionOf(join(root, "mylib")), {
        version: "2.4.1",
        source: "CMakeLists.txt",
        properties: [],
      });
      assert.strictEqual(vendoredVersionOf(join(root, "odd")), undefined);
      assert.strictEqual(vendoredVersionOf(join(root, "halfdone")), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the version on the vendored component", () => {
    const root = tree({
      LICENSE: APACHE,
      "third_party/brotli/LICENSE": MIT,
      "third_party/brotli/c/common/version.h":
        "#define BROTLI_VERSION_MAJOR 1\n#define BROTLI_VERSION_MINOR 2\n#define BROTLI_VERSION_PATCH 1\n",
      "third_party/brotli/c/include/brotli/decode.h":
        "  BROTLI_ERROR_CODE(_ERROR_FORMAT_, BLOCK_SWITCH, -17) SEPARATOR \\\n",
    });
    try {
      const [component] = findVendoredCode(root).components;
      assert.strictEqual(
        component.purl,
        "pkg:generic/brotli@1.2.1#third_party/brotli",
      );
      assert.strictEqual(component.version, "1.2.1");
      assert.ok(
        component.properties.some(
          (p) =>
            p.name === "cdx:vendored:versionSource" &&
            p.value === "third_party/brotli/c/common/version.h",
        ),
      );
      assert.ok(
        component.properties.some(
          (p) => p.name === "cdx:brotli:c:blockSwitchFix" && p.value === "true",
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isInVendoredDir()", () => {
  it("tells a copied project's build files from the project's own", () => {
    const root = join(tmpdir(), "project");
    assert.ok(
      isInVendoredDir(
        root,
        join(root, "third_party", "brotli", "MODULE.bazel"),
      ),
    );
    assert.ok(
      isInVendoredDir(root, join(root, "src", "vendor", "x", "WORKSPACE")),
    );
    assert.ok(!isInVendoredDir(root, join(root, "MODULE.bazel")));
    assert.ok(!isInVendoredDir(root, join(root, "tools", "MODULE.bazel")));
    assert.ok(
      !isInVendoredDir(
        join(root, "third_party"),
        join(root, "third_party", "MODULE.bazel"),
      ),
      "the scan root itself is never vendored",
    );
    assert.ok(
      !isInVendoredDir(
        root,
        join(tmpdir(), "elsewhere", "vendor", "WORKSPACE"),
      ),
    );
  });
});

describe("vendoredVersionOf() for brotli 1.0.x", () => {
  it("reads the packed BROTLI_VERSION and the fix marker independently", () => {
    const root = tree({
      // The upstream v1.0.9 c/common/version.h defines only the packed form.
      "brotli/c/common/version.h": "#define BROTLI_VERSION 0x1000009\n",
      "brotli/c/include/brotli/decode.h":
        "  BROTLI_ERROR_CODE(_ERROR_FORMAT_, EXUBERANT_NIBBLE, -1) SEPARATOR \\\n",
      "odd/c/common/version.h": "/* a version header that changed shape */\n",
      "odd/c/include/brotli/decode.h":
        "  BROTLI_ERROR_CODE(_ERROR_FORMAT_, BLOCK_SWITCH, -17) SEPARATOR \\\n",
    });
    try {
      assert.deepStrictEqual(vendoredVersionOf(join(root, "brotli")), {
        version: "1.0.9",
        source: "c/common/version.h",
        cpe: "cpe:2.3:a:google:brotli:1.0.9:*:*:*:*:*:*:*",
        properties: [{ name: "cdx:brotli:c:blockSwitchFix", value: "false" }],
      });
      assert.deepStrictEqual(vendoredVersionOf(join(root, "odd")), {
        properties: [{ name: "cdx:brotli:c:blockSwitchFix", value: "true" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

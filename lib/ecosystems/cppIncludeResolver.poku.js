import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import {
  conan2Packages,
  conanPackageOf,
  createIncludeAttributor,
  parseCIncludeSlices,
  readVcpkgInstalledIndex,
} from "./cppIncludeResolver.js";

function write(file, text = "") {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

describe("parseCIncludeSlices()", () => {
  it("collects the resolved files and the system flag per header", () => {
    const includes = parseCIncludeSlices({
      objectSlices: [
        {
          code: "#include <zlib.h>",
          fullName: "zlib.h",
          fileName: "src/a.c",
          resolvedPath: "/usr/include/zlib.h",
          isSystem: true,
        },
        {
          code: "#include <zlib.h>",
          fullName: "zlib.h",
          fileName: "src/b.c",
          resolvedPath: "/opt/zlib/include/zlib.h",
          isSystem: true,
        },
        // a slice from an atom release that does not name the file
        { code: '#include "util.h"', fullName: "util.h", fileName: "a.c" },
        { code: "", fullName: "main", fileName: "a.c" },
      ],
    });
    assert.deepStrictEqual([...includes.keys()], ["zlib.h", "util.h"]);
    assert.deepStrictEqual(
      [...includes.get("zlib.h").paths],
      ["/usr/include/zlib.h", "/opt/zlib/include/zlib.h"],
    );
    assert.strictEqual(includes.get("zlib.h").system, true);
    assert.strictEqual(includes.get("util.h").paths.size, 0);
    assert.strictEqual(parseCIncludeSlices(undefined).size, 0);
  });
});

describe("readVcpkgInstalledIndex()", () => {
  it("indexes every file a port installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "vcpkg-installed-"));
    try {
      write(
        join(dir, "vcpkg", "info", "zlib_1.3.1_x64-linux.list"),
        "x64-linux/\nx64-linux/include/zlib.h\nx64-linux/include/zconf.h\n",
      );
      write(
        join(dir, "vcpkg", "info", "fmt_11.0.2_x64-linux.list"),
        "x64-linux/include/fmt/core.h\n",
      );
      write(join(dir, "vcpkg", "info", "broken.list"), "x\n");
      const index = readVcpkgInstalledIndex([dir, join(dir, "missing")]);
      assert.deepStrictEqual(
        index.get(join(dir, "x64-linux", "include", "zlib.h")),
        { port: "zlib", version: "1.3.1", triplet: "x64-linux" },
      );
      assert.strictEqual(
        index.get(join(dir, "x64-linux", "include", "fmt", "core.h")).port,
        "fmt",
      );
      assert.strictEqual(index.size, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Conan caches", () => {
  it("reads name and version from a Conan 1 package path", () => {
    assert.deepStrictEqual(
      conanPackageOf(
        join(
          "/home",
          "dev",
          ".conan",
          "data",
          "openssl",
          "3.2.1",
          "_",
          "_",
          "package",
          "abc123",
          "include",
          "openssl",
          "ssl.h",
        ),
        [],
      ),
      { name: "openssl", version: "3.2.1" },
    );
    assert.strictEqual(conanPackageOf("/usr/include/zlib.h", []), undefined);
  });

  it("reads a Conan 2 cache from its database", () => {
    const sqlite = process.getBuiltinModule?.("node:sqlite");
    if (!sqlite?.DatabaseSync) {
      return;
    }
    const home = mkdtempSync(join(tmpdir(), "conan2-home-"));
    try {
      mkdirSync(join(home, "p", "b", "zlib1a2b3c4d5e6f7", "p", "include"), {
        recursive: true,
      });
      const db = new sqlite.DatabaseSync(join(home, "p", "cache.sqlite3"));
      db.exec(
        "CREATE TABLE packages (reference TEXT, rrev TEXT, pkgid TEXT, prev TEXT, path TEXT)",
      );
      db.prepare(
        "INSERT INTO packages (reference, rrev, pkgid, prev, path) VALUES (?, ?, ?, ?, ?)",
      ).run("zlib/1.3.1", "r1", "p1", "v1", "b/zlib1a2b3c4d5e6f7/p");
      db.close();
      const packages = conan2Packages(home);
      assert.deepStrictEqual(
        packages.map((p) => [p.name, p.version]),
        [["zlib", "1.3.1"]],
      );
      assert.deepStrictEqual(
        conanPackageOf(
          join(home, "p", "b", "zlib1a2b3c4d5e6f7", "p", "include", "zlib.h"),
          packages,
        ),
        { name: "zlib", version: "1.3.1" },
      );
      assert.deepStrictEqual(conan2Packages(join(home, "missing")), []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("createIncludeAttributor()", () => {
  it("attributes a resolved file to the dependency, port, cache package or OS package that holds it", async () => {
    const root = mkdtempSync(join(tmpdir(), "include-attr-"));
    const conanHome = mkdtempSync(join(tmpdir(), "conan-home-"));
    const savedConanHome = process.env.CONAN_HOME;
    process.env.CONAN_HOME = conanHome;
    try {
      write(join(root, "third_party", "zlib", "zlib.h"));
      write(join(root, "third_party", "zlib", "contrib", "minizip", "zip.h"));
      write(join(root, "vendor", "json", "json.hpp"));
      write(join(root, "include", "proj", "api.h"));
      write(
        join(
          root,
          "build",
          "vcpkg_installed",
          "vcpkg",
          "info",
          "fmt_11.0.2_x64-linux.list",
        ),
        "x64-linux/include/fmt/core.h\n",
      );
      write(
        join(
          root,
          "build",
          "vcpkg_installed",
          "x64-linux",
          "include",
          "fmt",
          "core.h",
        ),
      );
      const zlib = {
        name: "zlib",
        properties: [
          { name: "cdx:cmake:sourceDir", value: "third_party/zlib" },
        ],
      };
      const minizip = {
        name: "minizip",
        properties: [
          {
            name: "cdx:cmake:sourceDir",
            value: "third_party/zlib/contrib/minizip",
          },
        ],
      };
      const json = {
        name: "json",
        properties: [{ name: "cdx:vendored:path", value: "vendor/json" }],
      };
      const { createIncludeAttributor: attributorWithOs } = await esmock(
        "./cppIncludeResolver.js",
        {
          "../inventory/osPackageResolver.js": {
            resolvePackageForFile: (f) =>
              f.endsWith("ssl.h")
                ? {
                    name: "libssl-dev",
                    version: "3.0.13",
                    purl: "pkg:deb/ubuntu/libssl-dev@3.0.13",
                  }
                : undefined,
          },
        },
      );
      const attribute = attributorWithOs({
        src: root,
        components: [zlib, minizip, json],
        buildDirs: [join(root, "build")],
        isFirstPartyHeader: (f) => f.startsWith(join(root, "include")),
      });
      assert.strictEqual(
        attribute([join(root, "third_party", "zlib", "zlib.h")]).component,
        zlib,
      );
      // the deeper directory owns its files
      assert.strictEqual(
        attribute([
          join(root, "third_party", "zlib", "contrib", "minizip", "zip.h"),
        ]).component,
        minizip,
      );
      assert.strictEqual(
        attribute([join(root, "vendor", "json", "json.hpp")]).component,
        json,
      );
      assert.deepStrictEqual(
        attribute([join(root, "include", "proj", "api.h")]),
        { kind: "first-party" },
      );
      assert.deepStrictEqual(
        attribute([
          join(
            root,
            "build",
            "vcpkg_installed",
            "x64-linux",
            "include",
            "fmt",
            "core.h",
          ),
        ]),
        { kind: "vcpkg", port: "fmt", version: "11.0.2", triplet: "x64-linux" },
      );
      assert.deepStrictEqual(attribute.vcpkgPorts().get("fmt"), {
        version: "11.0.2",
        triplet: "x64-linux",
      });
      assert.deepStrictEqual(
        attribute([
          join(
            "/home",
            "dev",
            ".conan",
            "data",
            "boost",
            "1.84.0",
            "_",
            "_",
            "package",
            "x",
            "include",
            "boost",
            "any.hpp",
          ),
        ]),
        { kind: "conan", name: "boost", version: "1.84.0" },
      );
      assert.strictEqual(
        attribute(["/usr/include/openssl/ssl.h"]).pkgInfo.name,
        "libssl-dev",
      );
      // nothing to say: a relative path, or a file no package owns
      assert.strictEqual(attribute(["relative/x.h"]), undefined);
      assert.strictEqual(attribute(["/usr/include/unowned.h"]), undefined);
      // the first file that says wins
      assert.strictEqual(
        attribute([
          "/usr/include/unowned.h",
          join(root, "third_party", "zlib", "zlib.h"),
        ]).component,
        zlib,
      );
    } finally {
      if (savedConanHome === undefined) {
        delete process.env.CONAN_HOME;
      } else {
        process.env.CONAN_HOME = savedConanHome;
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(conanHome, { recursive: true, force: true });
    }
  });

  it("works without vcpkg or a known component", () => {
    const root = mkdtempSync(join(tmpdir(), "include-attr-empty-"));
    try {
      const attribute = createIncludeAttributor({ src: root });
      assert.strictEqual(attribute.vcpkgPorts().size, 0);
      assert.strictEqual(attribute([]), undefined);
      assert.strictEqual(attribute(undefined), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

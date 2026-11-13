import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  parseLuaRocksLock,
  parseRockspecFile,
  readLuaAssignments,
} from "./parsers-lua.js";

describe("parseRockspecFile", () => {
  it("parses the parent rock and declared dependencies", () => {
    const { pkgList, parentComponent } = parseRockspecFile(
      "./test/data/lua-smoke/lua-resty-http-0.17.1-1.rockspec",
    );
    assert.strictEqual(parentComponent.name, "lua-resty-http");
    assert.strictEqual(parentComponent.version, "0.17.1-0");
    assert.deepStrictEqual(pkgList.map((p) => p.name).sort(), [
      "lua",
      "net-url",
    ]);
    for (const pkg of pkgList) {
      assert.strictEqual(pkg.version, undefined);
      assert.strictEqual(
        pkg.properties.find((p) => p.name === "cdx:luarocks:dependency").value,
        "direct",
      );
    }
  });
});

describe("parseLuaRocksLock", () => {
  it("parses resolved rocks and marks declared ones direct", () => {
    const { pkgList } = parseLuaRocksLock(
      "./test/data/lua-smoke/luarocks.lock",
      "./test/data/lua-smoke/lua-resty-http-0.17.1-1.rockspec",
    );
    assert.strictEqual(pkgList.length, 3);

    const netUrl = pkgList.find((p) => p.name === "net-url");
    assert.strictEqual(netUrl.version, "0.9-0");
    assert.strictEqual(netUrl.purl, "pkg:luarocks/net-url@0.9-0");
    assert.strictEqual(
      netUrl.properties.find((p) => p.name === "cdx:luarocks:dependency").value,
      "direct",
    );

    // lua is written with a bare identifier key rather than the bracketed
    // form; both are valid Lua and both appear in real locks.
    const lua = pkgList.find((p) => p.name === "lua");
    assert.strictEqual(lua.version, "5.4-1");
    assert.strictEqual(
      lua.properties.find((p) => p.name === "cdx:luarocks:dependency").value,
      "direct",
    );

    // lua-cjson is pulled in by the resolver but not declared in the
    // rockspec, so it is transitive.
    const cjson = pkgList.find((p) => p.name === "lua-cjson");
    assert.strictEqual(cjson.version, "2.1.0.10-1");
    assert.strictEqual(
      cjson.properties.find((p) => p.name === "cdx:luarocks:dependency").value,
      "transitive",
    );
  });
});

describe("parseLuaRocksLock with several rockspecs", () => {
  it("marks a rock declared by any of them direct", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-lua-rockspecs-"));
    const scmRockspec = join(tempDir, "lua-resty-http-scm-1.rockspec");
    writeFileSync(
      scmRockspec,
      'package = "lua-resty-http"\nversion = "scm-1"\ndependencies = {\n   "lua-cjson >= 2.1",\n}\n',
    );
    try {
      const { pkgList } = parseLuaRocksLock(
        "./test/data/lua-smoke/luarocks.lock",
        ["./test/data/lua-smoke/lua-resty-http-0.17.1-1.rockspec", scmRockspec],
      );
      assert.strictEqual(pkgList.length, 3);
      for (const pkg of pkgList) {
        assert.strictEqual(
          pkg.properties.find((p) => p.name === "cdx:luarocks:dependency")
            .value,
          "direct",
        );
      }
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe("parseLuaRocksLock without a rockspec", () => {
  it("reports the whole closure as direct", () => {
    const { pkgList } = parseLuaRocksLock(
      "./test/data/lua-smoke/luarocks.lock",
      undefined,
    );
    assert.strictEqual(pkgList.length, 3);
    for (const pkg of pkgList) {
      assert.strictEqual(
        pkg.properties.find((p) => p.name === "cdx:luarocks:dependency").value,
        "direct",
      );
    }
  });
});

describe("readLuaAssignments", () => {
  it("reads strings and nested tables across lines", () => {
    const fields = readLuaAssignments(
      "./test/data/lua-smoke/lua-resty-http-0.17.1-1.rockspec",
    );
    assert.strictEqual(fields.get("package"), "lua-resty-http");
    assert.strictEqual(fields.get("version"), "0.17.1-0");
    const deps = fields.get("dependencies");
    assert.deepStrictEqual(deps, [
      { name: "lua", constraint: ">= 5.1" },
      { name: "net-url", constraint: ">= 0.9" },
    ]);
  });
});

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import { parseGoListDep, parseGoModulesTxt } from "./parsers-go.js";

// Replace directives, and links in the vendor tree, can lead any number of
// module paths to one directory. Its notice is embedded once, for the first
// module that reads it, and the others carry the licence without the text, so
// the BOM does not grow with modules times notice size.
it("go modules that share a directory embed its notice once", async () => {
  const previous = {
    FETCH_LICENSE: process.env.FETCH_LICENSE,
    GO_FETCH_VCS: process.env.GO_FETCH_VCS,
    GOMODCACHE: process.env.GOMODCACHE,
    GO_PKG_URL: process.env.GO_PKG_URL,
  };
  process.env.FETCH_LICENSE = "false";
  process.env.GO_FETCH_VCS = "false";
  process.env.GO_PKG_URL = "http://127.0.0.1:1/go/";
  const scratch = mkdtempSync(join(tmpdir(), "cdxgen-go-shared-notice-"));
  try {
    const mit =
      "MIT License\n\nPermission is hereby granted, free of charge, to any person.\n";
    const apache = "Apache License, Version 2.0\n";
    mkdirSync(join(scratch, "shared"));
    mkdirSync(join(scratch, "x"));
    writeFileSync(join(scratch, "shared", "LICENSE"), mit);
    writeFileSync(join(scratch, "LICENSE"), apache);
    const row = (path, main, dir, replace = "") =>
      `${path}|${main ? "" : "v1.0.0"}|false|${join(dir, "go.mod")}|1.21|${main}|<nil>|||${dir}||${replace}||`;
    const listOutput = [
      row("example.com/self", false, scratch, "./"),
      row("example.com/m0", false, join(scratch, "shared"), "./shared"),
      row(
        "example.com/m1",
        false,
        join(scratch, "x", "..", "shared"),
        "./x/../shared",
      ),
      row("example.com/app", true, scratch),
    ].join("\n");
    const licensesOf = (component) =>
      component.licenses?.map(({ license }) => [
        license.id,
        license.text?.content,
      ]);
    const noticeDirs = new Map();
    const { parentComponent, pkgList } = await parseGoListDep(
      listOutput,
      {},
      {
        mainModuleDir: scratch,
        noticeDirs,
      },
    );
    // The parent reads its own directory first, though a dependency replaced
    // into it comes earlier in the output.
    assert.deepStrictEqual(licensesOf(parentComponent), [
      ["Apache-2.0", apache],
    ]);
    assert.deepStrictEqual(
      pkgList.map((component) => [component.name, licensesOf(component)]),
      [
        ["example.com/m0", [["MIT", mit]]],
        ["example.com/m1", [["MIT", undefined]]],
        ["example.com/self", [["Apache-2.0", undefined]]],
      ],
    );
    // The go list run of a nested module names the same directory again.
    const nested = await parseGoListDep(
      row("example.com/m", true, join(scratch, "shared")),
      {},
      { mainModuleDir: join(scratch, "shared"), noticeDirs },
    );
    assert.deepStrictEqual(licensesOf(nested.parentComponent), [
      ["MIT", undefined],
    ]);
    // A run of its own reads the text for the first module that asks.
    const alone = await parseGoListDep(
      row("example.com/m", true, join(scratch, "shared")),
      {},
      { mainModuleDir: join(scratch, "shared") },
    );
    assert.deepStrictEqual(licensesOf(alone.parentComponent), [["MIT", mit]]);

    // Links in the vendor tree are read through when licences are fetched.
    // Creating a symbolic link on Windows needs a privilege a test runner may
    // lack, so this part runs elsewhere.
    if (process.platform !== "win32") {
      process.env.FETCH_LICENSE = "true";
      process.env.GOMODCACHE = join(scratch, "empty-modcache");
      const vendor = join(scratch, "project", "vendor", "example.com");
      mkdirSync(join(vendor, "v0"), { recursive: true });
      writeFileSync(join(vendor, "v0", "LICENSE"), mit);
      symlinkSync(join(vendor, "v0"), join(vendor, "v1"));
      writeFileSync(
        join(scratch, "project", "vendor", "modules.txt"),
        "# example.com/v0 v1.0.0\n## explicit\nexample.com/v0\n# example.com/v1 v1.0.0\n## explicit\nexample.com/v1\n",
      );
      const vendored = await parseGoModulesTxt(
        join(scratch, "project", "vendor", "modules.txt"),
        {},
      );
      assert.deepStrictEqual(
        vendored.map((component) => [component.name, licensesOf(component)]),
        [
          ["example.com/v0", [["MIT", mit]]],
          ["example.com/v1", [["MIT", undefined]]],
        ],
      );
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

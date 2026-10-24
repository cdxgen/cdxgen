import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  collectDotnetRuntimes,
  dotnetCpe,
  runtimePackFromDepsJson,
} from "./dotnetRuntime.js";

const FIXTURE = join(
  "test",
  "data",
  "brotli-exposure",
  "dotnet",
  "Microsoft.NETCore.App.deps.json",
);

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-dotnet-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function installFramework(root, dotnetRoot, framework, version, depsJson) {
  const dir = join(root, dotnetRoot, "shared", framework, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${framework}.deps.json`), depsJson);
  return dir;
}

function aspNetDepsJson(version, rid) {
  return JSON.stringify({
    runtimeTarget: { name: `.NETCoreApp,Version=v8.0/${rid}` },
    targets: {
      [`.NETCoreApp,Version=v8.0/${rid}`]: {
        [`Microsoft.AspNetCore.App.Runtime.${rid}/${version}`]: {},
      },
    },
  });
}

describe("runtimePackFromDepsJson()", () => {
  it("reads the runtime pack of the .NET 8.0.32 runtime", () => {
    const depsJson = JSON.parse(readFileSync(FIXTURE, "utf-8"));
    assert.deepStrictEqual(
      runtimePackFromDepsJson(depsJson, "Microsoft.NETCore.App"),
      {
        pack: "Microsoft.NETCore.App.Runtime.linux-arm64",
        version: "8.0.32",
        rid: "linux-arm64",
      },
    );
    assert.strictEqual(
      runtimePackFromDepsJson(depsJson, "Microsoft.AspNetCore.App"),
      undefined,
      "a pack of another framework is not this framework's",
    );
    assert.strictEqual(
      runtimePackFromDepsJson({}, "Microsoft.NETCore.App"),
      undefined,
    );
  });
});

describe("dotnetCpe()", () => {
  it("uses the product names NVD uses", () => {
    assert.strictEqual(
      dotnetCpe("Microsoft.NETCore.App", "8.0.32"),
      "cpe:2.3:a:microsoft:.net:8.0.32:*:*:*:*:*:*:*",
    );
    assert.strictEqual(
      dotnetCpe("Microsoft.NETCore.App", "3.1.32"),
      "cpe:2.3:a:microsoft:.net_core:3.1.32:*:*:*:*:*:*:*",
    );
    assert.strictEqual(
      dotnetCpe("Microsoft.AspNetCore.App", "8.0.21"),
      "cpe:2.3:a:microsoft:asp.net_core:8.0.21:*:*:*:*:*:*:*",
    );
    assert.strictEqual(
      dotnetCpe("Microsoft.WindowsDesktop.App", "8.0.1"),
      undefined,
    );
  });
});

describe("collectDotnetRuntimes()", () => {
  it("names each unpackaged shared framework by its runtime pack", () =>
    withRoot((root) => {
      const dir = join(
        root,
        "usr/share/dotnet/shared/Microsoft.NETCore.App/8.0.32",
      );
      mkdirSync(dir, { recursive: true });
      copyFileSync(FIXTURE, join(dir, "Microsoft.NETCore.App.deps.json"));
      installFramework(
        root,
        "usr/share/dotnet",
        "Microsoft.AspNetCore.App",
        "8.0.21",
        aspNetDepsJson("8.0.21", "linux-musl-x64"),
      );
      const runtimes = collectDotnetRuntimes(root);
      assert.deepStrictEqual(
        runtimes.map((r) => [r.purl, r.cpe]),
        [
          [
            "pkg:nuget/Microsoft.AspNetCore.App.Runtime.linux-musl-x64@8.0.21",
            "cpe:2.3:a:microsoft:asp.net_core:8.0.21:*:*:*:*:*:*:*",
          ],
          [
            "pkg:nuget/Microsoft.NETCore.App.Runtime.linux-arm64@8.0.32",
            "cpe:2.3:a:microsoft:.net:8.0.32:*:*:*:*:*:*:*",
          ],
        ],
      );
      const core = runtimes[1];
      assert.strictEqual(core.type, "platform");
      assert.deepStrictEqual(core.properties, [
        { name: "cdx:dotnet:sharedFramework", value: "Microsoft.NETCore.App" },
        { name: "cdx:dotnet:runtimeIdentifier", value: "linux-arm64" },
      ]);
      assert.deepStrictEqual(core.evidence.occurrences, [
        {
          location:
            "/usr/share/dotnet/shared/Microsoft.NETCore.App/8.0.32/Microsoft.NETCore.App.deps.json",
        },
      ]);
    }));

  it("leaves package-owned, mismatched and broken frameworks out", () =>
    withRoot((root) => {
      installFramework(
        root,
        "usr/lib/dotnet",
        "Microsoft.AspNetCore.App",
        "8.0.21",
        aspNetDepsJson("8.0.21", "linux-x64"),
      );
      // The directory says 8.0.20 but the pack is 8.0.21: not a runtime.
      installFramework(
        root,
        "opt/dotnet",
        "Microsoft.AspNetCore.App",
        "8.0.20",
        aspNetDepsJson("8.0.21", "linux-x64"),
      );
      installFramework(
        root,
        "root/.dotnet",
        "Microsoft.NETCore.App",
        "8.0.1",
        "{",
      );
      installFramework(
        root,
        "usr/share/dotnet",
        "Some.Other.App",
        "1.0.0",
        aspNetDepsJson("1.0.0", "linux-x64"),
      );
      assert.deepStrictEqual(
        collectDotnetRuntimes(root, [
          "/usr/lib/dotnet/shared/Microsoft.AspNetCore.App/8.0.21/Microsoft.AspNetCore.App.deps.json",
        ]),
        [],
      );
      assert.deepStrictEqual(collectDotnetRuntimes(undefined), []);
    }));
});

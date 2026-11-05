import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { isWin } from "../core/paths.js";
import {
  collectDotnetRuntimes,
  createHostDotnetRuntimeComponent,
  dotnetCpe,
  parseDotnetListRuntimes,
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

function frameworkDepsJson(framework, version, rid) {
  return JSON.stringify({
    runtimeTarget: { name: `.NETCoreApp,Version=v8.0/${rid}` },
    targets: {
      [`.NETCoreApp,Version=v8.0/${rid}`]: {
        [`${framework}.Runtime.${rid}/${version}`]: {},
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

  it("spells the version and update the way the NVD CPE dictionary does", () => {
    // Runtime versions as the runtime packs name them, each with the
    // product, version and update the NVD CPE dictionary lists for it.
    const cases = [
      // .NET Core names an x.y.0 release and its pre-releases with two parts.
      ["Microsoft.NETCore.App", "1.0.0-rc2-3002702", ".net_core:1.0:rc2"],
      ["Microsoft.NETCore.App", "2.1.0-rc1", ".net_core:2.1:rc1"],
      [
        "Microsoft.NETCore.App",
        "2.2.0-preview3-27014-02",
        ".net_core:2.2:preview3",
      ],
      ["Microsoft.NETCore.App", "2.1.0", ".net_core:2.1:*"],
      [
        "Microsoft.NETCore.App",
        "3.0.0-preview9-19423-09",
        ".net_core:3.0:preview9",
      ],
      ["Microsoft.NETCore.App", "3.0.0-rc1-19456-20", ".net_core:3.0:rc1"],
      [
        "Microsoft.NETCore.App",
        "3.1.0-preview3.19553.2",
        ".net_core:3.1:preview3",
      ],
      ["Microsoft.NETCore.App", "3.1.0", ".net_core:3.1:*"],
      ["Microsoft.NETCore.App", "2.1.30", ".net_core:2.1.30:*"],
      // .NET 5.0 pre-releases have two parts as well, the release three.
      [
        "Microsoft.NETCore.App",
        "5.0.0-preview.8.20407.11",
        ".net:5.0:preview8",
      ],
      ["Microsoft.NETCore.App", "5.0.0-rc.2.20475.5", ".net:5.0:rc2"],
      ["Microsoft.NETCore.App", "5.0.0", ".net:5.0.0:*"],
      ["Microsoft.NETCore.App", "5.0.17", ".net:5.0.17:*"],
      // Only the .NET 7, 8 and 10 previews are dotted.
      [
        "Microsoft.NETCore.App",
        "6.0.0-preview.7.21377.19",
        ".net:6.0.0:preview7",
      ],
      [
        "Microsoft.NETCore.App",
        "7.0.0-preview.7.22375.6",
        ".net:7.0.0:preview.7",
      ],
      [
        "Microsoft.NETCore.App",
        "8.0.0-preview.7.23375.6",
        ".net:8.0.0:preview.7",
      ],
      [
        "Microsoft.NETCore.App",
        "10.0.0-preview.7.25380.108",
        ".net:10.0.0:preview.7",
      ],
      [
        "Microsoft.NETCore.App",
        "11.0.0-preview.7.26380.108",
        ".net:11.0.0:preview7",
      ],
      ["Microsoft.NETCore.App", "11.0.0-rc.3.26522.148", ".net:11.0.0:rc3"],
      // ASP.NET Core keeps three parts and undotted previews.
      ["Microsoft.AspNetCore.App", "3.1.0", "asp.net_core:3.1.0:*"],
      ["Microsoft.AspNetCore.App", "2.1.30", "asp.net_core:2.1.30:*"],
      [
        "Microsoft.AspNetCore.App",
        "8.0.0-preview.7.23375.9",
        "asp.net_core:8.0.0:preview7",
      ],
      [
        "Microsoft.AspNetCore.App",
        "10.0.0-rc.2.25502.107",
        "asp.net_core:10.0.0:rc2",
      ],
    ];
    for (const [framework, version, expected] of cases) {
      assert.strictEqual(
        dotnetCpe(framework, version),
        `cpe:2.3:a:microsoft:${expected}:*:*:*:*:*:*`,
        `${framework} ${version}`,
      );
    }
  });

  it("gives no CPE to a pre-release NVD names no version of", () => {
    assert.strictEqual(
      dotnetCpe("Microsoft.NETCore.App", "11.0.0-alpha.1.25370.3"),
      undefined,
    );
    assert.strictEqual(
      dotnetCpe("Microsoft.NETCore.App", "9.0.0-ci.1"),
      undefined,
    );
    assert.strictEqual(
      dotnetCpe("Microsoft.AspNetCore.App", "8.0.0-dev.1"),
      undefined,
    );
    assert.strictEqual(
      dotnetCpe("Microsoft.NETCore.App", "6.0.0-servicing.21568.2"),
      undefined,
    );
    assert.strictEqual(
      dotnetCpe("Microsoft.NETCore.App", "5.0.0-preview"),
      undefined,
    );
  });

  it("keeps the * update of a release", () => {
    assert.strictEqual(
      dotnetCpe("Microsoft.NETCore.App", "9.0.0"),
      "cpe:2.3:a:microsoft:.net:9.0.0:*:*:*:*:*:*:*",
    );
    assert.strictEqual(
      dotnetCpe("Microsoft.NETCore.App", "8.0.32"),
      "cpe:2.3:a:microsoft:.net:8.0.32:*:*:*:*:*:*:*",
    );
  });
});

describe("parseDotnetListRuntimes()", () => {
  it("reads Windows CRLF output with a directory that contains spaces", () => {
    assert.deepStrictEqual(
      parseDotnetListRuntimes(
        [
          "Microsoft.NETCore.App 8.0.33 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]",
          "Microsoft.AspNetCore.App 8.0.33 [C:\\Program Files\\dotnet\\shared\\Microsoft.AspNetCore.App]",
          "",
        ].join("\r\n"),
      ),
      [
        {
          framework: "Microsoft.NETCore.App",
          version: "8.0.33",
          frameworkDir:
            "C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App",
        },
        {
          framework: "Microsoft.AspNetCore.App",
          version: "8.0.33",
          frameworkDir:
            "C:\\Program Files\\dotnet\\shared\\Microsoft.AspNetCore.App",
        },
      ],
    );
  });

  it("reads LF output", () => {
    assert.deepStrictEqual(
      parseDotnetListRuntimes(
        "Microsoft.NETCore.App 10.0.0 [/usr/local/share/dotnet/shared/Microsoft.NETCore.App]\n",
      ),
      [
        {
          framework: "Microsoft.NETCore.App",
          version: "10.0.0",
          frameworkDir: "/usr/local/share/dotnet/shared/Microsoft.NETCore.App",
        },
      ],
    );
  });

  it("reads the twelve runtimes of the issue's host, pre-release included", () => {
    const frameworks = [
      "Microsoft.AspNetCore.App",
      "Microsoft.NETCore.App",
      "Microsoft.WindowsDesktop.App",
    ];
    const versions = ["8.0.33", "9.0.22", "10.0.14", "11.0.0-rc.3.26522.148"];
    const output = frameworks
      .flatMap((framework) =>
        versions.map(
          (version) =>
            `${framework} ${version} [/usr/local/share/dotnet/shared/${framework}]`,
        ),
      )
      .join("\r\n");
    const entries = parseDotnetListRuntimes(output);
    assert.strictEqual(entries.length, 12);
    assert.deepStrictEqual(
      [...new Set(entries.map((entry) => entry.version))],
      versions,
    );
    assert.deepStrictEqual(
      [...new Set(entries.map((entry) => entry.framework))],
      frameworks,
    );
  });

  it("leaves warnings, unknown frameworks and bracketless lines out", () => {
    assert.deepStrictEqual(
      parseDotnetListRuntimes(
        [
          "Some.Other.App 1.0.0 [/opt/dotnet/shared/Some.Other.App]",
          "8.0.1 [/usr/share/dotnet/shared/Microsoft.NETCore.App]",
          "Microsoft.NETCore.App",
          "Microsoft.NETCore.App 8.0.1",
          "Microsoft.NETCore.App 8.0.1.1 [/usr/share/dotnet/shared/Microsoft.NETCore.App]",
          "Warning: Found unexpected directory /usr/share/dotnet/sdk",
          "",
          "Microsoft.NETCore.App 8.0.32 [/usr/share/dotnet/shared/Microsoft.NETCore.App]",
        ].join("\n"),
      ),
      [
        {
          framework: "Microsoft.NETCore.App",
          version: "8.0.32",
          frameworkDir: "/usr/share/dotnet/shared/Microsoft.NETCore.App",
        },
      ],
    );
  });

  it("stops at the runtime cap the module reads", () => {
    // dotnetRuntime.js reads at most MAX_FRAMEWORKS (64) runtimes
    const output = Array.from(
      { length: 70 },
      (_, i) => `Microsoft.NETCore.App 8.0.${i} [/dotnet/shared]`,
    ).join("\n");
    assert.strictEqual(parseDotnetListRuntimes(output).length, 64);
  });

  it("answers nothing without output", () => {
    assert.deepStrictEqual(parseDotnetListRuntimes(""), []);
    assert.deepStrictEqual(parseDotnetListRuntimes(undefined), []);
  });
});

describe("createHostDotnetRuntimeComponent()", () => {
  it("names the runtime pack the deps.json records, with no occurrence", () =>
    withRoot((root) => {
      const frameworkDir = join(
        root,
        "usr",
        "local",
        "share",
        "dotnet",
        "shared",
        "Microsoft.NETCore.App",
      );
      installFramework(
        root,
        "usr/local/share/dotnet",
        "Microsoft.NETCore.App",
        "8.0.32",
        readFileSync(FIXTURE, "utf-8"),
      );
      const component = createHostDotnetRuntimeComponent({
        framework: "Microsoft.NETCore.App",
        version: "8.0.32",
        frameworkDir,
      });
      assert.strictEqual(
        component.purl,
        "pkg:nuget/Microsoft.NETCore.App.Runtime.linux-arm64@8.0.32",
      );
      assert.strictEqual(
        component.cpe,
        "cpe:2.3:a:microsoft:.net:8.0.32:*:*:*:*:*:*:*",
      );
      assert.deepStrictEqual(component.properties, [
        { name: "cdx:dotnet:sharedFramework", value: "Microsoft.NETCore.App" },
        { name: "cdx:dotnet:runtimeIdentifier", value: "linux-arm64" },
      ]);
      assert.strictEqual(
        component.evidence,
        undefined,
        "host paths can name the user's home directory, so no occurrence is recorded",
      );
    }));

  it("keeps name, version and CPE when the deps.json is missing", () =>
    withRoot((root) => {
      const frameworkDir = join(
        root,
        "dotnet",
        "shared",
        "Microsoft.NETCore.App",
      );
      mkdirSync(join(frameworkDir, "9.0.0"), { recursive: true });
      const component = createHostDotnetRuntimeComponent({
        framework: "Microsoft.NETCore.App",
        version: "9.0.0",
        frameworkDir,
      });
      assert.strictEqual(component.purl, undefined);
      assert.strictEqual(
        component.cpe,
        "cpe:2.3:a:microsoft:.net:9.0.0:*:*:*:*:*:*:*",
      );
      assert.strictEqual(component.name, "Microsoft.NETCore.App");
      assert.strictEqual(component.version, "9.0.0");
      assert.deepStrictEqual(component.properties, [
        { name: "cdx:dotnet:sharedFramework", value: "Microsoft.NETCore.App" },
      ]);
    }));

  it("keeps no purl when the deps.json names another version", () =>
    withRoot((root) => {
      const frameworkDir = join(
        root,
        "dotnet",
        "shared",
        "Microsoft.NETCore.App",
      );
      // The directory says 8.0.20 but the pack is 8.0.21: not a runtime.
      installFramework(
        root,
        "dotnet",
        "Microsoft.NETCore.App",
        "8.0.20",
        frameworkDepsJson("Microsoft.NETCore.App", "8.0.21", "win-x64"),
      );
      const component = createHostDotnetRuntimeComponent({
        framework: "Microsoft.NETCore.App",
        version: "8.0.20",
        frameworkDir,
      });
      assert.strictEqual(component.purl, undefined);
      assert.strictEqual(
        component.cpe,
        "cpe:2.3:a:microsoft:.net:8.0.20:*:*:*:*:*:*:*",
      );
    }));

  it("does not read a deps.json that is a symlink", () =>
    withRoot((root) => {
      const frameworkDir = join(
        root,
        "dotnet",
        "shared",
        "Microsoft.NETCore.App",
      );
      const dir = installFramework(
        root,
        "dotnet",
        "Microsoft.NETCore.App",
        "8.0.32",
        frameworkDepsJson("Microsoft.NETCore.App", "8.0.32", "linux-arm64"),
      );
      // The target is a valid deps.json inside the framework directory, so
      // only the refusal to follow the link keeps the purl out.
      const link = join(dir, "Microsoft.NETCore.App.deps.json");
      const target = join(dir, "target.deps.json");
      writeFileSync(
        target,
        frameworkDepsJson("Microsoft.NETCore.App", "8.0.32", "linux-arm64"),
      );
      rmSync(link);
      try {
        symlinkSync(target, link);
      } catch (err) {
        if (isWin) {
          console.log(
            "skip: creating a file symlink needs privileges on Windows",
          );
          return;
        }
        throw err;
      }
      const component = createHostDotnetRuntimeComponent({
        framework: "Microsoft.NETCore.App",
        version: "8.0.32",
        frameworkDir,
      });
      assert.strictEqual(component.purl, undefined);
      assert.strictEqual(
        component.cpe,
        "cpe:2.3:a:microsoft:.net:8.0.32:*:*:*:*:*:*:*",
      );
    }));

  it("does not read a framework directory given as a relative path", () =>
    withRoot((root) => {
      installFramework(
        root,
        "dotnet",
        "Microsoft.NETCore.App",
        "8.0.32",
        frameworkDepsJson("Microsoft.NETCore.App", "8.0.32", "linux-arm64"),
      );
      // A relative path to a valid deps.json, so only the absolute-path check
      // keeps the purl out.
      const frameworkDir = relative(
        process.cwd(),
        join(root, "dotnet", "shared", "Microsoft.NETCore.App"),
      );
      if (isAbsolute(frameworkDir)) {
        console.log("The temporary directory is on another drive.");
        return;
      }
      const component = createHostDotnetRuntimeComponent({
        framework: "Microsoft.NETCore.App",
        version: "8.0.32",
        frameworkDir,
      });
      assert.strictEqual(component.purl, undefined);
      assert.strictEqual(
        component.cpe,
        "cpe:2.3:a:microsoft:.net:8.0.32:*:*:*:*:*:*:*",
      );
    }));

  it("gives WindowsDesktop a purl but no CPE", () =>
    withRoot((root) => {
      const frameworkDir = join(
        root,
        "dotnet",
        "shared",
        "Microsoft.WindowsDesktop.App",
      );
      installFramework(
        root,
        "dotnet",
        "Microsoft.WindowsDesktop.App",
        "8.0.1",
        frameworkDepsJson("Microsoft.WindowsDesktop.App", "8.0.1", "win-x64"),
      );
      const component = createHostDotnetRuntimeComponent({
        framework: "Microsoft.WindowsDesktop.App",
        version: "8.0.1",
        frameworkDir,
      });
      assert.strictEqual(
        component.purl,
        "pkg:nuget/Microsoft.WindowsDesktop.App.Runtime.win-x64@8.0.1",
      );
      assert.strictEqual(component.cpe, undefined);
      assert.deepStrictEqual(component.properties, [
        {
          name: "cdx:dotnet:sharedFramework",
          value: "Microsoft.WindowsDesktop.App",
        },
        { name: "cdx:dotnet:runtimeIdentifier", value: "win-x64" },
      ]);
    }));
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

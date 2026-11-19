import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  checkVersionRequirement,
  classifyProbeResult,
  classifySpawnRestriction,
  compareVersions,
  ecosystemForTool,
  extractVersionToken,
  parseGemfileLockBundlerVersion,
  parseGlobalJsonToolRequirements,
  parseGoModFile,
  parseJavaVersionFile,
  parseNvmrc,
  parsePackageJsonToolRequirements,
  parsePyprojectRequiresPython,
  parsePythonVersionFile,
  parseRustToolchainFile,
  parseToolVersionsFile,
  readDeclaredToolRequirements,
} from "./toolRequirements.js";

describe("compareVersions()", () => {
  it("orders dotted versions numerically", () => {
    assert.ok(compareVersions("3.9.16", "3.9.9") > 0);
    assert.ok(compareVersions("3.9.9", "3.9.16") < 0);
    assert.ok(compareVersions("3.10.0", "3.9.16") > 0);
    assert.ok(compareVersions("8.14", "8.9") > 0);
    assert.ok(compareVersions("9.1.0", "9.1.0") === 0);
    // Missing components count as zero.
    assert.ok(compareVersions("21", "21.0.0") === 0);
    assert.ok(compareVersions("21", "20.9") > 0);
  });

  it("ranks stable releases above prereleases", () => {
    assert.ok(compareVersions("3.10.0", "3.10.0-rc-1") > 0);
    assert.ok(compareVersions("4.0.0-rc-15", "4.0.0-rc-6") > 0);
    assert.ok(compareVersions("4.0.0-M1", "4.0.0-alpha-1") > 0);
    // Vendor suffixes are not prereleases.
    assert.ok(compareVersions("21.0.7-tem", "21.0.7-tem") === 0);
  });
});

describe("checkVersionRequirement()", () => {
  // Each row is [found, wanted, expected verdict]. The verdict contract:
  // an unparseable requirement or found value never yields "violated".
  const rows = [
    // exact
    ["3.9.9", "3.9.9", "satisfied"],
    ["3.9.16", "3.9.9", "violated"],
    ["21.0.7-tem", "21.0.7-tem", "satisfied"],
    ["21.0.11-tem", "21.0.7-tem", "violated"],
    // Vendor suffixes name the same release as the bare core version.
    ["21.0.7-tem", "21.0.7", "satisfied"],
    // Prerelease suffixes do not: an rc is not the stable release.
    ["4.0.0-rc-5", "4.0.0", "violated"],
    // major-only and partial pins
    ["21.0.5", "21", "satisfied"],
    ["22.0.1", "21", "violated"],
    ["20.11.9", "20.11", "satisfied"],
    ["20.10.1", "20.11", "violated"],
    // .x ranges
    ["20.3.1", "20.x", "satisfied"],
    ["19.9.0", "20.x", "violated"],
    ["20.11.2", "20.11.x", "satisfied"],
    // caret and tilde ranges
    ["20.11.5", "^20.11.1", "satisfied"],
    ["21.0.0", "^20.11.1", "violated"],
    ["20.11.9", "^20.11", "satisfied"],
    ["4.9.7", "~4.9.2", "satisfied"],
    ["4.10.0", "~4.9.2", "violated"],
    // comparison ranges
    ["18.0.1", ">=18", "satisfied"],
    ["17.0.9", ">=18", "violated"],
    ["18.0.1", ">18", "satisfied"],
    ["17.0.9", ">17", "satisfied"],
    ["19.1.0", ">=18 <=20", "satisfied"],
    ["21.0.0", ">=18 <=20", "violated"],
    ["16.9.0", ">=18 <=20", "violated"],
    ["21", ">=18 <25", "satisfied"],
    ["25", ">=18 <25", "violated"],
    // hyphen ranges
    ["1.9.0", "1.2 - 1.9", "satisfied"],
    ["1.9.2", "1.2 - 1.9", "violated"],
    ["2.0.0", "1.2 - 1.9", "violated"],
    // alternatives
    ["18.0.0", "^16 || >=18", "satisfied"],
    ["17.2.0", "^16 || >=18", "violated"],
    // unconstrained forms
    ["1.2.3", "latest", "satisfied"],
    ["0.0.0", "*", "satisfied"],
    ["1.2.3", "", "satisfied"],
    // found values embedded in tool output
    ["go version go1.23.1 darwin/arm64", ">=1.21", "satisfied"],
    ["go version go1.20.14 darwin/arm64", ">=1.21", "violated"],
    ['openjdk version "17.0.9"', "17.x", "satisfied"],
    // prerelease awareness
    ["4.0.0-rc-1", ">=3.9.9", "satisfied"],
    ["3.9.9-m1", "3.9.9", "violated"],
    // unparseable requirements and found values never violate
    ["3.9.9", "banana", "unparseable"],
    ["3.9.9", "file:../sibling", "unparseable"],
    ["", "3.9.9", "unparseable"],
    ["unknown", ">=18", "unparseable"],
    // A satisfied alternative wins before an unparseable one is consulted;
    // when no alternative is satisfied, unparseable beats violated.
    ["20.1.2", ">=18 || custom-channel", "satisfied"],
    ["17.0.0", ">=18 || custom-channel", "unparseable"],
  ];

  for (const [found, wanted, expected] of rows) {
    it(`found ${JSON.stringify(found)} vs wanted ${JSON.stringify(wanted)} is ${expected}`, () => {
      assert.strictEqual(checkVersionRequirement(found, wanted), expected);
    });
  }
});

describe("extractVersionToken()", () => {
  it("pulls version tokens out of tool output", () => {
    assert.strictEqual(
      extractVersionToken("rustc 1.82.0 (abc 2024-10-08)"),
      "1.82.0",
    );
    assert.strictEqual(extractVersionToken("v20.11.1"), "20.11.1");
    assert.strictEqual(extractVersionToken("openjdk 25 2025-09-16"), "25");
    assert.strictEqual(extractVersionToken("Python 3.12.7"), "3.12.7");
    assert.strictEqual(extractVersionToken("no version here"), undefined);
    assert.strictEqual(extractVersionToken(undefined), undefined);
  });
});

describe("parseToolVersionsFile()", () => {
  it("reads one version per tool and skips comments", () => {
    assert.deepStrictEqual(
      parseToolVersionsFile(
        "# comment\nnodejs 20.11.1\npython 3.12.7 3.11.9 # fallback\ngolang 1.23.1\n",
      ),
      { nodejs: "20.11.1", python: "3.12.7", golang: "1.23.1" },
    );
  });

  it("rejects malformed lines and content", () => {
    assert.strictEqual(
      parseToolVersionsFile("nodejs\n\n#only comments\n"),
      undefined,
    );
    assert.strictEqual(parseToolVersionsFile(""), undefined);
    assert.strictEqual(parseToolVersionsFile(undefined), undefined);
    assert.strictEqual(
      parseToolVersionsFile("123invalid-tool 1.0.0\n"),
      undefined,
    );
    // Junk tokens between the tool name and a real version are skipped.
    assert.deepStrictEqual(
      parseToolVersionsFile("nodejs not-a-version! 20.11.1\n"),
      { nodejs: "20.11.1" },
    );
  });
});

describe("parseGoModFile()", () => {
  it("prefers the toolchain directive over go", () => {
    assert.deepStrictEqual(
      parseGoModFile(
        "module example.com/x\n\ngo 1.23.0\n\ntoolchain go1.24.1\n",
      ),
      { tool: "go", version: "1.24.1", directive: "toolchain" },
    );
    assert.deepStrictEqual(
      parseGoModFile("module example.com/x\n\ngo 1.23\n"),
      { tool: "go", version: "1.23", directive: "go" },
    );
  });

  it("rejects files without usable directives", () => {
    assert.strictEqual(parseGoModFile("module example.com/x\n"), undefined);
    assert.strictEqual(parseGoModFile(""), undefined);
    assert.strictEqual(parseGoModFile(undefined), undefined);
    assert.strictEqual(parseGoModFile("go not-a-version\n"), undefined);
  });
});

describe("parseRustToolchainFile()", () => {
  it("reads the channel from a toml file", () => {
    assert.deepStrictEqual(
      parseRustToolchainFile(
        '[toolchain]\nchannel = "1.82.0"\ncomponents = ["rustfmt"]\n\n[targets.aarch64-apple-darwin]\nchannel = "9.9.9"\n',
      ),
      { channel: "1.82.0" },
    );
  });

  it("reads a plain rust-toolchain file", () => {
    assert.deepStrictEqual(parseRustToolchainFile("1.82.0\n"), {
      channel: "1.82.0",
    });
    assert.deepStrictEqual(parseRustToolchainFile("nightly-2024-10-01\n"), {
      channel: "nightly-2024-10-01",
    });
  });

  it("rejects malformed content", () => {
    assert.strictEqual(parseRustToolchainFile("[toolchain]\n"), undefined);
    assert.strictEqual(parseRustToolchainFile(""), undefined);
    assert.strictEqual(parseRustToolchainFile(undefined), undefined);
    assert.strictEqual(parseRustToolchainFile("channel = \n"), undefined);
  });
});

describe("parsePackageJsonToolRequirements()", () => {
  it("reads engines.node and packageManager", () => {
    assert.deepStrictEqual(
      parsePackageJsonToolRequirements(
        '{"engines": {"node": ">=18"}, "packageManager": "pnpm@9.1.0"}',
      ),
      { node: ">=18", pnpm: "9.1.0" },
    );
    assert.deepStrictEqual(
      parsePackageJsonToolRequirements(
        '{"packageManager": "npm@10.2.3+sha512.abc123"}',
      ),
      { npm: "10.2.3" },
    );
    assert.deepStrictEqual(
      parsePackageJsonToolRequirements('{"engines": {"node": "^20.11"}}'),
      { node: "^20.11" },
    );
  });

  it("rejects malformed content and unrelated fields", () => {
    assert.strictEqual(
      parsePackageJsonToolRequirements("{not json"),
      undefined,
    );
    assert.strictEqual(
      parsePackageJsonToolRequirements('{"engines": {"npm": ">=9"}}'),
      undefined,
    );
    assert.strictEqual(
      parsePackageJsonToolRequirements('{"packageManager": "nonsense"}'),
      undefined,
    );
    assert.strictEqual(parsePackageJsonToolRequirements(undefined), undefined);
  });
});

describe("parseGlobalJsonToolRequirements()", () => {
  it("reads the sdk version", () => {
    assert.deepStrictEqual(
      parseGlobalJsonToolRequirements(
        '{"sdk": {"rollForward": "latestFeature", "version": "9.0.100"}}',
      ),
      { dotnet: "9.0.100" },
    );
  });

  it("rejects malformed content", () => {
    assert.strictEqual(parseGlobalJsonToolRequirements("{"), undefined);
    assert.strictEqual(
      parseGlobalJsonToolRequirements('{"sdk": {"allowPrerelease": true}}'),
      undefined,
    );
    assert.strictEqual(parseGlobalJsonToolRequirements(undefined), undefined);
  });
});

describe("parsePyprojectRequiresPython()", () => {
  it("reads the requires-python declaration", () => {
    assert.deepStrictEqual(
      parsePyprojectRequiresPython(
        '[project]\nname = "x"\nrequires-python = ">=3.12"\n',
      ),
      { python: ">=3.12" },
    );
    assert.strictEqual(
      parsePyprojectRequiresPython('[project]\nname = "x"\n'),
      undefined,
    );
    assert.strictEqual(parsePyprojectRequiresPython(""), undefined);
  });
});

describe("parseNvmrc() and parsePythonVersionFile()", () => {
  it("reads the requested versions", () => {
    assert.deepStrictEqual(parseNvmrc("v20.11.1\n"), { node: "20.11.1" });
    assert.deepStrictEqual(parseNvmrc("lts/iron # comment\n"), {
      node: "lts/iron",
    });
    assert.strictEqual(parseNvmrc("\n \n"), undefined);
    assert.deepStrictEqual(parsePythonVersionFile("3.12.7\n"), {
      python: "3.12.7",
    });
    assert.strictEqual(parsePythonVersionFile(undefined), undefined);
  });

  it("strips a comment in linear time on a line with a lone line terminator", () => {
    // A lone \r, U+2028 or U+2029 does not end a line for split(/\r?\n/) and
    // `.` does not match it, so the former /#.*$/ was retried from every `#`
    // in front of it: about 50 s for a 256 KiB line.
    for (const terminator of ["\r", "\u2028", "\u2029"]) {
      const content = `${"#".repeat(256 * 1024)}${terminator}x\n`;
      const start = Date.now();
      assert.strictEqual(parseToolVersionsFile(content), undefined);
      assert.strictEqual(parseRustToolchainFile(content), undefined);
      assert.strictEqual(parseNvmrc(content), undefined);
      assert.strictEqual(parsePythonVersionFile(content), undefined);
      assert.strictEqual(parseJavaVersionFile(content), undefined);
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed < 1000,
        `comment stripping must stay linear, took ${elapsed}ms`,
      );
    }
  });
});

describe("parseJavaVersionFile()", () => {
  it("reads bare-major and full pins verbatim", () => {
    assert.deepStrictEqual(parseJavaVersionFile("21\n"), { java: "21" });
    assert.deepStrictEqual(parseJavaVersionFile("21.0.5\n"), {
      java: "21.0.5",
    });
    assert.deepStrictEqual(parseJavaVersionFile("17.0.9+9 # temurin\n"), {
      java: "17.0.9+9",
    });
    assert.strictEqual(parseJavaVersionFile("\n"), undefined);
    assert.strictEqual(parseJavaVersionFile(undefined), undefined);
  });

  it("normalises the legacy 1.N spelling to its modern major", () => {
    // `sdk install java 1.8` names nothing, and `{{major}}` of "1.8" builds
    // the winget id `EclipseAdoptium.Temurin.1.JDK`, which does not exist.
    assert.deepStrictEqual(parseJavaVersionFile("1.8\n"), { java: "8" });
    assert.deepStrictEqual(parseJavaVersionFile("1.8.0_302\n"), { java: "8" });
    assert.deepStrictEqual(parseJavaVersionFile("1.7\n"), { java: "7" });
    // A modern release keeps every component it declared.
    assert.deepStrictEqual(parseJavaVersionFile("11.0.2\n"), {
      java: "11.0.2",
    });
  });

  it("leaves a distribution-prefixed pin unparsed", () => {
    // These name a vendor build rather than a release, so no provisioner
    // takes them as an install argument; the run reports the version as
    // unresolved and the agent asks the user.
    for (const value of ["temurin-21", "openjdk64-17.0.1", "corretto-11.0.9"]) {
      assert.strictEqual(parseJavaVersionFile(`${value}\n`), undefined);
    }
  });

  it("collects .java-version pins through readDeclaredToolRequirements", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-javaversion-"));
    try {
      writeFileSync(join(projectDir, ".java-version"), "21.0.5\n");
      const requirements = readDeclaredToolRequirements(projectDir);
      assert.strictEqual(requirements.length, 1);
      assert.strictEqual(requirements[0].tool, "java");
      assert.strictEqual(requirements[0].wanted, "21.0.5");
      assert.strictEqual(requirements[0].source, ".java-version");
      assert.strictEqual(requirements[0].ecosystem, "java");
      assert.ok(requirements[0].path.startsWith(projectDir));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("parseGemfileLockBundlerVersion()", () => {
  it("reads the BUNDLED WITH section", () => {
    assert.strictEqual(
      parseGemfileLockBundlerVersion(
        "GEM\n  specs:\n    rack (3.0.0)\n\nBUNDLED WITH\n   2.5.7\n",
      ),
      "2.5.7",
    );
    assert.strictEqual(
      parseGemfileLockBundlerVersion("GEM\n  specs:\n"),
      undefined,
    );
    assert.strictEqual(parseGemfileLockBundlerVersion(undefined), undefined);
  });
});

describe("ecosystemForTool()", () => {
  it("maps declared tools to cdxgen ecosystems", () => {
    assert.strictEqual(ecosystemForTool("nodejs"), "npm");
    assert.strictEqual(ecosystemForTool("node"), "npm");
    assert.strictEqual(ecosystemForTool("golang"), "go");
    assert.strictEqual(ecosystemForTool("python"), "python");
    assert.strictEqual(ecosystemForTool("ruby"), "ruby");
    assert.strictEqual(ecosystemForTool("rust"), "rust");
    assert.strictEqual(ecosystemForTool("java"), "java");
    assert.strictEqual(ecosystemForTool("gradle"), "java");
    assert.strictEqual(ecosystemForTool("dotnet"), "csharp");
    assert.strictEqual(ecosystemForTool("swift"), "swift");
    assert.strictEqual(ecosystemForTool("terraform"), "generic");
    assert.strictEqual(ecosystemForTool(undefined), "generic");
  });
});

describe("classifyProbeResult()", () => {
  it("reads a successful probe as found", () => {
    assert.strictEqual(
      classifyProbeResult({ status: 0, stdout: "Maven 3.9.9", stderr: "" }),
      "found",
    );
  });

  it("reads an empty result as denied, the Deno permission shape", () => {
    // Under Deno with restricted --allow-run, spawnSync of an existing
    // binary returns an object with no fields at all.
    assert.strictEqual(classifyProbeResult({}), "denied");
    assert.strictEqual(classifyProbeResult(undefined), "denied");
  });

  it("reads ENOENT and probe failures as missing", () => {
    assert.strictEqual(
      classifyProbeResult({
        status: null,
        error: { code: "ENOENT", message: "spawnSync mvn ENOENT" },
      }),
      "missing",
    );
    assert.strictEqual(
      classifyProbeResult({ status: 1, error: "not found" }),
      "missing",
    );
    assert.strictEqual(classifyProbeResult({ status: 1 }), "missing");
  });

  it("reads permission and dry-run errors as denied", () => {
    assert.strictEqual(
      classifyProbeResult({
        status: null,
        error: { code: "EACCES", message: "permission denied" },
      }),
      "denied",
    );
    assert.strictEqual(
      classifyProbeResult({
        status: 1,
        error: { message: "No execute permission" },
      }),
      "denied",
    );
    assert.strictEqual(
      classifyProbeResult({
        status: 1,
        error: { dryRun: true, message: "Dry run mode blocks execution" },
      }),
      "denied",
    );
  });
});

describe("readDeclaredToolRequirements()", () => {
  it("collects requirements from every pin file in a project", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-toolreq-"));
    try {
      writeFileSync(
        join(projectDir, ".tool-versions"),
        "nodejs 20.11.1\nruby 3.3.6\n",
      );
      writeFileSync(join(projectDir, ".nvmrc"), "20.11.1\n");
      writeFileSync(join(projectDir, "go.mod"), "module x\n\ngo 1.23.0\n");
      writeFileSync(
        join(projectDir, "rust-toolchain.toml"),
        '[toolchain]\nchannel = "1.82.0"\n',
      );
      writeFileSync(
        join(projectDir, "package.json"),
        '{"engines": {"node": ">=18"}, "packageManager": "pnpm@9.1.0"}',
      );
      writeFileSync(
        join(projectDir, "global.json"),
        '{"sdk": {"version": "9.0.100"}}',
      );

      const requirements = readDeclaredToolRequirements(projectDir);
      const requirementAt = (source, tool) =>
        requirements.find(
          (requirement) =>
            requirement.source === source && requirement.tool === tool,
        );
      assert.strictEqual(
        requirementAt(".tool-versions", "nodejs").ecosystem,
        "npm",
      );
      assert.strictEqual(
        requirementAt(".tool-versions", "nodejs").wanted,
        "20.11.1",
      );
      assert.strictEqual(
        requirementAt(".tool-versions", "ruby").wanted,
        "3.3.6",
      );
      assert.strictEqual(requirementAt(".nvmrc", "node").wanted, "20.11.1");
      assert.strictEqual(requirementAt("go.mod:go", "go").wanted, "1.23.0");
      assert.strictEqual(
        requirementAt("rust-toolchain.toml", "rustc").wanted,
        "1.82.0",
      );
      assert.strictEqual(requirementAt("package.json", "node").wanted, ">=18");
      assert.ok(
        requirements.some(
          (requirement) =>
            requirement.source === "package.json" &&
            requirement.tool === "pnpm" &&
            requirement.wanted === "9.1.0",
        ),
        "expected the packageManager pin to be collected",
      );
      assert.strictEqual(
        requirementAt("global.json", "dotnet").wanted,
        "9.0.100",
      );
      for (const requirement of requirements) {
        assert.ok(requirement.path.startsWith(projectDir));
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns an empty list for a directory without pin files", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-toolreq-empty-"));
    try {
      mkdirSync(join(projectDir, "sub"));
      assert.deepStrictEqual(readDeclaredToolRequirements(projectDir), []);
      assert.deepStrictEqual(readDeclaredToolRequirements(undefined), []);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("skips malformed pin files instead of failing", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-toolreq-bad-"));
    try {
      writeFileSync(join(projectDir, "package.json"), "{definitely not json");
      writeFileSync(join(projectDir, "go.mod"), "\x00\x01binary");
      writeFileSync(join(projectDir, ".tool-versions"), "!!!\n");
      assert.deepStrictEqual(readDeclaredToolRequirements(projectDir), []);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("classifySpawnRestriction()", () => {
  it("reports no restriction in a permissive default environment", () => {
    // With neither dry-run, secure mode, a command allowlist, nor a Deno
    // permission gate active, nothing restricts the command. The dry-run and
    // secure-mode branches need those modes enabled at module load and are
    // covered through the envcontext suite's mocks instead.
    assert.strictEqual(classifySpawnRestriction("mvn"), undefined);
    assert.strictEqual(classifySpawnRestriction(""), undefined);
  });
});

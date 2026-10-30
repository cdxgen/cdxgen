import { assert, describe, it } from "poku";

import {
  isSemver,
  normalizeVscodeTargetPlatform,
  parseVscodeExtensionDirName,
  vscodeExtensionPlatformFromPath,
} from "./vscodeExtensionId.js";

describe("parseVscodeExtensionDirName()", () => {
  it("splits a platform-specific folder name", () => {
    assert.deepStrictEqual(
      parseVscodeExtensionDirName("anthropic.claude-code-2.1.313-darwin-arm64"),
      {
        publisher: "anthropic",
        name: "claude-code",
        version: "2.1.313",
        platform: "darwin-arm64",
      },
    );
  });

  it("keeps hyphenated names and drops universal and web suffixes", () => {
    assert.deepStrictEqual(
      parseVscodeExtensionDirName(
        "devsense.composer-php-vscode-1.74.19252-universal",
      ),
      {
        publisher: "devsense",
        name: "composer-php-vscode",
        version: "1.74.19252",
        platform: "",
      },
    );
    assert.strictEqual(
      parseVscodeExtensionDirName("redhat.vscode-yaml-1.19.0-web")?.version,
      "1.19.0",
    );
  });

  it("keeps a digit after a hyphen in the name and a prerelease tag in the version", () => {
    assert.deepStrictEqual(
      parseVscodeExtensionDirName("acme.vscode-3d-viewer-1.0.0-beta-2"),
      {
        publisher: "acme",
        name: "vscode-3d-viewer",
        version: "1.0.0-beta-2",
        platform: "",
      },
    );
  });

  it("rejects names without a publisher or a version", () => {
    assert.strictEqual(
      parseVscodeExtensionDirName("extensions.json"),
      undefined,
    );
    assert.strictEqual(
      parseVscodeExtensionDirName("claude-code-2.1.0"),
      undefined,
    );
    assert.strictEqual(parseVscodeExtensionDirName("acme.tool"), undefined);
    assert.strictEqual(parseVscodeExtensionDirName(""), undefined);
  });
});

describe("normalizeVscodeTargetPlatform()", () => {
  it("accepts only specific target platforms", () => {
    assert.strictEqual(normalizeVscodeTargetPlatform("Win32-X64"), "win32-x64");
    assert.strictEqual(normalizeVscodeTargetPlatform("universal"), "");
    assert.strictEqual(normalizeVscodeTargetPlatform("undefined"), "");
    assert.strictEqual(normalizeVscodeTargetPlatform(undefined), "");
  });
});

describe("vscodeExtensionPlatformFromPath()", () => {
  it("reads the platform from POSIX and Windows paths", () => {
    assert.strictEqual(
      vscodeExtensionPlatformFromPath(
        "/home/dev/.cursor-server/extensions/anthropic.claude-code-2.1.313-linux-x64/",
      ),
      "linux-x64",
    );
    assert.strictEqual(
      vscodeExtensionPlatformFromPath(
        "C:\\Users\\dev\\.cursor\\extensions\\anthropic.claude-code-2.1.313-win32-x64",
      ),
      "win32-x64",
    );
    assert.strictEqual(
      vscodeExtensionPlatformFromPath(
        "/Users/dev/.vscode/extensions/redhat.vscode-yaml-1.19.0",
      ),
      "",
    );
  });
});

describe("isSemver() and semver-based splitting", () => {
  it("accepts semantic versions only", () => {
    for (const v of [
      "1.0.0",
      "0.3.3073",
      "2026.84.0",
      "1.0.0-beta.2",
      "1.0.0+build.5",
    ]) {
      assert.ok(isSemver(v), v);
    }
    for (const v of [
      "1.2",
      "01.0.0",
      "1.0.0-",
      "1.0.0-01",
      "1.0",
      "a.b.c",
      "",
    ]) {
      assert.ok(!isSemver(v), v);
    }
  });

  it("keeps a version-like token inside the name", () => {
    assert.deepStrictEqual(
      parseVscodeExtensionDirName("acme.python-3.11-tools-1.0.0"),
      {
        publisher: "acme",
        name: "python-3.11-tools",
        version: "1.0.0",
        platform: "",
      },
    );
  });

  it("ignores a trailing separator", () => {
    assert.strictEqual(
      parseVscodeExtensionDirName("anthropic.claude-code-2.1.313-linux-x64/")
        ?.platform,
      "linux-x64",
    );
  });
});

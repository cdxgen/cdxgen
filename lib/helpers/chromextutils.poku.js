import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it } from "poku";

import {
  CHROME_EXTENSION_PURL_TYPE,
  collectChromeExtensionsFromPath,
  collectInstalledChromeExtensions,
  compareChromiumExtensionVersions,
  getChromiumExtensionDirs,
  getChromiumProfiles,
  inferChromiumContextFromManifest,
  parseChromiumExtensionManifest,
} from "./chromextutils.js";

const baseTempDir = mkdtempSync(join(tmpdir(), "cdxgen-chromext-poku-"));
process.on("exit", () => {
  try {
    rmSync(baseTempDir, { recursive: true, force: true });
  } catch (_e) {
    // Ignore cleanup errors
  }
});

describe("CHROME_EXTENSION_PURL_TYPE", () => {
  it("should be chrome-extension", () => {
    assert.strictEqual(CHROME_EXTENSION_PURL_TYPE, "chrome-extension");
  });
});

describe("getChromiumExtensionDirs", () => {
  it("should include expected browser entries", () => {
    const dirs = getChromiumExtensionDirs();
    assert.ok(Array.isArray(dirs));
    assert.ok(dirs.length > 0);
    const browsers = dirs.map((entry) => entry.browser);
    assert.ok(browsers.includes("Google Chrome"));
    assert.ok(browsers.includes("Chromium"));
    assert.ok(browsers.includes("Microsoft Edge"));
    assert.ok(browsers.includes("Brave"));
    assert.ok(browsers.includes("Vivaldi"));
  });
});

describe("compareChromiumExtensionVersions", () => {
  it("should compare 1-4 segment numeric versions", () => {
    assert.strictEqual(compareChromiumExtensionVersions("1", "1.0"), 0);
    assert.ok(compareChromiumExtensionVersions("1.2.9", "1.2.10") < 0);
    assert.ok(compareChromiumExtensionVersions("6.0.2.3611", "6.0.2.999") > 0);
    assert.strictEqual(compareChromiumExtensionVersions("2.0", "2.0"), 0);
  });
});

describe("getChromiumProfiles", () => {
  it("should use Local State profile info_cache when available", () => {
    const userData = join(baseTempDir, "profiles-local-state");
    mkdirSync(join(userData, "Default", "Extensions"), { recursive: true });
    mkdirSync(join(userData, "Profile 1", "Extensions"), { recursive: true });
    writeFileSync(
      join(userData, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: "Person 1" },
            "Profile 1": { name: "Person 2" },
          },
        },
      }),
      "utf-8",
    );
    const profiles = getChromiumProfiles(userData);
    assert.deepStrictEqual(profiles.sort(), ["Default", "Profile 1"]);
  });

  it("should fallback to Default/Profile* directories when Local State is missing", () => {
    const userData = join(baseTempDir, "profiles-fallback");
    mkdirSync(join(userData, "Default", "Extensions"), { recursive: true });
    mkdirSync(join(userData, "Profile 2", "Extensions"), { recursive: true });
    const profiles = getChromiumProfiles(userData);
    assert.deepStrictEqual(profiles.sort(), ["Default", "Profile 2"]);
  });
});

describe("parseChromiumExtensionManifest", () => {
  it("should parse known manifest fields", () => {
    const manifestPath = join(baseTempDir, "manifest-test.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        manifest_version: 3,
        name: "Example Extension",
        description: "Sample description",
        version: "1.2.3",
        update_url: "https://example.invalid/update.xml",
      }),
      "utf-8",
    );
    const parsed = parseChromiumExtensionManifest(manifestPath);
    assert.deepStrictEqual(parsed, {
      name: "Example Extension",
      description: "Sample description",
      version: "1.2.3",
      manifestVersion: 3,
      updateUrl: "https://example.invalid/update.xml",
    });
  });
});

describe("collectInstalledChromeExtensions", () => {
  it("should select highest version and suppress duplicate components", () => {
    const browserDir = join(baseTempDir, "browser-data");
    const extId = "abcdefghijklmnopqrstuvwxzyabcdef";
    const extensionBase = join(browserDir, "Default", "Extensions", extId);
    mkdirSync(join(extensionBase, "1.0.0"), { recursive: true });
    mkdirSync(join(extensionBase, "2.1.0"), { recursive: true });
    writeFileSync(
      join(extensionBase, "1.0.0", "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Demo extension",
        description: "Version 1",
        version: "1.0.0",
      }),
      "utf-8",
    );
    writeFileSync(
      join(extensionBase, "2.1.0", "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Demo extension",
        description: "Version 2",
        version: "2.1.0",
      }),
      "utf-8",
    );

    const components = collectInstalledChromeExtensions([
      { browser: "Google Chrome", channel: "stable", dir: browserDir },
      { browser: "Google Chrome", channel: "stable", dir: browserDir },
    ]);
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0].name, extId);
    assert.strictEqual(components[0].version, "2.1.0");
    assert.strictEqual(
      components[0].purl,
      `pkg:chrome-extension/${extId}@2.1.0`,
    );
  });
});

describe("collectChromeExtensionsFromPath", () => {
  it("should parse extension-id dir and choose highest available version", () => {
    const extensionRoot = join(baseTempDir, "single-extension");
    const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const extensionIdDir = join(extensionRoot, extensionId);
    mkdirSync(join(extensionIdDir, "1.0.0"), { recursive: true });
    mkdirSync(join(extensionIdDir, "1.2.0"), { recursive: true });
    writeFileSync(
      join(extensionIdDir, "1.0.0", "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Sample One",
        version: "1.0.0",
      }),
      "utf-8",
    );
    writeFileSync(
      join(extensionIdDir, "1.2.0", "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Sample Two",
        version: "1.2.0",
      }),
      "utf-8",
    );
    const result = collectChromeExtensionsFromPath(extensionIdDir);
    assert.strictEqual(result.components.length, 1);
    assert.strictEqual(result.components[0].name, extensionId);
    assert.strictEqual(result.components[0].version, "1.2.0");
    assert.strictEqual(result.extensionDirs.length, 1);
    assert.ok(result.extensionDirs[0].endsWith(join(extensionId, "1.2.0")));
  });
});

describe("inferChromiumContextFromManifest", () => {
  it("should return empty context for paths outside known browser roots", () => {
    const manifestPath = join(baseTempDir, "outside", "manifest.json");
    const context = inferChromiumContextFromManifest(manifestPath);
    assert.deepStrictEqual(context, {});
  });
});

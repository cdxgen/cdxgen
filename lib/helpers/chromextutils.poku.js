import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "chrome-extensions",
);

function getProp(component, propName) {
  return component?.properties?.find((prop) => prop.name === propName)?.value;
}
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
        minimum_edge_version: "125.0.0.0",
        edge_url_overrides: { newtab: "edge-newtab.html" },
      }),
      "utf-8",
    );
    const parsed = parseChromiumExtensionManifest(manifestPath);
    assert.strictEqual(parsed.name, "Example Extension");
    assert.strictEqual(parsed.description, "Sample description");
    assert.strictEqual(parsed.version, "1.2.3");
    assert.strictEqual(parsed.manifestVersion, 3);
    assert.strictEqual(parsed.updateUrl, "https://example.invalid/update.xml");
    assert.deepStrictEqual(parsed.permissions, []);
    assert.deepStrictEqual(parsed.optionalPermissions, []);
    assert.deepStrictEqual(parsed.hostPermissions, []);
    assert.deepStrictEqual(parsed.optionalHostPermissions, []);
    assert.deepStrictEqual(parsed.commands, []);
    assert.deepStrictEqual(parsed.contentScriptsRunAt, []);
    assert.deepStrictEqual(parsed.webAccessibleResourceMatches, []);
    assert.deepStrictEqual(parsed.externallyConnectableMatches, []);
    assert.strictEqual(parsed.minimumChromeVersion, "");
    assert.strictEqual(parsed.minimumEdgeVersion, "125.0.0.0");
    assert.deepStrictEqual(parsed.edgeUrlOverrides, {
      newtab: "edge-newtab.html",
    });
    assert.strictEqual(parsed.storageManagedSchema, "");
    assert.strictEqual(parsed.hasAutofill, false);
  });

  it("should parse real manifest fixtures from Chrome, Chromium and Edge extensions", () => {
    const fixtureCases = [
      {
        file: "chrome-bitwarden-manifest.json",
        version: "2026.4.0",
        manifestVersion: 2,
      },
      {
        file: "chromium-ublock-origin-manifest.json",
        version: "1.15.11.0",
        manifestVersion: 2,
      },
      {
        file: "edge-dark-reader-manifest.json",
        version: "4.9.124",
        manifestVersion: 2,
      },
      {
        file: "edge-duckduckgo-manifest.json",
        version: "2026.1.12",
        manifestVersion: 3,
      },
      {
        file: "brave-core-manifest.json",
        version: "1.0.0",
        manifestVersion: 2,
      },
      {
        file: "chrome-youtube-summary-chatgpt-manifest.json",
        version: "1.0.4",
        manifestVersion: 3,
      },
      {
        file: "chrome-agentbrain-chatgpt-claude-manifest.json",
        version: "0.1.0",
        manifestVersion: 3,
      },
      {
        file: "chrome-copilottts-manifest.json",
        version: "1.0.0",
        manifestVersion: 3,
      },
    ];
    for (const fixtureCase of fixtureCases) {
      const parsed = parseChromiumExtensionManifest(
        join(fixtureDir, fixtureCase.file),
      );
      assert.ok(parsed);
      assert.strictEqual(parsed.version, fixtureCase.version);
      assert.strictEqual(parsed.manifestVersion, fixtureCase.manifestVersion);
      assert.ok(parsed.name);
    }
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

  it("should parse a real fixture from a version directory path", () => {
    const extensionRoot = join(baseTempDir, "real-fixture-extension");
    const extensionId = "cccccccccccccccccccccccccccccccc";
    const extensionVersion = "4.9.124";
    const versionDir = join(extensionRoot, extensionId, extensionVersion);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      join(versionDir, "manifest.json"),
      readFileSync(join(fixtureDir, "edge-dark-reader-manifest.json"), "utf-8"),
      "utf-8",
    );
    const result = collectChromeExtensionsFromPath(versionDir);
    assert.strictEqual(result.components.length, 1);
    assert.strictEqual(
      result.components[0].purl,
      `pkg:chrome-extension/${extensionId}@${extensionVersion}`,
    );
    assert.strictEqual(
      getProp(result.components[0], "cdx:chrome-extension:permissions"),
      "alarms, fontSettings, storage, tabs, <all_urls>",
    );
    assert.strictEqual(
      getProp(result.components[0], "cdx:chrome-extension:commands"),
      "toggle, addSite, switchEngine",
    );
    assert.strictEqual(
      getProp(result.components[0], "cdx:chrome-extension:contentScriptsRunAt"),
      "document_start",
    );
    assert.strictEqual(
      getProp(result.components[0], "cdx:chrome-extension:hasAutofill"),
      undefined,
    );
    assert.strictEqual(
      getProp(
        result.components[0],
        "cdx:chrome-extension:storageManagedSchema",
      ),
      undefined,
    );
  });

  it("should capture security-sensitive properties from a real edge manifest", () => {
    const extensionRoot = join(baseTempDir, "real-edge-fixture-extension");
    const extensionId = "dddddddddddddddddddddddddddddddd";
    const extensionVersion = "2026.1.12";
    const versionDir = join(extensionRoot, extensionId, extensionVersion);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      join(versionDir, "manifest.json"),
      readFileSync(join(fixtureDir, "edge-duckduckgo-manifest.json"), "utf-8"),
      "utf-8",
    );
    const result = collectChromeExtensionsFromPath(versionDir);
    assert.strictEqual(result.components.length, 1);
    assert.strictEqual(
      getProp(result.components[0], "cdx:chrome-extension:hostPermissions"),
      "*://*/*, <all_urls>",
    );
    assert.strictEqual(
      getProp(
        result.components[0],
        "cdx:chrome-extension:contentScriptsMatches",
      ),
      "<all_urls>",
    );
    assert.strictEqual(
      getProp(result.components[0], "cdx:chrome-extension:optionalPermissions"),
      "browsingData",
    );
    assert.strictEqual(
      getProp(result.components[0], "cdx:chrome-extension:contentScriptsRunAt"),
      "document_start",
    );
    assert.strictEqual(
      getProp(
        result.components[0],
        "cdx:chrome-extension:storageManagedSchema",
      ),
      "managed-schema.json",
    );
    assert.strictEqual(
      getProp(result.components[0], "cdx:chrome-extension:hasAutofill"),
      "true",
    );
    assert.strictEqual(
      getProp(
        result.components[0],
        "cdx:chrome-extension:minimumChromeVersion",
      ),
      "128.0",
    );
    assert.strictEqual(
      getProp(
        result.components[0],
        "cdx:chrome-extension:optionalHostPermissions",
      ),
      undefined,
    );
    assert.strictEqual(
      getProp(
        result.components[0],
        "cdx:chrome-extension:webAccessibleResourceMatches",
      ),
      "<all_urls>",
    );
    assert.strictEqual(
      getProp(result.components[0], "cdx:chrome-extension:capability:network"),
      "true",
    );
    assert.strictEqual(
      getProp(
        result.components[0],
        "cdx:chrome-extension:capability:codeInjection",
      ),
      "true",
    );
  });

  it("should capture brave-specific manifest fields with explicit property names", () => {
    const extensionRoot = join(baseTempDir, "real-brave-fixture-extension");
    const extensionId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const extensionVersion = "1.0.0";
    const versionDir = join(extensionRoot, extensionId, extensionVersion);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      join(versionDir, "manifest.json"),
      readFileSync(join(fixtureDir, "brave-core-manifest.json"), "utf-8"),
      "utf-8",
    );
    const result = collectChromeExtensionsFromPath(versionDir);
    assert.strictEqual(result.components.length, 1);
    assert.strictEqual(
      getProp(
        result.components[0],
        "cdx:chrome-extension:brave:maybeBackground",
      ),
      "true",
    );
    assert.strictEqual(
      getProp(result.components[0], "cdx:chrome-extension:brave:permissions"),
      "settingsPrivate, webDiscovery",
    );
  });

  it("should capture AI extension fixture properties for OpenAI/Anthropic/Copilot scenarios", () => {
    const cases = [
      {
        fixture: "chrome-youtube-summary-chatgpt-manifest.json",
        extensionId: "ffffffffffffffffffffffffffffffff",
        extensionVersion: "1.0.4",
        checks: [
          ["cdx:chrome-extension:contentScriptsRunAt", undefined],
          ["cdx:chrome-extension:capabilities", "codeInjection"],
          ["cdx:chrome-extension:capability:codeInjection", "true"],
        ],
      },
      {
        fixture: "chrome-agentbrain-chatgpt-claude-manifest.json",
        extensionId: "gggggggggggggggggggggggggggggggg",
        extensionVersion: "0.1.0",
        checks: [
          [
            "cdx:chrome-extension:hostPermissions",
            "https://chat.openai.com/*, https://chatgpt.com/*, https://claude.ai/*, https://gemini.google.com/*, https://www.perplexity.ai/*, https://api.agentbrain.ch/*",
          ],
          ["cdx:chrome-extension:contentScriptsRunAt", "document_idle"],
          ["cdx:chrome-extension:capabilities", "codeInjection"],
          ["cdx:chrome-extension:capability:codeInjection", "true"],
        ],
      },
      {
        fixture: "chrome-copilottts-manifest.json",
        extensionId: "hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
        extensionVersion: "1.0.0",
        checks: [
          ["cdx:chrome-extension:permissions", "activeTab, scripting, storage"],
          ["cdx:chrome-extension:contentScriptsRunAt", "document_idle"],
          ["cdx:chrome-extension:capabilities", "codeInjection"],
          ["cdx:chrome-extension:capability:codeInjection", "true"],
        ],
      },
    ];
    for (const fixtureCase of cases) {
      const extensionRoot = join(
        baseTempDir,
        `ai-extension-${fixtureCase.extensionId}`,
      );
      const versionDir = join(
        extensionRoot,
        fixtureCase.extensionId,
        fixtureCase.extensionVersion,
      );
      mkdirSync(versionDir, { recursive: true });
      writeFileSync(
        join(versionDir, "manifest.json"),
        readFileSync(join(fixtureDir, fixtureCase.fixture), "utf-8"),
        "utf-8",
      );
      const result = collectChromeExtensionsFromPath(versionDir);
      assert.strictEqual(result.components.length, 1);
      for (const [propName, expectedValue] of fixtureCase.checks) {
        assert.strictEqual(
          getProp(result.components[0], propName),
          expectedValue,
          `${fixtureCase.fixture} expected ${propName}`,
        );
      }
    }
  });
});

describe("inferChromiumContextFromManifest", () => {
  it("should return empty context for paths outside known browser roots", () => {
    const manifestPath = join(baseTempDir, "outside", "manifest.json");
    const context = inferChromiumContextFromManifest(manifestPath);
    assert.deepStrictEqual(context, {});
  });
});

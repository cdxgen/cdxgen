import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it } from "poku";

import {
  cleanupTempDir,
  collectInstalledExtensions,
  extractExtensionCapabilities,
  getIdeExtensionDirs,
  parseExtensionDirName,
  parseInstalledExtensionDir,
  parseVsixManifest,
  parseVsixPackageJson,
  toComponent,
  VSCODE_EXTENSION_PURL_TYPE,
} from "./vsixutils.js";

describe("VSCODE_EXTENSION_PURL_TYPE", () => {
  it("should be vscode-extension", () => {
    assert.strictEqual(VSCODE_EXTENSION_PURL_TYPE, "vscode-extension");
  });
});

describe("getIdeExtensionDirs", () => {
  it("should return an array of IDE configurations", () => {
    const ides = getIdeExtensionDirs();
    assert.ok(Array.isArray(ides));
    assert.ok(ides.length > 0);
    for (const ide of ides) {
      assert.ok(ide.name, "Each IDE should have a name");
      assert.ok(Array.isArray(ide.dirs), "Each IDE should have dirs array");
      assert.ok(ide.dirs.length > 0, "Each IDE should have at least one dir");
    }
  });

  it("should include well-known IDEs", () => {
    const ides = getIdeExtensionDirs();
    const names = ides.map((ide) => ide.name);
    assert.ok(names.includes("VS Code"), "Should include VS Code");
    assert.ok(
      names.includes("VS Code Insiders"),
      "Should include VS Code Insiders",
    );
    assert.ok(names.includes("VSCodium"), "Should include VSCodium");
    assert.ok(names.includes("Cursor"), "Should include Cursor");
    assert.ok(names.includes("Windsurf"), "Should include Windsurf");
    assert.ok(names.includes("Positron"), "Should include Positron");
    assert.ok(names.includes("Theia"), "Should include Theia");
    assert.ok(names.includes("code-server"), "Should include code-server");
    assert.ok(names.includes("Trae"), "Should include Trae");
    assert.ok(names.includes("Augment Code"), "Should include Augment Code");
    assert.ok(
      names.includes("VS Code Remote"),
      "Should include VS Code Remote",
    );
    assert.ok(
      names.includes("OpenVSCode Server"),
      "Should include OpenVSCode Server",
    );
  });
});

describe("parseVsixManifest", () => {
  it("should return undefined for empty input", () => {
    assert.strictEqual(parseVsixManifest(""), undefined);
    assert.strictEqual(parseVsixManifest(null), undefined);
    assert.strictEqual(parseVsixManifest(undefined), undefined);
  });

  it("should parse a valid vsixmanifest XML", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="python" Version="2023.25.0" Publisher="ms-python" TargetPlatform="linux-x64" />
    <DisplayName>Python</DisplayName>
    <Description>Python language support</Description>
  </Metadata>
</PackageManifest>`;
    const result = parseVsixManifest(xml);
    assert.ok(result);
    assert.strictEqual(result.publisher, "ms-python");
    assert.strictEqual(result.name, "python");
    assert.strictEqual(result.version, "2023.25.0");
    assert.strictEqual(result.displayName, "Python");
    assert.strictEqual(result.description, "Python language support");
    assert.strictEqual(result.platform, "linux-x64");
  });

  it("should handle manifest without TargetPlatform", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="csharp" Version="2.15.30" Publisher="muhammad-sammy" />
    <DisplayName>C#</DisplayName>
    <Description>C# language support</Description>
  </Metadata>
</PackageManifest>`;
    const result = parseVsixManifest(xml);
    assert.ok(result);
    assert.strictEqual(result.publisher, "muhammad-sammy");
    assert.strictEqual(result.name, "csharp");
    assert.strictEqual(result.version, "2.15.30");
    assert.strictEqual(result.platform, "");
  });

  it("should handle manifest without Description or DisplayName", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="myext" Version="1.0.0" Publisher="testpub" />
  </Metadata>
</PackageManifest>`;
    const result = parseVsixManifest(xml);
    assert.ok(result);
    assert.strictEqual(result.publisher, "testpub");
    assert.strictEqual(result.name, "myext");
    assert.strictEqual(result.version, "1.0.0");
    assert.strictEqual(result.displayName, "");
    assert.strictEqual(result.description, "");
  });

  it("should return undefined for invalid XML", () => {
    const result = parseVsixManifest("not xml at all");
    assert.strictEqual(result, undefined);
  });

  it("should return undefined for XML without PackageManifest", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><root><child /></root>`;
    const result = parseVsixManifest(xml);
    assert.strictEqual(result, undefined);
  });

  it("should lowercase publisher and name", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="MyExtension" Version="1.0.0" Publisher="MyPublisher" />
    <DisplayName>My Extension</DisplayName>
    <Description>A test extension</Description>
  </Metadata>
</PackageManifest>`;
    const result = parseVsixManifest(xml);
    assert.ok(result);
    assert.strictEqual(result.publisher, "mypublisher");
    assert.strictEqual(result.name, "myextension");
  });
});

describe("extractExtensionCapabilities", () => {
  it("should return empty object for null/undefined", () => {
    assert.deepStrictEqual(extractExtensionCapabilities(null), {});
    assert.deepStrictEqual(extractExtensionCapabilities(undefined), {});
  });

  it("should extract activation events", () => {
    const pkg = {
      activationEvents: ["onLanguage:python", "onCommand:python.runLinting"],
    };
    const caps = extractExtensionCapabilities(pkg);
    assert.deepStrictEqual(caps.activationEvents, [
      "onLanguage:python",
      "onCommand:python.runLinting",
    ]);
  });

  it("should flag wildcard activation (always-on extension)", () => {
    const pkg = { activationEvents: ["*"] };
    const caps = extractExtensionCapabilities(pkg);
    assert.deepStrictEqual(caps.activationEvents, ["*"]);
  });

  it("should extract extensionKind", () => {
    const pkg = { extensionKind: ["workspace"] };
    const caps = extractExtensionCapabilities(pkg);
    assert.deepStrictEqual(caps.extensionKind, ["workspace"]);
  });

  it("should extract extensionDependencies", () => {
    const pkg = {
      extensionDependencies: ["ms-python.python", "ms-toolsai.jupyter"],
    };
    const caps = extractExtensionCapabilities(pkg);
    assert.deepStrictEqual(caps.extensionDependencies, [
      "ms-python.python",
      "ms-toolsai.jupyter",
    ]);
  });

  it("should extract extensionPack", () => {
    const pkg = {
      extensionPack: [
        "ms-python.python",
        "ms-python.vscode-pylance",
        "ms-toolsai.jupyter",
      ],
    };
    const caps = extractExtensionCapabilities(pkg);
    assert.deepStrictEqual(caps.extensionPack, [
      "ms-python.python",
      "ms-python.vscode-pylance",
      "ms-toolsai.jupyter",
    ]);
  });

  it("should extract workspace trust configuration", () => {
    const pkg = {
      capabilities: {
        untrustedWorkspaces: {
          supported: "limited",
          description: "Only basic",
        },
        virtualWorkspaces: { supported: false },
      },
    };
    const caps = extractExtensionCapabilities(pkg);
    assert.deepStrictEqual(caps.untrustedWorkspaces, {
      supported: "limited",
      description: "Only basic",
    });
    assert.deepStrictEqual(caps.virtualWorkspaces, { supported: false });
  });

  it("should extract contributed features", () => {
    const pkg = {
      contributes: {
        commands: [{ command: "ext.run", title: "Run" }],
        debuggers: [{ type: "python", label: "Python" }],
        terminal: [{ id: "ext.terminal" }],
        authentication: [{ id: "ext.auth", label: "My Auth" }],
      },
    };
    const caps = extractExtensionCapabilities(pkg);
    assert.ok(caps.contributes.includes("commands:1"));
    assert.ok(caps.contributes.includes("debuggers:1"));
    assert.ok(caps.contributes.includes("terminal-access"));
    assert.ok(caps.contributes.includes("authentication-provider"));
  });

  it("should extract main and browser entry points", () => {
    const pkg = {
      main: "./dist/extension.js",
      browser: "./dist/web/extension.js",
    };
    const caps = extractExtensionCapabilities(pkg);
    assert.strictEqual(caps.main, "./dist/extension.js");
    assert.strictEqual(caps.browser, "./dist/web/extension.js");
  });

  it("should detect lifecycle scripts", () => {
    const pkg = {
      scripts: {
        postinstall: "node setup.js",
        "vscode:prepublish": "npm run build",
        "vscode:uninstall": "node cleanup.js",
        test: "jest",
      },
    };
    const caps = extractExtensionCapabilities(pkg);
    assert.ok(caps.lifecycleScripts.includes("postinstall"));
    assert.ok(caps.lifecycleScripts.includes("vscode:prepublish"));
    assert.ok(caps.lifecycleScripts.includes("vscode:uninstall"));
    assert.ok(
      !caps.lifecycleScripts.includes("test"),
      "test is not a lifecycle script",
    );
  });

  it("should handle extension with taskDefinitions", () => {
    const pkg = {
      contributes: {
        taskDefinitions: [{ type: "npm" }],
      },
    };
    const caps = extractExtensionCapabilities(pkg);
    assert.ok(caps.contributes.includes("terminal-access"));
  });

  it("should handle extension with filesystem providers", () => {
    const pkg = {
      contributes: {
        fileSystemProviders: [{ scheme: "ftp", authority: "ftp" }],
      },
    };
    const caps = extractExtensionCapabilities(pkg);
    assert.ok(caps.contributes.includes("filesystem-provider"));
  });

  it("should return empty for extension with no capabilities", () => {
    const pkg = { name: "simple-ext", version: "1.0.0" };
    const caps = extractExtensionCapabilities(pkg);
    assert.ok(!caps.activationEvents);
    assert.ok(!caps.contributes);
    assert.ok(!caps.lifecycleScripts);
    assert.ok(!caps.main);
  });
});

describe("parseVsixPackageJson", () => {
  it("should return undefined for empty input", () => {
    assert.strictEqual(parseVsixPackageJson(""), undefined);
    assert.strictEqual(parseVsixPackageJson("{}"), undefined);
    assert.strictEqual(parseVsixPackageJson(null), undefined);
  });

  it("should parse a valid package.json string", () => {
    const json = JSON.stringify({
      name: "python",
      publisher: "ms-python",
      version: "2023.25.0",
      displayName: "Python",
      description: "Python language support with Pylance",
    });
    const result = parseVsixPackageJson(json, "/test/path");
    assert.ok(result);
    assert.strictEqual(result.publisher, "ms-python");
    assert.strictEqual(result.name, "python");
    assert.strictEqual(result.version, "2023.25.0");
    assert.strictEqual(result.displayName, "Python");
    assert.strictEqual(
      result.description,
      "Python language support with Pylance",
    );
    assert.strictEqual(result.srcPath, "/test/path");
  });

  it("should parse a pre-parsed object", () => {
    const obj = {
      name: "go",
      publisher: "golang",
      version: "0.39.1",
      displayName: "Go",
    };
    const result = parseVsixPackageJson(obj);
    assert.ok(result);
    assert.strictEqual(result.publisher, "golang");
    assert.strictEqual(result.name, "go");
    assert.strictEqual(result.version, "0.39.1");
  });

  it("should include capabilities from package.json", () => {
    const obj = {
      name: "python",
      publisher: "ms-python",
      version: "1.0.0",
      activationEvents: ["onLanguage:python"],
      main: "./dist/extension.js",
      contributes: {
        commands: [{ command: "python.run", title: "Run" }],
      },
      scripts: {
        postinstall: "node install.js",
      },
    };
    const result = parseVsixPackageJson(obj);
    assert.ok(result);
    assert.ok(result.capabilities);
    assert.deepStrictEqual(result.capabilities.activationEvents, [
      "onLanguage:python",
    ]);
    assert.strictEqual(result.capabilities.main, "./dist/extension.js");
    assert.ok(result.capabilities.contributes.includes("commands:1"));
    assert.ok(result.capabilities.lifecycleScripts.includes("postinstall"));
  });

  it("should lowercase publisher and name", () => {
    const obj = {
      name: "Python",
      publisher: "MS-Python",
      version: "1.0.0",
    };
    const result = parseVsixPackageJson(obj);
    assert.ok(result);
    assert.strictEqual(result.publisher, "ms-python");
    assert.strictEqual(result.name, "python");
  });

  it("should handle missing optional fields", () => {
    const obj = { name: "simple-ext" };
    const result = parseVsixPackageJson(obj);
    assert.ok(result);
    assert.strictEqual(result.name, "simple-ext");
    assert.strictEqual(result.publisher, "");
    assert.strictEqual(result.version, "");
    assert.strictEqual(result.displayName, "");
    assert.strictEqual(result.description, "");
  });

  it("should return undefined for invalid JSON string", () => {
    const result = parseVsixPackageJson("not json");
    assert.strictEqual(result, undefined);
  });
});

describe("toComponent", () => {
  it("should return undefined for undefined input", () => {
    assert.strictEqual(toComponent(undefined), undefined);
    assert.strictEqual(toComponent(null), undefined);
    assert.strictEqual(toComponent({}), undefined);
  });

  it("should create a component with publisher as namespace", () => {
    const extInfo = {
      publisher: "ms-python",
      name: "python",
      version: "2023.25.0",
      displayName: "Python",
      description: "Python language support",
      platform: "",
    };
    const component = toComponent(extInfo);
    assert.ok(component);
    assert.strictEqual(component.name, "python");
    assert.strictEqual(component.group, "ms-python");
    assert.strictEqual(component.version, "2023.25.0");
    assert.ok(
      component.purl.startsWith(
        "pkg:vscode-extension/ms-python/python@2023.25.0",
      ),
    );
    assert.strictEqual(component.type, "application");
  });

  it("should include platform qualifier when present", () => {
    const extInfo = {
      publisher: "golang",
      name: "go",
      version: "0.39.1",
      displayName: "Go",
      description: "",
      platform: "win32-x64",
    };
    const component = toComponent(extInfo);
    assert.ok(component);
    assert.ok(component.purl.includes("platform=win32-x64"));
  });

  it("should include IDE name in properties", () => {
    const extInfo = {
      publisher: "ms-python",
      name: "python",
      version: "1.0.0",
      displayName: "",
      description: "",
      platform: "",
    };
    const component = toComponent(extInfo, "Cursor");
    assert.ok(component);
    assert.ok(
      component.properties?.some(
        (p) => p.name === "cdx:vscode-extension:ide" && p.value === "Cursor",
      ),
    );
  });

  it("should include srcPath in properties", () => {
    const extInfo = {
      publisher: "test",
      name: "myext",
      version: "1.0.0",
      displayName: "",
      description: "",
      platform: "",
      srcPath: "/some/path",
    };
    const component = toComponent(extInfo);
    assert.ok(component);
    assert.ok(
      component.properties?.some(
        (p) => p.name === "SrcFile" && p.value === "/some/path",
      ),
    );
  });

  it("should include evidence field", () => {
    const extInfo = {
      publisher: "test",
      name: "myext",
      version: "1.0.0",
      displayName: "",
      description: "",
      platform: "",
    };
    const component = toComponent(extInfo);
    assert.ok(component);
    assert.ok(component.evidence);
    assert.ok(component.evidence.identity);
    assert.strictEqual(component.evidence.identity.field, "purl");
  });

  it("should handle extension with no publisher", () => {
    const extInfo = {
      publisher: "",
      name: "standalone-ext",
      version: "1.0.0",
      displayName: "",
      description: "",
      platform: "",
    };
    const component = toComponent(extInfo);
    assert.ok(component);
    assert.ok(
      component.purl.includes("pkg:vscode-extension/standalone-ext@1.0.0"),
    );
  });

  it("should include capability properties", () => {
    const extInfo = {
      publisher: "ms-python",
      name: "python",
      version: "1.0.0",
      displayName: "Python",
      description: "",
      platform: "",
      capabilities: {
        activationEvents: ["onLanguage:python", "*"],
        extensionKind: ["workspace"],
        extensionDependencies: ["ms-python.vscode-pylance"],
        contributes: ["commands:5", "debuggers:1", "terminal-access"],
        main: "./dist/extension.js",
        lifecycleScripts: ["postinstall", "vscode:prepublish"],
        untrustedWorkspaces: { supported: "limited" },
        virtualWorkspaces: false,
      },
    };
    const component = toComponent(extInfo);
    assert.ok(component);
    const props = component.properties;
    assert.ok(props);

    // Check activation events
    const activationProp = props.find(
      (p) => p.name === "cdx:vscode-extension:activationEvents",
    );
    assert.ok(activationProp);
    assert.ok(activationProp.value.includes("onLanguage:python"));
    assert.ok(activationProp.value.includes("*"));

    // Check extension kind
    const kindProp = props.find(
      (p) => p.name === "cdx:vscode-extension:extensionKind",
    );
    assert.ok(kindProp);
    assert.strictEqual(kindProp.value, "workspace");

    // Check extension dependencies
    const depProp = props.find(
      (p) => p.name === "cdx:vscode-extension:extensionDependencies",
    );
    assert.ok(depProp);
    assert.ok(depProp.value.includes("ms-python.vscode-pylance"));

    // Check contributes
    const contributesProp = props.find(
      (p) => p.name === "cdx:vscode-extension:contributes",
    );
    assert.ok(contributesProp);
    assert.ok(contributesProp.value.includes("commands:5"));
    assert.ok(contributesProp.value.includes("terminal-access"));

    // Check main entry point
    const mainProp = props.find((p) => p.name === "cdx:vscode-extension:main");
    assert.ok(mainProp);
    assert.strictEqual(mainProp.value, "./dist/extension.js");

    // Check lifecycle scripts
    const scriptsProp = props.find(
      (p) => p.name === "cdx:vscode-extension:lifecycleScripts",
    );
    assert.ok(scriptsProp);
    assert.ok(scriptsProp.value.includes("postinstall"));
    assert.ok(scriptsProp.value.includes("vscode:prepublish"));

    // Check untrusted workspaces
    const trustProp = props.find(
      (p) => p.name === "cdx:vscode-extension:untrustedWorkspaces",
    );
    assert.ok(trustProp);
    assert.strictEqual(trustProp.value, "limited");

    // Check virtual workspaces
    const vwsProp = props.find(
      (p) => p.name === "cdx:vscode-extension:virtualWorkspaces",
    );
    assert.ok(vwsProp);
    assert.strictEqual(vwsProp.value, "false");
  });
});

describe("parseExtensionDirName", () => {
  it("should parse publisher.name-version pattern", () => {
    const component = parseExtensionDirName(
      "/home/user/.vscode/extensions/ms-python.python-2023.25.0",
    );
    assert.ok(component);
    assert.strictEqual(component.group, "ms-python");
    assert.strictEqual(component.name, "python");
    assert.strictEqual(component.version, "2023.25.0");
  });

  it("should parse complex extension names", () => {
    const component = parseExtensionDirName(
      "/home/user/.vscode/extensions/redhat.vscode-xml-0.27.1",
    );
    assert.ok(component);
    assert.strictEqual(component.group, "redhat");
    assert.strictEqual(component.name, "vscode-xml");
    assert.strictEqual(component.version, "0.27.1");
  });

  it("should return undefined for non-matching names", () => {
    assert.strictEqual(parseExtensionDirName("/some/random/path"), undefined);
    assert.strictEqual(parseExtensionDirName(""), undefined);
  });

  it("should handle Windows paths", () => {
    const component = parseExtensionDirName(
      "C:\\Users\\test\\.vscode\\extensions\\golang.go-0.39.1",
    );
    assert.ok(component);
    assert.strictEqual(component.group, "golang");
    assert.strictEqual(component.name, "go");
    assert.strictEqual(component.version, "0.39.1");
  });

  it("should lowercase publisher and name", () => {
    const component = parseExtensionDirName(
      "/home/user/.vscode/extensions/MyPublisher.MyExt-1.0.0",
    );
    assert.ok(component);
    assert.strictEqual(component.group, "mypublisher");
    assert.strictEqual(component.name, "myext");
  });
});

describe("parseInstalledExtensionDir", () => {
  const testDir = join(tmpdir(), `cdxgen-vsix-test-${Date.now()}`);

  it("should parse extension dir with package.json", () => {
    const extDir = join(testDir, "ms-python.python-2023.25.0");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({
        name: "python",
        publisher: "ms-python",
        version: "2023.25.0",
        displayName: "Python",
        description: "Python language support",
      }),
    );
    const component = parseInstalledExtensionDir(extDir, "VS Code");
    assert.ok(component);
    assert.strictEqual(component.name, "python");
    assert.strictEqual(component.group, "ms-python");
    assert.strictEqual(component.version, "2023.25.0");
    assert.ok(
      component.purl.startsWith(
        "pkg:vscode-extension/ms-python/python@2023.25.0",
      ),
    );
    assert.ok(
      component.properties?.some(
        (p) => p.name === "cdx:vscode-extension:ide" && p.value === "VS Code",
      ),
    );
  });

  it("should parse extension dir with package.json and extract capabilities", () => {
    const extDir = join(testDir, "ms-python.python-cap-2023.25.0");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({
        name: "python",
        publisher: "ms-python",
        version: "2023.25.0",
        displayName: "Python",
        main: "./dist/extension.js",
        activationEvents: ["onLanguage:python"],
        contributes: {
          commands: [{ command: "python.run", title: "Run" }],
          debuggers: [{ type: "python", label: "Python" }],
        },
        extensionDependencies: ["ms-python.vscode-pylance"],
      }),
    );
    const component = parseInstalledExtensionDir(extDir, "VS Code");
    assert.ok(component);
    // Should have capability properties
    assert.ok(
      component.properties?.some(
        (p) => p.name === "cdx:vscode-extension:activationEvents",
      ),
      "Should extract activationEvents",
    );
    assert.ok(
      component.properties?.some((p) => p.name === "cdx:vscode-extension:main"),
      "Should extract main entry point",
    );
    assert.ok(
      component.properties?.some(
        (p) => p.name === "cdx:vscode-extension:contributes",
      ),
      "Should extract contributed features",
    );
    assert.ok(
      component.properties?.some(
        (p) => p.name === "cdx:vscode-extension:extensionDependencies",
      ),
      "Should extract extension dependencies",
    );
  });

  it("should parse extension dir with .vsixmanifest", () => {
    const extDir = join(testDir, "golang.go-0.39.1");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, ".vsixmanifest"),
      `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="go" Version="0.39.1" Publisher="golang" />
    <DisplayName>Go</DisplayName>
    <Description>Go language support</Description>
  </Metadata>
</PackageManifest>`,
    );
    const component = parseInstalledExtensionDir(extDir, "VS Code");
    assert.ok(component);
    assert.strictEqual(component.name, "go");
    assert.strictEqual(component.group, "golang");
    assert.strictEqual(component.version, "0.39.1");
  });

  it("should fall back to directory name parsing", () => {
    const extDir = join(testDir, "redhat.vscode-yaml-1.14.0");
    mkdirSync(extDir, { recursive: true });
    // No package.json or .vsixmanifest
    const component = parseInstalledExtensionDir(extDir);
    assert.ok(component);
    assert.strictEqual(component.group, "redhat");
    assert.strictEqual(component.name, "vscode-yaml");
    assert.strictEqual(component.version, "1.14.0");
  });

  // Clean up
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe("collectInstalledExtensions", () => {
  const testDir = join(tmpdir(), `cdxgen-vsix-collect-${Date.now()}`);
  const extDir = join(testDir, "extensions");

  it("should collect extensions from an extensions directory", () => {
    // Create mock extension dirs
    const ext1 = join(extDir, "ms-python.python-2023.25.0");
    const ext2 = join(extDir, "golang.go-0.39.1");
    mkdirSync(ext1, { recursive: true });
    mkdirSync(ext2, { recursive: true });
    writeFileSync(
      join(ext1, "package.json"),
      JSON.stringify({
        name: "python",
        publisher: "ms-python",
        version: "2023.25.0",
      }),
    );
    writeFileSync(
      join(ext2, "package.json"),
      JSON.stringify({
        name: "go",
        publisher: "golang",
        version: "0.39.1",
      }),
    );

    const components = collectInstalledExtensions([
      { name: "VS Code", dir: extDir },
    ]);
    assert.ok(Array.isArray(components));
    assert.strictEqual(components.length, 2);
    const names = components.map((c) => c.name);
    assert.ok(names.includes("python"));
    assert.ok(names.includes("go"));
  });

  it("should skip hidden directories", () => {
    const hiddenDir = join(extDir, ".obsolete");
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(
      join(hiddenDir, "package.json"),
      JSON.stringify({
        name: "old-ext",
        publisher: "test",
        version: "1.0.0",
      }),
    );

    const components = collectInstalledExtensions([
      { name: "VS Code", dir: extDir },
    ]);
    const names = components.map((c) => c.name);
    assert.ok(!names.includes("old-ext"), "Should not include hidden dirs");
  });

  it("should deduplicate by purl", () => {
    // Same extension in two different IDE dirs
    const ideDir1 = join(testDir, "ide1-ext");
    const ideDir2 = join(testDir, "ide2-ext");
    const ext1 = join(ideDir1, "ms-python.python-2023.25.0");
    const ext2 = join(ideDir2, "ms-python.python-2023.25.0");
    mkdirSync(ext1, { recursive: true });
    mkdirSync(ext2, { recursive: true });
    const pkgJson = JSON.stringify({
      name: "python",
      publisher: "ms-python",
      version: "2023.25.0",
    });
    writeFileSync(join(ext1, "package.json"), pkgJson);
    writeFileSync(join(ext2, "package.json"), pkgJson);

    const components = collectInstalledExtensions([
      { name: "IDE1", dir: ideDir1 },
      { name: "IDE2", dir: ideDir2 },
    ]);
    const pythonComponents = components.filter((c) => c.name === "python");
    assert.strictEqual(
      pythonComponents.length,
      1,
      "Should deduplicate by purl",
    );
  });

  it("should handle non-existent directory gracefully", () => {
    const components = collectInstalledExtensions([
      { name: "Nonexistent", dir: "/nonexistent/path/that/does/not/exist" },
    ]);
    assert.ok(Array.isArray(components));
    assert.strictEqual(components.length, 0);
  });

  // Clean up
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe("cleanupTempDir", () => {
  it("should not throw for null/undefined", () => {
    assert.doesNotThrow(() => cleanupTempDir(null));
    assert.doesNotThrow(() => cleanupTempDir(undefined));
    assert.doesNotThrow(() => cleanupTempDir(""));
  });

  it("should clean up a temp dir with vsix-deps- prefix", () => {
    const tempDir = join(tmpdir(), "vsix-deps-test-cleanup");
    mkdirSync(tempDir, { recursive: true });
    assert.ok(existsSync(tempDir));
    cleanupTempDir(tempDir);
    assert.ok(!existsSync(tempDir), "Should have been removed");
  });

  it("should not remove dirs without vsix-deps- prefix", () => {
    const tempDir = join(tmpdir(), "some-other-dir-test");
    mkdirSync(tempDir, { recursive: true });
    assert.ok(existsSync(tempDir));
    cleanupTempDir(tempDir);
    assert.ok(existsSync(tempDir), "Should NOT have been removed");
    // Manual cleanup
    rmSync(tempDir, { recursive: true, force: true });
  });
});

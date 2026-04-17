import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it } from "poku";

import {
  cleanupTempDir,
  collectInstalledExtensions,
  extractExtensionCapabilities,
  getIdeExtensionDirs,
  parseExtensionDependencies,
  parseExtensionDirName,
  parseInstalledExtensionDir,
  parseVsixManifest,
  parseVsixPackageJson,
  toComponent,
  VSCODE_EXTENSION_PURL_TYPE,
} from "./vsixutils.js";

const baseTempDir = mkdtempSync(join(tmpdir(), "cdxgen-vsix-poku-"));
process.on("exit", () => {
  try {
    rmSync(baseTempDir, { recursive: true, force: true });
  } catch (_e) {
    // Ignore cleanup errors
  }
});

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

  it("should handle larger manifest with tags", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0"
    xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"
    xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">

  <Metadata>
    <Identity Id="MyCompany.MyExtension"
              Version="1.2.3"
              Language="en-US"
              Publisher="My Company" />
    <DisplayName>My Awesome Extension</DisplayName>
    <Description xml:space="preserve">A description of what this extension does.</Description>
    <MoreInfo>https://github.com/mycompany/myextension</MoreInfo>
    <License>LICENSE.txt</License>
    <Icon>Resources\\icon.png</Icon>
    <PreviewImage>Resources\\preview.png</PreviewImage>
    <Tags>productivity, coding, tools</Tags>
  </Metadata>

  <Installation InstalledByMsi="false" AllUsers="false">
    <InstallationTarget Id="Microsoft.VisualStudio.Community" Version="[17.0,)" />
    <InstallationTarget Id="Microsoft.VisualStudio.Pro" Version="[17.0,)" />
    <InstallationTarget Id="Microsoft.VisualStudio.Enterprise" Version="[17.0,)" />
  </Installation>

  <Dependencies>
    <Dependency Id="Microsoft.Framework.NDP"
                DisplayName=".NET Framework"
                d:Source="Manual"
                Version="[4.8,)" />
  </Dependencies>

  <Prerequisites>
    <Prerequisite Id="Microsoft.VisualStudio.Component.CoreEditor"
                  Version="[17.0,)"
                  DisplayName="Visual Studio core editor" />
  </Prerequisites>

  <Assets>
    <Asset Type="Microsoft.VisualStudio.VsPackage"
           d:Source="Project"
           d:ProjectName="%CurrentProject%"
           Path="|%CurrentProject%;PkgdefProjectOutputGroup|" />
    <Asset Type="Microsoft.VisualStudio.MefComponent"
           d:Source="Project"
           d:ProjectName="%CurrentProject%"
           Path="|%CurrentProject%|" />
  </Assets>
</PackageManifest>`;
    const result = parseVsixManifest(xml);
    assert.ok(result);
    assert.strictEqual(result.publisher, "My Company");
    assert.strictEqual(result.name, "MyCompany.MyExtension");
    assert.strictEqual(result.version, "1.2.3");
    assert.strictEqual(result.displayName, "My Awesome Extension");
    assert.strictEqual(
      result.description,
      "A description of what this extension does.",
    );
    assert.deepStrictEqual(result.tags, ["productivity", "coding", "tools"]);
  });

  it("should parse a real one with tags", () => {
    const xml = `
    <?xml version="1.0" encoding="utf-8"?>
    <PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
        <Metadata>
            <Identity Language="en-US" Id="volar" Version="3.2.6" Publisher="Vue" />
            <DisplayName>Vue (Official)</DisplayName>
            <Description xml:space="preserve">Language Support for Vue</Description>
            <Tags>json,vue,__ext_vue,markdown,html,jade,__web_extension,__sponsor_extension</Tags>
            <Categories>Programming Languages</Categories>
            <GalleryFlags>Public</GalleryFlags>
            
            <Properties>
                <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.88.0" />
                <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
                <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
                <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace,web" />
                <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
                <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
                
                <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
                <Property Id="Microsoft.VisualStudio.Code.SponsorLink" Value="https://github.com/sponsors/johnsoncodehk" />
                <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/vuejs/language-tools.git" />
                <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="https://github.com/vuejs/language-tools.git" />
                <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="https://github.com/vuejs/language-tools.git" />
                <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="https://github.com/vuejs/language-tools/issues" />
                <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="https://github.com/vuejs/language-tools#readme" />
                
                
                <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
                <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>

                
                
            </Properties>
            <License>extension/LICENSE.txt</License>
            <Icon>extension/icon.png</Icon>
        </Metadata>
        <Installation>
            <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
        </Installation>
        <Dependencies/>
        <Assets>
            <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
            <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
<Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/changelog.md" Addressable="true" />
<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true" />
        </Assets>
    </PackageManifest>
    `;
    const result = parseVsixManifest(xml);
    assert.ok(result);
    assert.strictEqual(result.publisher, "Vue");
    assert.strictEqual(result.name, "volar");
    assert.strictEqual(result.version, "3.2.6");
    assert.strictEqual(result.displayName, "Vue (Official)");
    assert.strictEqual(result.description, "Language Support for Vue");
    assert.deepStrictEqual(result.tags, [
      "json",
      "vue",
      "__ext_vue",
      "markdown",
      "html",
      "jade",
      "__web_extension",
      "__sponsor_extension",
    ]);
  });
  it("should parse a real one with properties", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
        <PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
                <Metadata>
                        <Identity Language="en-US" Id="pyrefly" Version="0.61.0" Publisher="meta" TargetPlatform="win32-x64"/>
                        <DisplayName>Pyrefly - Python Language Tooling</DisplayName>
                        <Description xml:space="preserve">Python autocomplete, typechecking, code navigation and more! Powered by Pyrefly, an open-source language server</Description>
                        <Tags>multi-root ready,python,type,typecheck,typehint,completion,lint,Python,__ext_py,__ext_pyi</Tags>
                        <Categories>Programming Languages,Linters,Other</Categories>
                        <GalleryFlags>Public</GalleryFlags>

                        <Properties>
                                <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.94.0" />
                                <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="ms-python.python" />
                                <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
                                <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
                                <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
                                <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />

                                <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />

                                <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/facebook/pyrefly.git" />
                                <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="https://github.com/facebook/pyrefly.git" />
                                <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="https://github.com/facebook/pyrefly.git" />
                                <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="https://github.com/facebook/pyrefly/issues" />
                                <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="https://github.com/facebook/pyrefly#readme" />


                                <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
                                <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>



                        </Properties>
                        <License>extension/LICENSE.txt</License>
                        <Icon>extension/images/pyrefly-symbol.png</Icon>
                </Metadata>
                <Installation>
                        <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
                </Installation>
                <Dependencies/>
                <Assets>
                        <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
                        <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/images/pyrefly-symbol.png" Addressable="true" />
                </Assets>
        </PackageManifest>`;
    const result = parseVsixManifest(xml);
    assert.ok(result);
    assert.strictEqual(result.publisher, "meta");
    assert.strictEqual(result.name, "pyrefly");
    assert.strictEqual(result.version, "0.61.0");
    assert.strictEqual(result.platform, "win32-x64");
    assert.strictEqual(result.displayName, "Pyrefly - Python Language Tooling");
    // Properties tag parsing
    assert.strictEqual(result.vscodeEngine, "^1.94.0");
    assert.deepStrictEqual(result.extensionDependencies, ["ms-python.python"]);
    assert.deepStrictEqual(result.extensionKind, ["workspace"]);
    assert.strictEqual(result.executesCode, true);
    // Links from Properties
    assert.ok(result.links);
    assert.strictEqual(
      result.links.Source,
      "https://github.com/facebook/pyrefly.git",
    );
    assert.strictEqual(
      result.links.GitHub,
      "https://github.com/facebook/pyrefly.git",
    );
    assert.strictEqual(
      result.links.Support,
      "https://github.com/facebook/pyrefly/issues",
    );
    assert.strictEqual(
      result.links.Learn,
      "https://github.com/facebook/pyrefly#readme",
    );
    // Empty ExtensionPack should not be set
    assert.strictEqual(result.extensionPack, undefined);
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
    assert.ok(caps.contributes.includes("commands:count:1"));
    assert.ok(caps.contributes.includes("debuggers:count:1"));
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
    assert.ok(result.capabilities.contributes.includes("commands:count:1"));
    assert.ok(result.capabilities.lifecycleScripts.includes("postinstall"));
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
  it("should handle a real one", () => {
    const result = parseVsixPackageJson(`
    {
    "private": true,
    "name": "volar",
    "version": "3.2.6",
    "repository": {
        "type": "git",
        "url": "https://github.com/vuejs/language-tools.git",
        "directory": "extensions/vscode"
    },
    "categories": [
        "Programming Languages"
    ],
    "sponsor": {
        "url": "https://github.com/sponsors/johnsoncodehk"
    },
    "icon": "icon.png",
    "displayName": "Vue (Official)",
    "description": "Language Support for Vue",
    "author": "johnsoncodehk",
    "publisher": "Vue",
    "engines": {
        "vscode": "^1.88.0"
    },
    "activationEvents": [
        "onLanguage"
    ],
    "main": "./main.js",
    "browser": "./web.js",
    "capabilities": {
        "virtualWorkspaces": {
            "supported": "limited",
            "description": "Install https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-typescript-web to have IntelliSense for .vue files in Web IDE."
        }
    },
    "contributes": {
        "jsonValidation": [
            {
                "fileMatch": [
                    "tsconfig.json",
                    "tsconfig.*.json",
                    "tsconfig-*.json",
                    "jsconfig.json",
                    "jsconfig.*.json",
                    "jsconfig-*.json"
                ],
                "url": "./schemas/vue-tsconfig.schema.json"
            }
        ],
        "languages": [
            {
                "id": "vue",
                "extensions": [
                    ".vue"
                ],
                "configuration": "./languages/vue-language-configuration.json"
            },
            {
                "id": "markdown",
                "configuration": "./languages/markdown-language-configuration.json"
            },
            {
                "id": "html",
                "configuration": "./languages/sfc-template-language-configuration.json"
            },
            {
                "id": "jade",
                "configuration": "./languages/sfc-template-language-configuration.json"
            }
        ],
        "grammars": [
            {
                "language": "vue",
                "scopeName": "text.html.vue",
                "path": "./syntaxes/vue.tmLanguage.json",
                "embeddedLanguages": {
                    "text.html.vue": "vue",
                    "text": "plaintext",
                    "text.html.derivative": "html",
                    "text.html.markdown": "markdown",
                    "text.pug": "jade",
                    "source.css": "css",
                    "source.css.scss": "scss",
                    "source.css.less": "less",
                    "source.sass": "sass",
                    "source.stylus": "stylus",
                    "source.postcss": "postcss",
                    "source.js": "javascript",
                    "source.ts": "typescript",
                    "source.js.jsx": "javascriptreact",
                    "source.tsx": "typescriptreact",
                    "source.coffee": "coffeescript",
                    "meta.tag.js": "jsx-tags",
                    "meta.tag.tsx": "jsx-tags",
                    "meta.tag.without-attributes.js": "jsx-tags",
                    "meta.tag.without-attributes.tsx": "jsx-tags",
                    "source.json": "json",
                    "source.json.comments": "jsonc",
                    "source.json5": "json5",
                    "source.yaml": "yaml",
                    "source.toml": "toml",
                    "source.graphql": "graphql"
                },
                "unbalancedBracketScopes": [
                    "keyword.operator.relational",
                    "storage.type.function.arrow",
                    "keyword.operator.bitwise.shift",
                    "meta.brace.angle",
                    "punctuation.definition.tag"
                ]
            },
            {
                "scopeName": "markdown.vue.codeblock",
                "path": "./syntaxes/markdown-vue.json",
                "injectTo": [
                    "text.html.markdown"
                ],
                "embeddedLanguages": {
                    "meta.embedded.block.vue": "vue",
                    "text.html.vue": "vue",
                    "text": "plaintext",
                    "text.html.derivative": "html",
                    "text.html.markdown": "markdown",
                    "text.pug": "jade",
                    "source.css": "css",
                    "source.css.scss": "scss",
                    "source.css.less": "less",
                    "source.sass": "sass",
                    "source.stylus": "stylus",
                    "source.postcss": "postcss",
                    "source.js": "javascript",
                    "source.ts": "typescript",
                    "source.js.jsx": "javascriptreact",
                    "source.tsx": "typescriptreact",
                    "source.coffee": "coffeescript",
                    "meta.tag.js": "jsx-tags",
                    "meta.tag.tsx": "jsx-tags",
                    "meta.tag.without-attributes.js": "jsx-tags",
                    "meta.tag.without-attributes.tsx": "jsx-tags",
                    "source.json": "json",
                    "source.json.comments": "jsonc",
                    "source.json5": "json5",
                    "source.yaml": "yaml",
                    "source.toml": "toml",
                    "source.graphql": "graphql"
                }
            },
            {
                "scopeName": "mdx.vue.codeblock",
                "path": "./syntaxes/mdx-vue.json",
                "injectTo": [
                    "source.mdx"
                ],
                "embeddedLanguages": {
                    "mdx.embedded.vue": "vue",
                    "text.html.vue": "vue",
                    "text": "plaintext",
                    "text.html.derivative": "html",
                    "text.html.markdown": "markdown",
                    "text.pug": "jade",
                    "source.css": "css",
                    "source.css.scss": "scss",
                    "source.css.less": "less",
                    "source.sass": "sass",
                    "source.stylus": "stylus",
                    "source.postcss": "postcss",
                    "source.js": "javascript",
                    "source.ts": "typescript",
                    "source.js.jsx": "javascriptreact",
                    "source.tsx": "typescriptreact",
                    "source.coffee": "coffeescript",
                    "meta.tag.js": "jsx-tags",
                    "meta.tag.tsx": "jsx-tags",
                    "meta.tag.without-attributes.js": "jsx-tags",
                    "meta.tag.without-attributes.tsx": "jsx-tags",
                    "source.json": "json",
                    "source.json.comments": "jsonc",
                    "source.json5": "json5",
                    "source.yaml": "yaml",
                    "source.toml": "toml",
                    "source.graphql": "graphql"
                }
            },
            {
                "scopeName": "vue.directives",
                "path": "./syntaxes/vue-directives.json",
                "injectTo": [
                    "text.html.vue",
                    "text.html.markdown",
                    "text.html.derivative",
                    "text.pug"
                ]
            },
            {
                "scopeName": "vue.interpolations",
                "path": "./syntaxes/vue-interpolations.json",
                "injectTo": [
                    "text.html.vue",
                    "text.html.markdown",
                    "text.html.derivative",
                    "text.pug"
                ]
            },
            {
                "scopeName": "vue.sfc.script.leading-operator-fix",
                "path": "./syntaxes/vue-sfc-script-leading-operator-fix.json",
                "injectTo": [
                    "text.html.vue"
                ]
            },
            {
                "scopeName": "vue.sfc.style.variable.injection",
                "path": "./syntaxes/vue-sfc-style-variable-injection.json",
                "injectTo": [
                    "text.html.vue"
                ]
            }
        ],
        "semanticTokenScopes": [
            {
                "language": "vue",
                "scopes": {
                    "component": [
                        "support.class.component.vue",
                        "entity.name.type.class.vue"
                    ]
                }
            },
            {
                "language": "markdown",
                "scopes": {
                    "component": [
                        "support.class.component.vue",
                        "entity.name.type.class.vue"
                    ]
                }
            },
            {
                "language": "html",
                "scopes": {
                    "component": [
                        "support.class.component.vue",
                        "entity.name.type.class.vue"
                    ]
                }
            }
        ],
        "breakpoints": [
            {
                "language": "vue"
            }
        ],
        "configuration": {
            "type": "object",
            "title": "Vue",
            "properties": {
                "vue.trace.server": {
                    "scope": "window",
                    "type": "string",
                    "enum": [
                        "off",
                        "messages",
                        "verbose"
                    ],
                    "default": "off",
                    "markdownDescription": "%configuration.trace.server%"
                },
                "vue.editor.focusMode": {
                    "type": "boolean",
                    "default": false,
                    "markdownDescription": "%configuration.editor.focusMode%"
                },
                "vue.editor.reactivityVisualization": {
                    "type": "boolean",
                    "default": true,
                    "markdownDescription": "%configuration.editor.reactivityVisualization%"
                },
                "vue.editor.templateInterpolationDecorators": {
                    "type": "boolean",
                    "default": true,
                    "markdownDescription": "%configuration.editor.templateInterpolationDecorators%"
                },
                "vue.server.path": {
                    "type": "string",
                    "markdownDescription": "%configuration.server.path%"
                },
                "vue.server.includeLanguages": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "default": [
                        "vue"
                    ],
                    "markdownDescription": "%configuration.server.includeLanguages%"
                },
                "vue.codeActions.askNewComponentName": {
                    "type": "boolean",
                    "default": true,
                    "markdownDescription": "%configuration.codeActions.askNewComponentName%"
                },
                "vue.hover.rich": {
                    "type": "boolean",
                    "default": false,
                    "markdownDescription": "%configuration.hover.rich%"
                },
                "vue.suggest.componentNameCasing": {
                    "type": "string",
                    "enum": [
                        "preferKebabCase",
                        "preferPascalCase",
                        "alwaysKebabCase",
                        "alwaysPascalCase"
                    ],
                    "enumDescriptions": [
                        "Prefer kebab-case (lowercase with hyphens, e.g. my-component)",
                        "Prefer PascalCase (UpperCamelCase, e.g. MyComponent)",
                        "Always kebab-case (enforce kebab-case, e.g. my-component)",
                        "Always PascalCase (enforce PascalCase, e.g. MyComponent)"
                    ],
                    "default": "preferPascalCase",
                    "markdownDescription": "%configuration.suggest.componentNameCasing%"
                },
                "vue.suggest.propNameCasing": {
                    "type": "string",
                    "enum": [
                        "preferKebabCase",
                        "preferCamelCase",
                        "alwaysKebabCase",
                        "alwaysCamelCase"
                    ],
                    "enumDescriptions": [
                        "Prefer kebab-case (lowercase with hyphens, e.g. my-prop)",
                        "Prefer camelCase (lowerCamelCase, e.g. myProp)",
                        "Always kebab-case (enforce kebab-case, e.g. my-prop)",
                        "Always camelCase (enforce camelCase, e.g. myProp)"
                    ],
                    "default": "preferKebabCase",
                    "markdownDescription": "%configuration.suggest.propNameCasing%"
                },
                "vue.suggest.defineAssignment": {
                    "type": "boolean",
                    "default": true,
                    "markdownDescription": "%configuration.suggest.defineAssignment%"
                },
                "vue.autoInsert.dotValue": {
                    "type": "boolean",
                    "default": false,
                    "markdownDescription": "%configuration.autoInsert.dotValue%"
                },
                "vue.autoInsert.bracketSpacing": {
                    "type": "boolean",
                    "default": true,
                    "markdownDescription": "%configuration.autoInsert.bracketSpacing%"
                },
                "vue.inlayHints.destructuredProps": {
                    "type": "boolean",
                    "default": false,
                    "markdownDescription": "%configuration.inlayHints.destructuredProps%"
                },
                "vue.inlayHints.missingProps": {
                    "type": "boolean",
                    "default": false,
                    "markdownDescription": "%configuration.inlayHints.missingProps%"
                },
                "vue.inlayHints.inlineHandlerLeading": {
                    "type": "boolean",
                    "default": false,
                    "markdownDescription": "%configuration.inlayHints.inlineHandlerLeading%"
                },
                "vue.inlayHints.optionsWrapper": {
                    "type": "boolean",
                    "default": false,
                    "markdownDescription": "%configuration.inlayHints.optionsWrapper%"
                },
                "vue.inlayHints.vBindShorthand": {
                    "type": "boolean",
                    "default": false,
                    "markdownDescription": "%configuration.inlayHints.vBindShorthand%"
                },
                "vue.format.template.initialIndent": {
                    "type": "boolean",
                    "default": true,
                    "markdownDescription": "%configuration.format.template.initialIndent%"
                },
                "vue.format.script.initialIndent": {
                    "type": "boolean",
                    "default": false,
                    "markdownDescription": "%configuration.format.script.initialIndent%"
                },
                "vue.format.style.initialIndent": {
                    "type": "boolean",
                    "default": false,
                    "markdownDescription": "%configuration.format.style.initialIndent%"
                },
                "vue.format.script.enabled": {
                    "type": "boolean",
                    "default": true,
                    "markdownDescription": "%configuration.format.script.enabled%"
                },
                "vue.format.template.enabled": {
                    "type": "boolean",
                    "default": true,
                    "markdownDescription": "%configuration.format.template.enabled%"
                },
                "vue.format.style.enabled": {
                    "type": "boolean",
                    "default": true,
                    "markdownDescription": "%configuration.format.style.enabled%"
                },
                "vue.format.wrapAttributes": {
                    "type": "string",
                    "default": "auto",
                    "enum": [
                        "auto",
                        "force",
                        "force-aligned",
                        "force-expand-multiline",
                        "aligned-multiple",
                        "preserve",
                        "preserve-aligned"
                    ],
                    "markdownDescription": "%configuration.format.wrapAttributes%"
                }
            }
        },
        "commands": [
            {
                "command": "vue.welcome",
                "title": "%command.welcome%",
                "category": "Vue"
            },
            {
                "command": "vue.action.restartServer",
                "title": "%command.action.restartServer%",
                "category": "Vue"
            }
        ],
        "menus": {
            "editor/context": [
                {
                    "command": "typescript.goToSourceDefinition",
                    "when": "tsSupportsSourceDefinition && resourceLangId == vue",
                    "group": "navigation@9"
                }
            ],
            "explorer/context": [
                {
                    "command": "typescript.findAllFileReferences",
                    "when": "tsSupportsFileReferences && resourceLangId == vue",
                    "group": "4_search"
                }
            ],
            "editor/title/context": [
                {
                    "command": "typescript.findAllFileReferences",
                    "when": "tsSupportsFileReferences && resourceLangId == vue"
                }
            ],
            "commandPalette": [
                {
                    "command": "typescript.reloadProjects",
                    "when": "editorLangId == vue && typescript.isManagedFile"
                },
                {
                    "command": "typescript.goToProjectConfig",
                    "when": "editorLangId == vue && typescript.isManagedFile"
                },
                {
                    "command": "typescript.sortImports",
                    "when": "supportedCodeAction =~ /(\\\\s|^)source\\\\.sortImports\\\\b/ && editorLangId =~ /^vue$/"
                },
                {
                    "command": "typescript.removeUnusedImports",
                    "when": "supportedCodeAction =~ /(\\\\s|^)source\\\\.removeUnusedImports\\\\b/ && editorLangId =~ /^vue$/"
                }
            ]
        }
    },
    "scripts": {
        "vscode:prepublish": "rolldown --config",
        "pack": "npx @vscode/vsce package",
        "gen-ext-meta": "vscode-ext-gen --scope vue --output src/generated-meta.ts && cd ../.. && npm run format"
    },
    "devDependencies": {
        "@types/node": "^22.10.4",
        "@types/vscode": "1.88.0",
        "@volar/typescript": "2.4.28",
        "@volar/vscode": "2.4.28",
        "@vue/language-core": "workspace:*",
        "@vue/language-server": "workspace:*",
        "@vue/typescript-plugin": "workspace:*",
        "laplacenoma": "latest",
        "reactive-vscode": "^0.4.1",
        "rolldown": "latest",
        "vscode-ext-gen": "latest",
        "vscode-tmlanguage-snapshot": "latest"
    }
}
    `);
    assert.ok(result);
    assert.strictEqual(result.publisher, "Vue");
    assert.strictEqual(result.name, "volar");
    assert.strictEqual(result.version, "3.2.6");
    assert.strictEqual(result.displayName, "Vue (Official)");
    assert.strictEqual(result.description, "Language Support for Vue");
    assert.strictEqual(result.platform, "");
    assert.strictEqual(result.srcPath, undefined);
    // Should now capture repository as external reference (was a bug before: checked packageJsonData instead of pkg)
    assert.ok(result.externalReferences);
    assert.deepStrictEqual(result.externalReferences, [
      { type: "vcs", url: "https://github.com/vuejs/language-tools.git" },
    ]);
    assert.deepStrictEqual(result.capabilities, {
      activationEvents: ["onLanguage"],
      virtualWorkspaces: {
        supported: "limited",
        description:
          "Install https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-typescript-web to have IntelliSense for .vue files in Web IDE.",
      },
      contributes: [
        "breakpoints:count:1",
        "commands:count:2",
        "language-server-plugins",
      ],
      main: "./main.js",
      browser: "./web.js",
      lifecycleScripts: ["vscode:prepublish"],
    });
    // Should capture devDependencies for later analysis
    assert.ok(result.devDependencies);
    assert.strictEqual(result.devDependencies["@types/node"], "^22.10.4");
    assert.strictEqual(result.devDependencies["@types/vscode"], "1.88.0");
    assert.strictEqual(
      result.devDependencies["@vue/language-core"],
      "workspace:*",
    );
  });
  it("should handle another real one (incomplete)", () => {
    const result = parseVsixPackageJson(`
    {
    "name": "pyrefly",
    "displayName": "Pyrefly - Python Language Tooling",
    "description": "Python autocomplete, typechecking, code navigation and more! Powered by Pyrefly, an open-source language server",
    "icon": "images/pyrefly-symbol.png",
    "extensionKind": [
        "workspace"
    ],
    "author": "Facebook",
    "license": "Apache2",
    "version": "0.61.0",
    "repository": {
        "type": "git",
        "url": "https://github.com/facebook/pyrefly"
    },
    "publisher": "meta",
    "categories": [
        "Programming Languages",
        "Linters",
        "Other"
    ],
    "keywords": [
        "multi-root ready",
        "python",
        "type",
        "typecheck",
        "typehint",
        "completion",
        "lint"
    ],
    "engines": {
        "vscode": "^1.94.0"
    },
    "main": "./dist/extension",
    "activationEvents": [
        "onLanguage:python",
        "onNotebook:jupyter-notebook"
    ],
    "capabilities": {
        "untrustedWorkspaces": {
            "supported": false,
            "description": "Pyrefly can be configured to execute binaries. A malicious actor could exploit this to run arbitrary code on your machine."
        }
    },
    "contributes": {
        "languages": [
            {
                "id": "python",
                "aliases": [
                    "Python"
                ],
                "extensions": [
                    ".py",
                    ".pyi"
                ]
            }
        ],
        "commands": [
            {
                "title": "Restart Pyrefly Client",
                "category": "pyrefly",
                "command": "pyrefly.restartClient"
            },
            {
                "title": "Fold All Docstrings",
                "category": "pyrefly",
                "command": "pyrefly.foldAllDocstrings"
            },
            {
                "title": "Unfold All Docstrings",
                "category": "pyrefly",
                "command": "pyrefly.unfoldAllDocstrings"
            },
            {
                "title": "Run File",
                "category": "pyrefly",
                "command": "pyrefly.runMain"
            },
            {
                "title": "Run Test",
                "category": "pyrefly",
                "command": "pyrefly.runTest"
            }
        ],
        "semanticTokenScopes": [
            {
                "language": "python",
                "scopes": {
                    "variable.readonly": [
                        "variable.other.constant.python"
                    ]
                }
            }
        ],
        "configurationDefaults": {
            "editor.semanticTokenColorCustomizations": {
                "rules": {
                    "variable.readonly:python": "#4EC9B0"
                }
            }
        },
        "configuration": {
            "properties": {
                "pyrefly.lspPath": {
                    "type": "string",
                    "default": "",
                    "description": "The path to the binary used for the lsp",
                    "scope": "machine-overridable"
                },
                "pyrefly.lspArguments": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "default": [
                        "lsp"
                    ],
                    "description": "Additional arguments that should be passed to the binary at pyrefly.lspPath",
                    "scope": "machine-overridable"
                },
                "python.pyrefly.disableLanguageServices": {
                    "type": "boolean",
                    "default": false,
                    "description": "If true, pyrefly will not provide other IDE services like completions, hover, definition, etc. To control type errors, see \`python.pyrefly.displayTypeErrors\`",
                    "scope": "resource"
                },
                "python.pyrefly.displayTypeErrors": {
                    "type": "string",
                    "description": "If 'default', Pyrefly will only provide type check squiggles in the IDE if your file is covered by a Pyrefly configuration. If 'force-off', Pyrefly will never provide type check squiggles in the IDE. If 'force-on', Pyrefly will always provide type check squiggles in the IDE. If 'error-missing-imports', Pyrefly will only show errors for missing imports and missing sources (missing-import, missing-source, and missing-source-for-stubs).",
                    "default": "default",
                    "enum": [
                        "default",
                        "force-on",
                        "force-off",
                        "error-missing-imports"
                    ],
                    "scope": "resource"
                },
                "pyrefly.trace.server": {
                    "type": "string",
                    "description": "Set to 'verbose' to enable LSP trace in the console",
                    "default": "off",
                    "enum": [
                        "off",
                        "verbose"
                    ]
                },
                "python.pyrefly.disabledLanguageServices": {
                    "type": "object",
                    "default": {},
                    "description": "Disable specific language services. Set individual services to true to disable them.",
                    "scope": "resource",
                    "properties": {
                        "hover": {
                            "type": "boolean",
                            "default": false
                        },
                        "documentSymbol": {
                            "type": "boolean",
                            "default": false
                        },
                        "workspaceSymbol": {
                            "type": "boolean",
                            "default": false
                        },
                        "inlayHint": {
                            "type": "boolean",
                            "default": false
                        },
                        "completion": {
                            "type": "boolean",
                            "default": false
                        },
                        "codeAction": {
                            "type": "boolean",
                            "default": false
                        },
                        "definition": {
                            "type": "boolean",
                            "default": false
                        },
                        "declaration": {
                            "type": "boolean",
                            "default": false
                        },
                        "typeDefinition": {
                            "type": "boolean",
                            "default": false
                        },
                        "references": {
                            "type": "boolean",
                            "default": false
                        },
                        "documentHighlight": {
                            "type": "boolean",
                            "default": false
                        },
                        "rename": {
                            "type": "boolean",
                            "default": false
                        },
                        "codeLens": {
                            "type": "boolean",
                            "default": false
                        },
                        "semanticTokens": {
                            "type": "boolean",
                            "default": false
                        },
                        "signatureHelp": {
                            "type": "boolean",
                            "default": false
                        },
                        "implementation": {
                            "type": "boolean",
                            "default": false
                        },
                        "callHierarchy": {
                            "type": "boolean",
                            "default": false,
                            "description": "Disable call hierarchy feature (Show Incoming/Outgoing Calls)"
                        }
                    }
                },
                "python.analysis.showHoverGoToLinks": {
                    "type": "boolean",
                    "default": true,
                    "description": "Controls whether hover tooltips include 'Go to definition' and 'Go to type definition' navigation links.",
                    "scope": "resource"
                },
                "python.analysis.completeFunctionParens": {
                    "type": "boolean",
                    "default": false,
                    "description": "Automatically insert parentheses when completing a function or method.",
                    "scope": "resource"
                },
                "python.pyrefly.syncNotebooks": {
                    "type": "boolean",
                    "default": true,
                    "description": "If true, Pyrefly will sync notebook documents with the language server. Set to false to disable notebook support."
                },
                "python.pyrefly.runnableCodeLens": {
                    "type": "boolean",
                    "default": false,
                    "description": "Enable Pyrefly's Run/Test CodeLens actions for Python files.",
                    "scope": "resource"
                },
                "python.pyrefly.streamDiagnostics": {
                    "type": "boolean",
                    "default": true,
                    "description": "If true (default), Pyrefly will stream diagnostics as they become available during recheck, providing incremental feedback. Set to false to only publish diagnostics after the full recheck completes.",
                    "scope": "resource"
                },
                "python.pyrefly.diagnosticMode": {
                    "type": "string",
                    "default": "openFilesOnly",
                    "description": "Controls the scope of Pyrefly's diagnostic analysis. When set to 'openFilesOnly', diagnostics are only provided for files that are currently open in the editor. When set to 'workspace', diagnostics are computed and published for all files in the workspace.",
                    "enum": [
                        "openFilesOnly",
                        "workspace"
                    ],
                    "scope": "resource"
                },
                "pyrefly.commentFoldingRanges": {
                    "type": "boolean",
                    "default": false,
                    "description": "Controls whether comment section folding ranges are included in the editor. When true, comments following the pattern '# Section Name ----' (with 4+ trailing dashes) create collapsible regions, similar to R's code section convention."
                },
                "python.pyrefly.configPath": {
                    "type": "string",
                    "default": "",
                    "description": "Path to a pyrefly.toml or pyproject.toml configuration file. When set, the LSP will use this config for all files in your workspace instead of the default Pyrefly config-finding logic. Prefer to use default logic wherever possible.",
                    "scope": "resource"
                }
            }
        }
    },
    "scripts": {
        "compile": "npm run check-types && node esbuild.js",
        "check-types": "tsc --noEmit",
        "watch": "npm-run-all -p watch:*",
        "watch:esbuild": "node esbuild.js --watch",
        "watch:tsc": "tsc --noEmit --watch --project tsconfig.json",
        "vscode:prepublish": "npm run package",
        "package": "npm run check-types && node esbuild.js --production",
        "test": "vscode-test"
    },
    "devDependencies": {
        "@types/mocha": "^10.0.10",
        "@types/node": "^16.11.7",
        "@types/vscode": "^1.78.1",
        "@vscode/test-cli": "^0.0.10",
        "@vscode/test-electron": "^2.5.2",
        "@vscode/vsce": "^2.9.2",
        "esbuild": "^0.25.1",
        "npm-run-all": "^4.1.5",
        "typescript": "^4.4.3"
    },
    "dependencies": {
        "@vscode/python-extension": "^1.0.5",
        "serialize-javascript": "^7.0.5",
        "underscore": "^1.13.8",
        "vsce": "^2.15.0",
        "vscode-languageclient": "9.0.1"
    },
    "extensionDependencies": [
        "ms-python.python"
    ]
}
    `);
    assert.ok(result);
    assert.strictEqual(result.publisher, "meta");
    assert.strictEqual(result.name, "pyrefly");
    assert.strictEqual(result.version, "0.61.0");
    assert.strictEqual(result.displayName, "Pyrefly - Python Language Tooling");
    // Should capture repository as external reference
    assert.ok(result.externalReferences);
    assert.deepStrictEqual(result.externalReferences, [
      { type: "vcs", url: "https://github.com/facebook/pyrefly" },
    ]);
    // Capabilities
    assert.ok(result.capabilities);
    assert.deepStrictEqual(result.capabilities.extensionKind, ["workspace"]);
    assert.deepStrictEqual(result.capabilities.activationEvents, [
      "onLanguage:python",
      "onNotebook:jupyter-notebook",
    ]);
    assert.deepStrictEqual(result.capabilities.extensionDependencies, [
      "ms-python.python",
    ]);
    assert.deepStrictEqual(result.capabilities.untrustedWorkspaces, {
      supported: false,
      description:
        "Pyrefly can be configured to execute binaries. A malicious actor could exploit this to run arbitrary code on your machine.",
    });
    assert.strictEqual(result.capabilities.main, "./dist/extension");
    assert.ok(result.capabilities.contributes.includes("commands:count:5"));
    assert.ok(
      result.capabilities.lifecycleScripts.includes("vscode:prepublish"),
    );
    // Dependencies
    assert.ok(result.dependencies);
    assert.strictEqual(
      result.dependencies["@vscode/python-extension"],
      "^1.0.5",
    );
    assert.strictEqual(result.dependencies["vscode-languageclient"], "9.0.1");
    assert.ok(result.devDependencies);
    assert.strictEqual(result.devDependencies["typescript"], "^4.4.3");
    assert.strictEqual(result.devDependencies["esbuild"], "^0.25.1");
  });
});

describe("parseExtensionDependencies", () => {
  it("should return empty arrays for package with no dependencies", () => {
    const pkg = { name: "simple-ext" };
    const result = parseExtensionDependencies(
      pkg,
      "pkg:vscode-extension/pub/simple-ext@1.0.0",
    );
    assert.deepStrictEqual(result.components, []);
    assert.deepStrictEqual(result.dependencies, []);
  });

  it("should parse dependencies with required scope", () => {
    const pkg = {
      name: "test-ext",
      dependencies: {
        lodash: "^4.17.21",
        axios: "1.6.0",
      },
    };
    const result = parseExtensionDependencies(
      pkg,
      "pkg:vscode-extension/pub/test-ext@1.0.0",
    );
    assert.strictEqual(result.components.length, 2);
    const lodashComp = result.components.find((c) => c.name === "lodash");
    assert.ok(lodashComp);
    assert.strictEqual(lodashComp.scope, "required");
    assert.strictEqual(lodashComp.versionRange, "vers:npm/>=4.17.21|<5.0.0");
    assert.strictEqual(lodashComp.type, "library");
    assert.ok(lodashComp.purl.includes("pkg:npm/lodash"));
    const axiosComp = result.components.find((c) => c.name === "axios");
    assert.ok(axiosComp);
    assert.strictEqual(axiosComp.versionRange, "vers:npm/1.6.0");
    // Should create dependency tree entry
    assert.strictEqual(result.dependencies.length, 1);
    assert.strictEqual(
      result.dependencies[0].ref,
      "pkg:vscode-extension/pub/test-ext@1.0.0",
    );
    assert.ok(result.dependencies[0].dependsOn.length === 2);
  });

  it("should parse devDependencies with optional scope", () => {
    const pkg = {
      name: "test-ext",
      devDependencies: {
        typescript: "^5.0.0",
        esbuild: "^0.19.0",
      },
    };
    const result = parseExtensionDependencies(
      pkg,
      "pkg:vscode-extension/pub/test-ext@1.0.0",
    );
    assert.strictEqual(result.components.length, 2);
    for (const comp of result.components) {
      assert.strictEqual(comp.scope, "optional");
    }
  });

  it("should parse scoped npm packages correctly", () => {
    const pkg = {
      name: "test-ext",
      dependencies: {
        "@vscode/python-extension": "^1.0.5",
        "@types/node": "^20.0.0",
      },
    };
    const result = parseExtensionDependencies(
      pkg,
      "pkg:vscode-extension/pub/test-ext@1.0.0",
    );
    assert.strictEqual(result.components.length, 2);
    const vscodePy = result.components.find(
      (c) => c.name === "python-extension",
    );
    assert.ok(vscodePy);
    assert.strictEqual(vscodePy.group, "@vscode");
    assert.ok(vscodePy.purl.includes("pkg:npm/%40vscode/python-extension"));
    const typesNode = result.components.find((c) => c.name === "node");
    assert.ok(typesNode);
    assert.strictEqual(typesNode.group, "@types");
  });

  it("should handle peerDependencies and optionalDependencies", () => {
    const pkg = {
      name: "test-ext",
      peerDependencies: {
        react: "^18.0.0",
      },
      optionalDependencies: {
        fsevents: "^2.3.0",
      },
    };
    const result = parseExtensionDependencies(
      pkg,
      "pkg:vscode-extension/pub/test-ext@1.0.0",
    );
    assert.strictEqual(result.components.length, 2);
    for (const comp of result.components) {
      assert.strictEqual(comp.scope, "optional");
    }
  });

  it("should deduplicate packages across dependency groups", () => {
    const pkg = {
      name: "test-ext",
      dependencies: {
        lodash: "^4.17.21",
      },
      devDependencies: {
        lodash: "^4.17.21",
      },
    };
    const result = parseExtensionDependencies(
      pkg,
      "pkg:vscode-extension/pub/test-ext@1.0.0",
    );
    assert.strictEqual(
      result.components.length,
      1,
      "Should deduplicate lodash",
    );
  });

  it("should skip workspace:* and latest version ranges", () => {
    const pkg = {
      name: "test-ext",
      dependencies: {
        "real-dep": "^1.0.0",
      },
      devDependencies: {
        "workspace-dep": "workspace:*",
        "latest-dep": "latest",
      },
    };
    const result = parseExtensionDependencies(
      pkg,
      "pkg:vscode-extension/pub/test-ext@1.0.0",
    );
    // All three should be created as components
    assert.strictEqual(result.components.length, 3);
    // But workspace and latest should have no versionRange
    const wsDep = result.components.find((c) => c.name === "workspace-dep");
    assert.ok(wsDep);
    assert.strictEqual(wsDep.versionRange, undefined);
    const latestDep = result.components.find((c) => c.name === "latest-dep");
    assert.ok(latestDep);
    assert.strictEqual(latestDep.versionRange, undefined);
    const realDep = result.components.find((c) => c.name === "real-dep");
    assert.ok(realDep);
    assert.strictEqual(realDep.versionRange, "vers:npm/>=1.0.0|<2.0.0");
  });

  it("should handle real-world Pyrefly dependencies", () => {
    const pkg = {
      name: "pyrefly",
      publisher: "meta",
      version: "0.61.0",
      dependencies: {
        "@vscode/python-extension": "^1.0.5",
        "serialize-javascript": "^7.0.5",
        underscore: "^1.13.8",
        vsce: "^2.15.0",
        "vscode-languageclient": "9.0.1",
      },
      devDependencies: {
        "@types/mocha": "^10.0.10",
        "@types/node": "^16.11.7",
        "@types/vscode": "^1.78.1",
        "@vscode/test-cli": "^0.0.10",
        "@vscode/test-electron": "^2.5.2",
        "@vscode/vsce": "^2.9.2",
        esbuild: "^0.25.1",
        "npm-run-all": "^4.1.5",
        typescript: "^4.4.3",
      },
    };
    const result = parseExtensionDependencies(
      pkg,
      "pkg:vscode-extension/meta/pyrefly@0.61.0",
    );
    // 5 deps + 9 devDeps = 14 total (no overlap)
    assert.strictEqual(result.components.length, 14);
    // Verify dependency tree
    assert.strictEqual(result.dependencies.length, 1);
    assert.strictEqual(
      result.dependencies[0].ref,
      "pkg:vscode-extension/meta/pyrefly@0.61.0",
    );
    assert.strictEqual(result.dependencies[0].dependsOn.length, 14);
    // Check scopes
    const requiredComps = result.components.filter(
      (c) => c.scope === "required",
    );
    const optionalComps = result.components.filter(
      (c) => c.scope === "optional",
    );
    assert.strictEqual(requiredComps.length, 5);
    assert.strictEqual(optionalComps.length, 9);
    // Check specific component
    const vscLangClient = result.components.find(
      (c) => c.name === "vscode-languageclient",
    );
    assert.ok(vscLangClient);
    assert.strictEqual(vscLangClient.scope, "required");
    assert.strictEqual(vscLangClient.versionRange, "vers:npm/9.0.1");
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

  it("should include manifest Properties fields", () => {
    const extInfo = {
      publisher: "meta",
      name: "pyrefly",
      version: "0.61.0",
      displayName: "Pyrefly",
      description: "Python tooling",
      platform: "win32-x64",
      executesCode: true,
      vscodeEngine: "^1.94.0",
      extensionDependencies: ["ms-python.python"],
      extensionKind: ["workspace"],
      links: {
        Source: "https://github.com/facebook/pyrefly.git",
        GitHub: "https://github.com/facebook/pyrefly.git",
        Support: "https://github.com/facebook/pyrefly/issues",
        Learn: "https://github.com/facebook/pyrefly#readme",
        Getstarted: "https://github.com/facebook/pyrefly.git",
      },
    };
    const component = toComponent(extInfo);
    assert.ok(component);
    const props = component.properties;
    assert.ok(props);

    // Check executesCode
    const execProp = props.find(
      (p) => p.name === "cdx:vscode-extension:executesCode",
    );
    assert.ok(execProp);
    assert.strictEqual(execProp.value, "true");

    // Check vscodeEngine
    const engineProp = props.find(
      (p) => p.name === "cdx:vscode-extension:vscodeEngine",
    );
    assert.ok(engineProp);
    assert.strictEqual(engineProp.value, "^1.94.0");

    // Check extensionDependencies from manifest
    const depProp = props.find(
      (p) => p.name === "cdx:vscode-extension:extensionDependencies",
    );
    assert.ok(depProp);
    assert.strictEqual(depProp.value, "ms-python.python");

    // Check extensionKind from manifest
    const kindProp = props.find(
      (p) => p.name === "cdx:vscode-extension:extensionKind",
    );
    assert.ok(kindProp);
    assert.strictEqual(kindProp.value, "workspace");

    // Check externalReferences from links
    assert.ok(component.externalReferences);
    assert.ok(
      component.externalReferences.some(
        (r) =>
          r.type === "vcs" &&
          r.url === "https://github.com/facebook/pyrefly.git",
      ),
    );
    assert.ok(
      component.externalReferences.some(
        (r) =>
          r.type === "issue-tracker" &&
          r.url === "https://github.com/facebook/pyrefly/issues",
      ),
    );
    assert.ok(
      component.externalReferences.some(
        (r) =>
          r.type === "documentation" &&
          r.url === "https://github.com/facebook/pyrefly#readme",
      ),
    );
    assert.ok(
      component.externalReferences.some(
        (r) =>
          r.type === "website" &&
          r.url === "https://github.com/facebook/pyrefly.git",
      ),
    );
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
});

describe("parseInstalledExtensionDir", () => {
  const testDir = join(baseTempDir, "test-installed");

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
});

describe("collectInstalledExtensions", () => {
  const testDir = join(baseTempDir, "test-collect");
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

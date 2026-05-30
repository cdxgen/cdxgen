import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { assert, describe, it } from "poku";

import {
  analyzeJsCapabilitiesFile,
  analyzeJsCryptoFile,
  analyzeSuspiciousJsFile,
  detectExtensionCapabilities,
  detectJsCryptoInventory,
  detectMcpInventory,
  detectPythonMcpInventory,
  findJSImportsExports,
} from "./analyzer.js";

const baseTempDir = mkdtempSync(join(tmpdir(), "cdxgen-analyzer-poku-"));

process.on("exit", () => {
  rmSync(baseTempDir, { recursive: true, force: true });
});

const createProject = (subDirName, entryContent) => {
  const projectDir = join(baseTempDir, subDirName);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "index.js"), entryContent, {
    encoding: "utf-8",
  });
  return projectDir;
};

const createProjectFromFixture = (subDirName, fixtureFileName) => {
  const projectDir = join(baseTempDir, subDirName);
  mkdirSync(projectDir, { recursive: true });
  const fixturePath = new URL(
    `../../test/data/${fixtureFileName}`,
    import.meta.url,
  );
  copyFileSync(fixturePath, join(projectDir, fixtureFileName));
  return projectDir;
};

const createProjectFiles = (subDirName, fileMap) => {
  const projectDir = join(baseTempDir, subDirName);
  mkdirSync(projectDir, { recursive: true });
  for (const [fileName, content] of Object.entries(fileMap)) {
    const fullPath = join(projectDir, fileName);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, { encoding: "utf-8" });
  }
  return projectDir;
};

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

function normalizePathForAssertion(filePath) {
  return String(filePath || "").replaceAll("\\", "/");
}

describe("findJSImportsExports() wasm and wasi detection", () => {
  it("captures wasm exports from WebAssembly.instantiate() flow", async () => {
    const projectDir = createProject(
      "instantiate-flow",
      `import fs from "node:fs/promises";
const wasmBuffer = await fs.readFile("./add.wasm");
const wasmModule = await WebAssembly.instantiate(wasmBuffer);
const { add } = wasmModule.instance.exports;
console.log(add(5, 6));
`,
    );

    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(allImports["add.wasm"], "expected add.wasm to be discovered");
    const occurrences = Array.from(allImports["add.wasm"]);
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("add")),
      "expected add export symbol to be tracked",
    );
    const addOccurrence = occurrences.find((occ) =>
      occ.importedModules?.includes("add"),
    );
    assert.ok(addOccurrence, "expected add symbol occurrence to exist");
    assert.ok(
      normalizePathForAssertion(addOccurrence.fileName).endsWith("index.js"),
      "expected source filename to be tracked",
    );
    assert.strictEqual(addOccurrence.lineNumber, 4);
    assert.strictEqual(typeof addOccurrence.columnNumber, "number");
    assert.ok(addOccurrence.columnNumber >= 0);
  });

  it("captures wasm exports from instantiateStreaming(fetch(new URL(...)))", async () => {
    const projectDir = createProject(
      "streaming-flow",
      `const { instance } = await WebAssembly.instantiateStreaming(
  fetch(new URL("./stream.wasm", import.meta.url)),
);
const { run } = instance.exports;
console.log(run());
`,
    );

    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(
      allImports["stream.wasm"],
      "expected stream.wasm to be discovered",
    );
    const occurrences = Array.from(allImports["stream.wasm"]);
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("run")),
      "expected run export symbol to be tracked",
    );
  });

  it("does not treat arbitrary function calls with .wasm literals as wasm imports", async () => {
    const projectDir = createProject(
      "non-wasm-callee",
      `doSomething("./ignored.wasm");
`,
    );

    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(
      !allImports["./ignored.wasm"] && !allImports["ignored.wasm"],
      "expected non-wasm callee usage to be ignored",
    );
  });

  it("captures wasi constructor and lifecycle API usage", async () => {
    const projectDir = createProject(
      "wasi-flow",
      `import { WASI } from "node:wasi";
const wasi = new WASI({ version: "preview1" });
wasi.initialize(instance);
`,
    );

    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(allImports["node:wasi"], "expected node:wasi to be discovered");
    const occurrences = Array.from(allImports["node:wasi"]);
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("WASI")),
      "expected WASI usage to be tracked",
    );
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("initialize")),
      "expected initialize API usage to be tracked",
    );
  });

  it("captures wasi constructor alias invoked without new", async () => {
    const projectDir = createProject(
      "wasi-call-alias-flow",
      `import { WASI as WasiCtor } from "node:wasi";
const wasi = WasiCtor({ version: "preview1" });
wasi.start(instance);
`,
    );

    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(allImports["node:wasi"], "expected node:wasi to be discovered");
    const occurrences = Array.from(allImports["node:wasi"]);
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("WASI")),
      "expected WASI constructor alias usage to be tracked",
    );
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("start")),
      "expected start API usage to be tracked",
    );
  });

  it("detects wasm import/export functions from libmagic wrapper fixture", async () => {
    const projectDir = createProjectFromFixture(
      "libmagic-wrapper",
      "libmagic-wrapper.js",
    );

    const { allImports, allExports } = await findJSImportsExports(
      projectDir,
      false,
    );
    assert.ok(allImports.fs, "expected fs require import to be detected");
    assert.ok(
      allImports.crypto,
      "expected crypto require import to be detected",
    );
    assert.ok(
      allImports["libmagic-wrapper.wasm"],
      "expected libmagic-wrapper.wasm to be detected",
    );
    assert.ok(
      allExports["libmagic-wrapper.wasm"],
      "expected libmagic-wrapper.wasm exports to be detected",
    );

    const wasmImportOccurrences = Array.from(
      allImports["libmagic-wrapper.wasm"],
    );
    const wasmExportOccurrences = Array.from(
      allExports["libmagic-wrapper.wasm"],
    );

    assert.ok(
      wasmImportOccurrences.some(
        (occ) =>
          normalizePathForAssertion(occ.fileName).endsWith(
            "libmagic-wrapper.js",
          ) &&
          typeof occ.lineNumber === "number" &&
          typeof occ.columnNumber === "number",
      ),
      "expected wasm import occurrences to include source location metadata",
    );

    const importedModules = new Set(
      wasmImportOccurrences.flatMap((occ) => occ.importedModules || []),
    );
    for (const expectedImportedModule of [
      "free",
      "malloc",
      "magic_wrapper_load",
      "magic_wrapper_detect",
      "_emscripten_stack_restore",
      "_emscripten_stack_alloc",
      "emscripten_stack_get_current",
      "memory",
      "__indirect_function_table",
    ]) {
      assert.ok(
        importedModules.has(expectedImportedModule),
        `expected imported wasm symbol ${expectedImportedModule}`,
      );
    }

    const exportedModules = new Set(
      wasmExportOccurrences.flatMap((occ) => occ.exportedModules || []),
    );
    for (const expectedExportedModule of [
      "_free",
      "_malloc",
      "_magic_wrapper_load",
      "_magic_wrapper_detect",
    ]) {
      assert.ok(
        exportedModules.has(expectedExportedModule),
        `expected exported wasm symbol ${expectedExportedModule}`,
      );
    }
  });

  it("honors exclude globs during JS import/export discovery", async () => {
    const projectDir = createProjectFiles("imports-with-excludes", {
      "src/index.js":
        "import { readFileSync } from 'node:fs';\nvoid readFileSync;\n",
      "test/ignored.js": "import net from 'node:net';\nvoid net;\n",
      "node_modules/demo/index.js": "import tls from 'node:tls';\nvoid tls;\n",
    });

    const { allImports } = await findJSImportsExports(projectDir, {
      deep: true,
      exclude: ["**/test/**", "**/node_modules/**"],
    });

    assert.ok(allImports["node:fs"]);
    assert.equal(allImports["node:net"], undefined);
    assert.equal(allImports["node:tls"], undefined);
  });
});

describe("findJSImportsExports() Angular occurrence evidence", () => {
  it("captures Angular workspace builder, polyfill, style, script, plugin, and schematic package references", async () => {
    const projectDir = createProjectFiles("angular-workspace-evidence", {
      "angular.json": JSON.stringify({
        projects: {
          app: {
            architect: {
              build: {
                builder: "@angular-devkit/build-angular:application",
                options: {
                  polyfills: ["zone.js", "@angular/localize/init"],
                  scripts: ["node_modules/jquery/dist/jquery.js"],
                  styles: [
                    "src/styles.scss",
                    "node_modules/bootstrap/dist/css/bootstrap.css",
                    {
                      input:
                        "node_modules/@fortawesome/fontawesome-free/css/all.css",
                    },
                  ],
                },
              },
              serve: {
                executor: "@nx/angular:dev-server",
              },
              test: {
                builder: "@angular-devkit/build-angular:karma",
              },
              e2e: {
                builder: "@angular-devkit/build-angular:protractor",
              },
              package: {
                builder: "@angular-devkit/build-ng-packagr:build",
              },
              modernBuild: {
                builder: "@angular/build:application",
              },
            },
            schematics: {
              "@schematics/angular:component": {
                style: "scss",
              },
            },
          },
        },
        plugins: ["@angular-eslint/builder"],
      }),
      "src/app/app.component.ts":
        "import { Component } from '@angular/core';\n@Component({ template: '<router-outlet />' })\nexport class AppComponent {}\n",
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    for (const expectedPackage of [
      "@angular-devkit/build-angular",
      "@angular-eslint/builder",
      "@angular/build",
      "@angular/compiler-cli",
      "@angular/localize",
      "@fortawesome/fontawesome-free",
      "@nx/angular",
      "@schematics/angular",
      "bootstrap",
      "jquery",
      "karma",
      "ng-packagr",
      "protractor",
      "typescript",
      "zone.js",
    ]) {
      assert.ok(
        allImports[expectedPackage],
        `expected ${expectedPackage} workspace evidence`,
      );
    }
    assert.equal(allImports["src"], undefined);
  });

  it("captures Angular resource metadata and legacy external loadChildren strings", async () => {
    const projectDir = createProjectFiles("angular-source-literal-evidence", {
      "src/app/app.module.ts": `import { NgModule } from "@angular/core";
import { RouterModule } from "@angular/router";

@NgModule({
  imports: [
    RouterModule.forRoot([
      { path: "legacy", loadChildren: "@acme/legacy-feature#LegacyFeatureModule" },
      { path: "local", loadChildren: "./local/local.module#LocalModule" },
    ]),
  ],
})
export class AppModule {}
`,
      "src/app/app.component.ts": `import { Component } from "@angular/core";

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
  styleUrls: ["./app.component.scss"],
})
export class AppComponent {}
`,
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(allImports["@acme/legacy-feature"]);
    assert.ok(
      Object.keys(allImports).some((importName) =>
        normalizePathForAssertion(importName).endsWith(
          "src/app/local/local.module",
        ),
      ),
    );
    assert.ok(
      Object.keys(allImports).some((importName) =>
        normalizePathForAssertion(importName).endsWith(
          "src/app/app.component.html",
        ),
      ),
    );
    assert.ok(
      Object.keys(allImports).some((importName) =>
        normalizePathForAssertion(importName).endsWith(
          "src/app/app.component.scss",
        ),
      ),
    );
  });

  it("captures Angular package script and test config package evidence", async () => {
    const projectDir = createProjectFiles("angular-script-config-evidence", {
      "package.json": JSON.stringify({
        scripts: {
          start: "ng serve",
          test: "ng test",
          e2e: "ng e2e",
          "ng-lint": "ng lint",
          compile: "tsc -p tsconfig.json && ngc -p tsconfig.app.json",
          lint: "tslint --project tslint.json",
          analyze: "webpack-bundle-analyzer dist/stats.json",
          docs: "typedoc src/public-api.ts",
          clean: "rimraf dist",
        },
      }),
      "src/app/app.component.ts":
        "import { Component } from '@angular/core';\n@Component({ template: '<router-outlet />' })\nexport class AppComponent {}\n",
      "karma.conf.js": [
        "module.exports = function(config) {",
        "config.set({",
        "frameworks: ['jasmine', '@angular-devkit/build-angular'],",
        "browsers: ['ChromeHeadless'],",
        "reporters: ['progress', 'coverage-istanbul', 'html'],",
        "plugins: [require('karma-jasmine'), require('karma-chrome-launcher')],",
        "});",
        "};",
      ].join("\n"),
      "protractor.conf.js": [
        "require('ts-node/register');",
        "exports.config = { framework: 'jasmine' };",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    for (const expectedPackage of [
      "@angular/cli",
      "@angular/compiler-cli",
      "codelyzer",
      "jasmine-core",
      "jasminewd2",
      "karma",
      "karma-chrome-launcher",
      "karma-coverage-istanbul-reporter",
      "karma-jasmine",
      "karma-jasmine-html-reporter",
      "protractor",
      "rimraf",
      "ts-node",
      "tslint",
      "typedoc",
      "typescript",
      "webpack-bundle-analyzer",
    ]) {
      assert.ok(
        allImports[expectedPackage],
        `expected ${expectedPackage} script/config evidence`,
      );
    }
  });

  it("captures @angular/animations when platform-browser animations are imported", async () => {
    const projectDir = createProjectFiles("angular-animations-evidence", {
      "src/app/app.module.ts":
        "import { BrowserAnimationsModule } from '@angular/platform-browser/animations';\nvoid BrowserAnimationsModule;\n",
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(allImports["@angular/platform-browser/animations"]);
    assert.ok(allImports["@angular/animations"]);
  });

  it("captures AngularFire and platform-browser-dynamic implied package evidence", async () => {
    const projectDir = createProjectFiles("angular-import-implied-evidence", {
      "src/app/app.module.ts": [
        "import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';",
        "import { AngularFireModule } from '@angular/fire';",
        "import { AngularFirestoreModule } from '@angular/fire/firestore';",
        "void platformBrowserDynamic;",
        "void AngularFireModule;",
        "void AngularFirestoreModule;",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(allImports["@angular/compiler"]);
    assert.ok(allImports.firebase);
  });

  it("captures Angular tsconfig helper, type, and transformer package evidence", async () => {
    const projectDir = createProjectFiles("angular-tsconfig-evidence", {
      "src/app/app.component.ts":
        "import { Component } from '@angular/core';\n@Component({ template: '<router-outlet />' })\nexport class AppComponent {}\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          importHelpers: true,
          plugins: [{ transform: "ts-transformer-keys/transformer" }],
          types: ["jasmine", "node"],
        },
      }),
      "tsconfig.spec.json": [
        "{",
        "  // JSON with comments should still be parsed",
        '  "compilerOptions": { "types": ["jasminewd2"] }',
        "}",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    for (const expectedPackage of [
      "@types/jasmine",
      "@types/jasminewd2",
      "@types/node",
      "ts-transformer-keys",
      "tslib",
    ]) {
      assert.ok(
        allImports[expectedPackage],
        `expected ${expectedPackage} tsconfig evidence`,
      );
    }
  });

  it("captures common Angular template selector package evidence", async () => {
    const routerLinkAttr = "routerLink";
    const ngIfAttr = "ngIf";
    const formGroupAttr = "formGroup";
    const formControlNameAttr = "formControlName";
    const matButtonAttr = "mat-button";
    const cdkDropListAttr = "cdkDropList";
    const projectDir = createProjectFiles("angular-template-evidence", {
      "src/app/app.component.ts":
        "import { Component } from '@angular/core';\n@Component({ templateUrl: './app.component.html' })\nexport class AppComponent {}\n",
      "src/app/app.component.html": [
        "<router-outlet />",
        `<a ${routerLinkAttr}="/home">Home</a>`,
        [
          "<section ",
          "*",
          ngIfAttr,
          '="ready">{{ total | async }}</section>',
        ].join(""),
        [
          "<form ",
          "[",
          formGroupAttr,
          ']="profileForm"><input ',
          formControlNameAttr,
          '="name" /></form>',
        ].join(""),
        `<button ${matButtonAttr}>Save</button>`,
        `<div ${cdkDropListAttr}></div>`,
        "<ion-button>Open</ion-button>",
        '<fa-icon [icon]="icon"></fa-icon>',
        "<ag-grid-angular></ag-grid-angular>",
        "<ng-select></ng-select>",
        "<ngx-charts-bar-vertical></ngx-charts-bar-vertical>",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    for (const expectedPackage of [
      "@angular/cdk",
      "@angular/common",
      "@angular/forms",
      "@angular/material",
      "@angular/router",
      "@fortawesome/angular-fontawesome",
      "@ionic/angular",
      "@ng-select/ng-select",
      "@swimlane/ngx-charts",
      "ag-grid-angular",
    ]) {
      assert.ok(
        allImports[expectedPackage],
        `expected ${expectedPackage} template evidence`,
      );
      const occurrences = Array.from(allImports[expectedPackage]);
      assert.ok(
        occurrences.some((occurrence) =>
          normalizePathForAssertion(occurrence.fileName).endsWith(
            "src/app/app.component.html",
          ),
        ),
      );
    }
  });

  it("does not treat unrelated project.json files as Angular workspace evidence", async () => {
    const projectDir = createProjectFiles("non-angular-project-json", {
      "project.json": JSON.stringify({
        targets: {
          build: {
            executor: "@nx/react:build",
          },
        },
      }),
      "src/index.ts": "import React from 'react';\nvoid React;\n",
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(allImports.react);
    assert.equal(allImports["@nx/react"], undefined);
  });
});

describe("detectExtensionCapabilities()", () => {
  it("should detect extension capability signals from source usage", () => {
    const projectDir = createProject(
      "extension-capabilities",
      `chrome.scripting.executeScript({ target: { tabId: 1 }, files: ["inject.js"] });
chrome.bluetooth.getDevices(() => {});
chrome.downloads.download({ url: "https://example.invalid/a.txt" });
const canvas = document.createElement("canvas");
canvas.toDataURL();
fetch("https://example.invalid/api");
navigator.userAgentData?.getHighEntropyValues(["platformVersion"]);
`,
    );
    const detected = detectExtensionCapabilities(projectDir);
    assert.ok(detected.capabilities.includes("codeInjection"));
    assert.ok(detected.capabilities.includes("bluetooth"));
    assert.ok(detected.capabilities.includes("deviceAccess"));
    assert.ok(detected.capabilities.includes("fileAccess"));
    assert.ok(detected.capabilities.includes("network"));
    assert.ok(detected.capabilities.includes("fingerprinting"));
  });

  it("should detect fingerprinting from canvas member-chain APIs", () => {
    const projectDir = createProject(
      "extension-capabilities-canvas-only",
      `const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");
ctx.getImageData(0, 0, 1, 1);
canvas.toDataURL();
ctx.measureText("a");
`,
    );
    const detected = detectExtensionCapabilities(projectDir);
    assert.ok(detected.capabilities.includes("fingerprinting"));
  });
});

describe("analyzeSuspiciousJsFile()", () => {
  it("detects encoded child-process loader patterns", () => {
    const projectDir = createProject(
      "suspicious-lifecycle-js",
      [
        "import cp from 'node:child_process';",
        "const payload = Buffer.from('ZXZhbCgnY29uc29sZS5sb2coMSknKQ==', 'base64');",
        "cp.execSync(payload.toString());",
      ].join("\n"),
    );

    const analysis = analyzeSuspiciousJsFile(join(projectDir, "index.js"));
    assert.match(analysis.obfuscationIndicators.join(","), /buffer-base64/);
    assert.match(analysis.executionIndicators.join(","), /child-process/);
  });

  it("detects network-capable script files referenced by lifecycle hooks", () => {
    const projectDir = createProject(
      "network-lifecycle-js",
      [
        "import https from 'node:https';",
        "https.request('https://example.invalid/payload');",
      ].join("\n"),
    );

    const analysis = analyzeSuspiciousJsFile(join(projectDir, "index.js"));
    assert.match(analysis.networkIndicators.join(","), /network-request/);
  });
});

describe("analyzeJsCapabilitiesFile()", () => {
  it("detects file, network, hardware, child-process, and dynamic fetch signals", () => {
    const projectDir = createProject(
      "js-capabilities",
      [
        "import fs from 'node:fs/promises';",
        "import { execFile } from 'node:child_process';",
        "import usb from 'usb';",
        "const endpoint = process.env.API_URL;",
        "await fs.readFile('config.json');",
        "await fetch(endpoint);",
        "await import(process.env.PLUGIN_NAME);",
        "usb.getDeviceList();",
        "execFile('sh', ['-c', 'echo hi']);",
      ].join("\n"),
    );

    const analysis = analyzeJsCapabilitiesFile(join(projectDir, "index.js"));

    assert.ok(analysis.capabilities.includes("fileAccess"));
    assert.ok(analysis.capabilities.includes("network"));
    assert.ok(analysis.capabilities.includes("hardware"));
    assert.ok(analysis.capabilities.includes("childProcess"));
    assert.ok(analysis.capabilities.includes("dynamicFetch"));
    assert.ok(analysis.capabilities.includes("dynamicImport"));
    assert.strictEqual(analysis.hasDynamicFetch, true);
    assert.strictEqual(analysis.hasDynamicImport, true);
  });

  it("detects eval and vm-based code generation signals", () => {
    const projectDir = createProject(
      "js-capabilities-eval",
      [
        "import vm from 'node:vm';",
        "eval('console.log(1)');",
        "vm.runInNewContext('console.log(2)');",
      ].join("\n"),
    );

    const analysis = analyzeJsCapabilitiesFile(join(projectDir, "index.js"));

    assert.ok(analysis.capabilities.includes("codeGeneration"));
    assert.strictEqual(analysis.hasEval, true);
    assert.match(
      (analysis.indicatorMap.codeGeneration || []).join(","),
      /eval|vm\.runInNewContext/,
    );
  });
});

describe("analyzeJsCryptoFile()", () => {
  it("detects crypto algorithms with light constant propagation", () => {
    const projectDir = createProject(
      "js-crypto-analysis",
      [
        "import { createHash, pbkdf2Sync, webcrypto } from 'node:crypto';",
        "import jwt from 'jsonwebtoken';",
        "import { SignJWT } from 'jose';",
        "const subtle = webcrypto.subtle;",
        "const digestName = 'sha256';",
        "const digestOptions = { algorithm: 'RS256' };",
        "const aesProfile = { name: 'AES-GCM', length: 256 };",
        "const deriveProfile = { name: 'PBKDF2', hash: 'SHA-256' };",
        "createHash(digestName);",
        "pbkdf2Sync('secret', 'salt', 1000, 32, digestName);",
        "subtle.digest('SHA-384', new Uint8Array());",
        "subtle.generateKey(aesProfile, true, ['encrypt']);",
        "subtle.deriveKey(deriveProfile, keyMaterial, aesProfile, false, ['encrypt']);",
        "jwt.sign({ sub: '123' }, 'secret', digestOptions);",
        "new SignJWT({ sub: '123' }).setProtectedHeader({ alg: 'ES256', enc: 'A256GCM' });",
      ].join("\n"),
    );

    const analysis = analyzeJsCryptoFile(join(projectDir, "index.js"));
    const names = analysis.algorithms.map((algorithm) => algorithm.name);

    assert.ok(names.includes("sha256"));
    assert.ok(names.includes("SHA-384"));
    assert.ok(names.includes("AES-GCM"));
    assert.ok(names.includes("PBKDF2"));
    assert.ok(names.includes("RS256"));
    assert.ok(names.includes("ES256"));
    assert.ok(names.includes("A256GCM"));
    assert.ok(analysis.libraries.includes("jsonwebtoken"));
    assert.ok(analysis.libraries.includes("jose"));
    assert.ok(analysis.libraries.includes("node:crypto"));
  });

  it("avoids chained-call false positives and captures signing algorithm literals", () => {
    const projectDir = createProject(
      "js-crypto-signing-analysis",
      [
        "import crypto from 'node:crypto';",
        "function createSignatureBlock(payload, privateKey, alg) {",
        "  const hash = alg.replace('HS', 'sha');",
        "  const value = crypto.createHmac(hash, privateKey).update(payload, 'utf8').digest('base64url');",
        "  if (alg === 'Ed25519' || alg === 'Ed448') {",
        "    return crypto.sign(null, Buffer.from(payload, 'utf8'), { key: privateKey });",
        "  }",
        "  return value;",
        "}",
        "export function signBom(payload, privateKey, algorithm = 'RS512') {",
        "  return createSignatureBlock(payload, privateKey, algorithm);",
        "}",
      ].join("\n"),
    );

    const analysis = analyzeJsCryptoFile(join(projectDir, "index.js"));
    const names = analysis.algorithms.map((algorithm) => algorithm.name);

    assert.ok(names.includes("RS512"));
    assert.ok(names.includes("Ed25519"));
    assert.ok(names.includes("Ed448"));
    assert.ok(!names.includes("base64url"));
  });

  it("resolves crypto values through conditional branches, fallbacks, and reassignment", () => {
    const projectDir = createProject(
      "js-crypto-dynamic-branches",
      [
        "import { createHash, createHmac, webcrypto } from 'node:crypto';",
        "import jwt from 'jsonwebtoken';",
        "const subtle = webcrypto.subtle;",
        "let digestName = 'sha256';",
        "digestName = globalThis.__preferStrongDigest ? 'sha512' : 'sha384';",
        "const hmacAlgorithm = globalThis.__preferStrongMac ? 'HS512' : 'HS256';",
        "const derivedHash = hmacAlgorithm.replace('HS', 'sha');",
        "const cipherProfiles = globalThis.__legacyCipher",
        "  ? { active: { name: 'AES-CBC', length: 256 } }",
        "  : { active: { name: 'AES-GCM', length: 256 } };",
        "const signingAlgorithm = globalThis.__legacySignature ? 'RS256' : 'RS512';",
        "const jwtOptions = globalThis.__jwtOptions ?? { algorithm: signingAlgorithm };",
        "createHash(digestName);",
        "createHmac(derivedHash, 'secret').update('payload').digest('hex');",
        "subtle.generateKey(cipherProfiles.active, true, ['encrypt', 'decrypt']);",
        "jwt.sign({ sub: '123' }, 'secret', jwtOptions);",
      ].join("\n"),
    );

    const analysis = analyzeJsCryptoFile(join(projectDir, "index.js"));
    const names = analysis.algorithms.map((algorithm) => algorithm.name);

    assert.ok(names.includes("sha256"));
    assert.ok(names.includes("sha384"));
    assert.ok(names.includes("sha512"));
    assert.ok(names.includes("AES-CBC"));
    assert.ok(names.includes("AES-GCM"));
    assert.ok(names.includes("RS256"));
    assert.ok(names.includes("RS512"));
  });

  it("narrows identifier values inside if-guarded crypto branches", () => {
    const projectDir = createProject(
      "js-crypto-if-guard-narrowing",
      [
        "import crypto from 'node:crypto';",
        "function signPayload(payload, privateKey, alg) {",
        "  let hashAlg = null;",
        "  if (alg === 'RS256' || alg === 'RS512') {",
        "    hashAlg = alg.replace('RS', 'SHA');",
        "    return crypto.sign(hashAlg, Buffer.from(payload, 'utf8'), { key: privateKey });",
        "  }",
        "  if (alg !== 'RS384') {",
        "    return crypto.sign('SHA-224', Buffer.from(payload, 'utf8'), { key: privateKey });",
        "  } else {",
        "    hashAlg = alg.replace('RS', 'SHA');",
        "    return crypto.sign(hashAlg, Buffer.from(payload, 'utf8'), { key: privateKey });",
        "  }",
        "}",
      ].join("\n"),
    );

    const analysis = analyzeJsCryptoFile(join(projectDir, "index.js"));
    const names = analysis.algorithms.map((algorithm) => algorithm.name);
    const signAlgorithms = analysis.algorithms
      .filter((algorithm) => algorithm.source === "node:crypto.sign")
      .map((algorithm) => algorithm.name);

    assert.ok(names.includes("RS256"));
    assert.ok(names.includes("RS512"));
    assert.ok(signAlgorithms.includes("SHA256"));
    assert.ok(signAlgorithms.includes("SHA512"));
    assert.ok(signAlgorithms.includes("SHA384"));
    assert.ok(signAlgorithms.includes("SHA-224"));
  });

  it("narrows identifier values inside switch/case crypto branches", () => {
    const projectDir = createProject(
      "js-crypto-switch-guard-narrowing",
      [
        "import crypto from 'node:crypto';",
        "function signPayloadWithSwitch(payload, privateKey, alg) {",
        "  switch (alg) {",
        "    case 'RS256':",
        "    case 'RS512':",
        "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
        "    case 'RS384':",
        "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
        "    default:",
        "      return crypto.sign('SHA-224', Buffer.from(payload, 'utf8'), { key: privateKey });",
        "  }",
        "}",
      ].join("\n"),
    );

    const analysis = analyzeJsCryptoFile(join(projectDir, "index.js"));
    const signAlgorithms = analysis.algorithms
      .filter((algorithm) => algorithm.source === "node:crypto.sign")
      .map((algorithm) => algorithm.name);

    assert.ok(signAlgorithms.includes("SHA256"));
    assert.ok(signAlgorithms.includes("SHA512"));
    assert.ok(signAlgorithms.includes("SHA384"));
    assert.ok(signAlgorithms.includes("SHA-224"));
  });

  it("narrows switch default branches using a known finite identifier union", () => {
    const projectDir = createProject(
      "js-crypto-switch-default-narrowing",
      [
        "import crypto from 'node:crypto';",
        "function signPayloadWithSwitchDefault(payload, privateKey) {",
        "  const alg = globalThis.__preferLegacy ? 'RS256' : 'RS384';",
        "  switch (alg) {",
        "    case 'RS256':",
        "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
        "    default:",
        "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
        "  }",
        "}",
      ].join("\n"),
    );

    const analysis = analyzeJsCryptoFile(join(projectDir, "index.js"));
    const signAlgorithms = analysis.algorithms
      .filter((algorithm) => algorithm.source === "node:crypto.sign")
      .map((algorithm) => algorithm.name);

    assert.ok(signAlgorithms.includes("SHA256"));
    assert.ok(signAlgorithms.includes("SHA384"));
    assert.ok(!signAlgorithms.includes("SHA512"));
  });
});

describe("detectJsCryptoInventory()", () => {
  it("aggregates crypto algorithm usage across source files", async () => {
    const projectDir = createProjectFiles("js-crypto-inventory", {
      "src/hash.js": [
        "import { createHash } from 'node:crypto';",
        "const algo = 'sha512';",
        "createHash(algo);",
      ].join("\n"),
      "src/webcrypto.js": [
        "const profile = { name: 'AES-GCM', length: 256 };",
        "crypto.subtle.generateKey(profile, true, ['encrypt']);",
      ].join("\n"),
    });

    const inventory = await detectJsCryptoInventory(projectDir, false);
    const names = inventory.algorithms.map((algorithm) => algorithm.name);
    const files = inventory.algorithms.map((algorithm) =>
      normalizePathForAssertion(algorithm.fileName),
    );

    assert.ok(names.includes("sha512"));
    assert.ok(names.includes("AES-GCM"));
    assert.ok(files.includes("src/hash.js"));
    assert.ok(files.includes("src/webcrypto.js"));
  });

  it("honors exclude globs during crypto inventory collection", async () => {
    const projectDir = createProjectFiles("js-crypto-inventory-excludes", {
      "src/hash.js": [
        "import { createHash } from 'node:crypto';",
        "createHash('sha256');",
      ].join("\n"),
      "test/ignored.js": [
        "import { createHash } from 'node:crypto';",
        "createHash('sha512');",
      ].join("\n"),
      "node_modules/demo/index.js": [
        "import { createHash } from 'node:crypto';",
        "createHash('sha1');",
      ].join("\n"),
    });

    const inventory = await detectJsCryptoInventory(projectDir, {
      deep: true,
      exclude: ["**/test/**", "**/node_modules/**"],
    });
    const names = inventory.algorithms.map((algorithm) => algorithm.name);

    assert.ok(names.includes("sha256"));
    assert.equal(names.includes("sha512"), false);
    assert.equal(names.includes("sha1"), false);
  });
});

describe("findJSImportsExports() Angular evidence enrichment", () => {
  it("captures Angular package usage from styles, angular.json assets/includePaths, and script executables", async () => {
    const projectDir = createProjectFiles("angular-evidence-enrichment", {
      "src/main.ts":
        "import { bootstrapApplication } from '@angular/platform-browser';\nvoid bootstrapApplication;\n",
      "src/styles.scss":
        "@use 'bootstrap/scss/bootstrap';\n@import 'material-symbols';\n@import '~@fortawesome/fontawesome-free/css/all.css';\n",
      "package.json": JSON.stringify(
        {
          name: "angular-evidence-enrichment",
          version: "1.0.0",
          scripts: {
            build:
              "node ./node_modules/.bin/tailwindcss -i src/styles.scss -o dist/styles.css && ng build",
          },
        },
        null,
        2,
      ),
      "angular.json": JSON.stringify(
        {
          version: 1,
          projects: {
            app: {
              architect: {
                build: {
                  builder: "@angular-devkit/build-angular:browser",
                  options: {
                    assets: [
                      {
                        glob: "**/angular-locale_+(en|de|sv).js",
                        input: "./node_modules/angular-i18n",
                        output: "/i18n/",
                      },
                      "node_modules/flag-icons/flags",
                    ],
                    styles: [
                      "src/styles.scss",
                      "node_modules/@fortawesome/fontawesome-free/css/all.css",
                    ],
                    stylePreprocessorOptions: {
                      includePaths: ["node_modules/bootstrap/scss"],
                    },
                  },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    });

    const { allImports } = await findJSImportsExports(projectDir, {
      deep: true,
      exclude: [],
    });
    for (const expectedPackage of [
      "@angular/cli",
      "@angular/compiler-cli",
      "@fortawesome/fontawesome-free",
      "angular-i18n",
      "bootstrap",
      "flag-icons",
      "material-symbols",
      "tailwindcss",
      "typescript",
    ]) {
      assert.ok(
        allImports[expectedPackage],
        `expected ${expectedPackage} to be discovered from Angular evidence`,
      );
    }
  });

  it("captures scoped package executables invoked through pnpm dlx", async () => {
    const projectDir = createProjectFiles("angular-dlx-scripts", {
      "src/main.ts":
        "import { Component } from '@angular/core';\nvoid Component;\n",
      "package.json": JSON.stringify(
        {
          name: "angular-dlx-scripts",
          version: "1.0.0",
          scripts: {
            generate: "pnpm dlx @angular/cli generate component hello",
          },
        },
        null,
        2,
      ),
      "angular.json": JSON.stringify(
        {
          version: 1,
          projects: {
            app: {
              architect: {
                build: {
                  builder: "@angular-devkit/build-angular:browser",
                },
              },
            },
          },
        },
        null,
        2,
      ),
    });

    const { allImports } = await findJSImportsExports(projectDir, true);
    assert.ok(
      allImports["@angular/cli"],
      "expected @angular/cli to be detected from pnpm dlx script",
    );
  });

  it("captures template-only material-symbols usage via fontSet/class attribute values", async () => {
    const projectDir = createProjectFiles("angular-template-fontset", {
      "src/main.ts":
        "import { Component } from '@angular/core';\nvoid Component;\n",
      "src/app/help.component.html": [
        '<mat-icon fontSet="material-symbols-outlined">help</mat-icon>',
        '<span class="material-symbols-rounded">home</span>',
        '<i class="pi pi-fw pi-check"></i>',
        '<i class="bi bi-alarm"></i>',
        '<i class="fa-solid fa-house"></i>',
        '<i class="pilot light"></i>',
        '<i class="binary-icon"></i>',
      ].join("\n"),
      "src/app/inline-icons.component.ts": [
        "import { Component } from '@angular/core';",
        "@Component({",
        "  selector: 'app-inline-icons',",
        '  template: `<i class="pi pi-home"></i><i class="bi bi-gear"></i><i class="fas fa-user"></i>`,',
        "})",
        "export class InlineIconsComponent {",
        "  treeNode = { icon: 'pi pi-fw pi-folder', expandedIcon: 'pi pi-folder-open', collapsedIcon: 'pi pi-folder' };",
        "}",
      ].join("\n"),
      "package.json": JSON.stringify(
        {
          name: "angular-template-fontset",
          version: "1.0.0",
          scripts: {
            start: "ng serve",
          },
        },
        null,
        2,
      ),
      "angular.json": JSON.stringify(
        {
          version: 1,
          projects: {
            app: {
              architect: {
                build: {
                  builder: "@angular-devkit/build-angular:browser",
                },
              },
            },
          },
        },
        null,
        2,
      ),
    });

    const { allImports } = await findJSImportsExports(projectDir, {
      deep: true,
      exclude: [],
    });
    assert.ok(
      allImports["material-symbols"],
      "expected material-symbols from template-only fontSet/class usage",
    );
    assert.ok(
      allImports.primeicons,
      "expected primeicons from template/icon class usage",
    );
    assert.ok(
      allImports["bootstrap-icons"],
      "expected bootstrap-icons from template class usage",
    );
    assert.ok(
      allImports["@fortawesome/fontawesome-free"],
      "expected @fortawesome/fontawesome-free from template class usage",
    );
    assert.equal(
      allImports.pilot,
      undefined,
      "expected non-icon words beginning with pi to remain undetected",
    );
    assert.equal(
      allImports["binary-icon"],
      undefined,
      "expected non-bootstrap-icon class names to remain undetected",
    );
  });

  it("captures npx CLI package usage without introducing wrapper-command false positives", async () => {
    const projectDir = createProjectFiles("angular-npx-scripts", {
      "src/main.ts":
        "import { Component } from '@angular/core';\nvoid Component;\n",
      "package.json": JSON.stringify(
        {
          name: "angular-npx-scripts",
          version: "1.0.0",
          scripts: {
            build: "npm run license-report && ng build",
            "license-report":
              "npx license-report --only=prod --output=json > ./src/assets/license-report.json",
            noisy: "echo hello && npm run build",
          },
        },
        null,
        2,
      ),
      "angular.json": JSON.stringify(
        {
          version: 1,
          projects: {
            app: {
              architect: {
                build: {
                  builder: "@angular-devkit/build-angular:browser",
                },
              },
            },
          },
        },
        null,
        2,
      ),
    });

    const { allImports } = await findJSImportsExports(projectDir, true);
    assert.ok(
      allImports["cdx:npm:bin/license-report"],
      "expected license-report to be detected as npm bin command evidence from npx execution",
    );
    assert.ok(
      allImports["@angular/cli"],
      "expected @angular/cli from ng build",
    );
    assert.equal(
      allImports.run,
      undefined,
      "expected npm run wrapper token to not be treated as package usage",
    );
    assert.equal(
      allImports.echo,
      undefined,
      "expected shell built-in commands to remain undetected",
    );
  });
});

describe("detectMcpInventory()", () => {
  it("honors exclude globs during MCP source discovery", () => {
    const projectDir = createProjectFiles("mcp-with-excludes", {
      "src/server.js": [
        "import { McpServer } from '@modelcontextprotocol/server';",
        "const server = new McpServer({ name: 'included-server', version: '1.0.0' });",
        "void server;",
      ].join("\n"),
      "test/ignored.js": [
        "import { McpServer } from '@modelcontextprotocol/server';",
        "const server = new McpServer({ name: 'ignored-server', version: '9.9.9' });",
        "void server;",
      ].join("\n"),
    });

    const inventory = detectMcpInventory(projectDir, {
      deep: true,
      exclude: ["**/test/**"],
    });

    assert.strictEqual(inventory.services.length, 1);
    assert.strictEqual(inventory.services[0].name, "included-server");
  });

  it("detects an official authenticated streamable HTTP MCP server", () => {
    const projectDir = createProjectFiles("mcp-http-server", {
      "src/server.js": [
        "import { McpServer } from '@modelcontextprotocol/server';",
        "import { Client } from '@modelcontextprotocol/client';",
        "import { createMcpExpressApp, mcpAuthMetadataRouter, requireBearerAuth } from '@modelcontextprotocol/express';",
        "import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';",
        "import OpenAI from 'openai';",
        "const app = createMcpExpressApp();",
        "const oauthMetadata = { issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token' };",
        "const mcpServerUrl = new URL('http://localhost:3000/mcp');",
        "const server = new McpServer({ name: 'demo-http-server', version: '1.2.3' }, { capabilities: { logging: {}, resources: { subscribe: true }, tools: { listChanged: true } } });",
        "const upstream = new Client({ name: 'relay-client', version: '0.0.1' });",
        "server.registerTool('summarize', { description: 'Summarize text', annotations: { readOnlyHint: true } }, async () => ({ content: [] }));",
        "server.registerPrompt('ask-user', { description: 'Prompt template' }, async () => ({ messages: [] }));",
        "server.registerResource('docs', 'file:///{path}', { description: 'Workspace docs' }, async () => ({ contents: [] }));",
        "const auth = requireBearerAuth({ requiredScopes: ['mcp'] });",
        "app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpServerUrl }));",
        "app.post('/mcp', auth, async () => {});",
        "const transport = new NodeStreamableHTTPServerTransport();",
        "await server.connect(transport);",
        "const openai = new OpenAI({ apiKey: 'sk-test' });",
        "await fetch('https://api.openai.com/v1/responses');",
        "await upstream.callTool({ name: 'summarize' });",
        "const provider = 'anthropic';",
        "const model = 'claude-3-5-sonnet';",
        "void provider; void model;",
      ].join("\n"),
    });
    const inventory = detectMcpInventory(projectDir);
    assert.strictEqual(inventory.services.length, 1);
    assert.strictEqual(inventory.components.length, 3);
    const service = inventory.services[0];
    assert.strictEqual(service.name, "demo-http-server");
    assert.strictEqual(service.version, "1.2.3");
    assert.strictEqual(service.authenticated, true);
    assert.ok(service.endpoints.includes("/mcp"));
    assert.ok(service.endpoints.includes("http://localhost:3000/mcp"));
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:capabilities:resources.subscribe" &&
          prop.value === "true",
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:modelNames" &&
          prop.value.includes("claude-3-5-sonnet"),
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:serviceType" && prop.value === "gateway",
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:providerFamilies" &&
          prop.value.includes("anthropic") &&
          prop.value.includes("openai"),
      ),
    );
    assert.ok(
      new Set((getProp(service, "cdx:mcp:outboundHosts") || "").split(",")).has(
        "api.openai.com",
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:usageConfidence" && prop.value === "high",
      ),
    );
    assert.ok(
      inventory.dependencies.some(
        (dependency) =>
          dependency.ref === service["bom-ref"] &&
          dependency.provides.length === 3,
      ),
    );
  });

  it("detects an unauthenticated non-official HTTP MCP server", () => {
    const projectDir = createProjectFiles("mcp-unsafe-server", {
      "index.js": [
        "import express from 'express';",
        "import { Server as AcmeMcpServer } from '@acme/mcp-server';",
        "const app = express();",
        "const server = new AcmeMcpServer({ name: 'unsafe-http-server', version: '0.1.0' });",
        "server.registerTool('run_shell', { description: 'Run a command' }, async () => ({ content: [] }));",
        "app.post('/mcp-unsafe', async () => {});",
      ].join("\n"),
    });
    const inventory = detectMcpInventory(projectDir);
    assert.strictEqual(inventory.services.length, 1);
    const service = inventory.services[0];
    assert.strictEqual(service.name, "unsafe-http-server");
    assert.strictEqual(service.authenticated, false);
    assert.ok(service.endpoints.includes("/mcp-unsafe"));
    assert.ok(
      service.properties.some(
        (prop) => prop.name === "cdx:mcp:officialSdk" && prop.value === "false",
      ),
    );
  });

  it("detects MCP client-only usage and provider wiring", () => {
    const projectDir = createProjectFiles("mcp-client-only", {
      "index.js": [
        "import { Client } from '@modelcontextprotocol/client';",
        "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';",
        "import Anthropic from '@anthropic-ai/sdk';",
        "const client = new Client({ name: 'demo-client', version: '0.1.0' });",
        "const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example.com/mcp'));",
        "await client.connect(transport);",
        "const anthropic = new Anthropic({ apiKey: 'test' });",
        "await client.listTools();",
        "await fetch('https://api.anthropic.com/v1/messages');",
        "const modelName = 'claude-3-7-sonnet';",
        "void anthropic; void modelName;",
      ].join("\n"),
    });
    const inventory = detectMcpInventory(projectDir);
    assert.strictEqual(inventory.services.length, 1);
    const service = inventory.services[0];
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:serviceType" && prop.value === "client",
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:exposureType" &&
          prop.value === "networked-public",
      ),
    );
    assert.ok(
      ["mcp.example.com", "api.anthropic.com"].every((hostname) =>
        getProp(service, "cdx:mcp:outboundHosts")
          ?.split(",")
          .includes(hostname),
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:providerFamilies" &&
          prop.value.includes("anthropic"),
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:inventorySource" &&
          prop.value === "source-code-analysis",
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) => prop.name === "cdx:mcp:reviewNeeded" && prop.value === "true",
      ),
    );
  });

  it("detects a TypeScript stdio MCP server and emits source-code-analysis inventory", () => {
    const projectDir = createProjectFiles("mcp-ts-stdio-server", {
      "src/server.ts": [
        "import { McpServer } from '@modelcontextprotocol/server';",
        "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
        "const server = new McpServer({ name: 'ts-stdio-server', version: '0.2.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });",
        "server.registerTool('lint', { description: 'Lint source files' }, async () => ({ content: [] }));",
        "server.registerPrompt('review', { description: 'Prompt review guidance' }, async () => ({ messages: [] }));",
        "server.registerResource('workspace-docs', 'file:///docs/{path}', { description: 'Workspace docs' }, async () => ({ contents: [] }));",
        "const transport = new StdioServerTransport();",
        "await server.connect(transport);",
      ].join("\n"),
    });
    const inventory = detectMcpInventory(projectDir);
    assert.strictEqual(inventory.services.length, 1);
    assert.strictEqual(inventory.components.length, 3);
    const service = inventory.services[0];
    assert.strictEqual(service.name, "ts-stdio-server");
    assert.strictEqual(service.version, "0.2.0");
    assert.strictEqual(getProp(service, "cdx:mcp:transport"), "stdio");
    assert.strictEqual(
      getProp(service, "cdx:mcp:inventorySource"),
      "source-code-analysis",
    );
    assert.strictEqual(getProp(service, "cdx:mcp:serviceType"), "gateway");
    assert.strictEqual(getProp(service, "cdx:mcp:toolCount"), "1");
    assert.strictEqual(getProp(service, "cdx:mcp:promptCount"), "1");
    assert.strictEqual(getProp(service, "cdx:mcp:resourceCount"), "1");
    assert.ok(
      inventory.dependencies.some(
        (dependency) =>
          dependency.ref === service["bom-ref"] &&
          dependency.provides.length === 3,
      ),
    );
  });

  it("sanitizes source-code-analysis MCP metadata before emission", () => {
    const projectDir = createProjectFiles("mcp-sanitized-source-analysis", {
      "src/server.ts": [
        "import { McpServer } from '@modelcontextprotocol/server';",
        "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';",
        "const server = new McpServer({",
        "  name: 'sanitized-server',",
        "  version: '0.3.0',",
        "  description: 'Use https://user:pass@example.com/mcp?token=abc#frag and Bearer sk_test_super_secret_value',",
        "});",
        "server.registerTool(",
        "  'download',",
        "  {",
        "    description: 'Download from https://user:pass@example.com/tool?token=abc#frag',",
        "    annotations: {",
        "      Authorization: 'Bearer sk_test_super_secret_value',",
        "      nested: { __proto__: 'polluted', endpoint: 'https://user:pass@example.com/tool?token=abc#frag' },",
        "    },",
        "  },",
        "  async () => ({ content: [] }),",
        ");",
        "server.registerResource(",
        "  'private-docs',",
        "  'https://user:pass@example.com/docs?token=abc#frag',",
        "  { description: 'Private docs' },",
        "  async () => ({ contents: [] }),",
        ");",
        "const transport = new StreamableHTTPClientTransport(new URL('https://user:pass@example.com/mcp?access_token=secret#frag'));",
        "void transport;",
      ].join("\n"),
    });

    const inventory = detectMcpInventory(projectDir);
    const service = inventory.services[0];
    const toolComponent = inventory.components.find(
      (component) => component.name === "download",
    );
    const resourceComponent = inventory.components.find(
      (component) => component.name === "private-docs",
    );

    assert.strictEqual(
      service.description,
      "Use https://example.com/mcp and [redacted]",
    );
    const serviceEndpoint = new URL(service.endpoints[0]);
    assert.strictEqual(serviceEndpoint.hostname, "example.com");
    assert.strictEqual(serviceEndpoint.pathname, "/mcp");
    assert.strictEqual(
      getProp(resourceComponent, "cdx:mcp:resourceUri"),
      "https://example.com/docs",
    );
    assert.strictEqual(
      toolComponent.description,
      "Download from https://example.com/tool",
    );
    const toolAnnotations = JSON.parse(
      getProp(toolComponent, "cdx:mcp:toolAnnotations"),
    );
    assert.strictEqual(toolAnnotations.Authorization, "[redacted]");
    assert.ok(
      !JSON.stringify(toolAnnotations).includes("sk_test_super_secret_value"),
    );
    assert.ok(!JSON.stringify(toolAnnotations).includes("__proto__"));
  });
});

describe("detectPythonMcpInventory()", () => {
  it("detects a Python stdio MCP server and exported primitives", () => {
    const projectDir = createProjectFiles("mcp-python-server", {
      "src/server.py": [
        "import mcp.server.stdio",
        "import mcp.types as mtypes",
        "from mcp.server import NotificationOptions, Server",
        "",
        'server = Server("appthreat-vulnerability-db", version="1.0.1")',
        "",
        "@server.list_resources()",
        "async def handle_list_resources():",
        '    return [mtypes.Resource(uri=mtypes.AnyUrl("cve://"), name="CVE Information", description="Get detailed information about a CVE")]',
        "",
        "@server.list_tools()",
        "async def handle_list_tools():",
        '    return [mtypes.Tool(name="search_by_purl_like", description="Search by purl", inputSchema={"type": "object"})]',
        "",
        "async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):",
        "    await server.run(",
        "        read_stream,",
        "        write_stream,",
        '        InitializationOptions(server_name="appthreat-vulnerability-db", server_version="1.0.1", capabilities=server.get_capabilities(notification_options=NotificationOptions(), experimental_capabilities={}))',
        "    )",
      ].join("\n"),
    });
    const inventory = detectPythonMcpInventory(projectDir);
    assert.strictEqual(inventory.services.length, 1);
    assert.strictEqual(inventory.components.length, 2);
    const service = inventory.services[0];
    assert.strictEqual(service.name, "appthreat-vulnerability-db");
    assert.strictEqual(service.version, "1.0.1");
    assert.strictEqual(getProp(service, "cdx:mcp:transport"), "stdio");
    assert.strictEqual(getProp(service, "cdx:mcp:officialSdk"), "true");
    assert.strictEqual(getProp(service, "cdx:mcp:toolCount"), "1");
    assert.strictEqual(getProp(service, "cdx:mcp:resourceCount"), "1");
    assert.ok(
      inventory.components.some(
        (component) => component.name === "search_by_purl_like",
      ),
    );
    assert.ok(
      inventory.components.some(
        (component) => component.name === "CVE Information",
      ),
    );
  });
});

describe("findJSImportsExports() TypeScript type-only imports and exports", () => {
  it("detects type-only imports correctly", async () => {
    const projectDir = createProjectFiles("type-only-imports", {
      "index.ts": [
        "import type { Foo } from 'type-pkg';",
        "import { type Bar, type Baz } from 'specifier-type-pkg';",
        "import { type Qux, normalValue } from 'mixed-pkg';",
        "import Normal from 'value-pkg';",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(allImports["type-pkg"], "expected type-pkg to be detected");
    const occurrencesType = Array.from(allImports["type-pkg"]);
    assert.strictEqual(occurrencesType[0].isTypeOnly, true);

    assert.ok(
      allImports["specifier-type-pkg"],
      "expected specifier-type-pkg to be detected",
    );
    const occurrencesSpecType = Array.from(allImports["specifier-type-pkg"]);
    assert.strictEqual(occurrencesSpecType[0].isTypeOnly, true);

    assert.ok(allImports["mixed-pkg"], "expected mixed-pkg to be detected");
    const occurrencesMixed = Array.from(allImports["mixed-pkg"]);
    assert.strictEqual(occurrencesMixed[0].isTypeOnly, false);

    assert.ok(allImports["value-pkg"], "expected value-pkg to be detected");
    const occurrencesValue = Array.from(allImports["value-pkg"]);
    assert.strictEqual(occurrencesValue[0].isTypeOnly, false);
  });

  it("detects type-only exports correctly", async () => {
    const projectDir = createProjectFiles("type-only-exports", {
      "index.ts": [
        "export type { Foo } from 'export-type-pkg';",
        "export { type Bar } from 'export-specifier-type-pkg';",
        "export { type Qux, normalValue } from 'export-mixed-pkg';",
        "export { Normal } from 'export-value-pkg';",
        "export * as namespace from 'export-all-pkg';",
        "export type * as namespaceType from 'export-all-type-pkg';",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    const occurrencesAllType = Array.from(allImports["export-all-type-pkg"]);
    assert.strictEqual(occurrencesAllType[0].isTypeOnly, true);

    const occurrencesAllVal = Array.from(allImports["export-all-pkg"]);
    assert.strictEqual(occurrencesAllVal[0].isTypeOnly, false);

    const occurrencesType = Array.from(allImports["export-type-pkg"]);
    assert.strictEqual(occurrencesType[0].isTypeOnly, true);

    const occurrencesSpecType = Array.from(
      allImports["export-specifier-type-pkg"],
    );
    assert.strictEqual(occurrencesSpecType[0].isTypeOnly, true);

    const occurrencesMixed = Array.from(allImports["export-mixed-pkg"]);
    assert.strictEqual(occurrencesMixed[0].isTypeOnly, false);

    const occurrencesValue = Array.from(allImports["export-value-pkg"]);
    assert.strictEqual(occurrencesValue[0].isTypeOnly, false);
  });
});

// ---------------------------------------------------------------------------
// Vue.js SFC (.vue) import/export tracking
// ---------------------------------------------------------------------------

describe("findJSImportsExports() Vue SFC — script setup imports", () => {
  it("tracks imports from a <script setup> block with simple props", async () => {
    const projectDir = createProjectFiles("vue-script-setup-simple", {
      "App.vue": [
        "<template>",
        "  <div>{{ msg }}</div>",
        "</template>",
        "<script setup>",
        "import { ref } from 'vue'",
        "import { useRouter } from 'vue-router'",
        "import { useStore } from 'pinia'",
        "import axios from 'axios'",
        "const msg = ref('hello')",
        "</script>",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(allImports["vue"], "expected 'vue' to be detected");
    assert.ok(allImports["vue-router"], "expected 'vue-router' to be detected");
    assert.ok(allImports["pinia"], "expected 'pinia' to be detected");
    assert.ok(allImports["axios"], "expected 'axios' to be detected");
  });

  it("tracks imports from a <script setup lang='ts'> block with kebab-case bound attributes in template", async () => {
    const projectDir = createProjectFiles("vue-script-setup-ts-kebab", {
      "UserList.vue": [
        "<template>",
        "  <UserCard",
        '    v-for="user in users"',
        '    :key="user.id"',
        '    :user-name="user.name"',
        '    :user-email="user.email"',
        '    :is-active="user.active"',
        '    @update:model-value="onUpdate"',
        '    @delete="onDelete(user.id)"',
        "  />",
        '  <component :is="emptyState" />',
        "</template>",
        '<script setup lang="ts">',
        "import { ref } from 'vue'",
        "import { useUserStore } from '@/stores/user'",
        "import { storeToRefs } from 'pinia'",
        "import axios from 'axios'",
        "import UserCard from './UserCard.vue'",
        "const store = useUserStore()",
        "const { users } = storeToRefs(store)",
        "const emptyState = ref('div')",
        "async function onUpdate(u) { await axios.put('/api/users', u) }",
        "function onDelete(id) { store.removeUser(id) }",
        "</script>",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(allImports["vue"], "expected 'vue' to be detected");
    assert.ok(
      allImports["@/stores/user"],
      "expected '@/stores/user' to be detected",
    );
    assert.ok(allImports["pinia"], "expected 'pinia' to be detected");
    assert.ok(allImports["axios"], "expected 'axios' to be detected");
    assert.ok(
      allImports["UserCard.vue"] ||
        allImports["./UserCard.vue"] ||
        allImports["UserCard"],
      "expected UserCard import to be detected",
    );
  });

  it("tracks imports from a <script setup> block with event colon modifiers (v-model:prop)", async () => {
    const projectDir = createProjectFiles("vue-event-colon-modifiers", {
      "Modal.vue": [
        "<template>",
        '  <div v-if="visible">',
        '    <slot name="header" />',
        '    <Teleport to="body">',
        '      <Inner v-model:visible="show" @update:title="onTitle" />',
        "    </Teleport>",
        "  </div>",
        "</template>",
        "<script setup>",
        "import { ref } from 'vue'",
        "import Inner from './Inner.vue'",
        "import { useEventBus } from '@vueuse/core'",
        "defineProps({ visible: Boolean })",
        "const show = ref(false)",
        "const bus = useEventBus('modal')",
        "function onTitle(t) { bus.emit(t) }",
        "</script>",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(allImports["vue"], "expected 'vue' to be detected");
    assert.ok(
      allImports["Inner.vue"] ||
        allImports["./Inner.vue"] ||
        allImports["Inner"],
      "expected Inner import to be detected",
    );
    assert.ok(
      allImports["@vueuse/core"],
      "expected '@vueuse/core' to be detected",
    );
  });

  it("tracks imports from Options API style Vue SFC", async () => {
    const projectDir = createProjectFiles("vue-options-api", {
      "Legacy.vue": [
        "<template>",
        '  <LegacyChild :some-prop="value" @custom-event="handle" />',
        "</template>",
        "<script>",
        "import LegacyChild from './LegacyChild.vue'",
        "import { mapState } from 'vuex'",
        "import _ from 'lodash'",
        "export default {",
        "  components: { LegacyChild },",
        "  computed: mapState(['value']),",
        "  methods: { handle() { _.noop() } }",
        "}",
        "</script>",
        "<style scoped>",
        "div { color: red; }",
        "</style>",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(
      allImports["LegacyChild.vue"] ||
        allImports["./LegacyChild.vue"] ||
        allImports["LegacyChild"],
      "expected LegacyChild import to be detected",
    );
    assert.ok(allImports["vuex"], "expected 'vuex' to be detected");
    assert.ok(allImports["lodash"], "expected 'lodash' to be detected");
  });

  it("tracks line numbers for imports in Vue SFC script block", async () => {
    const projectDir = createProjectFiles("vue-line-numbers", {
      "Check.vue": [
        "<template>",
        "  <div :class=\"['wrapper', { active: flag }]\">",
        "    <span>{{ label }}</span>",
        "  </div>",
        "</template>",
        "",
        "<script setup>",
        "import { ref } from 'vue'",
        "import axios from 'axios'",
        "const flag = ref(true)",
        "const label = ref('test')",
        "</script>",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(allImports["vue"], "expected 'vue' to be detected");
    assert.ok(allImports["axios"], "expected 'axios' to be detected");

    const vueOccurrences = Array.from(allImports["vue"]);
    assert.ok(
      vueOccurrences.length > 0,
      "expected at least one vue occurrence",
    );
    const vueOccurrence = vueOccurrences[0];
    assert.ok(
      typeof vueOccurrence.lineNumber === "number" &&
        vueOccurrence.lineNumber > 0,
      "expected a positive line number for vue import",
    );
    // 'vue' import is on line 8, 'axios' on line 9
    assert.ok(
      vueOccurrence.lineNumber < 20,
      "expected line number to be within the script block range",
    );
  });

  it("tracks imports from the vue-repotest fixture directory", async () => {
    const fixtureDir = fileURLToPath(
      new URL("../../test/data/vue-repotest/src", import.meta.url),
    );
    const { allImports } = await findJSImportsExports(fixtureDir, true);

    assert.ok(allImports["vue"], "expected 'vue' to be found in fixture");
    assert.ok(
      allImports["vue-router"],
      "expected 'vue-router' to be found in fixture",
    );
    assert.ok(allImports["pinia"], "expected 'pinia' to be found in fixture");
    assert.ok(allImports["axios"], "expected 'axios' to be found in fixture");
  });

  it("tracks async dynamic import() calls inside <script setup>", async () => {
    const projectDir = createProjectFiles("vue-dynamic-import", {
      "router.vue": [
        "<script setup>",
        "import { defineAsyncComponent } from 'vue'",
        "const AsyncModal = defineAsyncComponent(() => import('./AsyncModal.vue'))",
        "const AsyncChart = defineAsyncComponent(() => import('@/components/Chart.vue'))",
        "</script>",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(allImports["vue"], "expected 'vue' to be detected");
    assert.ok(
      allImports["./AsyncModal.vue"] ||
        allImports["AsyncModal.vue"] ||
        allImports["AsyncModal"],
      "expected dynamic AsyncModal import to be detected",
    );
    assert.ok(
      allImports["@/components/Chart.vue"] ||
        allImports["@/components/Chart"] ||
        allImports["Chart.vue"],
      "expected dynamic Chart import to be detected",
    );
  });

  it("tracks imports from a Vue SFC with multiple <script> blocks (setup + non-setup)", async () => {
    const projectDir = createProjectFiles("vue-dual-script", {
      "Hybrid.vue": [
        "<template>",
        "  <div>{{ msg }}</div>",
        "</template>",
        "<script>",
        "// Options API block",
        "import { defineComponent } from 'vue'",
        "import { mapState } from 'vuex'",
        "export default defineComponent({ name: 'Hybrid' })",
        "</script>",
        "<script setup>",
        "import { ref } from 'vue'",
        "import axios from 'axios'",
        "const msg = ref('hello')",
        "</script>",
      ].join("\n"),
    });

    const { allImports } = await findJSImportsExports(projectDir, false);

    assert.ok(allImports["vue"], "expected 'vue' to be detected");
    assert.ok(allImports["vuex"], "expected 'vuex' to be detected");
    assert.ok(allImports["axios"], "expected 'axios' to be detected");
  });

  it("tracks all imports from the full vue-repotest fixture (including new views and components)", async () => {
    const fixtureDir = fileURLToPath(
      new URL("../../test/data/vue-repotest/src", import.meta.url),
    );
    const { allImports } = await findJSImportsExports(fixtureDir, true);

    // Core runtime libraries
    assert.ok(allImports["vue"], "expected 'vue' to be found in fixture");
    assert.ok(
      allImports["vue-router"],
      "expected 'vue-router' to be found in fixture",
    );
    assert.ok(allImports["pinia"], "expected 'pinia' to be found in fixture");
    assert.ok(allImports["axios"], "expected 'axios' to be found in fixture");
    // storeToRefs is imported in UserList.vue
    assert.ok(
      allImports["pinia"],
      "expected 'pinia' (storeToRefs) to be found in fixture",
    );
  });
});

// ---------------------------------------------------------------------------
// Vite / Vue CLI config file parsing
// ---------------------------------------------------------------------------

describe("findJSImportsExports() Vite and Vue config file support", () => {
  it("detects imports from vite.config.js (previously excluded by IGNORE_FILE_PATTERN)", async () => {
    const projectDir = createProjectFiles("vite-config-imports", {
      "vite.config.js": [
        "import { defineConfig } from 'vite'",
        "import vue from '@vitejs/plugin-vue'",
        "import vueJsx from '@vitejs/plugin-vue-jsx'",
        "export default defineConfig({ plugins: [vue(), vueJsx()] })",
      ].join("\n"),
      "src/main.js": "import { createApp } from 'vue'",
    });
    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(
      allImports["vite"],
      "expected 'vite' to be detected from vite.config.js",
    );
    assert.ok(
      allImports["@vitejs/plugin-vue"],
      "expected '@vitejs/plugin-vue' to be detected from vite.config.js",
    );
    assert.ok(
      allImports["@vitejs/plugin-vue-jsx"],
      "expected '@vitejs/plugin-vue-jsx' to be detected from vite.config.js",
    );
  });

  it("detects imports from vite.config.ts", async () => {
    const projectDir = createProjectFiles("vite-config-ts-imports", {
      "vite.config.ts": [
        "import { defineConfig } from 'vite'",
        "import vue from '@vitejs/plugin-vue'",
        "export default defineConfig({ plugins: [vue()] })",
      ].join("\n"),
    });
    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(
      allImports["vite"],
      "expected 'vite' to be detected from vite.config.ts",
    );
    assert.ok(
      allImports["@vitejs/plugin-vue"],
      "expected '@vitejs/plugin-vue' to be detected from vite.config.ts",
    );
  });

  it("detects imports from vue.config.js (Vue CLI)", async () => {
    const projectDir = createProjectFiles("vue-config-imports", {
      "vue.config.js": [
        "const { defineConfig } = require('@vue/cli-service')",
        "module.exports = defineConfig({ transpileDependencies: true })",
      ].join("\n"),
    });
    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(
      allImports["@vue/cli-service"],
      "expected '@vue/cli-service' to be detected from vue.config.js",
    );
  });

  it("extracts CSS preprocessor additionalData @import package references from vite.config.js", async () => {
    const projectDir = createProjectFiles("vite-config-css-additional-data", {
      "vite.config.js": [
        "import { defineConfig } from 'vite'",
        "export default defineConfig({",
        "  css: {",
        "    preprocessorOptions: {",
        "      scss: {",
        '        additionalData: `@import "bootstrap/scss/variables"; @import "~bulma/sass/utilities/_all";`',
        "      },",
        "    },",
        "  },",
        "})",
      ].join("\n"),
    });
    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(
      allImports["bootstrap"],
      "expected 'bootstrap' to be detected from CSS additionalData",
    );
    assert.ok(
      allImports["bulma"],
      "expected 'bulma' to be detected from CSS additionalData",
    );
  });

  it("does not detect packages from other .config.js files (e.g. jest.config.js)", async () => {
    const projectDir = createProjectFiles("jest-config-excluded", {
      "jest.config.js": [
        "module.exports = {",
        "  testEnvironment: 'jsdom',",
        "  transform: { '^.+\\.tsx?$': 'ts-jest' },",
        "}",
      ].join("\n"),
      "src/app.js": "import express from 'express'",
    });
    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(
      !allImports["ts-jest"],
      "expected 'ts-jest' NOT to be detected from jest.config.js",
    );
    assert.ok(
      allImports["express"],
      "expected 'express' to be detected from src/app.js",
    );
  });
});

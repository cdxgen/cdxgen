import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { filterBom } from "../stages/postgen/postgen.js";
import { validateBom } from "../validator/bomValidator.js";
import {
  createComposerNodeModulesFixture,
  createJarNodeModulesFixture,
  fixtureDir,
  getProp,
  loadStubbedCreateJarBom,
  toPortablePath,
} from "./bomTestHelpers.poku.js";
import {
  createChromeExtensionBom,
  createNodejsBom,
  getDirectAiInventoryType,
} from "./jsBom.js";
import { createPHPBom } from "./managedBom.js";

describe("jsBom", () => {
  describe("createChromeExtensionBom()", () => {
    it("should catalog a directly provided extension and its node dependencies", async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "cdxgen-chrome-ext-cli-"));
      const extensionId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const extensionIdDir = join(tempRoot, extensionId);
      const extensionVersionDir = join(extensionIdDir, "1.2.3");
      try {
        mkdirSync(extensionVersionDir, { recursive: true });
        writeFileSync(
          join(extensionVersionDir, "manifest.json"),
          JSON.stringify({
            manifest_version: 3,
            name: "CLI Test Extension",
            description: "Direct path test",
            version: "1.2.3",
          }),
          "utf-8",
        );
        writeFileSync(
          join(extensionVersionDir, "package.json"),
          JSON.stringify({
            name: "chrome-extension-cli-test",
            version: "1.2.3",
            dependencies: {
              "left-pad": "1.3.0",
            },
          }),
          "utf-8",
        );
        writeFileSync(
          join(extensionVersionDir, "package-lock.json"),
          JSON.stringify({
            name: "chrome-extension-cli-test",
            version: "1.2.3",
            lockfileVersion: 3,
            requires: true,
            packages: {
              "": {
                name: "chrome-extension-cli-test",
                version: "1.2.3",
                dependencies: {
                  "left-pad": "1.3.0",
                },
              },
              "node_modules/left-pad": {
                version: "1.3.0",
              },
            },
          }),
          "utf-8",
        );
        const bomData = await createChromeExtensionBom(extensionIdDir, {
          projectType: ["chrome-extension"],
          multiProject: false,
        });
        const components = bomData?.bomJson?.components || [];
        assert.ok(
          components.some(
            (component) =>
              component.purl === `pkg:chrome-extension/${extensionId}@1.2.3`,
          ),
        );
        assert.ok(
          components.some(
            (component) =>
              component.name === "left-pad" &&
              component.purl?.startsWith("pkg:npm/left-pad@1.3.0"),
          ),
        );
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it("should parse an AI-targeted community extension manifest from direct version path", async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "cdxgen-chrome-ext-cli-ai-"));
      const extensionId = "llllllllllllllllllllllllllllllll";
      const extensionVersion = "1.0.0";
      const extensionVersionDir = join(tempRoot, extensionId, extensionVersion);
      try {
        mkdirSync(extensionVersionDir, { recursive: true });
        writeFileSync(
          join(extensionVersionDir, "manifest.json"),
          readFileSync(
            join(fixtureDir, "chrome-copilottts-manifest.json"),
            "utf-8",
          ),
          "utf-8",
        );
        const bomData = await createChromeExtensionBom(extensionVersionDir, {
          projectType: ["chrome-extension"],
          multiProject: false,
        });
        const extensionComponent = (bomData?.bomJson?.components || []).find(
          (component) =>
            component.purl ===
            `pkg:chrome-extension/${extensionId}@${extensionVersion}`,
        );
        assert.ok(extensionComponent, "expected direct extension component");
        const properties = extensionComponent.properties || [];
        assert.ok(
          properties.some(
            (prop) =>
              prop.name === "cdx:chrome-extension:permissions" &&
              prop.value.includes("scripting"),
          ),
        );
        assert.ok(
          properties.some(
            (prop) =>
              prop.name === "cdx:chrome-extension:capability:codeInjection" &&
              prop.value === "true",
          ),
        );
        assert.ok(
          properties.some(
            (prop) =>
              prop.name === "cdx:chrome-extension:hostPermissions" &&
              prop.value.includes("https://github.com/copilot/tasks/*"),
          ),
        );
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it("should not scan installed browser locations without explicit extension project type", async () => {
      const discoverChromiumExtensionDirs = sinon.stub().returns([
        {
          browser: "Google Chrome",
          channel: "stable",
          dir: join(tmpdir(), "fake-browser-dir"),
        },
      ]);
      const collectInstalledChromeExtensions = sinon.stub().returns([
        {
          type: "application",
          name: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          version: "1.0.0",
          purl: "pkg:chrome-extension/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@1.0.0",
          "bom-ref":
            "pkg:chrome-extension/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@1.0.0",
        },
      ]);
      const { createChromeExtensionBom: createChromeExtensionBomMocked } =
        await esmock("./jsBom.js", {
          "../ecosystems/chromextutils.js": {
            CHROME_EXTENSION_PURL_TYPE: "chrome-extension",
            collectChromeExtensionsFromPath: sinon
              .stub()
              .returns({ components: [], extensionDirs: [] }),
            collectInstalledChromeExtensions,
            discoverChromiumExtensionDirs,
          },
        });
      const bomData = await createChromeExtensionBomMocked(
        join(tmpdir(), "generic-project"),
        {
          deep: true,
          multiProject: false,
          projectType: ["js"],
        },
      );
      assert.deepStrictEqual(bomData?.bomJson?.components || [], []);
      sinon.assert.notCalled(discoverChromiumExtensionDirs);
      sinon.assert.notCalled(collectInstalledChromeExtensions);
    });
  });

  describe("createVscodeExtensionBom()", () => {
    it("should not scan installed IDE locations without explicit extension project type", async () => {
      const discoverIdeExtensionDirs = sinon.stub().returns([
        {
          name: "VS Code",
          dir: join(tmpdir(), "fake-ide-dir"),
        },
      ]);
      const collectInstalledExtensions = sinon.stub().returns([
        {
          type: "application",
          name: "sample.publisher",
          version: "1.0.0",
          purl: "pkg:vscode-extension/sample/publisher@1.0.0",
          "bom-ref": "pkg:vscode-extension/sample/publisher@1.0.0",
        },
      ]);
      const { createVscodeExtensionBom: createVscodeExtensionBomMocked } =
        await esmock("./jsBom.js", {
          "../helpers/vsixutils.js": {
            cleanupTempDir: sinon.stub(),
            collectInstalledExtensions,
            discoverIdeExtensionDirs,
            extractVsixToTempDir: sinon.stub(),
            parseVsixFile: sinon.stub(),
            VSCODE_EXTENSION_PURL_TYPE: "vscode-extension",
          },
        });
      const bomData = await createVscodeExtensionBomMocked(
        join(tmpdir(), "generic-project"),
        {
          deep: true,
          multiProject: false,
          projectType: ["js"],
        },
      );
      assert.deepStrictEqual(bomData?.bomJson?.components || [], []);
      sinon.assert.notCalled(discoverIdeExtensionDirs);
      sinon.assert.notCalled(collectInstalledExtensions);
    });

    it("should scan installed IDE locations when explicitly requested", async () => {
      const discoverIdeExtensionDirs = sinon.stub().returns([
        {
          name: "VS Code",
          dir: join(tmpdir(), "fake-ide-dir"),
        },
      ]);
      const collectInstalledExtensions = sinon.stub().returns([
        {
          type: "application",
          name: "sample.publisher",
          version: "1.0.0",
          purl: "pkg:vscode-extension/sample/publisher@1.0.0",
          "bom-ref": "pkg:vscode-extension/sample/publisher@1.0.0",
        },
      ]);
      const { createVscodeExtensionBom: createVscodeExtensionBomMocked } =
        await esmock("./jsBom.js", {
          "../helpers/vsixutils.js": {
            cleanupTempDir: sinon.stub(),
            collectInstalledExtensions,
            discoverIdeExtensionDirs,
            extractVsixToTempDir: sinon.stub(),
            parseVsixFile: sinon.stub(),
            VSCODE_EXTENSION_PURL_TYPE: "vscode-extension",
          },
        });
      const bomData = await createVscodeExtensionBomMocked(
        join(tmpdir(), "generic-project"),
        {
          deep: true,
          multiProject: false,
          projectType: ["ide-extension"],
        },
      );
      const components = bomData?.bomJson?.components || [];
      assert.ok(
        components.some(
          (component) =>
            component.purl === "pkg:vscode-extension/sample/publisher@1.0.0",
        ),
      );
      sinon.assert.calledOnce(discoverIdeExtensionDirs);
      sinon.assert.calledOnce(collectInstalledExtensions);
    });
  });

  describe("node_modules multi-ecosystem filtering", () => {
    it("ignores composer manifests in node_modules during mixed npm/php scans", () => {
      const tmpDir = createComposerNodeModulesFixture();
      try {
        const bomData = createPHPBom(tmpDir, {
          installDeps: false,
          multiProject: true,
          projectType: ["js", "php"],
          specVersion: 1.7,
        });
        assert.deepStrictEqual(bomData, {});
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("still allows explicit php scans to inspect composer manifests in node_modules", () => {
      const tmpDir = createComposerNodeModulesFixture();
      try {
        const bomData = createPHPBom(tmpDir, {
          installDeps: false,
          multiProject: true,
          projectType: ["php"],
          specVersion: 1.7,
        });
        assert.ok(bomData?.bomJson?.components?.length);
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("still allows direct php scans without projectType to inspect composer manifests in node_modules", () => {
      const tmpDir = createComposerNodeModulesFixture();
      try {
        const bomData = createPHPBom(tmpDir, {
          installDeps: false,
          multiProject: true,
          specVersion: 1.7,
        });
        assert.ok(bomData?.bomJson?.components?.length);
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("still allows explicit php alias combinations to inspect composer manifests in node_modules", () => {
      const tmpDir = createComposerNodeModulesFixture();
      try {
        const bomData = createPHPBom(tmpDir, {
          installDeps: false,
          multiProject: true,
          projectType: ["php", "composer"],
          specVersion: 1.7,
        });
        assert.ok(bomData?.bomJson?.components?.length);
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("ignores jar artifacts in node_modules during mixed npm/jar scans", async () => {
      const tmpDir = createJarNodeModulesFixture();
      try {
        const createJarBom = await loadStubbedCreateJarBom();
        const bomData = await createJarBom(tmpDir, {
          multiProject: true,
          projectType: ["js", "jar"],
          specVersion: 1.7,
        });
        assert.strictEqual(bomData?.bomJson?.components?.length || 0, 0);
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("still allows explicit jar scans to inspect node_modules artifacts", async () => {
      const tmpDir = createJarNodeModulesFixture();
      try {
        const createJarBom = await loadStubbedCreateJarBom();
        const bomData = await createJarBom(tmpDir, {
          multiProject: true,
          projectType: ["jar"],
          specVersion: 1.7,
        });
        assert.ok(bomData?.bomJson?.components?.length);
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("still allows direct jar scans without projectType to inspect node_modules artifacts", async () => {
      const tmpDir = createJarNodeModulesFixture();
      try {
        const createJarBom = await loadStubbedCreateJarBom();
        const bomData = await createJarBom(tmpDir, {
          multiProject: true,
          specVersion: 1.7,
        });
        assert.ok(bomData?.bomJson?.components?.length);
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("still allows explicit jar alias combinations to inspect node_modules artifacts", async () => {
      const tmpDir = createJarNodeModulesFixture();
      try {
        const createJarBom = await loadStubbedCreateJarBom();
        const bomData = await createJarBom(tmpDir, {
          multiProject: true,
          projectType: ["jar", "war"],
          specVersion: 1.7,
        });
        assert.ok(bomData?.bomJson?.components?.length);
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  describe("createNodejsBom() npm scope and scripts", () => {
    const angularCliScriptsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "angular-cli-scripts-repotest",
    );
    const angularCssConfigDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "angular-css-config-repotest",
    );
    const angularAppConfigDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "angular-app-config-repotest",
    );
    const vueRepoDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "vue-repotest",
    );
    const svelteRepoDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "svelte-repotest",
    );
    const svelteLegacyRepoDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "svelte-legacy-repotest",
    );
    const sveltePrecisionDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "svelte-precision",
    );
    const pnpmGitSshRepoDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "pnpm-git-ssh-repotest",
    );
    const pnpmNestedLocksRepoDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "pnpm-nested-locks-repotest",
    );

    const bunRepoDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "bun",
    );

    const unusedRuntimeDepRepoDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "unused-runtime-dep-repotest",
    );
    const typeOnlyRepoDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "type-only-repotest",
    );

    const baseOptions = {
      installDeps: false,
      multiProject: false,
      specVersion: 1.7,
    };

    it("parses a bun.lock project via createNodejsBom", async () => {
      const result = await createNodejsBom(bunRepoDir, baseOptions);
      const comps = result.bomJson?.components || [];
      assert.strictEqual(comps.length, 13);
      const find = (group, name) =>
        comps.find((c) => c.group === group && c.name === name);
      const generator = find("@babel", "generator");
      const leftPad = find("", "left-pad");
      const typescript = find("", "typescript");
      const fsevents = find("", "fsevents");
      // Registry dependency carries a distribution external reference.
      assert.ok(
        generator?.externalReferences?.some(
          (ref) => ref.type === "distribution",
        ),
      );
      // left-pad is a production dependency (no optional scope).
      assert.strictEqual(leftPad?.scope, undefined);
      // typescript is a devDependency -> optional.
      assert.strictEqual(typescript?.scope, "optional");
      // fsevents is an optionalDependency -> optional.
      assert.strictEqual(fsevents?.scope, "optional");
      // The parent component (bun-fixture) is wired into the dependency tree.
      const parentRef = result.bomJson?.metadata?.component?.["bom-ref"];
      const rootDeps = (result.bomJson?.dependencies || []).find(
        (d) => d.ref === parentRef,
      );
      assert.ok(
        rootDeps?.dependsOn?.includes("pkg:npm/@babel/generator@7.26.5"),
      );
    });

    // #4336: a missing import is not evidence that a package is optional.
    it("keeps unimported runtime dependencies at their manifest scope", async () => {
      const result = await createNodejsBom(
        unusedRuntimeDepRepoDir,
        baseOptions,
      );
      const comps = result.bomJson?.components || [];
      const find = (name) =>
        comps.find((c) => c.group === "" && c.name === name);
      const isDevelopment = (comp) =>
        getProp(comp, "cdx:npm:package:development") === "true";

      // Declared in dependencies and never imported: the lockfile scope stands.
      assert.strictEqual(find("left-pad")?.scope, undefined);
      assert.strictEqual(isDevelopment(find("left-pad")), false);
      // Imported runtime dependency and the dependency it pulls in at runtime.
      assert.strictEqual(find("debug")?.scope, "required");
      assert.strictEqual(find("ms")?.scope, "required");
      // An imported devDependency is promoted, and still says it is one.
      const isNumber = find("is-number");
      assert.strictEqual(isNumber?.scope, "required");
      assert.ok(isDevelopment(isNumber));
      assert.ok(
        (isNumber?.evidence?.occurrences || []).some((o) =>
          toPortablePath(o.location).endsWith("index.js"),
        ),
      );
      // A devDependency nothing imports stays optional.
      assert.strictEqual(find("picocolors")?.scope, "optional");
      assert.ok(isDevelopment(find("picocolors")));

      const requiredOnly = filterBom(structuredClone(result.bomJson), {
        requiredOnly: true,
      });
      assert.deepStrictEqual(
        requiredOnly.components.map((c) => c.name).sort(),
        ["debug", "is-number", "left-pad", "ms"],
      );
    });

    it("keeps the dependencies of a type-only import out of required scope", async () => {
      const result = await createNodejsBom(typeOnlyRepoDir, baseOptions);
      const comps = result.bomJson?.components || [];
      const find = (name) => comps.find((c) => c.name === name);

      assert.strictEqual(find("is-even")?.scope, "required");
      // `import type` from is-odd is erased at compile time.
      assert.strictEqual(find("is-odd")?.scope, "excluded");
      assert.strictEqual(
        getProp(find("is-odd"), "cdx:npm:package:type-only"),
        "true",
      );
      // is-number is only reached through is-odd.
      assert.strictEqual(find("is-number")?.scope, "optional");
    });

    it("marks script-referenced packages required in Angular CLI scripts app", async () => {
      const result = await createNodejsBom(angularCliScriptsDir, baseOptions);
      const comps = result.bomJson?.components || [];
      const find = (group, name) =>
        comps.find((c) => c.group === group && c.name === name);
      const angularCli = find("@angular", "cli");
      const angularCore = find("@angular", "core");
      const licenseReport = find("", "license-report");
      const leftPad = find("", "left-pad");

      // @angular/cli is referenced via "ng" command in build script
      assert.strictEqual(angularCli?.scope, "required");
      // @angular/core is imported in src/main.ts
      assert.strictEqual(angularCore?.scope, "required");
      // license-report is invoked via "npx license-report" in npm scripts
      assert.strictEqual(licenseReport?.scope, "required");
      // left-pad is a runtime dependency nothing references, so it keeps the
      // lockfile scope
      assert.strictEqual(leftPad?.scope, undefined);
    });

    it("marks CSS/asset-only packages required via angular.json configuration", async () => {
      const result = await createNodejsBom(angularCssConfigDir, baseOptions);
      const comps = result.bomJson?.components || [];
      const find = (group, name) =>
        comps.find((c) => c.group === group && c.name === name);

      // Packages referenced in angular.json styles/assets/includePaths
      assert.strictEqual(
        find("@fortawesome", "fontawesome-free")?.scope,
        "required",
      );
      assert.strictEqual(find("", "bootstrap")?.scope, "required");
      assert.strictEqual(find("", "flag-icons")?.scope, "required");
      assert.strictEqual(find("", "angular-i18n")?.scope, "required");
      // Package imported via @use/@import in styles.scss
      assert.strictEqual(find("", "material-symbols")?.scope, "required");
      // left-pad is a runtime dependency nothing references, so it keeps the
      // lockfile scope
      assert.strictEqual(find("", "left-pad")?.scope, undefined);
    });

    // #4456: ng new puts the root providers in src/app/app.config.ts.
    it("scopes the providers registered in an Angular app.config.ts", async () => {
      const result = await createNodejsBom(angularAppConfigDir, baseOptions);
      const comps = result.bomJson?.components || [];
      const find = (group, name) =>
        comps.find((c) => c.group === group && c.name === name);
      const locations = (comp) =>
        (comp?.evidence?.occurrences || []).map(
          (o) => `${toPortablePath(o.location)}:${o.line}`,
        );

      // Nothing else imports from @ngrx, so app.config.ts alone makes the
      // store required.
      const store = find("@ngrx", "store");
      assert.strictEqual(store?.scope, "required");
      assert.deepStrictEqual(locations(store), [
        "src/app/app.config.ts:5",
        "src/app/app.config.ts:14",
      ]);
      assert.deepStrictEqual(locations(find("@angular", "service-worker")), [
        "src/app/app.config.ts:4",
        "src/app/app.config.ts:15",
      ]);
      // https-proxy-agent is a devDependency only src/proxy.conf.js requires,
      // and that config file is still skipped.
      const proxyAgent = find("", "https-proxy-agent");
      assert.strictEqual(proxyAgent?.scope, "optional");
      assert.deepStrictEqual(locations(proxyAgent), []);
    });

    it("correctly scopes devDependencies vs runtime deps in a Vue app", async () => {
      const result = await createNodejsBom(vueRepoDir, baseOptions);
      const comps = result.bomJson?.components || [];
      const find = (group, name) =>
        comps.find((c) => c.group === group && c.name === name);

      // Runtime deps imported in source files
      assert.strictEqual(find("", "vue")?.scope, "required");
      assert.strictEqual(find("", "vue-router")?.scope, "required");
      assert.strictEqual(find("", "pinia")?.scope, "required");
      assert.strictEqual(find("", "axios")?.scope, "required");
      // devDependency: vite is a build tool, but imported in vite.config.js
      // (now parsed since vite.config.js is excluded from IGNORE_FILE_PATTERN)
      assert.strictEqual(find("", "vite")?.scope, "required");
      // devDependency: plugin imported in vite.config.js, now detected as required
      assert.strictEqual(find("@vitejs", "plugin-vue")?.scope, "required");
    });

    it("scopes a SvelteKit app correctly: runtime deps, framework, adapter, CSS, scripts", async () => {
      const result = await createNodejsBom(svelteRepoDir, baseOptions);
      const comps = result.bomJson?.components || [];
      const find = (group, name) =>
        comps.find((c) => c.group === group && c.name === name);

      // Runtime dependencies imported from .svelte components
      assert.strictEqual(find("", "svelte")?.scope, "required");
      assert.strictEqual(find("", "chart.js")?.scope, "required");
      assert.strictEqual(find("", "dayjs")?.scope, "required");
      assert.strictEqual(find("", "zod")?.scope, "required");
      assert.strictEqual(find("", "nanoid")?.scope, "required");
      // Framework: @sveltejs/kit is used via hooks.server.ts, +page.server.ts,
      // vite.config.js, and the $app/* / $env/* virtual modules
      assert.strictEqual(find("@sveltejs", "kit")?.scope, "required");
      // Adapter imported in svelte.config.js (previously ignored)
      assert.strictEqual(find("@sveltejs", "adapter-node")?.scope, "required");
      assert.strictEqual(
        find("@sveltejs", "vite-plugin-svelte")?.scope,
        "required",
      );
      // CSS: @use'd package and the preprocessor implied by lang="scss"
      assert.strictEqual(find("", "bulma")?.scope, "required");
      assert.strictEqual(find("", "sass")?.scope, "required");
      // <script lang="ts"> implies the typescript compiler
      assert.strictEqual(find("", "typescript")?.scope, "required");
      // npm script executables: vite, svelte-kit sync, svelte-check, vitest
      assert.strictEqual(find("", "vite")?.scope, "required");
      assert.strictEqual(find("", "svelte-check")?.scope, "required");
      assert.strictEqual(find("", "vitest")?.scope, "required");
      // left-pad is deliberately unused
      assert.strictEqual(find("", "left-pad")?.scope, "optional");

      // Occurrence evidence carries the correct file and line: the dayjs
      // import in src/routes/+page.svelte is on line 4.
      const dayjsOccurrences = find("", "dayjs")?.evidence?.occurrences || [];
      assert.ok(
        dayjsOccurrences.some(
          (occurrence) =>
            toPortablePath(occurrence.location).endsWith(
              "src/routes/+page.svelte",
            ) && occurrence.line === 4,
        ),
        "expected dayjs occurrence at src/routes/+page.svelte line 4",
      );
      // The $app/stores virtual module usage is attributed to @sveltejs/kit.
      const kit = find("@sveltejs", "kit");
      assert.ok(
        (kit?.properties || []).some(
          (property) =>
            property.name === "internal:ImportedModules" &&
            property.value.includes("$app/stores"),
        ),
        "expected $app/stores in @sveltejs/kit imported modules",
      );
    });

    it("scopes a Svelte 4 legacy app correctly", async () => {
      const result = await createNodejsBom(svelteLegacyRepoDir, baseOptions);
      const comps = result.bomJson?.components || [];
      const find = (group, name) =>
        comps.find((c) => c.group === group && c.name === name);

      assert.strictEqual(find("", "svelte")?.scope, "required");
      assert.strictEqual(find("", "date-fns")?.scope, "required");
      // "vite build" script
      assert.strictEqual(find("", "vite")?.scope, "required");
      assert.strictEqual(find("", "left-pad")?.scope, "optional");
    });

    it("scopes the svelte-precision parser fixtures correctly, including the rune-only module", async () => {
      const result = await createNodejsBom(sveltePrecisionDir, baseOptions);
      const comps = result.bomJson?.components || [];
      const find = (group, name) =>
        comps.find((c) => c.group === group && c.name === name);

      // store.svelte.ts uses runes without importing svelte
      assert.strictEqual(find("", "svelte")?.scope, "required");
      assert.strictEqual(find("", "dayjs")?.scope, "required");
      assert.strictEqual(find("", "nanoid")?.scope, "required");
      assert.strictEqual(find("", "zod")?.scope, "required");
      assert.strictEqual(find("", "left-pad")?.scope, "optional");

      // broken-template.svelte still yields its script imports at the right line
      const nanoOccurrences = find("", "nanoid")?.evidence?.occurrences || [];
      assert.ok(
        nanoOccurrences.some(
          (occurrence) =>
            toPortablePath(occurrence.location).endsWith(
              "broken-template.svelte",
            ) && occurrence.line === 6,
        ),
        "expected nanoid occurrence in broken-template.svelte at line 6",
      );
    });

    it("keeps Svelte scopes correct when the optional template parser is absent (tier 1 only)", async () => {
      // jsBom imports findJSImportsExports from analyzer.js directly, so the
      // optional-parser seam is mocked at the analyzer level and the scope
      // assignment (addEvidenceForImports) is exercised on the tier-1-only
      // evidence that results — the same pairing createNodejsBom performs.
      const esmockModule = await import("esmock");
      const realSvelteUtils = await import("../inventory/svelteUtils.js");
      const mockedAnalyzer = await esmockModule.default(
        "../inventory/analyzer.js",
        {
          "../inventory/svelteUtils.js": {
            ...realSvelteUtils,
            getSvelteTemplateParser: () => null,
            primeSvelteParser: async () => null,
          },
        },
      );
      const { addEvidenceForImports } = await import(
        "../ecosystems/jsEvidence.js"
      );
      const { allImports, allExports } =
        await mockedAnalyzer.findJSImportsExports(
          join(svelteRepoDir, "src"),
          false,
        );

      // The tier-1 evidence that drives scope assignment.
      assert.ok(allImports["svelte"]);
      assert.ok(allImports["dayjs"]);
      assert.ok(allImports["@sveltejs/kit"]);
      assert.ok(allImports["bulma"]);
      assert.ok(allImports["sass"]);

      const pkgList = [
        { group: "", name: "svelte", properties: [] },
        { group: "", name: "dayjs", properties: [] },
        { group: "@sveltejs", name: "kit", properties: [] },
        { group: "", name: "bulma", properties: [] },
        { group: "", name: "sass", properties: [] },
        // left-pad is a devDependency in the fixture, scoped as the lockfile
        // parser scopes it
        {
          group: "",
          name: "left-pad",
          scope: "optional",
          properties: [{ name: "cdx:npm:package:development", value: "true" }],
        },
      ];
      const enriched = await addEvidenceForImports(
        pkgList,
        allImports,
        allExports,
        false,
      );
      const scopeOf = Object.fromEntries(
        enriched.map((pkg) => [
          pkg.group ? `${pkg.group}/${pkg.name}` : pkg.name,
          pkg.scope,
        ]),
      );
      assert.strictEqual(scopeOf.svelte, "required");
      assert.strictEqual(scopeOf.dayjs, "required");
      assert.strictEqual(scopeOf["@sveltejs/kit"], "required");
      assert.strictEqual(scopeOf.bulma, "required");
      assert.strictEqual(scopeOf.sass, "required");
      assert.strictEqual(scopeOf["left-pad"], "optional");
    });

    it("emits cdx:npm:buildScripts property for packages with build scripts", async () => {
      const result = await createNodejsBom(angularCliScriptsDir, baseOptions);
      const parentComp = result.bomJson?.metadata?.component;
      const buildScripts = getProp(parentComp, "cdx:npm:buildScripts");
      assert.ok(
        buildScripts?.includes("build"),
        "expected 'build' in cdx:npm:buildScripts",
      );
    });

    it("emits cdx:npm:buildScripts for Vue app with vite build script", async () => {
      const result = await createNodejsBom(vueRepoDir, baseOptions);
      const parentComp = result.bomJson?.metadata?.component;
      const buildScripts = getProp(parentComp, "cdx:npm:buildScripts");
      assert.ok(
        buildScripts?.includes("build"),
        "expected 'build' in cdx:npm:buildScripts",
      );
    });

    it("creates a BOM for pnpm-git-ssh-repotest with private git dependency", async () => {
      const registryEnvKey = "NPM_CONFIG_@group:registry";
      const previousRegistry = process.env[registryEnvKey];
      process.env[registryEnvKey] =
        "https://private-registry.example.com/api/v4/packages/npm/";
      try {
        const result = await createNodejsBom(pnpmGitSshRepoDir, {
          ...baseOptions,
          projectType: ["pnpm"],
        });
        const comps = result.bomJson?.components || [];
        const gitPkg = comps.find((pkg) => pkg.name === "my_project");
        assert.ok(gitPkg, "git+ssh dependency should be present in components");
        assert.strictEqual(gitPkg.group, "@group");
        assert.strictEqual(gitPkg.version, "1.0.6");
        assert.ok(
          gitPkg["bom-ref"].includes("vcs_url="),
          "git dependency purl should include vcs_url qualifier",
        );
      } finally {
        if (previousRegistry === undefined) {
          delete process.env[registryEnvKey];
        } else {
          process.env[registryEnvKey] = previousRegistry;
        }
      }
    });

    it("keeps nested non-workspace pnpm lockfiles in a pnpm workspace", async () => {
      // The root is a pnpm workspace (root pnpm-lock.yaml + pnpm-workspace.yaml).
      // Independent nested projects that are NOT declared workspace members keep
      // their own committed lockfile and must still be parsed (see #4224), while
      // the redundant lockfile inside a declared workspace member is dropped.
      const result = await createNodejsBom(pnpmNestedLocksRepoDir, {
        ...baseOptions,
        multiProject: true,
        projectType: ["pnpm"],
      });
      const comps = result.bomJson?.components || [];
      const names = comps.map((c) => c.name);
      // Root workspace dependency.
      assert.ok(names.includes("is-odd"), "expected root dependency is-odd");
      // Dependency that lives only in an independent nested lockfile.
      assert.ok(
        names.includes("left-pad"),
        "expected nested independent project dependency left-pad to be kept",
      );
      // Dependency that lives only in a nested lockfile under a dot-directory
      // (eg: .github/scripts) - discovery must include hidden paths.
      assert.ok(
        names.includes("dot-dir-only"),
        "expected dot-directory nested lockfile dependency to be discovered",
      );
      // The lockfile inside the declared workspace member is redundant and must
      // not be parsed - its stray-only package should be absent.
      assert.ok(
        !names.includes("member-stray-only"),
        "redundant workspace-member lockfile should be discarded",
      );
    });
  });

  describe("createNodejsBom() parent component overrides", () => {
    const licensedParentDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
      "js-licensed-parent-repotest",
    );

    it("anchors a licensed package.json parent as a schema-valid component (#4320)", async () => {
      const result = await createNodejsBom(licensedParentDir, {
        installDeps: false,
        multiProject: false,
        specVersion: 1.6,
        projectName: "override-shell",
        projectVersion: "9.9.9",
      });
      const bomJson = result.bomJson;
      assert.ok(bomJson, "expected a BOM document");

      // The override becomes metadata.component.
      assert.strictEqual(
        bomJson.metadata.component["bom-ref"],
        "pkg:application/override-shell@9.9.9",
      );

      // The project described by package.json survives as a subproject
      // component, cleaned of the transient keys parsePkgJson produced.
      const anchored = (bomJson.components || []).find(
        (comp) => comp.name === "licensed-parent-demo",
      );
      assert.ok(anchored, "expected the detected parent as a component");
      assert.strictEqual(anchored.type, "application");
      assert.strictEqual(anchored.license, undefined);
      assert.strictEqual(anchored.homepage, undefined);
      assert.strictEqual(anchored.repository, undefined);
      assert.ok(
        anchored.licenses?.some(
          (l) => l.license?.id === "Apache-2.0" || l.expression,
        ),
        "expected a schema-valid licenses entry",
      );
      assert.ok(
        (anchored.externalReferences || []).some((ref) => ref.type === "vcs"),
        "expected repository url converted to a vcs external reference",
      );
      assert.ok(
        (anchored.externalReferences || []).some(
          (ref) => ref.type === "website",
        ),
        "expected homepage converted to a website external reference",
      );

      // The override root is linked to the detected subproject.
      const rootEdge = (bomJson.dependencies || []).find(
        (dep) => dep.ref === bomJson.metadata.component["bom-ref"],
      );
      assert.ok(
        rootEdge?.dependsOn?.includes(anchored["bom-ref"]),
        "expected the override root to depend on the detected parent",
      );

      // Regression: the document must pass cdxgen's own schema validation,
      // which rejected the transient 'license' key before this fix.
      assert.strictEqual(await validateBom(bomJson), true);
    });
  });

  describe("getDirectAiInventoryType()", () => {
    it("keeps owner/repo-shaped relative paths as ordinary project paths", () => {
      // Regression: a one-slash relative path such as
      // `repotests/sveltejs-realworld` used to be mistaken for a bare
      // Hugging Face repo id, which produced an empty AI-only BOM instead of
      // scanning the local project (#4358).
      assert.strictEqual(
        getDirectAiInventoryType("repotests/sveltejs-realworld", {
          projectType: ["js"],
        }),
        undefined,
      );
      assert.strictEqual(
        getDirectAiInventoryType("repotests/sveltejs-realworld", {
          projectType: [],
        }),
        undefined,
      );
      assert.strictEqual(
        getDirectAiInventoryType("models/org/model", {
          projectType: ["js"],
        }),
        undefined,
      );
    });

    it("resolves bare Hugging Face repo ids only with an explicit ai type", () => {
      assert.strictEqual(
        getDirectAiInventoryType("openai/whisper-small", {
          projectType: ["ai"],
        }),
        "ai",
      );
      // Mixed types collect AI inventory on top of the JS BOM instead of
      // switching the whole scan to exact AI mode.
      assert.strictEqual(
        getDirectAiInventoryType("openai/whisper-small", {
          projectType: ["js", "ai"],
        }),
        undefined,
      );
    });

    it("always resolves explicit Hugging Face purls and URLs", () => {
      assert.strictEqual(
        getDirectAiInventoryType("pkg:huggingface/openai/whisper-small", {
          projectType: ["js"],
        }),
        "ai",
      );
      assert.strictEqual(
        getDirectAiInventoryType(
          "https://huggingface.co/openai/whisper-small",
          {
            projectType: ["js"],
          },
        ),
        "ai",
      );
    });
  });

  describe("createNodejsBom() yarn v1 workspaces", () => {
    it("links workspace members and their own dependencies into the tree", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-yarn-classic-ws-"));
      try {
        const writeJson = (file, data) => {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify(data));
        };
        writeJson(join(tmpDir, "package.json"), {
          name: "yc",
          version: "1.0.0",
          private: true,
          workspaces: ["packages/*"],
          dependencies: { "left-pad": "1.3.0" },
        });
        // `ws` is a prefix of `wsmember`: each name must resolve to its own member.
        writeJson(join(tmpDir, "packages", "wsmember", "package.json"), {
          name: "wsmember",
          version: "3.0.0",
          dependencies: { ws: "*", "is-number": "^7.0.0" },
        });
        writeJson(join(tmpDir, "packages", "ws", "package.json"), {
          name: "ws",
          version: "0.1.0",
          devDependencies: { "@acme/tools": "*" },
        });
        writeJson(join(tmpDir, "packages", "tools", "package.json"), {
          name: "@acme/tools",
          version: "0.9.0",
        });
        // yarn v1 records no entries for workspace members.
        writeFileSync(
          join(tmpDir, "yarn.lock"),
          [
            "# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.",
            "# yarn lockfile v1",
            "",
            "",
            "is-number@^7.0.0:",
            '  version "7.0.0"',
            '  resolved "https://registry.yarnpkg.com/is-number/-/is-number-7.0.0.tgz#7535345b896734d5f80c4d06c50955527a14f12b"',
            "  integrity sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
            "",
            "left-pad@1.3.0:",
            '  version "1.3.0"',
            '  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#5b8a3a7765dfe001261dde915589e782f8c94d1e"',
            "  integrity sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
            "",
          ].join("\n"),
        );
        const result = await createNodejsBom(tmpDir, {
          installDeps: false,
          multiProject: false,
          projectType: ["yarn"],
          specVersion: 1.7,
        });
        const dependsOn = Object.fromEntries(
          result.bomJson.dependencies.map((d) => [d.ref, d.dependsOn]),
        );
        assert.deepStrictEqual(dependsOn["pkg:npm/wsmember@3.0.0"], [
          "pkg:npm/is-number@7.0.0",
          "pkg:npm/ws@0.1.0",
        ]);
        assert.deepStrictEqual(dependsOn["pkg:npm/ws@0.1.0"], [
          "pkg:npm/@acme/tools@0.9.0",
        ]);
        assert.deepStrictEqual(dependsOn["pkg:npm/@acme/tools@0.9.0"], []);
        for (const member of [
          "pkg:npm/@acme/tools@0.9.0",
          "pkg:npm/ws@0.1.0",
          "pkg:npm/wsmember@3.0.0",
        ]) {
          assert.ok(
            dependsOn["pkg:npm/yc@1.0.0"].includes(member),
            `the root should reach ${member}`,
          );
        }
        assert.strictEqual(
          result.bomJson.dependencies.length,
          new Set(result.bomJson.dependencies.map((d) => d.ref)).size,
          "each ref should have one dependency entry",
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

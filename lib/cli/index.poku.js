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

import { auditBom } from "../stages/postgen/auditBom.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { createBom, createChromeExtensionBom, createRustBom } from "./index.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "chrome-extensions",
);
const cargoFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "cargo-workspace-repotest",
);
const cargoCacheFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "cargo-cache-fixture",
  "registry",
  "cache",
  "index.crates.io-1949cf8c6b5b557f",
);

describe("CLI tests", () => {
  describe("submitBom()", () => {
    it("should successfully report the SBOM with given project id, name, version and a single tag", async () => {
      const fakeGotResponse = {
        json: sinon.stub().resolves({ success: true }),
      };

      const gotStub = sinon.stub().returns(fakeGotResponse);
      gotStub.extend = sinon.stub().returns(gotStub);

      const { submitBom } = await esmock("./index.js", {
        got: { default: gotStub },
      });

      const serverUrl = "https://dtrack.example.com";
      const projectId = "f7cb9f02-8041-4991-9101-b01fa07a6522";
      const projectName = "cdxgen-test-project";
      const projectVersion = "1.0.0";
      const projectTag = "tag1";
      const bomContent = { bom: "test" };
      const apiKey = "TEST_API_KEY";
      const skipDtTlsCheck = false;

      const expectedRequestPayload = {
        autoCreate: "true",
        bom: "eyJib20iOiJ0ZXN0In0=", // stringified and base64 encoded bomContent
        project: projectId,
        projectName,
        projectVersion,
        projectTags: [{ name: projectTag }],
      };

      await submitBom(
        {
          serverUrl,
          projectId,
          projectName,
          projectVersion,
          apiKey,
          skipDtTlsCheck,
          projectTag,
        },
        bomContent,
      );

      // Verify got was called exactly once
      sinon.assert.calledOnce(gotStub);

      // Grab call arguments
      const [calledUrl, options] = gotStub.firstCall.args;

      assert.equal(calledUrl, `${serverUrl}/api/v1/bom`);
      assert.equal(options.method, "PUT");
      assert.equal(options.https.rejectUnauthorized, !skipDtTlsCheck);
      assert.equal(options.headers["X-Api-Key"], apiKey);
      assert.match(options.headers["user-agent"], /@CycloneDX\/cdxgen/);
      assert.deepEqual(options.json, expectedRequestPayload);
    });

    it("should successfully report the SBOM with given parent project, name, version and multiple tags", async () => {
      const fakeGotResponse = {
        json: sinon.stub().resolves({ success: true }),
      };

      const gotStub = sinon.stub().returns(fakeGotResponse);
      gotStub.extend = sinon.stub().returns(gotStub);

      const { submitBom } = await esmock("./index.js", {
        got: { default: gotStub },
      });

      const serverUrl = "https://dtrack.example.com";
      const projectName = "cdxgen-test-project";
      const projectVersion = "1.1.0";
      const projectTags = ["tag1", "tag2"];
      const parentProjectId = "5103b8b4-4ca3-46ea-8051-036a3b2ab17e";
      const bomContent = {
        bom: "test2",
      };
      const apiKey = "TEST_API_KEY";
      const skipDtTlsCheck = false;

      const expectedRequestPayload = {
        autoCreate: "true",
        bom: "eyJib20iOiJ0ZXN0MiJ9", // stringified and base64 encoded bomContent
        parentUUID: parentProjectId,
        projectName,
        projectVersion,
        projectTags: [{ name: projectTags[0] }, { name: projectTags[1] }],
      };

      await submitBom(
        {
          serverUrl,
          parentProjectId,
          projectName,
          projectVersion,
          apiKey,
          skipDtTlsCheck,
          projectTag: projectTags,
        },
        bomContent,
      );

      // Verify got was called exactly once
      sinon.assert.calledOnce(gotStub);

      // Grab call arguments
      const [calledUrl, options] = gotStub.firstCall.args;

      // Assert call arguments against expectations
      assert.equal(calledUrl, `${serverUrl}/api/v1/bom`);
      assert.equal(options.method, "PUT");
      assert.equal(options.https.rejectUnauthorized, !skipDtTlsCheck);
      assert.equal(options.headers["X-Api-Key"], apiKey);
      assert.match(options.headers["user-agent"], /@CycloneDX\/cdxgen/);
      assert.deepEqual(options.json, expectedRequestPayload);
    });

    it("should include parentName and parentVersion when parent project name and version are passed", async () => {
      const fakeGotResponse = {
        json: sinon.stub().resolves({ success: true }),
      };

      const gotStub = sinon.stub().returns(fakeGotResponse);
      gotStub.extend = sinon.stub().returns(gotStub);

      const { submitBom } = await esmock("./index.js", {
        got: { default: gotStub },
      });

      const serverUrl = "https://dtrack.example.com";
      const projectName = "cdxgen-test-project";
      const projectVersion = "2.0.0";
      const parentProjectName = "parent-project";
      const parentProjectVersion = "1.0.0";
      const bomContent = {
        bom: "test3",
      };
      const apiKey = "TEST_API_KEY";
      const skipDtTlsCheck = false;

      const expectedRequestPayload = {
        autoCreate: "true",
        bom: "eyJib20iOiJ0ZXN0MyJ9", // stringified and base64 encoded bomContent
        parentName: parentProjectName,
        parentVersion: parentProjectVersion,
        projectName,
        projectVersion,
      };

      await submitBom(
        {
          serverUrl,
          projectName,
          projectVersion,
          parentProjectName,
          parentProjectVersion,
          apiKey,
          skipDtTlsCheck,
        },
        bomContent,
      );

      sinon.assert.calledOnce(gotStub);
      const [calledUrl, options] = gotStub.firstCall.args;

      assert.equal(calledUrl, `${serverUrl}/api/v1/bom`);
      assert.equal(options.method, "PUT");
      assert.equal(options.https.rejectUnauthorized, !skipDtTlsCheck);
      assert.equal(options.headers["X-Api-Key"], apiKey);
      assert.match(options.headers["user-agent"], /@CycloneDX\/cdxgen/);
      assert.deepEqual(options.json, expectedRequestPayload);
    });

    it("should include configurable autoCreate and isLatest values in payload", async () => {
      const fakeGotResponse = {
        json: sinon.stub().resolves({ success: true }),
      };

      const gotStub = sinon.stub().returns(fakeGotResponse);
      gotStub.extend = sinon.stub().returns(gotStub);

      const { submitBom } = await esmock("./index.js", {
        got: { default: gotStub },
      });

      const serverUrl = "https://dtrack.example.com";
      const projectName = "cdxgen-test-project";
      const apiKey = "TEST_API_KEY";

      await submitBom(
        {
          serverUrl,
          projectName,
          apiKey,
          autoCreate: false,
          isLatest: true,
        },
        { bom: "test4" },
      );

      sinon.assert.calledOnce(gotStub);
      const [_calledUrl, options] = gotStub.firstCall.args;
      assert.equal(options.json.autoCreate, "false");
      assert.equal(options.json.isLatest, true);
      assert.equal(options.json.projectVersion, "main");
    });

    it("should reject invalid mixed parent modes before making network request", async () => {
      const fakeGotResponse = {
        json: sinon.stub().resolves({ success: true }),
      };

      const gotStub = sinon.stub().returns(fakeGotResponse);
      gotStub.extend = sinon.stub().returns(gotStub);

      const { submitBom } = await esmock("./index.js", {
        got: { default: gotStub },
      });

      const response = await submitBom(
        {
          serverUrl: "https://dtrack.example.com",
          projectName: "cdxgen-test-project",
          parentProjectId: "5103b8b4-4ca3-46ea-8051-036a3b2ab17e",
          parentProjectName: "parent",
          parentProjectVersion: "1.0.0",
        },
        { bom: "test5" },
      );

      assert.equal(response, undefined);
      sinon.assert.notCalled(gotStub);
    });
  });

  describe("createCocoaBom()", () => {
    it("should skip missing Podfile.lock when failOnError is false", async () => {
      const { createCocoaBom } = await import("./index.js");
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-cocoa-"));
      const podFile = join(tempDir, "Podfile");
      writeFileSync(
        podFile,
        "platform :ios, '14.0'\n\ntarget 'TestApp' do\nend\n",
        "utf-8",
      );
      const consoleLogStub = sinon.stub(console, "log");
      try {
        const bomData = await createCocoaBom(tempDir, {
          deep: false,
          failOnError: false,
          installDeps: false,
          multiProject: false,
        });
        assert.equal(bomData, undefined);
        sinon.assert.calledWithMatch(
          consoleLogStub,
          sinon.match("No 'Podfile.lock' found"),
        );
      } finally {
        consoleLogStub.restore();
        rmSync(tempDir, { force: true, recursive: true });
      }
    });

    it("should not warn or exit for deep mode when Podfile.lock exists", async () => {
      const { createCocoaBom } = await import("./index.js");
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-cocoa-deep-"));
      const podFile = join(tempDir, "Podfile");
      const lockFile = join(tempDir, "Podfile.lock");
      writeFileSync(
        podFile,
        "platform :ios, '14.0'\n\ntarget 'TestApp' do\nend\n",
        "utf-8",
      );
      writeFileSync(lockFile, "PODS: []\nDEPENDENCIES: []\n", "utf-8");
      const processExitStub = sinon.stub(process, "exit");
      try {
        await createCocoaBom(tempDir, {
          deep: true,
          failOnError: true,
          installDeps: false,
          multiProject: false,
        });
        sinon.assert.notCalled(processExitStub);
      } finally {
        processExitStub.restore();
        rmSync(tempDir, { force: true, recursive: true });
      }
    });
  });

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
  });

  describe("createMultiXBom()", () => {
    it("should scan installed chrome extensions only once across multiple non-extension paths", async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "cdxgen-chrome-ext-multi-"));
      const pathA = join(tempRoot, "project-a");
      const pathB = join(tempRoot, "project-b");
      mkdirSync(pathA, { recursive: true });
      mkdirSync(pathB, { recursive: true });
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
      try {
        const { createMultiXBom } = await esmock("./index.js", {
          "../helpers/chromextutils.js": {
            CHROME_EXTENSION_PURL_TYPE: "chrome-extension",
            collectChromeExtensionsFromPath: sinon
              .stub()
              .returns({ components: [], extensionDirs: [] }),
            collectInstalledChromeExtensions,
            discoverChromiumExtensionDirs: sinon.stub().returns([
              {
                browser: "Google Chrome",
                channel: "stable",
                dir: join(tempRoot, "fake-browser-dir"),
              },
            ]),
          },
        });
        await createMultiXBom([pathA, pathB], {
          projectType: ["chrome-extension"],
          multiProject: true,
        });
        sinon.assert.calledOnce(collectInstalledChromeExtensions);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe("createBom() cargo cache support", () => {
    it("catalogs cached cargo crate archives via the cargo-cache project type", async () => {
      const originalCargoCacheDir = process.env.CARGO_CACHE_DIR;
      try {
        process.env.CARGO_CACHE_DIR = cargoCacheFixtureDir;
        const bomNSData = await createBom(cargoCacheFixtureDir, {
          deep: false,
          failOnError: true,
          installDeps: false,
          multiProject: false,
          projectType: ["cargo-cache"],
          specVersion: 1.6,
        });
        const bomJson = bomNSData?.bomJson || {};
        const components = bomJson.components || [];
        const serdeComponent = components.find(
          (component) => component.name === "serde",
        );
        assert.ok(serdeComponent);
        assert.strictEqual(serdeComponent.version, "1.0.217");
        assert.strictEqual(
          serdeComponent.properties.find(
            (property) => property.name === "cdx:cargo:cacheSource",
          )?.value,
          "registry-cache",
        );
      } finally {
        if (originalCargoCacheDir === undefined) {
          delete process.env.CARGO_CACHE_DIR;
        } else {
          process.env.CARGO_CACHE_DIR = originalCargoCacheDir;
        }
      }
    });

    it("creates a Cargo workspace BOM with workflow signals and matching audit findings", async () => {
      const options = {
        bomAudit: true,
        bomAuditCategories: "package-integrity",
        bomAuditMinSeverity: "low",
        failOnError: true,
        includeFormulation: true,
        installDeps: false,
        multiProject: true,
        projectType: ["cargo", "github"],
        specVersion: 1.7,
      };
      const bomNSData = await createBom(cargoFixtureDir, options);
      const processedBomNSData = postProcess(
        bomNSData,
        options,
        cargoFixtureDir,
      );
      const bomJson = processedBomNSData?.bomJson || {};
      const coreComponent = (bomJson.components || []).find(
        (component) =>
          component.name === "core" &&
          component.properties?.some(
            (property) =>
              property.name === "cdx:cargo:workspaceDependencyResolved" &&
              property.value === "true",
          ),
      );
      const buildHelperComponent = (bomJson.components || []).find(
        (component) =>
          component.name === "build-helper" &&
          component.properties?.some(
            (property) =>
              property.name === "cdx:cargo:workspaceDependencyResolved" &&
              property.value === "true",
          ),
      );
      const cargoToolchainComponent = (bomJson.components || []).find(
        (component) =>
          component.properties?.some(
            (property) =>
              property.name === "cdx:github:action:role" &&
              property.value === "toolchain",
          ),
      );
      const cargoRunComponent = (bomJson.components || []).find((component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:github:step:usesCargo" &&
            property.value === "true",
        ),
      );
      assert.strictEqual(
        coreComponent?.properties?.find(
          (property) =>
            property.name === "cdx:cargo:workspaceDependencyResolved",
        )?.value,
        "true",
      );
      assert.strictEqual(
        buildHelperComponent?.properties?.find(
          (property) => property.name === "cdx:cargo:dependencyKind",
        )?.value,
        "build",
      );
      assert.strictEqual(
        buildHelperComponent?.properties?.find(
          (property) => property.name === "cdx:cargo:resolvedWorkspaceMember",
        )?.value,
        "build-helper",
      );
      assert.strictEqual(
        cargoToolchainComponent?.properties?.find(
          (property) => property.name === "cdx:github:action:ecosystem",
        )?.value,
        "cargo",
      );
      assert.strictEqual(
        cargoRunComponent?.properties?.find(
          (property) => property.name === "cdx:github:step:cargoSubcommands",
        )?.value,
        "build,test",
      );
      const findings = await auditBom(bomJson, {
        bomAuditCategories: "package-integrity",
        bomAuditMinSeverity: "low",
      });
      assert.ok(findings.some((finding) => finding.ruleId === "INT-012"));
      assert.ok(findings.some((finding) => finding.ruleId === "INT-013"));
    });

    it("nests only manifest package components under the Rust parent component", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-rust-parent-"));
      const helperDir = join(tmpDir, "crates", "helper");
      mkdirSync(helperDir, { recursive: true });
      writeFileSync(
        join(tmpDir, "Cargo.toml"),
        `[package]
name = "demo-app"
version = "1.0.0"

[workspace]
members = ["crates/helper"]

[dependencies]
helper = { path = "crates/helper" }
serde = "1.0.0"
`,
      );
      writeFileSync(
        join(helperDir, "Cargo.toml"),
        `[package]
name = "helper"
version = "0.1.0"

[dependencies]
serde = "1.0.0"
`,
      );
      writeFileSync(
        join(tmpDir, "Cargo.lock"),
        `version = 3

[[package]]
name = "demo-app"
version = "1.0.0"
dependencies = ["helper", "serde"]

[[package]]
name = "helper"
version = "0.1.0"
dependencies = ["serde"]

[[package]]
name = "serde"
version = "1.0.0"
checksum = "${"a".repeat(64)}"
`,
      );
      try {
        const bomData = await createRustBom(tmpDir, {
          installDeps: false,
          multiProject: true,
          specVersion: 1.7,
        });
        const parentComponent = bomData.parentComponent;
        const nestedComponentNames = parentComponent.components.map(
          (component) => component.name,
        );
        assert.strictEqual(parentComponent.name, "demo-app");
        assert.deepStrictEqual(nestedComponentNames, ["helper"]);
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });
});

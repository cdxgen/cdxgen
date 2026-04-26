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

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { createChromeExtensionBom } from "./index.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "chrome-extensions",
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
});

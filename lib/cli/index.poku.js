import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  getRecordedActivities,
  resetRecordedActivities,
  setDryRunMode,
} from "../helpers/utils.js";
import { auditBom } from "../stages/postgen/auditBom.js";
import { postProcess } from "../stages/postgen/postgen.js";
import {
  createBom,
  createChromeExtensionBom,
  createNodejsBom,
  createPHPBom,
  createRustBom,
  listComponents,
  submitBom,
} from "./index.js";

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
const mcpFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "mcp-repotest",
);
const cacheDisableFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "cache-disable-repotest",
);
const composerFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
);
const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

function createComposerNodeModulesFixture() {
  const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-composer-node-modules-"));
  const packageDir = join(tmpDir, "node_modules", "moment-timezone");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "composer.json"),
    readFileSync(join(composerFixtureDir, "composer.json"), "utf-8"),
  );
  writeFileSync(
    join(packageDir, "composer.lock"),
    readFileSync(join(composerFixtureDir, "composer.lock"), "utf-8"),
  );
  return tmpDir;
}

function createJarNodeModulesFixture() {
  const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-jar-node-modules-"));
  const packageDir = join(tmpDir, "node_modules", "font-mfizz");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "blaze.jar"), "fake jar content");
  return tmpDir;
}

const stubbedJarPackage = {
  group: "org.slf4j",
  name: "slf4j-simple",
  version: "2.0.17",
  purl: "pkg:maven/org.slf4j/slf4j-simple@2.0.17?type=jar",
  "bom-ref": "pkg:maven/org.slf4j/slf4j-simple@2.0.17?type=jar",
};

async function loadStubbedCreateJarBom() {
  const actualUtils = await import("../helpers/utils.js");
  const extractJarArchive = sinon.stub().resolves([stubbedJarPackage]);
  const getMvnMetadata = sinon.stub().callsFake(async (pkgList) => pkgList);
  const mockedIndex = await esmock("./index.js", {
    "../helpers/utils.js": {
      ...actualUtils,
      extractJarArchive,
      getMvnMetadata,
    },
  });
  return mockedIndex.createJarBom;
}

function toPortablePath(filePath) {
  return normalize(filePath).split(sep).join("/");
}

function getNpmPackFilePaths() {
  const command =
    process.platform === "win32"
      ? {
          args: ["/c", "npm", "pack", "--dry-run", "--json"],
          file: process.env.ComSpec || "cmd.exe",
        }
      : {
          args: ["pack", "--dry-run", "--json"],
          file: "npm",
        };
  const packOutput = execFileSync(command.file, command.args, {
    cwd: repoDir,
    encoding: "utf8",
  });
  const [packSummary] = JSON.parse(packOutput);
  return packSummary.files.map((file) => toPortablePath(file.path));
}

function buildMinimalCliEnv(extraEnv = {}) {
  const baseEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
  };
  if (process.platform === "win32") {
    baseEnv.SystemRoot = process.env.SystemRoot;
    baseEnv.TEMP = process.env.TEMP;
    baseEnv.TMP = process.env.TMP;
    baseEnv.USERPROFILE = process.env.USERPROFILE;
  }
  return Object.fromEntries(
    Object.entries({
      ...baseEnv,
      ...extraEnv,
    }).filter(([, value]) => value !== undefined),
  );
}

async function startSubmitBomTestServer(requestHandler) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      const request = {
        body,
        headers: req.headers,
        method: req.method,
        url: req.url,
      };
      requests.push(request);
      const response = (await requestHandler(request, requests.length)) || {};
      if (res.writableEnded) {
        return;
      }
      res.writeHead(response.statusCode || 200, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(response.body || { success: true }));
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const serverUrl = `http://127.0.0.1:${address.port}`;
  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    requests,
    serverUrl,
  };
}

describe("CLI tests", () => {
  describe("component creation", () => {
    it("keeps readable OBOM bom-refs when no package purl type is available", () => {
      const components = listComponents(
        { specVersion: 1.7 },
        undefined,
        [
          {
            "bom-ref":
              "osquery:authorized_keys_snapshot:data:root@ssh-ed25519[key_file=/root/.ssh/authorized_keys]",
            name: "root",
            properties: [
              {
                name: "cdx:osquery:category",
                value: "authorized_keys_snapshot",
              },
            ],
            type: "data",
            version: "ssh-ed25519",
          },
        ],
        "",
      );
      assert.strictEqual(components.length, 1);
      assert.strictEqual(components[0].purl, undefined);
      assert.strictEqual(
        components[0]["bom-ref"],
        "osquery:authorized_keys_snapshot:data:root@ssh-ed25519[key_file=/root/.ssh/authorized_keys]",
      );
      assert.strictEqual(components[0].type, "data");
    });
  });

  describe("distribution filters", () => {
    it("keeps npm types while excluding poku tests from npm pack output", () => {
      const packedPaths = getNpmPackFilePaths();

      assert.ok(
        packedPaths.some((path) => path.startsWith("types/")),
        "expected npm pack output to keep generated type definitions",
      );
      assert.ok(
        packedPaths.every((path) => !path.endsWith(".poku.js")),
        "expected npm pack output to exclude co-located poku tests",
      );
      assert.ok(
        packedPaths.every((path) => !path.startsWith("test/")),
        "expected npm pack output to exclude test fixtures",
      );
    });
  });

  describe("dry-run tracing", () => {
    it("captures sensitive file reads and environment reads for private registry style Docker inputs", () => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), "cdxgen-dry-run-registry-"),
      );
      const dockerConfigDir = join(fixtureRoot, "docker-config");
      mkdirSync(dockerConfigDir, { recursive: true });
      writeFileSync(
        join(dockerConfigDir, "config.json"),
        JSON.stringify({
          credHelpers: {
            "docker.io": "osxkeychain",
          },
        }),
      );
      try {
        const output = execFileSync(
          process.execPath,
          [
            join(repoDir, "bin", "cdxgen.js"),
            "--dry-run",
            "-t",
            "oci",
            "docker.io/library/alpine:3.20",
            "--no-banner",
          ],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: buildMinimalCliEnv({
              DOCKER_CONFIG: dockerConfigDir,
            }),
          },
        );
        assert.match(output, /cdxgen dry-run activity summary/);
        assert.match(output, /process\.env:DOCKER_CONFIG/);
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });

    it("supports bom audit in dry-run mode while skipping predictive dependency analysis", () => {
      const result = spawnSync(
        process.execPath,
        [
          join(repoDir, "bin", "cdxgen.js"),
          "--dry-run",
          "--bom-audit",
          "--bom-audit-categories",
          "mcp-server",
          "-t",
          "js",
          mcpFixtureDir,
          "--no-banner",
        ],
        {
          cwd: repoDir,
          encoding: "utf8",
          env: buildMinimalCliEnv(),
        },
      );
      assert.strictEqual(result.status, 0);
      const output = `${result.stdout}${result.stderr}`;

      assert.match(output, /BOM Audit Findings/);
      assert.match(output, /MCP-001/);
      assert.match(
        output,
        /Dry-run mode only planned predictive audit targets/i,
      );
    });

    it("enforces CDXGEN_ALLOWED_HOSTS for Dependency-Track submission in secure CLI mode", () => {
      const result = spawnSync(
        process.execPath,
        [
          join(repoDir, "bin", "cdxgen.js"),
          "--dry-run",
          "-t",
          "js",
          mcpFixtureDir,
          "--server-url",
          "https://blocked.example.com",
          "--api-key",
          "test-api-key",
          "--no-banner",
        ],
        {
          cwd: repoDir,
          encoding: "utf8",
          env: buildMinimalCliEnv({
            CDXGEN_ALLOWED_HOSTS: "allowed.example.com",
            CDXGEN_SECURE_MODE: "true",
          }),
        },
      );
      const output = `${result.stdout}${result.stderr}`;

      assert.strictEqual(result.status, 1);
      assert.match(
        output,
        /Dependency-Track server host 'blocked\.example\.com' is not allowed/i,
      );
    });
  });

  describe("submitBom()", () => {
    it("should report blocked Dependency-Track submission during dry-run", async () => {
      const recordActivity = sinon.stub();
      const actualUtils = await import("../helpers/utils.js");
      const { submitBom } = await esmock("./index.js", {
        "../helpers/utils.js": {
          ...actualUtils,
          isDryRun: true,
          recordActivity,
        },
      });

      const response = await submitBom(
        {
          apiKey: "TEST_API_KEY",
          projectId: "f7cb9f02-8041-4991-9101-b01fa07a6522",
          projectName: "cdxgen-test-project",
          projectVersion: "1.0.0",
          serverUrl: "https://dtrack.example.com",
        },
        { bom: "test" },
      );

      assert.strictEqual(response, undefined);
      sinon.assert.calledWithMatch(recordActivity, {
        kind: "network",
        status: "blocked",
        target: sinon.match("https://dtrack.example.com"),
      });
    });

    it("should successfully report the SBOM with given project id, name, version and a single tag", async () => {
      const server = await startSubmitBomTestServer(async () => ({
        body: { success: true },
      }));

      const serverUrl = server.serverUrl;
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

      try {
        const response = await submitBom(
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

        assert.deepEqual(response, { success: true });
        assert.equal(server.requests.length, 1);
        assert.equal(server.requests[0].method, "PUT");
        assert.equal(server.requests[0].url, "/api/v1/bom");
        assert.equal(server.requests[0].headers["x-api-key"], apiKey);
        assert.equal(
          server.requests[0].headers["content-type"],
          "application/json",
        );
        assert.deepEqual(
          JSON.parse(server.requests[0].body),
          expectedRequestPayload,
        );
      } finally {
        await server.close();
      }
    });

    it("should successfully report the SBOM with given parent project, name, version and multiple tags", async () => {
      const server = await startSubmitBomTestServer(async () => ({
        body: { success: true },
      }));

      const serverUrl = server.serverUrl;
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

      try {
        const response = await submitBom(
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

        assert.deepEqual(response, { success: true });
        assert.equal(server.requests.length, 1);
        assert.equal(server.requests[0].method, "PUT");
        assert.equal(server.requests[0].url, "/api/v1/bom");
        assert.equal(server.requests[0].headers["x-api-key"], apiKey);
        assert.equal(
          server.requests[0].headers["content-type"],
          "application/json",
        );
        assert.deepEqual(
          JSON.parse(server.requests[0].body),
          expectedRequestPayload,
        );
      } finally {
        await server.close();
      }
    });

    it("should include parentName and parentVersion when parent project name and version are passed", async () => {
      const server = await startSubmitBomTestServer(async () => ({
        body: { success: true },
      }));

      const serverUrl = server.serverUrl;
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

      try {
        const response = await submitBom(
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

        assert.deepEqual(response, { success: true });
        assert.equal(server.requests.length, 1);
        assert.equal(server.requests[0].method, "PUT");
        assert.equal(server.requests[0].url, "/api/v1/bom");
        assert.equal(server.requests[0].headers["x-api-key"], apiKey);
        assert.equal(
          server.requests[0].headers["content-type"],
          "application/json",
        );
        assert.deepEqual(
          JSON.parse(server.requests[0].body),
          expectedRequestPayload,
        );
      } finally {
        await server.close();
      }
    });

    it("should include configurable autoCreate and isLatest values in payload", async () => {
      const server = await startSubmitBomTestServer(async () => ({
        body: { success: true },
      }));

      const serverUrl = server.serverUrl;
      const projectName = "cdxgen-test-project";
      const apiKey = "TEST_API_KEY";

      try {
        const response = await submitBom(
          {
            serverUrl,
            projectName,
            apiKey,
            autoCreate: false,
            isLatest: true,
          },
          { bom: "test4" },
        );

        assert.deepEqual(response, { success: true });
        assert.equal(server.requests.length, 1);
        const payload = JSON.parse(server.requests[0].body);
        assert.equal(payload.autoCreate, "false");
        assert.equal(payload.isLatest, true);
        assert.equal(payload.projectVersion, "main");
      } finally {
        await server.close();
      }
    });

    it("should reject invalid mixed parent modes before making network request", async () => {
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
    });

    it("rejects malformed Dependency-Track URLs before making a request", async () => {
      const response = await submitBom(
        {
          serverUrl: "file:///tmp/dtrack",
          projectName: "cdxgen-test-project",
          apiKey: "TEST_API_KEY",
        },
        { bom: "test-invalid-url" },
      );

      assert.equal(response, undefined);
    });

    it("disables redirects for the POST fallback request too", async () => {
      const server = await startSubmitBomTestServer(
        async (_request, requestCount) => {
          if (requestCount === 1) {
            return { body: { error: "Method not allowed" }, statusCode: 405 };
          }
          return { body: { success: true }, statusCode: 200 };
        },
      );

      try {
        const response = await submitBom(
          {
            serverUrl: server.serverUrl,
            projectName: "cdxgen-test-project",
            apiKey: "TEST_API_KEY\r\n",
          },
          { bom: "test6" },
        );

        assert.deepEqual(response, { success: true });
        assert.equal(server.requests.length, 2);
        assert.equal(server.requests[0].method, "PUT");
        assert.equal(server.requests[1].method, "POST");
        assert.equal(server.requests[1].url, "/api/v1/bom");
        assert.equal(server.requests[1].headers["x-api-key"], "TEST_API_KEY");
        assert.equal(
          server.requests[1].headers["content-type"],
          "application/json",
        );
      } finally {
        await server.close();
      }
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

    it("records the specific create*Bom project type for multi-type dry-run activities", async () => {
      let currentActivityContext = {};
      const recordedActivities = [];
      const actualUtils = await import("../helpers/utils.js");
      const { createBom: createBomMocked } = await esmock("./index.js", {
        "../helpers/utils.js": {
          ...actualUtils,
          recordActivity: (activity) => {
            recordedActivities.push({
              packageType: currentActivityContext.packageType,
              projectType: currentActivityContext.projectType,
              sourcePath: currentActivityContext.sourcePath,
              ...activity,
            });
          },
          resetActivityContext: () => {
            currentActivityContext = {};
          },
          setActivityContext: (context = {}) => {
            currentActivityContext = {
              ...currentActivityContext,
              ...context,
            };
          },
        },
      });
      await createBomMocked(cargoFixtureDir, {
        installDeps: false,
        multiProject: true,
        projectType: ["cargo", "github"],
        specVersion: 1.7,
      });
      const activities = recordedActivities.filter(
        (activity) =>
          activity.kind === "read" &&
          ["cargo", "github"].includes(activity.packageType),
      );
      const cargoActivity = activities.find(
        (activity) => activity.packageType === "cargo",
      );
      const githubActivity = activities.find(
        (activity) => activity.packageType === "github",
      );
      assert.strictEqual(cargoActivity?.projectType, "rust");
      assert.strictEqual(githubActivity?.projectType, "github");
      assert.ok(
        activities.every((activity) => activity.projectType !== "cargo,github"),
      );
    });

    it("records the python source directory as the activity target when no metadata filename is available", async () => {
      let currentActivityContext = {};
      const recordedActivities = [];
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-python-activity-"));
      const requirementsFile = join(tempDir, "requirements.txt");
      const actualUtils = await import("../helpers/utils.js");
      try {
        writeFileSync(requirementsFile, "flask==3.1.0\n", "utf-8");
        const { createBom: createBomMocked } = await esmock("./index.js", {
          "../helpers/utils.js": {
            ...actualUtils,
            recordActivity: (activity) => {
              recordedActivities.push({
                packageType: currentActivityContext.packageType,
                projectType: currentActivityContext.projectType,
                sourcePath: currentActivityContext.sourcePath,
                ...activity,
              });
            },
            resetActivityContext: () => {
              currentActivityContext = {};
            },
            setActivityContext: (context = {}) => {
              currentActivityContext = {
                ...currentActivityContext,
                ...context,
              };
            },
          },
        });
        await createBomMocked(tempDir, {
          installDeps: false,
          multiProject: false,
          projectType: ["python"],
          specVersion: 1.7,
        });
        const pythonActivity = recordedActivities.find(
          (activity) =>
            activity.kind === "read" && activity.packageType === "pypi",
        );
        assert.strictEqual(pythonActivity?.projectType, "python");
        assert.strictEqual(pythonActivity?.sourcePath, tempDir);
        assert.strictEqual(pythonActivity?.target, tempDir);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("treats an existing local directory as a staged rootfs for docker scans", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-rootfs-"));
      const exportImage = sinon.stub().resolves(undefined);
      const getPkgPathList = sinon.stub().returns([]);
      try {
        const { createBom: createBomMocked } = await esmock("./index.js", {
          "../managers/binary.js": {
            executeOsQuery: sinon.stub(),
            getBinaryBom: sinon.stub(),
            getDotnetSlices: sinon.stub(),
            getOSPackages: sinon.stub().resolves({
              allTypes: [],
              binPaths: [],
              bundledRuntimes: [],
              bundledSdks: [],
              dependenciesList: [],
              executables: [],
              osPackages: [],
              sharedLibs: [],
            }),
          },
          "../managers/docker.js": {
            addSkippedSrcFiles: sinon.stub(),
            exportArchive: sinon.stub(),
            exportImage,
            getPkgPathList,
            parseImageName: sinon.stub(),
          },
        });
        const bomNSData = await createBomMocked(tempDir, {
          failOnError: true,
          installDeps: false,
          multiProject: false,
          projectType: ["docker"],
          specVersion: 1.6,
        });
        sinon.assert.notCalled(exportImage);
        sinon.assert.calledOnce(getPkgPathList);
        assert.ok(bomNSData?.bomJson);
        assert.strictEqual(bomNSData?.parentComponent?.type, "container");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("prefers an all-layers subdirectory when scanning staged rootfs inputs", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-rootfs-"));
      const allLayersDir = join(tempDir, "all-layers");
      const exportImage = sinon.stub().resolves(undefined);
      const getPkgPathList = sinon.stub().returns([]);
      mkdirSync(allLayersDir);
      try {
        const { createBom: createBomMocked } = await esmock("./index.js", {
          "../managers/binary.js": {
            executeOsQuery: sinon.stub(),
            getBinaryBom: sinon.stub(),
            getDotnetSlices: sinon.stub(),
            getOSPackages: sinon.stub().resolves({
              allTypes: [],
              binPaths: [],
              bundledRuntimes: [],
              bundledSdks: [],
              dependenciesList: [],
              executables: [],
              osPackages: [],
              sharedLibs: [],
            }),
          },
          "../managers/docker.js": {
            addSkippedSrcFiles: sinon.stub(),
            exportArchive: sinon.stub(),
            exportImage,
            getPkgPathList,
            parseImageName: sinon.stub(),
          },
        });
        await createBomMocked(tempDir, {
          failOnError: true,
          installDeps: false,
          multiProject: false,
          projectType: ["docker"],
          specVersion: 1.6,
        });
        sinon.assert.calledOnce(getPkgPathList);
        assert.strictEqual(
          getPkgPathList.firstCall.args[0].allLayersDir,
          tempDir,
        );
        assert.strictEqual(
          getPkgPathList.firstCall.args[0].allLayersExplodedDir,
          allLayersDir,
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
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

  if (process.platform !== "win32") {
    describe("HBOM support", () => {
      it("delegates hbom project types to the hbom helper", async () => {
        const actualHbomHelpers = await import("../helpers/hbom.js");
        const createHbomDocument = sinon.stub().resolves({
          bomFormat: "CycloneDX",
          components: [],
          metadata: {
            component: {
              name: "Demo Board",
              type: "device",
              version: "rev-a",
            },
          },
          specVersion: "1.7",
        });
        const { createBom: createBomMocked } = await esmock("./index.js", {
          "../helpers/hbom.js": {
            ...actualHbomHelpers,
            createHbomDocument,
          },
        });

        const bomNSData = await createBomMocked(repoDir, {
          projectType: ["hbom"],
          specVersion: 1.7,
        });

        sinon.assert.calledOnce(createHbomDocument);
        assert.strictEqual(
          bomNSData?.bomJson?.metadata?.component?.name,
          "Demo Board",
        );
        assert.strictEqual(bomNSData?.parentComponent?.type, "device");
      });

      it("supports dry-run mode for hbom project types in the main CLI flow", async () => {
        setDryRunMode(true);
        resetRecordedActivities();

        try {
          const bomNSData = await createBom(repoDir, {
            projectType: ["hbom"],
            specVersion: 1.7,
          });

          assert.strictEqual(bomNSData?.bomJson?.bomFormat, "CycloneDX");
          assert.strictEqual(bomNSData?.bomJson?.specVersion, "1.7");
          assert.ok(Array.isArray(bomNSData?.bomJson?.components));
          assert.ok(bomNSData?.bomJson?.components.length >= 1);
          assert.ok(Array.isArray(bomNSData?.dependencies));
        } finally {
          setDryRunMode(false);
          resetRecordedActivities();
        }
      });

      it("shows dedicated hbom command help", () => {
        const result = spawnSync(
          process.execPath,
          [join(repoDir, "bin", "hbom.js"), "--help"],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          },
        );
        const output = `${result.stdout}${result.stderr}`;

        assert.strictEqual(result.status, 0);
        assert.match(output, /Output file\.\s+Default\s+hbom\.json/u);
        assert.match(output, /--include-runtime/u);
        assert.match(output, /--privileged/u);
        assert.match(output, /diagnostics/u);
      });

      it("uses the invoked hbom binary name in help output", () => {
        const tempDir = mkdtempSync(join(repoDir, ".cdxgen-hbom-help-name-"));
        try {
          const slimScript = join(tempDir, "hbom-slim");
          copyFileSync(join(repoDir, "bin", "hbom.js"), slimScript);
          const result = spawnSync(process.execPath, [slimScript, "--help"], {
            cwd: tempDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          });
          const output = `${result.stdout}${result.stderr}`;

          assert.strictEqual(result.status, 0);
          assert.match(output, /hbom-slim \[command\] \[options\]/u);
        } finally {
          rmSync(tempDir, { force: true, recursive: true });
        }
      });

      it("fails early when hbom include-runtime lacks osquery support", () => {
        const emptyPluginsDir = mkdtempSync(
          join(tmpdir(), "cdxgen-empty-plugins-"),
        );
        try {
          const result = spawnSync(
            process.execPath,
            [join(repoDir, "bin", "hbom.js"), "--include-runtime"],
            {
              cwd: repoDir,
              encoding: "utf8",
              env: buildMinimalCliEnv({
                CDXGEN_PLUGINS_DIR: emptyPluginsDir,
              }),
            },
          );
          const output = `${result.stdout}${result.stderr}`;

          assert.strictEqual(result.status, 1);
          assert.match(output, /--include-runtime/u);
          assert.match(output, /cdxgen-plugins-bin/u);
          assert.match(
            output,
            /'hbom' is the bundled option required for '--include-runtime' support/u,
          );
          assert.doesNotMatch(output, /About to generate OBOM/u);
        } finally {
          rmSync(emptyPluginsDir, { force: true, recursive: true });
        }
      });

      it("guides hbom-slim users to the standard binary for include-runtime", () => {
        const tempDir = mkdtempSync(
          join(repoDir, ".cdxgen-hbom-runtime-check-"),
        );
        const emptyPluginsDir = mkdtempSync(
          join(tmpdir(), "cdxgen-empty-plugins-"),
        );
        try {
          const slimScript = join(tempDir, "hbom-slim");
          copyFileSync(join(repoDir, "bin", "hbom.js"), slimScript);
          const result = spawnSync(
            process.execPath,
            [slimScript, "--include-runtime"],
            {
              cwd: tempDir,
              encoding: "utf8",
              env: buildMinimalCliEnv({
                CDXGEN_PLUGINS_DIR: emptyPluginsDir,
              }),
            },
          );
          const output = `${result.stdout}${result.stderr}`;

          assert.strictEqual(result.status, 1);
          assert.match(output, /'hbom-slim' is hardware-only by default/u);
          assert.match(
            output,
            /Use 'hbom' for bundled '--include-runtime' support/u,
          );
        } finally {
          rmSync(tempDir, { force: true, recursive: true });
          rmSync(emptyPluginsDir, { force: true, recursive: true });
        }
      });

      it("supports the hbom diagnostics subcommand for existing BOM files", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-hbom-diagnostics-"));
        try {
          const inputFile = join(tempDir, "hbom.json");
          writeFileSync(
            inputFile,
            JSON.stringify({
              bomFormat: "CycloneDX",
              components: [],
              metadata: {
                component: {
                  name: "demo-host",
                  properties: [
                    { name: "cdx:hbom:platform", value: "linux" },
                    { name: "cdx:hbom:architecture", value: "amd64" },
                  ],
                  type: "device",
                },
              },
              properties: [
                { name: "cdx:hbom:collectorProfile", value: "linux-amd64-v1" },
                {
                  name: "cdx:hbom:evidence:commandDiagnosticCount",
                  value: "2",
                },
                {
                  name: "cdx:hbom:evidence:commandDiagnostic",
                  value: JSON.stringify({
                    command: "lsusb",
                    installHint:
                      "Command not found: install the Linux package providing lsusb (commonly `usbutils`).",
                    issue: "missing-command",
                    message: "lsusb failed with missing-command",
                  }),
                },
                {
                  name: "cdx:hbom:evidence:commandDiagnostic",
                  value: JSON.stringify({
                    command: "drm_info",
                    issue: "permission-denied",
                    message: "drm_info failed with permission-denied",
                    privilegeHint:
                      "Retry with --privileged to allow a non-interactive sudo attempt for permission-sensitive Linux commands.",
                  }),
                },
              ],
              specVersion: "1.7",
              version: 1,
            }),
          );
          const result = spawnSync(
            process.execPath,
            [
              join(repoDir, "bin", "hbom.js"),
              "diagnostics",
              "--input",
              inputFile,
            ],
            {
              cwd: tempDir,
              encoding: "utf8",
              env: buildMinimalCliEnv(),
            },
          );
          const output = `${result.stdout}${result.stderr}`;

          assert.strictEqual(result.status, 0);
          assert.match(output, /HBOM diagnostics summary/u);
          assert.match(output, /Missing commands:\n- lsusb/u);
          assert.match(output, /Permission-sensitive enrichments:/u);
          assert.match(output, /--privileged/u);
        } finally {
          rmSync(tempDir, { force: true, recursive: true });
        }
      });

      it("supports dry-run mode in the dedicated hbom command", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-hbom-dry-run-"));
        try {
          const outputFile = join(tempDir, "hbom.json");
          const result = spawnSync(
            process.execPath,
            [join(repoDir, "bin", "hbom.js"), "--dry-run"],
            {
              cwd: tempDir,
              encoding: "utf8",
              env: buildMinimalCliEnv(),
            },
          );
          const output = `${result.stdout}${result.stderr}`;

          assert.strictEqual(result.status, 0);
          assert.match(output, /cdxgen dry-run activity summary/u);
          assert.strictEqual(existsSync(outputFile), false);
        } finally {
          rmSync(tempDir, { force: true, recursive: true });
        }
      });

      it("rejects mixed hbom and sbom project types in the main CLI", () => {
        const result = spawnSync(
          process.execPath,
          [
            join(repoDir, "bin", "cdxgen.js"),
            "-t",
            "hbom",
            "-t",
            "js",
            "--no-banner",
          ],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          },
        );
        const output = `${result.stdout}${result.stderr}`;

        assert.strictEqual(result.status, 1);
        assert.match(output, /HBOM project types cannot be mixed/u);
      });
    });
  }

  describe("createBom() Collider lock support", () => {
    it("preserves Collider integrity metadata and dependency nodes in the BOM", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-collider-"));
      writeFileSync(
        join(tmpDir, "collider.lock"),
        JSON.stringify(
          {
            version: 1,
            dependencies: {
              fmt: {
                version: "11.0.2",
                wrap_hash: `sha256:${"a".repeat(64)}`,
                origin: "https://packages.example.com/collider/v2/",
              },
            },
            packages: {
              fast_float: {
                version: "8.0.2",
                wrap_hash: `sha256:${"b".repeat(64)}`,
                origin: "https://wrapdb.mesonbuild.com/v2/",
              },
            },
          },
          null,
          2,
        ),
      );
      try {
        const bomNSData = await createBom(tmpDir, {
          failOnError: true,
          installDeps: false,
          multiProject: false,
          projectType: ["collider"],
          specVersion: 1.7,
        });
        const bomJson = bomNSData?.bomJson || {};
        const fmtComponent = (bomJson.components || []).find(
          (component) => component.name === "fmt",
        );
        const transitiveComponent = (bomJson.components || []).find(
          (component) => component.name === "fast_float",
        );
        assert.ok(fmtComponent);
        assert.ok(transitiveComponent);
        assert.deepStrictEqual(
          getProp(fmtComponent, "cdx:collider:origin"),
          "https://packages.example.com/collider/v2/",
        );
        assert.deepStrictEqual(
          getProp(fmtComponent, "cdx:collider:hasWrapHash"),
          "true",
        );
        assert.deepStrictEqual(
          getProp(transitiveComponent, "cdx:collider:dependencyKind"),
          "transitive",
        );
        assert.deepStrictEqual(fmtComponent.hashes, [
          {
            alg: "SHA-256",
            content: "a".repeat(64),
          },
        ]);
        assert.deepStrictEqual(fmtComponent.externalReferences, [
          {
            type: "distribution",
            url: "https://packages.example.com/collider/v2/",
          },
        ]);
        const parentDependency = (bomJson.dependencies || []).find(
          (dependency) =>
            dependency.ref === bomJson.metadata.component["bom-ref"],
        );
        assert.ok(parentDependency);
        assert.deepStrictEqual(parentDependency.dependsOn, [
          "pkg:generic/fmt@11.0.2",
        ]);
        assert.ok(
          (bomJson.dependencies || []).some(
            (dependency) =>
              dependency.ref === "pkg:generic/fmt@11.0.2" &&
              dependency.dependsOn.length === 0,
          ),
        );
        assert.ok(
          (bomJson.dependencies || []).some(
            (dependency) =>
              dependency.ref === "pkg:generic/fast_float@8.0.2" &&
              dependency.dependsOn.length === 0,
          ),
        );
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  describe("createBom() MCP inventory support", () => {
    it("catalogs MCP services, primitives, and audit findings for JavaScript projects", async () => {
      const options = {
        bomAudit: true,
        bomAuditCategories: "mcp-server",
        bomAuditMinSeverity: "low",
        failOnError: true,
        installDeps: false,
        multiProject: false,
        projectType: ["js"],
        specVersion: 1.7,
      };
      const bomNSData = await createBom(mcpFixtureDir, options);
      const processedBomNSData = postProcess(bomNSData, options, mcpFixtureDir);
      const bomJson = processedBomNSData?.bomJson || {};
      const officialSdk = (bomJson.components || []).find(
        (component) =>
          component.purl ===
          "pkg:npm/%40modelcontextprotocol/server@2.0.0-alpha.0",
      );
      const wrapperSdk = (bomJson.components || []).find(
        (component) => component.purl === "pkg:npm/%40acme/mcp-server@0.1.0",
      );
      assert.ok(officialSdk);
      assert.ok(
        officialSdk.tags?.includes("official-mcp-sdk"),
        "expected official MCP SDK tags",
      );
      assert.ok(wrapperSdk);
      assert.ok(
        wrapperSdk.properties?.some(
          (property) =>
            property.name === "cdx:mcp:official" && property.value === "false",
        ),
        "expected non-official MCP wrapper signal",
      );
      assert.strictEqual((bomJson.services || []).length, 2);
      const unsafeService = (bomJson.services || []).find(
        (service) => service.name === "unsafe-http-server",
      );
      const authService = (bomJson.services || []).find(
        (service) => service.name === "auth-http-server",
      );
      assert.ok(unsafeService);
      assert.strictEqual(unsafeService.authenticated, false);
      assert.ok(authService);
      assert.strictEqual(authService.authenticated, true);
      assert.ok(
        (bomJson.dependencies || []).some(
          (dependency) =>
            dependency.ref === unsafeService["bom-ref"] &&
            dependency.provides.length >= 1,
        ),
      );
      const findings = await auditBom(bomJson, {
        bomAuditCategories: "mcp-server",
        bomAuditMinSeverity: "low",
      });
      assert.ok(findings.some((finding) => finding.ruleId === "MCP-001"));
      assert.ok(findings.some((finding) => finding.ruleId === "MCP-002"));
      assert.ok(findings.some((finding) => finding.ruleId === "MCP-003"));
    });

    it("supports the ai-inventory audit category alias for MCP discovery", async () => {
      const options = {
        bomAudit: true,
        bomAuditCategories: "ai-inventory",
        bomAuditMinSeverity: "low",
        failOnError: true,
        installDeps: false,
        multiProject: false,
        projectType: ["js"],
        specVersion: 1.7,
      };
      const bomNSData = await createBom(mcpFixtureDir, options);
      const processedBomNSData = postProcess(bomNSData, options, mcpFixtureDir);
      const bomJson = processedBomNSData?.bomJson || {};
      assert.ok(
        (bomJson.services || []).some(
          (service) => service.name === "unsafe-http-server",
        ),
      );
      const findings = await auditBom(bomJson, {
        bomAuditCategories: "ai-inventory",
        bomAuditMinSeverity: "low",
      });
      assert.ok(findings.some((finding) => finding.ruleId === "MCP-001"));
    });

    it("supports the dedicated mcp project type alias", async () => {
      const options = {
        bomAudit: false,
        failOnError: true,
        installDeps: false,
        multiProject: false,
        projectType: ["mcp"],
        specVersion: 1.7,
      };
      const bomNSData = await createBom(mcpFixtureDir, options);
      const processedBomNSData = postProcess(bomNSData, options, mcpFixtureDir);
      const bomJson = processedBomNSData?.bomJson || {};
      assert.ok(
        (bomJson.services || []).some(
          (service) => service.name === "unsafe-http-server",
        ),
      );
      assert.ok(
        (bomJson.components || []).some(
          (component) =>
            component.purl ===
            "pkg:npm/%40modelcontextprotocol/server@2.0.0-alpha.0",
        ),
      );
    });

    it("flags disabled setup caches for npm, Python, and Cargo fixtures", async () => {
      const options = {
        bomAudit: true,
        bomAuditCategories: "ci-permission",
        bomAuditMinSeverity: "low",
        failOnError: true,
        includeFormulation: true,
        installDeps: false,
        multiProject: true,
        projectType: ["js", "python", "cargo", "github"],
        specVersion: 1.7,
      };
      const bomNSData = await createBom(cacheDisableFixtureDir, options);
      const processedBomNSData = postProcess(
        bomNSData,
        options,
        cacheDisableFixtureDir,
      );
      const bomJson = processedBomNSData?.bomJson || {};
      const setupNodeComponent = (bomJson.components || []).find(
        (component) =>
          getProp(component, "cdx:github:action:uses") ===
          "actions/setup-node@v4",
      );
      const setupPythonComponent = (bomJson.components || []).find(
        (component) =>
          getProp(component, "cdx:github:action:uses") ===
          "actions/setup-python@v5",
      );
      const setupRustComponent = (bomJson.components || []).find(
        (component) =>
          getProp(component, "cdx:github:action:uses") ===
          "moonrepo/setup-rust@v1",
      );
      const npmComponent = (bomJson.components || []).find((component) =>
        component.purl?.startsWith("pkg:npm/left-pad@1.3.0"),
      );
      const pythonComponent = (bomJson.components || []).find((component) =>
        component.purl?.startsWith("pkg:pypi/anyio@4.6.0"),
      );
      const cargoComponent = (bomJson.components || []).find(
        (component) =>
          component.name === "git-crate" &&
          getProp(component, "cdx:cargo:git") ===
            "https://github.com/acme/git-crate.git",
      );
      const cargoRunComponent = (bomJson.components || []).find((component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:github:step:cargoSubcommands" &&
            property.value === "build",
        ),
      );
      assert.ok(setupNodeComponent, "expected setup-node workflow component");
      assert.ok(
        setupPythonComponent,
        "expected setup-python workflow component",
      );
      assert.ok(setupRustComponent, "expected setup-rust workflow component");
      assert.strictEqual(
        getProp(setupNodeComponent, "cdx:github:action:disablesBuildCache"),
        "true",
      );
      assert.strictEqual(
        getProp(setupPythonComponent, "cdx:github:action:disablesBuildCache"),
        "true",
      );
      assert.strictEqual(
        getProp(setupRustComponent, "cdx:github:action:disablesBuildCache"),
        "true",
      );
      assert.strictEqual(
        getProp(setupRustComponent, "cdx:github:action:buildCacheEcosystem"),
        "cargo",
      );
      assert.strictEqual(
        getProp(setupRustComponent, "cdx:github:action:buildCacheDisableInput"),
        "cache",
      );
      assert.ok(npmComponent, "expected npm dependency from package-lock");
      assert.ok(pythonComponent, "expected PyPI dependency from uv.lock");
      assert.ok(cargoComponent, "expected Cargo dependency from Cargo.toml");
      assert.ok(cargoRunComponent, "expected Cargo run step component");
      assert.strictEqual(
        getProp(npmComponent, "cdx:npm:manifestSourceType"),
        "url",
      );
      assert.strictEqual(
        getProp(pythonComponent, "cdx:pypi:manifestSourceType"),
        "url",
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:git"),
        "https://github.com/acme/git-crate.git",
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:gitBranch"),
        "main",
      );
      assert.strictEqual(
        getProp(cargoRunComponent, "cdx:github:step:usesCargo"),
        "true",
      );

      const findings = await auditBom(bomJson, {
        bomAuditCategories: "ci-permission",
        bomAuditMinSeverity: "low",
      });
      assert.ok(
        findings.some((finding) => finding.ruleId === "CI-022"),
        "expected npm disabled cache finding",
      );
      assert.ok(
        findings.some((finding) => finding.ruleId === "CI-023"),
        "expected Python disabled cache finding",
      );
      assert.ok(
        findings.some((finding) => finding.ruleId === "CI-024"),
        "expected Cargo disabled cache finding",
      );
    });

    it("supports exact AI skill scans and js exclude-type filtering for AI inventory", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-ai-inventory-"));
      mkdirSync(join(tmpDir, ".claude", "skills", "release"), {
        recursive: true,
      });
      mkdirSync(join(tmpDir, ".vscode"), { recursive: true });
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify(
          {
            dependencies: {
              "left-pad": "1.3.0",
            },
            name: "ai-inventory-demo",
            version: "1.0.0",
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(tmpDir, "package-lock.json"),
        JSON.stringify(
          {
            lockfileVersion: 3,
            name: "ai-inventory-demo",
            packages: {
              "": {
                dependencies: {
                  "left-pad": "1.3.0",
                },
                name: "ai-inventory-demo",
                version: "1.0.0",
              },
              "node_modules/left-pad": {
                resolved:
                  "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
                version: "1.3.0",
              },
            },
            requires: true,
            version: "1.0.0",
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(tmpDir, "CLAUDE.md"),
        "Use the release skill before publishing artifacts.",
      );
      writeFileSync(
        join(tmpDir, ".claude", "skills", "release", "SKILL.md"),
        [
          "---",
          "name: release",
          "description: Prepare release artifacts",
          "---",
          "Use this skill before shipping.",
        ].join("\n"),
      );
      writeFileSync(
        join(tmpDir, ".vscode", "mcp.json"),
        JSON.stringify(
          {
            mcpServers: {
              releaseDocs: {
                endpoint: "https://example.com/mcp",
                transport: "http",
              },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(tmpDir, "pyproject.toml"),
        [
          "[project]",
          'name = "demo-python-app"',
          'version = "0.1.0"',
          'requires-python = ">=3.10"',
        ].join("\n"),
      );
      writeFileSync(
        join(tmpDir, "server.py"),
        [
          "import mcp.server.stdio",
          "import mcp.types as mtypes",
          "from mcp.server import Server",
          "",
          'server = Server("python-release-docs", version="0.2.0")',
          "",
          "@server.list_tools()",
          "async def handle_list_tools():",
          '    return [mtypes.Tool(name="summarize_vulns", description="Summarize vulns", inputSchema={"type": "object"})]',
          "",
          "async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):",
          "    await server.run(read_stream, write_stream, None)",
        ].join("\n"),
      );
      try {
        const baseOptions = {
          installDeps: false,
          multiProject: false,
          specVersion: 1.7,
        };
        const jsOptions = {
          ...baseOptions,
          projectType: ["js"],
        };
        const jsBomJson = postProcess(
          await createBom(tmpDir, jsOptions),
          jsOptions,
          tmpDir,
        ).bomJson;
        assert.ok(
          (jsBomJson.components || []).some(
            (component) =>
              getProp(component, "cdx:file:kind") === "skill-file" &&
              getProp(component, "cdx:skill:name") === "release",
          ),
          "expected skill file in js scan",
        );
        assert.ok(
          (jsBomJson.components || []).some(
            (component) =>
              component.name === "CLAUDE.md" &&
              getProp(component, "cdx:file:kind") === "agent-instructions",
          ),
          "expected CLAUDE.md in js scan",
        );
        assert.ok(
          (jsBomJson.components || []).some(
            (component) => getProp(component, "cdx:file:kind") === "mcp-config",
          ),
          "expected MCP config in js scan",
        );
        assert.ok(
          (jsBomJson.services || []).some(
            (service) =>
              service.name === "releaseDocs" &&
              getProp(service, "cdx:mcp:inventorySource") === "config-file",
          ),
          "expected MCP config service in js scan",
        );

        const dockerOptions = {
          ...baseOptions,
          projectType: ["js", "docker"],
        };
        const dockerBomJson = postProcess(
          await createNodejsBom(tmpDir, dockerOptions),
          dockerOptions,
          tmpDir,
        ).bomJson;
        assert.ok(
          (dockerBomJson.components || []).some(
            (component) =>
              getProp(component, "cdx:file:kind") === "skill-file" &&
              getProp(component, "cdx:skill:name") === "release",
          ),
          "expected skill file in docker js scan",
        );
        assert.ok(
          (dockerBomJson.components || []).some(
            (component) => getProp(component, "cdx:file:kind") === "mcp-config",
          ),
          "expected MCP config in docker js scan",
        );

        const exactAiSkillOptions = {
          ...baseOptions,
          projectType: ["ai-skill"],
        };
        const aiSkillBomJson = postProcess(
          await createBom(tmpDir, exactAiSkillOptions),
          exactAiSkillOptions,
          tmpDir,
        ).bomJson;
        assert.ok(
          (aiSkillBomJson.components || []).some(
            (component) =>
              component.name === "CLAUDE.md" &&
              getProp(component, "cdx:file:kind") === "agent-instructions",
          ),
          "expected CLAUDE.md in exact ai-skill scan",
        );
        assert.ok(
          !(aiSkillBomJson.components || []).some(
            (component) => getProp(component, "cdx:file:kind") === "mcp-config",
          ),
          "did not expect MCP configs in exact ai-skill scan",
        );

        const filteredOptions = {
          ...baseOptions,
          excludeType: ["ai-skill", "mcp"],
          projectType: ["js"],
        };
        const filteredBomJson = postProcess(
          await createBom(tmpDir, filteredOptions),
          filteredOptions,
          tmpDir,
        ).bomJson;
        assert.ok(
          !(filteredBomJson.components || []).some((component) =>
            ["agent-instructions", "mcp-config", "skill-file"].includes(
              getProp(component, "cdx:file:kind"),
            ),
          ),
          "did not expect AI inventory components after exclude-type filtering",
        );
        assert.ok(
          !(filteredBomJson.services || []).some((service) =>
            service.properties?.some((property) =>
              property.name.startsWith("cdx:mcp:"),
            ),
          ),
          "did not expect MCP services after exclude-type filtering",
        );

        const pyOptions = {
          ...baseOptions,
          projectType: ["py"],
        };
        const pyBomJson = postProcess(
          await createBom(tmpDir, pyOptions),
          pyOptions,
          tmpDir,
        ).bomJson;
        assert.ok(
          (pyBomJson.components || []).some(
            (component) =>
              getProp(component, "cdx:file:kind") === "skill-file" &&
              getProp(component, "cdx:skill:name") === "release",
          ),
          "expected skill file in python scan",
        );
        assert.ok(
          (pyBomJson.components || []).some(
            (component) => getProp(component, "cdx:file:kind") === "mcp-config",
          ),
          "expected MCP config in python scan",
        );
        assert.ok(
          (pyBomJson.services || []).some(
            (service) =>
              service.name === "python-release-docs" &&
              getProp(service, "cdx:mcp:inventorySource") ===
                "source-code-analysis",
          ),
          "expected Python MCP service in python scan",
        );
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("does not trace an npm registry config read when opening .npmrc fails", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-npmrc-read-fail-"));
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "npmrc-read-fail",
          version: "1.0.0",
        }),
      );
      mkdirSync(join(tmpDir, ".npmrc"), { recursive: true });
      setDryRunMode(true);
      resetRecordedActivities();
      try {
        await assert.rejects(() =>
          createNodejsBom(tmpDir, {
            installDeps: true,
            multiProject: false,
            projectType: ["npm"],
          }),
        );
        const readActivities = getRecordedActivities().filter(
          (activity) =>
            activity.kind === "read" &&
            activity.target === join(tmpDir, ".npmrc"),
        );
        assert.deepStrictEqual(readActivities, []);
      } finally {
        setDryRunMode(false);
        resetRecordedActivities();
        rmSync(tmpDir, { force: true, recursive: true });
      }
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
});

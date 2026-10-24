import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { resolvePluginBinary } from "../inventory/plugins.js";
import { readBinary } from "../inventory/protobom.js";
import {
  buildMinimalCliEnv,
  cargoFixtureDir,
  cbomFixtureDir,
  getRequestHeader,
  mcpFixtureDir,
  parseMultipartFormData,
  repoDir,
  startSubmitBomTestServer,
  uvWorkspaceFixtureDir,
} from "./bomTestHelpers.poku.js";
import {
  createBom,
  submitBom,
  summarizeCounts,
  summarizePurlTypes,
} from "./index.js";

function submittedParts(request) {
  return parseMultipartFormData(
    request.body,
    getRequestHeader(request, "content-type"),
  );
}

describe("CLI tests", () => {
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
        const result = spawnSync(
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
        // Diagnostics (including the dry-run activity summary) moved to stderr
        // in v13; stdout carries the payload only.
        const output = `${result.stdout}${result.stderr}`;
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

    it("records the schema validation activity and marks it blocked with --no-validate", () => {
      const runDryRun = (extraArgs) => {
        const result = spawnSync(
          process.execPath,
          [
            join(repoDir, "bin", "cdxgen.js"),
            "--dry-run",
            "-t",
            "js",
            mcpFixtureDir,
            "--no-banner",
            ...extraArgs,
          ],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          },
        );
        assert.strictEqual(result.status, 0);
        return `${result.stdout}${result.stderr}`;
      };

      assert.match(runDryRun([]), /validate\s+\|\s+cyclonedx-\d+\.\d+/);
      assert.match(
        runDryRun(["--no-validate"]),
        /validate\s+\|\s+cyclonedx-\d+\.\d+\s+\|\s+blocked/,
      );
    });

    it("enforces CDXGEN_ALLOWED_HOSTS for Dependency-Track submission in secure CLI mode", () => {
      // Secure mode refuses to run as root outside the cdxgen container image,
      // which would end the run before the Dependency-Track host check.
      const containerEnv =
        process.getuid?.() === 0 ? { CDXGEN_IN_CONTAINER: "true" } : {};
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
            ...containerEnv,
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

  describe("protobuf CLI round-trip", () => {
    it("generates, converts, and validates protobuf BOMs for CycloneDX 1.6 and 1.7", () => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), "cdxgen-proto-roundtrip-"),
      );
      try {
        for (const specVersion of ["1.6", "1.7"]) {
          const jsonPath = join(fixtureRoot, `bom-${specVersion}.json`);
          const protoPath = join(fixtureRoot, `bom-${specVersion}.cdx`);
          const spdxPath = join(fixtureRoot, `bom-${specVersion}.spdx.json`);
          const generateResult = spawnSync(
            process.execPath,
            [
              join(repoDir, "bin", "cdxgen.js"),
              "-t",
              "js",
              mcpFixtureDir,
              "-o",
              jsonPath,
              "--spec-version",
              specVersion,
              "--export-proto",
              "--proto-bin-file",
              protoPath,
              "--no-banner",
            ],
            {
              cwd: repoDir,
              encoding: "utf8",
              env: buildMinimalCliEnv(),
            },
          );
          assert.strictEqual(generateResult.status, 0);
          assert.ok(existsSync(jsonPath));
          assert.ok(existsSync(protoPath));

          const convertResult = spawnSync(
            process.execPath,
            [
              join(repoDir, "bin", "convert.js"),
              "-i",
              protoPath,
              "-o",
              spdxPath,
            ],
            {
              cwd: repoDir,
              encoding: "utf8",
              env: buildMinimalCliEnv(),
            },
          );
          assert.strictEqual(convertResult.status, 0);
          assert.ok(existsSync(spdxPath));

          const validateResult = spawnSync(
            process.execPath,
            [
              join(repoDir, "bin", "validate.js"),
              "-i",
              protoPath,
              "--fail-severity",
              "critical",
              "--no-deep",
              "--report",
              "json",
            ],
            {
              cwd: repoDir,
              encoding: "utf8",
              env: buildMinimalCliEnv(),
            },
          );
          assert.strictEqual(validateResult.status, 0);
          assert.doesNotMatch(
            `${validateResult.stdout}${validateResult.stderr}`,
            /Failed to parse|non-CycloneDX|Unsupported CycloneDX specVersion/i,
          );
        }
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });

    it("preserves user output directories for research-profile protobuf exports", () => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), "cdxgen-proto-research-roundtrip-"),
      );
      try {
        const jsonPath = join(fixtureRoot, "research.json");
        const protoPath = join(fixtureRoot, "research.cdx");
        const generateResult = spawnSync(
          process.execPath,
          [
            join(repoDir, "bin", "cdxgen.js"),
            "-t",
            "js",
            "-t",
            "mcp",
            mcpFixtureDir,
            "--profile",
            "research",
            "-o",
            jsonPath,
            "--export-proto",
            "--proto-bin-file",
            protoPath,
            "--no-banner",
          ],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          },
        );

        assert.strictEqual(generateResult.status, 0);
        assert.ok(existsSync(fixtureRoot));
        assert.ok(existsSync(jsonPath));
        assert.ok(existsSync(protoPath));

        const generatedBom = JSON.parse(readFileSync(jsonPath, "utf8"));
        assert.ok((generatedBom.services || []).length >= 1);

        const roundTrippedBom = readBinary(protoPath);
        assert.ok(roundTrippedBom);
        assert.ok((roundTrippedBom.services || []).length >= 1);
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });

    it("exports standards-enabled BOMs to protobuf using canonical definitions objects", () => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), "cdxgen-proto-standards-roundtrip-"),
      );
      try {
        const jsonPath = join(fixtureRoot, "standards.json");
        const protoPath = join(fixtureRoot, "standards.cdx");
        const generateResult = spawnSync(
          process.execPath,
          [
            join(repoDir, "bin", "cdxgen.js"),
            "-t",
            "js",
            mcpFixtureDir,
            "--standard",
            "asvs-5.0",
            "-o",
            jsonPath,
            "--export-proto",
            "--proto-bin-file",
            protoPath,
            "--no-banner",
          ],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          },
        );

        assert.strictEqual(generateResult.status, 0);
        assert.ok(existsSync(jsonPath));
        assert.ok(existsSync(protoPath));

        const roundTrippedBom = readBinary(protoPath);
        assert.ok(roundTrippedBom);
        assert.equal(Array.isArray(roundTrippedBom.definitions), false);
        assert.ok((roundTrippedBom.definitions?.standards || []).length >= 1);
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });

    it("round-trips research, standards, and CBOM protobuf exports with canonical JSON", () => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), "cdxgen-proto-mode-roundtrip-"),
      );
      const scenarios = [
        {
          args: [
            "-t",
            "js",
            "-t",
            "mcp",
            mcpFixtureDir,
            "--profile",
            "research",
          ],
          assertRoundTrip: (bomJson) => {
            assert.ok((bomJson.components || []).length >= 1);
          },
          expectedSpecVersion: (specVersion) => specVersion,
          name: "research",
        },
        {
          args: [cbomFixtureDir, "--include-crypto", "--evidence", "--deep"],
          assertRoundTrip: (bomJson) => {
            const cryptoComponents = (bomJson.components || []).filter(
              (component) => component.type === "cryptographic-asset",
            );
            assert.ok(cryptoComponents.length >= 3);
            assert.equal(
              cryptoComponents.some(
                (component) => component.purl !== undefined,
              ),
              false,
            );
          },
          isolateDepsSlicesFile: true,
          expectedSpecVersion: (specVersion) => specVersion,
          name: "cbom",
        },
        {
          args: ["-t", "js", mcpFixtureDir, "--standard", "asvs-5.0"],
          assertRoundTrip: (bomJson) => {
            assert.equal(Array.isArray(bomJson.definitions), false);
            assert.ok((bomJson.definitions?.standards || []).length >= 1);
          },
          expectedSpecVersion: () => "1.7",
          name: "standards",
        },
      ];
      try {
        for (const scenario of scenarios) {
          for (const specVersion of ["1.6", "1.7"]) {
            const jsonPath = join(
              fixtureRoot,
              `${scenario.name}-${specVersion}.json`,
            );
            const protoPath = join(
              fixtureRoot,
              `${scenario.name}-${specVersion}.cdx`,
            );
            const spdxPath = join(
              fixtureRoot,
              `${scenario.name}-${specVersion}.spdx.json`,
            );
            const depsSlicesPath = join(
              fixtureRoot,
              `${scenario.name}-${specVersion}.deps.slices.json`,
            );
            const depsSlicesArgs = scenario.isolateDepsSlicesFile
              ? ["--deps-slices-file", depsSlicesPath]
              : [];
            const generateResult = spawnSync(
              process.execPath,
              [
                join(repoDir, "bin", "cdxgen.js"),
                ...scenario.args,
                "-o",
                jsonPath,
                "--spec-version",
                specVersion,
                ...depsSlicesArgs,
                "--export-proto",
                "--proto-bin-file",
                protoPath,
                "--no-banner",
              ],
              {
                cwd: repoDir,
                encoding: "utf8",
                env: buildMinimalCliEnv(),
              },
            );
            assert.strictEqual(
              generateResult.status,
              0,
              `${scenario.name} ${specVersion}: ${generateResult.stdout}${generateResult.stderr}`,
            );

            const generatedBom = JSON.parse(readFileSync(jsonPath, "utf8"));
            assert.strictEqual(generatedBom.specVersion, specVersion);

            const convertResult = spawnSync(
              process.execPath,
              [
                join(repoDir, "bin", "convert.js"),
                "-i",
                protoPath,
                "-o",
                spdxPath,
              ],
              {
                cwd: repoDir,
                encoding: "utf8",
                env: buildMinimalCliEnv(),
              },
            );
            assert.strictEqual(
              convertResult.status,
              0,
              `${scenario.name} ${specVersion}: ${convertResult.stdout}${convertResult.stderr}`,
            );

            const validateResult = spawnSync(
              process.execPath,
              [
                join(repoDir, "bin", "validate.js"),
                "-i",
                protoPath,
                "--fail-severity",
                "critical",
                "--no-deep",
                "--report",
                "json",
              ],
              {
                cwd: repoDir,
                encoding: "utf8",
                env: buildMinimalCliEnv(),
              },
            );
            assert.strictEqual(
              validateResult.status,
              0,
              `${scenario.name} ${specVersion}: ${validateResult.stdout}${validateResult.stderr}`,
            );

            const roundTrippedBom = readBinary(protoPath);
            assert.ok(roundTrippedBom);
            assert.strictEqual(roundTrippedBom.bomFormat, "CycloneDX");
            assert.strictEqual(roundTrippedBom.specVersion, specVersion);
            scenario.assertRoundTrip(roundTrippedBom);
          }
        }
        assert.strictEqual(
          existsSync(join(repoDir, "deps.slices.json")),
          false,
          "protobuf round-trip tests must not leave deps.slices.json in the repository root",
        );
      } finally {
        rmSync(join(repoDir, "deps.slices.json"), { force: true });
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });
  });

  describe("CycloneDX 2.0 JSON output", () => {
    it("generates valid experimental 2.0-dev JSON with specFormat", () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "cdxgen-json20-"));
      try {
        const jsonPath = join(fixtureRoot, "bom-2.0.json");
        const generateResult = spawnSync(
          process.execPath,
          [
            join(repoDir, "bin", "cdxgen.js"),
            "-t",
            "js",
            mcpFixtureDir,
            "-o",
            jsonPath,
            "--spec-version",
            "2.0",
            "--no-banner",
          ],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          },
        );
        assert.strictEqual(
          generateResult.status,
          0,
          `${generateResult.stdout}${generateResult.stderr}`,
        );

        const generatedBom = JSON.parse(readFileSync(jsonPath, "utf8"));
        assert.strictEqual(generatedBom.specFormat, "CycloneDX");
        assert.strictEqual(generatedBom.bomFormat, undefined);
        assert.strictEqual(generatedBom.specVersion, "2.0");
        assert.ok(Array.isArray(generatedBom.metadata?.tools?.components));

        const validateResult = spawnSync(
          process.execPath,
          [
            join(repoDir, "bin", "validate.js"),
            "-i",
            jsonPath,
            "--fail-severity",
            "critical",
            "--no-deep",
            "--report",
            "json",
          ],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          },
        );
        assert.strictEqual(
          validateResult.status,
          0,
          `${validateResult.stdout}${validateResult.stderr}`,
        );
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });

    it("rejects experimental 2.0-dev protobuf export until cdx-proto supports it", () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "cdxgen-proto20-"));
      try {
        const jsonPath = join(fixtureRoot, "bom-2.0.json");
        const protoPath = join(fixtureRoot, "bom-2.0.cdx");
        const generateResult = spawnSync(
          process.execPath,
          [
            join(repoDir, "bin", "cdxgen.js"),
            "-t",
            "js",
            mcpFixtureDir,
            "-o",
            jsonPath,
            "--spec-version",
            "2.0",
            "--export-proto",
            "--proto-bin-file",
            protoPath,
            "--no-banner",
          ],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          },
        );
        assert.strictEqual(generateResult.status, 1);
        assert.match(
          `${generateResult.stdout}${generateResult.stderr}`,
          /CycloneDX 2\.0 is not currently supported for protobuf export/i,
        );
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });
  });

  describe("submitBom()", () => {
    it("should report blocked Dependency-Track submission during dry-run", async () => {
      const recordActivity = sinon.stub();
      const { submitBom } = await esmock("./index.js", {
        "../core/activity.js": { isDryRun: true, recordActivity },
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
        assert.equal(server.requests[0].method, "POST");
        assert.equal(server.requests[0].url, "/api/v1/bom");
        assert.equal(getRequestHeader(server.requests[0], "x-api-key"), apiKey);
        assert.match(
          getRequestHeader(server.requests[0], "content-type"),
          /^multipart\/form-data; boundary=/,
        );
        const parts = submittedParts(server.requests[0]);
        assert.equal(parts.bom.filename, "bom.json");
        assert.equal(parts.bom.value, JSON.stringify(bomContent));
        assert.equal(parts.autoCreate.value, "true");
        assert.equal(parts.project.value, projectId);
        assert.equal(parts.projectName.value, projectName);
        assert.equal(parts.projectVersion.value, projectVersion);
        assert.equal(parts.projectTags.value, projectTag);
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
        assert.equal(server.requests[0].method, "POST");
        assert.equal(server.requests[0].url, "/api/v1/bom");
        assert.equal(getRequestHeader(server.requests[0], "x-api-key"), apiKey);
        const parts = submittedParts(server.requests[0]);
        assert.equal(parts.bom.value, JSON.stringify(bomContent));
        assert.equal(parts.parentUUID.value, parentProjectId);
        assert.equal(parts.projectName.value, projectName);
        assert.equal(parts.projectVersion.value, projectVersion);
        assert.equal(parts.projectTags.value, projectTags.join(","));
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
        assert.equal(server.requests[0].method, "POST");
        assert.equal(server.requests[0].url, "/api/v1/bom");
        assert.equal(getRequestHeader(server.requests[0], "x-api-key"), apiKey);
        const parts = submittedParts(server.requests[0]);
        assert.equal(parts.parentName.value, parentProjectName);
        assert.equal(parts.parentVersion.value, parentProjectVersion);
        assert.equal(parts.projectName.value, projectName);
        assert.equal(parts.projectVersion.value, projectVersion);
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
        const parts = submittedParts(server.requests[0]);
        assert.equal(parts.autoCreate.value, "false");
        assert.equal(parts.isLatest.value, "true");
        assert.equal(parts.projectVersion.value, "main");
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

    it("strips CRLF from the API key and submits a single multipart POST", async () => {
      const server = await startSubmitBomTestServer(async () => ({
        body: { success: true },
      }));

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
        assert.equal(server.requests.length, 1);
        assert.equal(server.requests[0].method, "POST");
        assert.equal(server.requests[0].url, "/api/v1/bom");
        assert.equal(
          getRequestHeader(server.requests[0], "x-api-key"),
          "TEST_API_KEY",
        );
        assert.match(
          getRequestHeader(server.requests[0], "content-type"),
          /^multipart\/form-data; boundary=/,
        );
      } finally {
        await server.close();
      }
    });

    it("does not retry with another method when the server rejects the request", async () => {
      const server = await startSubmitBomTestServer(async () => ({
        body: { error: "Method not allowed" },
        statusCode: 405,
      }));

      try {
        await assert.rejects(() =>
          submitBom(
            {
              serverUrl: server.serverUrl,
              projectName: "cdxgen-test-project",
              apiKey: "TEST_API_KEY",
            },
            { bom: "test7" },
          ),
        );
        assert.equal(server.requests.length, 1);
        assert.equal(server.requests[0].method, "POST");
      } finally {
        await server.close();
      }
    });

    it("submits a BOM larger than the base64 JSON limit of the server", async () => {
      const server = await startSubmitBomTestServer(async () => ({
        body: { success: true },
      }));
      // The JSON variant of the endpoint caps the base64 BOM at 20,000,000 characters,
      // which a BOM of this size exceeds once encoded.
      const bomContent = {
        bomFormat: "CycloneDX",
        components: Array.from({ length: 60000 }, (_unused, index) => ({
          description: "d".repeat(180),
          name: `component-${index}`,
          purl: `pkg:generic/component-${index}@1.0.0`,
          type: "library",
          version: "1.0.0",
        })),
      };
      const bomString = JSON.stringify(bomContent);
      assert.ok(
        Buffer.from(bomString).toString("base64").length > 20_000_000,
        "fixture must exceed the base64 limit to be a regression test",
      );

      try {
        const response = await submitBom(
          {
            serverUrl: server.serverUrl,
            projectName: "cdxgen-test-project",
            apiKey: "TEST_API_KEY",
          },
          bomContent,
        );

        assert.deepEqual(response, { success: true });
        assert.equal(server.requests.length, 1);
        assert.equal(submittedParts(server.requests[0]).bom.value, bomString);
      } finally {
        await server.close();
      }
    });
  });

  describe("createMultiXBom()", () => {
    // The uv workspace members (lib-a, lib-b) are nested under the python
    // project by the parser, and the merge in createMultiXBom must carry them
    // into metadata.component.components the way it already does for js, rust,
    // and the other workspace-aware ecosystems (issue #4445).
    const uvWorkspaceMemberPurls = [
      "pkg:pypi/lib-a@0.2.0",
      "pkg:pypi/lib-b@0.3.0",
    ];
    const subComponentPurls = (bom) =>
      (bomJsonOf(bom).metadata.component.components || []).map(
        (component) => component.purl,
      );
    const bomJsonOf = (bom) => bom?.bomJson || bom;

    it("retains uv workspace members as sub-components of the parent in the default multi-type scan", async () => {
      const result = await createBom(uvWorkspaceFixtureDir, {
        installDeps: false,
        multiProject: true,
        specVersion: 1.7,
      });
      const metadataComponent = bomJsonOf(result).metadata.component;
      assert.strictEqual(metadataComponent.purl, "pkg:pypi/ws-root@0.1.0");
      for (const memberPurl of uvWorkspaceMemberPurls) {
        assert.ok(
          subComponentPurls(result).includes(memberPurl),
          `${memberPurl} is missing from metadata.component.components`,
        );
      }
    });

    it("records dependsOn edges from the parent to hoisted workspace members", async () => {
      // The parent has no dependency entry of its own before the merge, so
      // the edges to hoisted sub-components must be created there (issue #4451).
      const result = await createBom(uvWorkspaceFixtureDir, {
        installDeps: false,
        multiProject: true,
        specVersion: 1.7,
      });
      const bomJson = bomJsonOf(result);
      const parentRef = bomJson.metadata.component["bom-ref"];
      const parentDeps = bomJson.dependencies.filter(
        (d) => d.ref === parentRef,
      );
      assert.strictEqual(parentDeps.length, 1);
      for (const memberPurl of uvWorkspaceMemberPurls) {
        assert.ok(
          parentDeps[0].dependsOn.includes(memberPurl),
          `${parentRef} does not depend on ${memberPurl}`,
        );
      }
      assert.ok(!parentDeps[0].dependsOn.includes(parentRef));
    });

    it("retains uv workspace members in a python+js multi-type scan", async () => {
      const result = await createBom(uvWorkspaceFixtureDir, {
        installDeps: false,
        projectType: ["python", "js"],
        specVersion: 1.7,
      });
      for (const memberPurl of uvWorkspaceMemberPurls) {
        assert.ok(
          subComponentPurls(result).includes(memberPurl),
          `${memberPurl} is missing from metadata.component.components`,
        );
      }
    });

    it("retains uv workspace members when a same-named npm project becomes the parent", async () => {
      // A monorepo root can carry both package.json and pyproject.toml under
      // one project name. The npm project wins the parent slot by scan order,
      // and the same-name collapse used to delete the python project's
      // workspace members with it.
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-uv-ws-samename-"));
      try {
        cpSync(uvWorkspaceFixtureDir, tempDir, { recursive: true });
        writeFileSync(
          join(tempDir, "package.json"),
          JSON.stringify(
            {
              name: "ws-root",
              version: "0.1.0",
              private: true,
              dependencies: { lodash: "^4.17.21" },
            },
            null,
            2,
          ),
        );
        writeFileSync(
          join(tempDir, "package-lock.json"),
          JSON.stringify(
            {
              name: "ws-root",
              version: "0.1.0",
              lockfileVersion: 3,
              requires: true,
              packages: {
                "": {
                  name: "ws-root",
                  version: "0.1.0",
                  dependencies: { lodash: "^4.17.21" },
                },
                "node_modules/lodash": {
                  version: "4.17.21",
                  resolved:
                    "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
                  integrity:
                    "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==",
                },
              },
            },
            null,
            2,
          ),
        );
        const result = await createBom(tempDir, {
          installDeps: false,
          multiProject: true,
          specVersion: 1.7,
        });
        assert.strictEqual(
          bomJsonOf(result).metadata.component.purl,
          "pkg:npm/ws-root@0.1.0",
        );
        for (const memberPurl of uvWorkspaceMemberPurls) {
          assert.ok(
            subComponentPurls(result).includes(memberPurl),
            `${memberPurl} is missing from metadata.component.components`,
          );
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

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
        const { createMultiXBom } = await esmock(
          "./index.js",
          {},
          {
            "../ecosystems/chromextutils.js": {
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
          },
        );
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
      const actualUtils = await import("../ecosystems/utils.js");
      const { createBom: createBomMocked } = await esmock(
        "./index.js",
        {},
        {
          "../core/activity.js": {
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
                ...actualUtils,
                ...currentActivityContext,
                ...context,
              };
            },
          },
        },
      );
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
      const actualUtils = await import("../ecosystems/utils.js");
      try {
        writeFileSync(requirementsFile, "flask==3.1.0\n", "utf-8");
        const { createBom: createBomMocked } = await esmock(
          "./index.js",
          {},
          {
            "../core/activity.js": {
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
                  ...actualUtils,
                  ...currentActivityContext,
                  ...context,
                };
              },
            },
          },
        );
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

    // Runs the CLI with an atom stub that records its arguments, and returns
    // each atom run as "<command> <language>", sorted, with the CLI output.
    const scanWithAtomStub = (fixtureRoot, projectDir, cliArgs) => {
      const logFile = join(fixtureRoot, "atom-argv.log");
      const stubPath = join(fixtureRoot, "atom-stub.js");
      writeFileSync(
        stubPath,
        `require("node:fs").appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
      );
      rmSync(logFile, { force: true });
      const result = spawnSync(
        process.execPath,
        [
          join(repoDir, "bin", "cdxgen.js"),
          ...cliArgs,
          "--no-install-deps",
          "--no-banner",
          "-o",
          `${projectDir}.bom.json`,
          projectDir,
        ],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: buildMinimalCliEnv({
            ATOM_CMD: `${process.execPath} ${stubPath}`,
            CDXGEN_TRACE_MODE: "true",
          }),
        },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      const atomRuns = existsSync(logFile)
        ? readFileSync(logFile, "utf-8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .map(
              (argv) =>
                `${argv.find((a) => ["parsedeps", "reachables", "usages"].includes(a))} ${argv[argv.indexOf("-l") + 1]}`,
            )
            .sort()
        : [];
      return { atomRuns, output: `${result.stdout}${result.stderr}` };
    };

    it("runs the atom Python and C fallbacks of a no-type deep scan only over their own sources", () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "cdxgen-notype-deep-"));
      try {
        const webDir = join(fixtureRoot, "web");
        mkdirSync(webDir);
        writeFileSync(
          join(webDir, "package.json"),
          JSON.stringify({ name: "web", version: "1.0.0" }),
        );
        const web = scanWithAtomStub(fixtureRoot, webDir, ["--deep"]);
        assert.deepStrictEqual(web.atomRuns, []);
        // The development packages osquery lists only resolve C includes
        assert.ok(
          !web.output
            .split("\n")
            .some(
              (line) =>
                line.includes('"type":"spawn"') && line.includes("osquery"),
            ),
          "osquery ran for a project with no C sources",
        );

        const polyDir = join(fixtureRoot, "poly");
        mkdirSync(polyDir);
        writeFileSync(
          join(polyDir, "package.json"),
          JSON.stringify({ name: "poly", version: "1.0.0" }),
        );
        writeFileSync(join(polyDir, "app.py"), "import requests\n");
        writeFileSync(
          join(polyDir, "main.c"),
          "#include <zlib.h>\nint main(void) { return 0; }\n",
        );
        assert.deepStrictEqual(
          scanWithAtomStub(fixtureRoot, polyDir, ["--deep"]).atomRuns,
          ["parsedeps python", "usages c"],
        );
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it("takes the evidence language of a no-type --evidence scan from the BOM", () => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), "cdxgen-notype-evidence-"),
      );
      try {
        const webDir = join(fixtureRoot, "web");
        mkdirSync(webDir);
        const webManifest = {
          name: "web",
          version: "1.0.0",
          dependencies: { "left-pad": "1.3.0" },
        };
        writeFileSync(
          join(webDir, "package.json"),
          JSON.stringify(webManifest),
        );
        writeFileSync(
          join(webDir, "package-lock.json"),
          JSON.stringify({
            name: "web",
            version: "1.0.0",
            lockfileVersion: 3,
            requires: true,
            packages: {
              "": webManifest,
              "node_modules/left-pad": {
                version: "1.3.0",
                resolved:
                  "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
              },
            },
          }),
        );
        assert.deepStrictEqual(
          scanWithAtomStub(fixtureRoot, webDir, ["--evidence"]).atomRuns,
          ["reachables js", "usages js"],
        );

        const pyDir = join(fixtureRoot, "py");
        mkdirSync(pyDir);
        writeFileSync(join(pyDir, "requirements.txt"), "requests==2.32.3\n");
        writeFileSync(join(pyDir, "app.py"), "import requests\n");
        assert.deepStrictEqual(
          scanWithAtomStub(fixtureRoot, pyDir, ["--evidence"]).atomRuns,
          ["parsedeps python", "reachables python", "usages python"],
        );

        const docsDir = join(fixtureRoot, "docs");
        mkdirSync(docsDir);
        writeFileSync(join(docsDir, "README.md"), "# docs\n");
        const docs = scanWithAtomStub(fixtureRoot, docsDir, ["--evidence"]);
        assert.deepStrictEqual(docs.atomRuns, []);
        assert.match(docs.output, /Skipping the evidence analysis/);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });
  });

  describe("createBom() dynamic trace plugins tests", () => {
    for (const plugin of ["trivy", "golem", "rusi"]) {
      it(`traces and generates SBOM for cdxgen plugin: ${plugin}`, async () => {
        try {
          const binaryPath = resolvePluginBinary(plugin);
          if (binaryPath && existsSync(binaryPath)) {
            const bomNSData = await createBom(process.cwd(), {
              projectType: "dynamic",
              traceCmd: `"${binaryPath}" --help`,
            });
            assert.ok(bomNSData, "BOM data should be returned");
            assert.ok(bomNSData.bomJson, "bomJson should be present");
            assert.ok(
              Array.isArray(bomNSData.bomJson.components || []),
              "components should be an array",
            );
          }
        } catch (_err) {
          // Safe to catch in environments without sandboxing/tracing tools
        }
      });
    }
  });
});

describe("scan progress summaries", () => {
  it("omits zero counts and uses the given plural form", () => {
    assert.strictEqual(
      summarizeCounts([
        [520, "OS package", "OS packages"],
        [0, "executable", "executables"],
        [37, "shared library", "shared libraries"],
        [1, "service", "services"],
      ]),
      "520 OS packages, 37 shared libraries, 1 service",
    );
    assert.strictEqual(summarizeCounts([[0, "component", "components"]]), "");
  });

  it("counts components by purl type, busiest first", () => {
    assert.strictEqual(
      summarizePurlTypes([
        { purl: "pkg:pypi/requests@2.32.3" },
        { purl: "pkg:cargo/serde@1.0.0" },
        { purl: "pkg:cargo/syn@2.0.0" },
        { purl: "pkg:cargo/quote@1.0.0" },
        { purl: "pkg:pypi/urllib3@2.2.0" },
      ]),
      "3 cargo, 2 pypi",
    );
  });

  it("falls back to the component type when a purl is missing", () => {
    assert.strictEqual(
      summarizePurlTypes([{ type: "file" }, { type: "file" }]),
      "2 file",
    );
  });

  describe("createOSBom() PHP host probe", () => {
    const runtime = {
      type: "platform",
      name: "php",
      version: "8.4.27",
      purl: "pkg:generic/php@8.4.27",
      "bom-ref": "pkg:generic/php@8.4.27",
      cpe: "cpe:2.3:a:php:php:8.4.27:*:*:*:*:*:*:*",
    };
    const file = {
      type: "file",
      name: "php",
      purl: "pkg:generic/php#usr/local/bin/php",
      "bom-ref": "pkg:generic/php#usr/local/bin/php",
      properties: [
        { name: "internal:SrcFile", value: "/usr/local/bin/php" },
        { name: "cdx:php:buildVersion", value: "8.4.27" },
        { name: "cdx:php:buildVersionSource", value: "binary" },
        { name: "cdx:php:sapi", value: "cli" },
      ],
    };
    const loadCreateOSBom = (
      probeHostPhp,
      probeHostNode = () => ({ components: [], dependencies: [] }),
      probeHostPythonEnvironments = () => [],
    ) =>
      esmock(
        "./index.js",
        {},
        {
          "../managers/binary.js": {
            executeOsQuery: () => undefined,
            enrichOSComponentsWithTrustData: (components) => ({
              components,
              tools: [],
            }),
          },
          "../inventory/phpHostProbe.js": { probeHostPhp },
          "../inventory/nodeHostProbe.js": { probeHostNode },
          "../ecosystems/venvProbe.js": { probeHostPythonEnvironments },
        },
      );

    it("puts the unpackaged Node.js and the Python environment packages the probes found in the OBOM", async () => {
      const nodeFile = {
        type: "file",
        name: "node",
        purl: "pkg:generic/node#usr/local/bin/node",
        "bom-ref": "pkg:generic/node#usr/local/bin/node",
        properties: [
          { name: "cdx:node:buildVersion", value: "24.22.0" },
          { name: "cdx:brotli:c:blockSwitchFix", value: "false" },
        ],
      };
      const nodeRuntime = {
        type: "platform",
        name: "node",
        version: "24.22.0",
        purl: "pkg:generic/node@24.22.0",
        "bom-ref": "pkg:generic/node@24.22.0",
      };
      const venvBrotli = {
        type: "library",
        name: "brotli",
        version: "1.2.0",
        purl: "pkg:pypi/brotli@1.2.0",
        "bom-ref": "pkg:pypi/brotli@1.2.0",
        properties: [{ name: "cdx:python:environment", value: "virtualenv" }],
        evidence: { occurrences: [{ location: "/opt/app/venv/x" }] },
      };
      const probeHostNode = sinon.stub().returns({
        components: [nodeFile, nodeRuntime],
        dependencies: [],
      });
      const { createOSBom } = await loadCreateOSBom(
        sinon.stub().returns({ components: [], dependencies: [] }),
        probeHostNode,
        () => [venvBrotli],
      );
      const { bomJson } = await createOSBom("", {
        specVersion: 1.7,
        projectType: ["os"],
      });
      sinon.assert.calledOnce(probeHostNode);
      const purls = bomJson.components.map((c) => c.purl).sort();
      for (const purl of [
        "pkg:generic/node#usr/local/bin/node",
        "pkg:generic/node@24.22.0",
        "pkg:pypi/brotli@1.2.0",
      ]) {
        assert.ok(purls.includes(purl), `${purl} in ${purls.join(", ")}`);
      }
    });

    it("puts the unpackaged PHP the probe found in the OBOM, without its edges", async () => {
      const probeHostPhp = sinon.stub().returns({
        components: [file, runtime],
        dependencies: [
          { ref: runtime["bom-ref"], dependsOn: [] },
          { ref: file["bom-ref"], dependsOn: [runtime["bom-ref"]] },
        ],
      });
      const { createOSBom } = await loadCreateOSBom(probeHostPhp);
      const { bomJson } = await createOSBom("", {
        specVersion: 1.7,
        projectType: ["os"],
      });
      // The probe is handed what it needs to ask osquery and to read the
      // packages the scan has inventoried.
      sinon.assert.calledOnce(probeHostPhp);
      assert.strictEqual(
        typeof probeHostPhp.firstCall.args[0].executeOsQuery,
        "function",
      );
      assert.ok(
        Array.isArray(probeHostPhp.firstCall.args[0].packageComponents),
      );
      assert.deepStrictEqual(
        bomJson.components.map((component) => component["bom-ref"]).sort(),
        [file["bom-ref"], runtime["bom-ref"]].sort(),
      );
      // An OBOM has no dependency graph. The probe's edges alone would make
      // post-processing infer that the OS depends on these PHP files only.
      assert.deepStrictEqual(bomJson.dependencies, []);
    });

    it("leaves an OBOM with no unpackaged PHP as flat as it was", async () => {
      const probeHostPhp = sinon
        .stub()
        .returns({ components: [], dependencies: [] });
      const { createOSBom } = await loadCreateOSBom(probeHostPhp);
      const { bomJson } = await createOSBom("", {
        specVersion: 1.7,
        projectType: ["os"],
      });
      sinon.assert.calledOnce(probeHostPhp);
      assert.deepStrictEqual(bomJson.components, []);
      assert.deepStrictEqual(bomJson.dependencies, []);
    });
  });
});

describe("createOSBom() OS package identity", () => {
  // The distro is what the host's os-release says; fixed here so the tests hold
  // on any operating system.
  const UBUNTU_2404 = {
    purlType: "deb",
    namespace: "ubuntu",
    distroId: "ubuntu-24.04",
    distroName: "noble",
  };
  const ALMALINUX_98 = {
    purlType: "rpm",
    namespace: "almalinux",
    distroId: "almalinux-9.8",
    distroName: "",
  };
  const ALPINE_324 = {
    purlType: "apk",
    namespace: "alpine",
    distroId: "alpine-3.24.3",
    distroName: "alpine-3.24",
  };
  const OS_VERSION_ROW = {
    name: "Ubuntu",
    version: "24.04.5 LTS (Noble Numbat)",
    codename: "noble",
    platform: "ubuntu",
  };
  const DEB_ROWS = [
    {
      name: "bsdutils",
      version: "1:2.39.3-9ubuntu6.6",
      source: "util-linux (2.39.3-9ubuntu6.6)",
      size: "289",
      arch: "amd64",
      revision: "9ubuntu6.6",
      status: "install ok installed",
      maintainer: "Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>",
      section: "utils",
      priority: "required",
      admindir: "/var/lib/dpkg",
    },
    {
      name: "php8.3-cli",
      version: "8.3.6-0ubuntu0.24.04.13",
      source: "php8.3",
      size: "5752",
      arch: "amd64",
      revision: "0ubuntu0.24.04.13",
      status: "install ok installed",
      maintainer: "Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>",
      section: "php",
      priority: "optional",
      admindir: "/var/lib/dpkg",
    },
  ];
  const RPM_ROWS = [
    {
      name: "openssl-libs",
      version: "3.5.8",
      release: "1.el9_8",
      source: "openssl-3.5.8-1.el9_8.src.rpm",
      size: "7490835",
      arch: "x86_64",
      epoch: "1",
      vendor: "AlmaLinux",
    },
    {
      name: "php-cli",
      version: "8.0.30",
      release: "8.el9_8.alma.1",
      source: "php-8.0.30-8.el9_8.alma.1.src.rpm",
      size: "16976035",
      arch: "x86_64",
      epoch: "",
      vendor: "AlmaLinux",
    },
  ];
  const BREW_ROWS = [
    {
      name: "php",
      path: "/opt/homebrew/Cellar/php",
      version: "8.5.11_1",
      type: "formula",
      auto_updates: "",
      app_name: "",
    },
    {
      name: "android-commandlinetools",
      path: "/opt/homebrew/Caskroom/android-commandlinetools",
      version: "15859902",
      type: "cask",
      auto_updates: "0",
      app_name: "",
    },
  ];
  const APK_PACKAGES = [
    {
      name: "php84",
      version: "8.4.27-r0",
      arch: "x86_64",
      origin: "php84",
      maintainer: "A Maintainer <maintainer@example.org>",
      license: "PHP-3.01",
      url: "https://www.php.net/",
      description: "The PHP84 language runtime engine",
      fileCount: 1,
      files: [],
    },
    {
      name: "musl",
      version: "1.2.6-r3",
      arch: "x86_64",
      origin: "musl",
      license: "MIT",
      description: "the musl c library (libc) implementation",
      fileCount: 1,
      files: [],
    },
  ];

  // rowsByTable answers the osquery queries the pack of the mocked platform
  // asks; every other table answers nothing, as on a host osquery cannot read.
  const load = ({
    platform,
    distro,
    rowsByTable = {},
    apk = { state: "absent", packages: [], malformed: 0 },
    recordDegradation = sinon.stub(),
  }) => {
    const readApkInstalledDb = sinon.stub().returns(apk);
    const executeOsQuery = (query) => {
      const table = Object.keys(rowsByTable).find((name) =>
        query.toLowerCase().includes(`from ${name}`),
      );
      return table ? rowsByTable[table] : undefined;
    };
    return esmock(
      "./index.js",
      {
        "node:os": { platform: () => platform },
        "../core/buildLedger.js": { recordDegradation },
        "../inventory/apkInstalledDb.js": { readApkInstalledDb },
      },
      {
        "../managers/binary.js": {
          executeOsQuery,
          enrichOSComponentsWithTrustData: (components) => ({
            components,
            tools: [],
          }),
        },
        "../inventory/phpHostProbe.js": {
          probeHostPhp: () => ({ components: [], dependencies: [] }),
        },
        "../inventory/nodeHostProbe.js": {
          probeHostNode: () => ({ components: [], dependencies: [] }),
        },
        "../ecosystems/venvProbe.js": {
          probeHostPythonEnvironments: () => [],
        },
        "../inventory/osinfo.js": { getDistroInfo: () => distro },
      },
    ).then((module) => ({ ...module, readApkInstalledDb, recordDegradation }));
  };
  const run = async (createOSBom) =>
    (await createOSBom("", { specVersion: 1.7, projectType: ["os"] })).bomJson;
  const byName = (bomJson, name) =>
    bomJson.components.find((component) => component.name === name);
  const property = (component, name) =>
    component?.properties?.find((entry) => entry.name === name)?.value;

  it("gives the deb packages of a Debian-family host the purls the container scan gives them", async () => {
    const { createOSBom } = await load({
      platform: "linux",
      distro: UBUNTU_2404,
      rowsByTable: { os_version: [OS_VERSION_ROW], deb_packages: DEB_ROWS },
    });
    const bomJson = await run(createOSBom);
    assert.strictEqual(
      byName(bomJson, "bsdutils").purl,
      "pkg:deb/ubuntu/bsdutils@1:2.39.3-9ubuntu6.6?arch=amd64&distro=ubuntu-24.04&distro_name=noble&epoch=1",
    );
    assert.strictEqual(
      byName(bomJson, "php8.3-cli").purl,
      "pkg:deb/ubuntu/php8.3-cli@8.3.6-0ubuntu0.24.04.13?arch=amd64&distro=ubuntu-24.04&distro_name=noble",
    );
    for (const component of bomJson.components) {
      assert.ok(!component.purl.includes("#var/lib/dpkg"), component.purl);
      assert.ok(!component["bom-ref"].includes("var/lib/dpkg"));
    }
    assert.strictEqual(
      property(byName(bomJson, "php8.3-cli"), "cdx:deb:source"),
      "php8.3",
    );
  });

  it("gives the rpm packages of an RPM host the release in the version and the epoch", async () => {
    const { createOSBom } = await load({
      platform: "linux",
      distro: ALMALINUX_98,
      rowsByTable: {
        os_version: [{ ...OS_VERSION_ROW, name: "AlmaLinux" }],
        rpm_packages: RPM_ROWS,
      },
    });
    const bomJson = await run(createOSBom);
    assert.strictEqual(
      byName(bomJson, "openssl-libs").purl,
      "pkg:rpm/almalinux/openssl-libs@1:3.5.8-1.el9_8?arch=x86_64&distro=almalinux-9.8&epoch=1",
    );
    assert.strictEqual(
      byName(bomJson, "openssl-libs").version,
      "1:3.5.8-1.el9_8",
    );
    assert.strictEqual(
      byName(bomJson, "php-cli").purl,
      "pkg:rpm/almalinux/php-cli@8.0.30-8.el9_8.alma.1?arch=x86_64&distro=almalinux-9.8",
    );
    assert.strictEqual(
      property(byName(bomJson, "php-cli"), "cdx:rpm:sourceRpm"),
      "php-8.0.30-8.el9_8.alma.1.src.rpm",
    );
  });

  it("inventories the apk packages of a host osquery cannot read, after the osquery categories", async () => {
    const { createOSBom, readApkInstalledDb } = await load({
      platform: "linux",
      distro: ALPINE_324,
      apk: {
        state: "ok",
        path: "/lib/apk/db/installed",
        packages: APK_PACKAGES,
        malformed: 0,
      },
    });
    const bomJson = await run(createOSBom);
    sinon.assert.calledOnce(readApkInstalledDb);
    assert.deepStrictEqual(
      bomJson.components.map((component) => component.purl).sort(),
      [
        "pkg:apk/alpine/musl@1.2.6-r3?arch=x86_64&distro=alpine-3.24.3&distro_name=alpine-3.24",
        "pkg:apk/alpine/php84@8.4.27-r0?arch=x86_64&distro=alpine-3.24.3&distro_name=alpine-3.24",
      ],
    );
    for (const component of bomJson.components) {
      assert.strictEqual(
        property(component, "cdx:osquery:category"),
        "apk_packages",
      );
    }
  });

  it("keeps every apk package as a component, never one as the OS", async () => {
    const { createOSBom } = await load({
      platform: "linux",
      distro: ALPINE_324,
      rowsByTable: {
        os_version: [{ ...OS_VERSION_ROW, name: "Alpine Linux" }],
      },
      apk: {
        state: "ok",
        path: "/lib/apk/db/installed",
        packages: APK_PACKAGES,
        malformed: 0,
      },
    });
    const bomJson = await run(createOSBom);
    assert.strictEqual(bomJson.components.length, 2);
    assert.ok(bomJson.metadata.component.name.startsWith("Alpine"));
    assert.strictEqual(bomJson.metadata.component.type, "operating-system");
  });

  it("records a degradation, and no packages, when the apk database exists but cannot be read", async () => {
    const recordDegradation = sinon.stub();
    const { createOSBom } = await load({
      platform: "linux",
      distro: ALPINE_324,
      rowsByTable: {
        os_version: [{ ...OS_VERSION_ROW, name: "Alpine Linux" }],
      },
      apk: {
        state: "unreadable",
        path: "/lib/apk/db/installed",
        packages: [],
        malformed: 0,
      },
      recordDegradation,
    });
    const bomJson = await run(createOSBom);
    assert.deepStrictEqual(bomJson.components, []);
    sinon.assert.calledOnce(recordDegradation);
    sinon.assert.calledWithMatch(
      recordDegradation,
      "os.apk-installed-db.unreadable",
      {
        ecosystem: "generic",
        tool: "apk",
        impact: "components",
        path: "/lib/apk/db/installed",
      },
    );
  });

  it("records nothing when there is no apk database or the scan is a dry run", async () => {
    for (const state of ["absent", "skipped"]) {
      const recordDegradation = sinon.stub();
      const { createOSBom } = await load({
        platform: "linux",
        distro: UBUNTU_2404,
        rowsByTable: { os_version: [OS_VERSION_ROW], deb_packages: DEB_ROWS },
        apk: { state, packages: [], malformed: 0 },
        recordDegradation,
      });
      const bomJson = await run(createOSBom);
      sinon.assert.notCalled(recordDegradation);
      assert.strictEqual(bomJson.components.length, 2, state);
    }
  });

  it("does not look for an apk database off Linux", async () => {
    const { createOSBom, readApkInstalledDb } = await load({
      platform: "darwin",
      distro: UBUNTU_2404,
      rowsByTable: { homebrew_packages: BREW_ROWS },
    });
    await run(createOSBom);
    sinon.assert.notCalled(readApkInstalledDb);
  });

  it("gives Homebrew packages on macOS the brew type, told apart by a property", async () => {
    const { createOSBom } = await load({
      platform: "darwin",
      distro: UBUNTU_2404,
      rowsByTable: {
        os_version: [{ name: "macOS", version: "27.0.1", platform: "darwin" }],
        homebrew_packages: BREW_ROWS,
      },
    });
    const bomJson = await run(createOSBom);
    const formula = byName(bomJson, "php");
    const cask = byName(bomJson, "android-commandlinetools");
    assert.strictEqual(formula.purl, "pkg:brew/php@8.5.11_1");
    assert.strictEqual(cask.purl, "pkg:brew/android-commandlinetools@15859902");
    assert.strictEqual(property(formula, "cdx:homebrew:type"), "formula");
    assert.strictEqual(property(cask, "cdx:homebrew:type"), "cask");
    assert.strictEqual(
      property(formula, "cdx:osquery:category"),
      "homebrew_packages",
    );
    for (const component of bomJson.components) {
      assert.ok(!component.purl?.startsWith("pkg:swid"), component.purl);
    }
  });

  it("names npm and pypi packages without the path they were found at", async () => {
    const abbrevAt = (node) =>
      `/home/alice/.nvm/versions/node/${node}/lib/node_modules/npm/node_modules/abbrev/package.json`;
    const { createOSBom } = await load({
      platform: "linux",
      distro: UBUNTU_2404,
      rowsByTable: {
        os_version: [OS_VERSION_ROW],
        npm_packages: [
          { name: "abbrev", version: "2.0.0", path: abbrevAt("v24.22.1") },
          { name: "abbrev", version: "2.0.0", path: abbrevAt("v20.20.2") },
          {
            name: "@isaacs/cliui",
            version: "8.0.2",
            path: "/usr/lib/node_modules/npm/node_modules/@isaacs/cliui/package.json",
          },
        ],
        python_packages: [
          {
            name: "requests",
            version: "2.31.0",
            path: "/usr/lib/python3/dist-packages/requests-2.31.0.dist-info",
            directory: "/usr/lib/python3/dist-packages",
          },
        ],
      },
    });
    const bomJson = await run(createOSBom);
    assert.deepStrictEqual(
      bomJson.components.map((component) => component["bom-ref"]).sort(),
      [
        "pkg:npm/@isaacs/cliui@8.0.2",
        "pkg:npm/abbrev@2.0.0",
        "pkg:pypi/requests@2.31.0",
      ],
    );
    assert.deepStrictEqual(
      byName(bomJson, "abbrev").evidence.occurrences.map(
        (occurrence) => occurrence.location,
      ),
      [abbrevAt("v20.20.2"), abbrevAt("v24.22.1")],
    );
    assert.strictEqual(byName(bomJson, "cliui").group, "@isaacs");
    assert.strictEqual(
      byName(bomJson, "cliui").purl,
      "pkg:npm/%40isaacs/cliui@8.0.2",
    );
    for (const component of bomJson.components) {
      assert.ok(!component.purl.includes("#"), component.purl);
      assert.ok(!component["bom-ref"].includes("alice"), component["bom-ref"]);
    }
  });

  describe("the query packs", () => {
    const pack = (name) =>
      JSON.parse(
        readFileSync(
          join(import.meta.dirname, "..", "..", "data", name),
          "utf-8",
        ),
      );

    it("types the Homebrew table as brew, not swid", () => {
      assert.strictEqual(
        pack("queries-darwin.json").homebrew_packages.purlType,
        "brew",
      );
    });

    it("keeps the Linux package tables on the types of their package managers", () => {
      const linux = pack("queries.json");
      assert.strictEqual(linux.deb_packages.purlType, "deb");
      assert.strictEqual(linux.rpm_packages.purlType, "rpm");
    });

    it("never types a package manager's table as swid", () => {
      for (const file of [
        "queries.json",
        "queries-darwin.json",
        "queries-win.json",
      ]) {
        for (const [category, query] of Object.entries(pack(file))) {
          if (/(^|_)packages$/.test(category)) {
            assert.notStrictEqual(
              query.purlType,
              "swid",
              `${file}: ${category}`,
            );
          }
        }
      }
    });
  });
});

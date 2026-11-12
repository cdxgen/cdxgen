import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { mcpServerManifestParser } from "./mcpServerManifest.js";

const getProp = (subject, name) =>
  subject?.properties?.find((property) => property.name === name)?.value;

const createTempDir = () =>
  mkdtempSync(join(os.tmpdir(), "cdxgen-mcp-manifest-"));

describe("mcpServerManifestParser", () => {
  it("parses packages and remotes from a registry server.json", () => {
    const tmpDir = createTempDir();
    try {
      const manifestPath = join(tmpDir, "server.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          $schema:
            "https://static.modelcontextprotocol.io/schemas/2025-09-16/server.schema.json",
          name: "io.github.example/weather",
          description: "Weather MCP server",
          version: "1.4.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/weather-mcp",
              version: "1.4.0",
              transport: { type: "stdio" },
            },
            {
              registryType: "pypi",
              identifier: "Example_Weather_MCP",
              version: "1.4.0",
              environmentVariables: [
                { name: "WEATHER_API_KEY", isSecret: true },
                { name: "WEATHER_UNITS" },
              ],
            },
          ],
          remotes: [
            {
              type: "streamable-http",
              url: "https://mcp.example.com/weather",
            },
          ],
        }),
      );

      const result = mcpServerManifestParser.parse([manifestPath]);

      const fileComponent = result.components.find(
        (component) =>
          getProp(component, "cdx:file:kind") === "mcp-server-manifest",
      );
      assert.ok(fileComponent, "expected a manifest file component");
      assert.strictEqual(
        getProp(fileComponent, "cdx:registry:server:packageCount"),
        "2",
      );
      assert.strictEqual(
        getProp(fileComponent, "cdx:registry:server:remoteCount"),
        "1",
      );

      const npmComponent = result.components.find(
        (component) => component.name === "@example/weather-mcp",
      );
      assert.ok(npmComponent, "expected npm package component");
      assert.strictEqual(
        npmComponent.purl,
        "pkg:npm/%40example/weather-mcp@1.4.0",
      );
      assert.strictEqual(
        getProp(npmComponent, "cdx:registry:server:packageRegistryType"),
        "npm",
      );

      const pypiComponent = result.components.find(
        (component) => component.name === "Example_Weather_MCP",
      );
      assert.ok(pypiComponent, "expected pypi package component");
      // The identifier `Example_Weather_MCP` normalizes to the canonical purl
      // name (lowercase, underscores collapsed to hyphens).
      assert.strictEqual(
        pypiComponent.purl,
        "pkg:pypi/example-weather-mcp@1.4.0",
      );
      assert.strictEqual(
        getProp(pypiComponent, "cdx:registry:server:environmentVariableCount"),
        "2",
      );
      assert.strictEqual(
        getProp(pypiComponent, "cdx:registry:server:secretInputCount"),
        "1",
      );

      assert.strictEqual(result.services.length, 1);
      const remote = result.services[0];
      assert.deepStrictEqual(remote.endpoints, [
        "https://mcp.example.com/weather",
      ]);
      assert.strictEqual(
        getProp(remote, "cdx:mcp:serviceType"),
        "registry-remote",
      );
      // The non-version sentinel must not be emitted into the version field.
      assert.strictEqual(remote.version, undefined);
      assert.strictEqual(getProp(remote, "cdx:mcp:composition"), "unknown");
      assert.strictEqual(
        getProp(remote, "cdx:mcp:exposureType"),
        "networked-public",
      );
      assert.strictEqual(
        getProp(remote, "cdx:mcp:transport"),
        "streamable-http",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("sanitizes registry remote endpoints", () => {
    const tmpDir = createTempDir();
    try {
      const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
      const manifestPath = join(tmpDir, "server.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: "io.github.example/release",
          remotes: [
            {
              type: "sse",
              url: `https://bot:hunter2@mcp.example.com/mcp/${token}/sse?sig=abc#frag`,
            },
          ],
        }),
      );

      const result = mcpServerManifestParser.parse([manifestPath]);

      assert.deepStrictEqual(result.services[0].endpoints, [
        "https://mcp.example.com/mcp",
      ]);
      const text = JSON.stringify(result);
      for (const secret of [token, "hunter2", "sig=abc"]) {
        assert.ok(!text.includes(secret), secret);
      }
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("ignores unrelated server.json files", () => {
    const tmpDir = createTempDir();
    try {
      const manifestPath = join(tmpDir, "server.json");
      // A typical dev-server config that is not an MCP registry manifest.
      writeFileSync(
        manifestPath,
        JSON.stringify({ port: 8080, host: "0.0.0.0", root: "./public" }),
      );

      const result = mcpServerManifestParser.parse([manifestPath]);
      assert.strictEqual(result.components.length, 0);
      assert.strictEqual(result.services.length, 0);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("marks an mcpb-only package without a derivable purl", () => {
    const tmpDir = createTempDir();
    try {
      const manifestPath = join(tmpDir, "server.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: "io.github.example/local",
          packages: [
            {
              registryType: "mcpb",
              identifier: "local-bundle",
              version: "0.1.0",
            },
          ],
        }),
      );

      const result = mcpServerManifestParser.parse([manifestPath]);
      const bundleComponent = result.components.find(
        (component) => component.name === "local-bundle",
      );
      assert.ok(bundleComponent, "expected the mcpb package component");
      assert.strictEqual(bundleComponent.purl, undefined);
      assert.strictEqual(
        getProp(bundleComponent, "cdx:registry:server:packageRegistryType"),
        "mcpb",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("only builds an oci purl when a digest and repository are present", () => {
    const tmpDir = createTempDir();
    try {
      const manifestPath = join(tmpDir, "server.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: "io.github.example/containers",
          packages: [
            {
              registryType: "oci",
              identifier: "example/Weather-Server",
              version: "sha256:abc123def456",
              registryBaseUrl: "https://ghcr.io",
            },
            {
              registryType: "oci",
              identifier: "example/tag-only",
              version: "1.0.0",
            },
          ],
        }),
      );

      const result = mcpServerManifestParser.parse([manifestPath]);
      const withDigest = result.components.find(
        (component) => component.name === "example/Weather-Server",
      );
      assert.ok(withDigest, "expected the digest-pinned oci component");
      assert.ok(
        withDigest.purl?.startsWith("pkg:oci/weather-server@sha256:"),
        `expected a normalized oci purl, got ${withDigest.purl}`,
      );
      assert.ok(
        withDigest.purl.includes("repository_url="),
        "expected a repository_url qualifier",
      );

      const tagOnly = result.components.find(
        (component) => component.name === "example/tag-only",
      );
      assert.ok(tagOnly, "expected the tag-only oci component");
      assert.strictEqual(
        tagOnly.purl,
        undefined,
        "a tag-only oci reference must not produce a misleading purl",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});

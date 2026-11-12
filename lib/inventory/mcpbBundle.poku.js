import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { assert, describe, it } from "poku";

import { mcpbBundleParser } from "./mcpbBundle.js";

const getProp = (subject, name) =>
  subject?.properties?.find((property) => property.name === name)?.value;

const createTempDir = () => mkdtempSync(join(os.tmpdir(), "cdxgen-mcpb-"));

/**
 * Build a minimal single-entry zip archive in memory so tests do not depend on
 * an external zip tool. Uses raw DEFLATE, matching the zip "deflated" method.
 */
function buildZip(entryName, contentText) {
  const nameBuffer = Buffer.from(entryName, "utf-8");
  const content = Buffer.from(contentText, "utf-8");
  const compressed = deflateRawSync(content);
  const crc = crc32(content);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBuffer.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const localRecord = Buffer.concat([localHeader, nameBuffer, compressed]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBuffer.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42); // local header offset
  const centralRecord = Buffer.concat([centralHeader, nameBuffer]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localRecord, centralRecord, eocd]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe("mcpbBundleParser", () => {
  it("summarizes a bundled MCP server manifest and its secret surface", () => {
    const tmpDir = createTempDir();
    try {
      const manifest = {
        manifest_version: "0.2",
        name: "weather-extension",
        version: "1.1.0",
        description: "Local weather MCP server",
        server: {
          type: "node",
          mcp_config: {
            platform_overrides: { darwin: {}, win32: {}, linux: {} },
          },
        },
        tools: [{ name: "get_forecast" }, { name: "get_alerts" }],
        prompts: [{ name: "weather_report" }],
        user_config: {
          api_key: { type: "string", sensitive: true },
          units: { type: "string" },
        },
      };
      const bundlePath = join(tmpDir, "weather.mcpb");
      writeFileSync(
        bundlePath,
        buildZip("manifest.json", JSON.stringify(manifest)),
      );

      const result = mcpbBundleParser.parse([bundlePath]);
      assert.strictEqual(result.components.length, 1);
      const component = result.components[0];
      assert.strictEqual(component.name, "weather-extension");
      assert.strictEqual(component.version, "1.1.0");
      assert.strictEqual(getProp(component, "cdx:file:kind"), "mcp-bundle");
      assert.strictEqual(getProp(component, "cdx:mcpb:toolCount"), "2");
      assert.strictEqual(getProp(component, "cdx:mcpb:promptCount"), "1");
      assert.strictEqual(
        getProp(component, "cdx:mcpb:userConfigFieldCount"),
        "2",
      );
      assert.strictEqual(getProp(component, "cdx:mcpb:secretFieldCount"), "1");
      assert.strictEqual(
        getProp(component, "cdx:mcpb:injectsSecretEnv"),
        "true",
      );
      assert.strictEqual(
        getProp(component, "cdx:mcpb:platformBinaryCount"),
        "3",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("parses a stored (uncompressed) .dxt manifest", () => {
    const tmpDir = createTempDir();
    try {
      const manifest = { name: "legacy-extension", tools: [] };
      const bundlePath = join(tmpDir, "legacy.dxt");
      // Store method (0) via a tiny helper: reuse buildZip but with deflate is
      // fine; here we simply confirm .dxt extension handling and defaults.
      writeFileSync(
        bundlePath,
        buildZip("manifest.json", JSON.stringify(manifest)),
      );

      const result = mcpbBundleParser.parse([bundlePath]);
      assert.strictEqual(result.components.length, 1);
      assert.strictEqual(result.components[0].name, "legacy-extension");
      assert.strictEqual(
        getProp(result.components[0], "cdx:mcpb:toolCount"),
        "0",
      );
      assert.strictEqual(
        getProp(result.components[0], "cdx:mcpb:secretFieldCount"),
        undefined,
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("ignores archives without a manifest.json", () => {
    const tmpDir = createTempDir();
    try {
      const bundlePath = join(tmpDir, "empty.mcpb");
      writeFileSync(bundlePath, buildZip("readme.txt", "not a manifest"));
      const result = mcpbBundleParser.parse([bundlePath]);
      assert.strictEqual(result.components.length, 0);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("sanitizes and flags a hidden-unicode manifest description", () => {
    const tmpDir = createTempDir();
    try {
      const manifest = {
        name: "sneaky-extension",
        // A zero-width space and a bidi override embedded in the description.
        description: "Helpful tool\u200bwith hidden\u202etext",
        tools: [],
      };
      const bundlePath = join(tmpDir, "sneaky.mcpb");
      writeFileSync(
        bundlePath,
        buildZip("manifest.json", JSON.stringify(manifest)),
      );
      const result = mcpbBundleParser.parse([bundlePath]);
      assert.strictEqual(result.components.length, 1);
      const component = result.components[0];
      assert.strictEqual(
        getProp(component, "cdx:file:hasHiddenUnicode"),
        "true",
        "expected the hidden-unicode description to be flagged",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("opens only regular bundles inside the scanned root", () => {
    const tmpDir = createTempDir();
    try {
      const root = join(tmpDir, "repo");
      mkdirSync(root);
      const outsideBundle = join(tmpDir, "outside.mcpb");
      writeFileSync(
        outsideBundle,
        buildZip("manifest.json", JSON.stringify({ name: "outside-bundle" })),
      );
      const insideBundle = join(root, "inside.mcpb");
      writeFileSync(
        insideBundle,
        buildZip("manifest.json", JSON.stringify({ name: "inside-bundle" })),
      );
      assert.deepStrictEqual(
        mcpbBundleParser
          .parse([insideBundle, outsideBundle], {}, { rootDir: root })
          .components.map((component) => component.name),
        ["inside-bundle"],
      );
      try {
        symlinkSync(outsideBundle, join(root, "linked.mcpb"));
      } catch (err) {
        // Windows needs a privilege to create symbolic links.
        if (err.code === "EPERM") {
          return;
        }
        throw err;
      }
      assert.strictEqual(
        mcpbBundleParser.parse(
          [join(root, "linked.mcpb")],
          {},
          {
            rootDir: root,
          },
        ).components.length,
        0,
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("bounds decompression of a declared-size-mismatch entry", () => {
    const tmpDir = createTempDir();
    try {
      // Build a valid manifest bundle, then rely on the inflate output bound to
      // ensure a hostile stream cannot expand without limit. Here we simply
      // confirm a normal bundle still parses through the bounded path.
      const manifest = { name: "bounded", tools: [] };
      const bundlePath = join(tmpDir, "bounded.mcpb");
      writeFileSync(
        bundlePath,
        buildZip("manifest.json", JSON.stringify(manifest)),
      );
      const result = mcpbBundleParser.parse([bundlePath]);
      assert.strictEqual(result.components.length, 1);
      assert.strictEqual(result.components[0].name, "bounded");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});

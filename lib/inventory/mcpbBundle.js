import { closeSync, readSync } from "node:fs";
import { basename } from "node:path";
import { inflateRawSync } from "node:zlib";

import { DEBUG_MODE } from "../core/activity.js";
import { openRegularFile } from "../core/boundedFile.js";
import { sanitizeBomPropertyValue } from "../core/propertySanitizer.js";
import { sanitizeMcpRefToken } from "./mcpDiscovery.js";
import { scanTextForHiddenUnicode } from "./unicodeScan.js";

const MCPB_BUNDLE_PATTERNS = ["**/*.mcpb", "**/*.dxt"];

// Bound only what is decompressed. The archive itself is no longer fully
// buffered: the End-Of-Central-Directory record, the central directory, and a
// single local entry are read positionally, so a large vendored bundle is
// inspected rather than silently skipped.
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
// Cap the central directory read so a hostile archive cannot force a huge
// allocation. 16 MiB comfortably covers tens of thousands of entries.
const MAX_CENTRAL_DIR_BYTES = 16 * 1024 * 1024;
// The EOCD record is 22 bytes plus an optional comment of up to 65535 bytes.
const MAX_EOCD_SCAN_BYTES = 22 + 65535;
const MAX_DESCRIPTION_BYTES = 1000;
// Characters a long description may be cut after: whitespace and the CJK
// full stop, comma and ideographic comma. None of them occurs inside a token
// the BOM sanitizer recognises or ends the user-info of a URL, so a cut there
// never hands the sanitizer half a credential.
const DESCRIPTION_CUT_BOUNDARY = /[\s\u3001\u3002\uff0c]/u;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const SECRET_FIELD_NAME_PATTERN =
  /(token|secret|password|api[_-]?key|client[_-]?secret|authorization|credential)/iu;

/**
 * Read a byte range from an open file descriptor into a fresh buffer.
 *
 * @param {number} fd Open file descriptor
 * @param {number} position Absolute byte offset
 * @param {number} length Number of bytes to read
 * @returns {Buffer|undefined} Filled buffer, or undefined on short read
 */
function readRange(fd, position, length) {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(fd, buffer, 0, length, position);
  if (bytesRead !== length) {
    return undefined;
  }
  return buffer;
}

/**
 * Read and decompress the `manifest.json` entry from a zip archive using
 * positional reads, without any third-party dependency and without buffering
 * the whole archive. Only the End-Of-Central-Directory record, the central
 * directory, and the single manifest entry are read, so an untrusted bundle is
 * never fully expanded.
 *
 * Zip64 archives (more than 65535 entries, or offsets beyond 4 GiB) are not
 * decoded; such a bundle is skipped with a debug log rather than mis-read.
 * Only a regular file inside rootDir is opened; a symbolic link, FIFO or
 * device is skipped.
 *
 * @param {string} filePath Path to the .mcpb/.dxt bundle
 * @param {string|undefined} rootDir Root of the scan
 * @returns {string|undefined} Decoded manifest.json text, or undefined
 */
function readManifestFromBundle(filePath, rootDir) {
  let fd;
  try {
    const opened = openRegularFile(filePath, rootDir);
    if (!opened) {
      return undefined;
    }
    fd = opened.fd;
    const size = opened.size;
    if (size < 22) {
      return undefined;
    }
    const eocd = findEndOfCentralDirectory(fd, size);
    if (!eocd) {
      debugSkip(filePath, "no end-of-central-directory record");
      return undefined;
    }
    if (eocd.entryCount === 0xffff || eocd.centralDirOffset === 0xffffffff) {
      debugSkip(filePath, "zip64 archive is not supported");
      return undefined;
    }
    if (eocd.centralDirSize > MAX_CENTRAL_DIR_BYTES) {
      debugSkip(filePath, "central directory exceeds the read cap");
      return undefined;
    }
    const central = readRange(fd, eocd.centralDirOffset, eocd.centralDirSize);
    if (!central) {
      debugSkip(filePath, "could not read the central directory");
      return undefined;
    }
    const entry = findManifestEntry(central, eocd.entryCount);
    if (!entry) {
      return undefined;
    }
    const data = readLocalEntry(fd, size, entry);
    if (data === undefined) {
      debugSkip(filePath, "could not inflate the manifest entry");
    }
    return data;
  } catch (err) {
    debugSkip(filePath, err?.message || "read error");
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failures
      }
    }
  }
}

/**
 * Cut text to at most limit characters at the last boundary before the
 * limit, so no URL or token is split. Text within the limit is returned as
 * it is, and text with no boundary before the limit gives an empty string.
 *
 * @param {string} text Text to cut
 * @param {number} limit Largest length kept
 * @returns {string} The cut text
 */
export function truncateAtWordBoundary(text, limit) {
  if (text.length <= limit) {
    return text;
  }
  for (let index = limit; index > 0; index--) {
    if (DESCRIPTION_CUT_BOUNDARY.test(text[index])) {
      return text.slice(0, index).trimEnd();
    }
  }
  return "";
}

function debugSkip(filePath, reason) {
  if (DEBUG_MODE) {
    console.log(`Skipping MCPB bundle ${filePath}: ${reason}`);
  }
}

function findEndOfCentralDirectory(fd, size) {
  const scanLength = Math.min(size, MAX_EOCD_SCAN_BYTES);
  const start = size - scanLength;
  const tail = readRange(fd, start, scanLength);
  if (!tail) {
    return undefined;
  }
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return {
        entryCount: tail.readUInt16LE(offset + 10),
        centralDirSize: tail.readUInt32LE(offset + 12),
        centralDirOffset: tail.readUInt32LE(offset + 16),
      };
    }
  }
  return undefined;
}

function findManifestEntry(central, entryCount) {
  let pointer = 0;
  for (let index = 0; index < entryCount; index++) {
    if (pointer + 46 > central.length) {
      return undefined;
    }
    if (central.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) {
      return undefined;
    }
    const compressionMethod = central.readUInt16LE(pointer + 10);
    const compressedSize = central.readUInt32LE(pointer + 20);
    const uncompressedSize = central.readUInt32LE(pointer + 24);
    const fileNameLength = central.readUInt16LE(pointer + 28);
    const extraLength = central.readUInt16LE(pointer + 30);
    const commentLength = central.readUInt16LE(pointer + 32);
    const localHeaderOffset = central.readUInt32LE(pointer + 42);
    const fileName = central
      .subarray(pointer + 46, pointer + 46 + fileNameLength)
      .toString("utf-8");
    const normalizedName = fileName.replaceAll("\\", "/");
    const isManifest =
      normalizedName === "manifest.json" ||
      normalizedName.endsWith("/manifest.json");
    if (isManifest && uncompressedSize <= MAX_MANIFEST_BYTES) {
      return { compressionMethod, compressedSize, localHeaderOffset };
    }
    pointer += 46 + fileNameLength + extraLength + commentLength;
  }
  return undefined;
}

function readLocalEntry(fd, size, entry) {
  const { localHeaderOffset, compressionMethod, compressedSize } = entry;
  // Bound the compressed read for every method, not just stored entries. The
  // size comes from the archive's own central directory, so without this a
  // hostile bundle could declare a multi-gigabyte entry and force that much to
  // be allocated before `maxOutputLength` ever gets a chance to apply. A
  // deflate stream that inflates to at most MAX_MANIFEST_BYTES cannot
  // meaningfully exceed that compressed.
  if (compressedSize > MAX_MANIFEST_BYTES) {
    return undefined;
  }
  const header = readRange(fd, localHeaderOffset, 30);
  if (!header || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    return undefined;
  }
  const fileNameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength;
  if (dataStart + compressedSize > size) {
    return undefined;
  }
  const compressed = readRange(fd, dataStart, compressedSize);
  if (!compressed) {
    return undefined;
  }
  try {
    if (compressionMethod === 0) {
      return compressed.toString("utf-8");
    }
    if (compressionMethod === 8) {
      // Bound the inflated output: the central-directory size field is
      // attacker-controlled, so the real guard is the output length limit.
      return inflateRawSync(compressed, {
        maxOutputLength: MAX_MANIFEST_BYTES,
      }).toString("utf-8");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function addUniqueProperty(properties, name, value) {
  const sanitizedValue = sanitizeBomPropertyValue(name, value);
  if (
    sanitizedValue === undefined ||
    sanitizedValue === null ||
    sanitizedValue === ""
  ) {
    return;
  }
  if (
    properties.some(
      (property) =>
        property.name === name && property.value === String(sanitizedValue),
    )
  ) {
    return;
  }
  properties.push({ name, value: String(sanitizedValue) });
}

function countCollection(value) {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value && typeof value === "object") {
    return Object.keys(value).length;
  }
  return 0;
}

/**
 * Count how many declared user-configuration fields look secret-bearing.
 *
 * The MCPB client injects `user_config` values as environment variables when it
 * launches the bundled server, so secret-typed fields are a credential surface
 * worth surfacing. Only field names and types are inspected; no user-provided
 * values are read or emitted.
 *
 * @param {Object|Array} userConfig Declared user_config block
 * @returns {{ fieldCount: number, secretFieldCount: number }} field counts
 */
function summarizeUserConfig(userConfig) {
  const entries = Array.isArray(userConfig)
    ? userConfig.map((entry) => [entry?.key || entry?.name || "", entry])
    : Object.entries(userConfig || {});
  let secretFieldCount = 0;
  for (const [key, definition] of entries) {
    const type = String(definition?.type || "").toLowerCase();
    const sensitive =
      definition?.sensitive === true ||
      type === "secret" ||
      type === "password" ||
      SECRET_FIELD_NAME_PATTERN.test(String(key));
    if (sensitive) {
      secretFieldCount++;
    }
  }
  return { fieldCount: entries.length, secretFieldCount };
}

/**
 * Count how many precompiled platform binaries a bundle declares across the
 * `server.mcp_config.platform_overrides` / `compatibility.platforms` shapes
 * used by MCPB manifests.
 *
 * @param {Object} manifest Parsed manifest.json
 * @returns {number} platform binary count
 */
function platformBinaryCount(manifest) {
  const overrides =
    manifest?.server?.mcp_config?.platform_overrides ||
    manifest?.server?.platform_overrides;
  if (overrides) {
    return countCollection(overrides);
  }
  const platforms = manifest?.compatibility?.platforms || manifest?.platforms;
  return countCollection(platforms);
}

/**
 * Build a component from a parsed MCPB manifest.
 *
 * @param {string} filePath Bundle path
 * @param {Object} manifest Parsed manifest.json
 * @returns {Object} CycloneDX component
 */
function componentFromManifest(filePath, manifest) {
  const name =
    (typeof manifest?.name === "string" && manifest.name) || basename(filePath);
  const serverType = String(manifest?.server?.type || "").toLowerCase();
  const userConfig = summarizeUserConfig(manifest?.user_config);
  const properties = [
    { name: "internal:SrcFile", value: filePath },
    { name: "cdx:file:kind", value: "mcp-bundle" },
    { name: "cdx:mcp:inventorySource", value: "mcp-bundle" },
    // A bundle ships a whole local server plus its dependencies, so treat it as
    // an install-time supply-chain surface that warrants review.
    { name: "cdx:mcp:reviewNeeded", value: "true" },
  ];
  addUniqueProperty(
    properties,
    "cdx:mcpb:manifestVersion",
    manifest?.manifest_version ? String(manifest.manifest_version) : undefined,
  );
  addUniqueProperty(properties, "cdx:mcpb:serverType", serverType || undefined);
  addUniqueProperty(
    properties,
    "cdx:mcpb:toolCount",
    String(countCollection(manifest?.tools)),
  );
  addUniqueProperty(
    properties,
    "cdx:mcpb:promptCount",
    String(countCollection(manifest?.prompts)),
  );
  addUniqueProperty(
    properties,
    "cdx:mcpb:userConfigFieldCount",
    String(userConfig.fieldCount),
  );
  if (userConfig.secretFieldCount) {
    addUniqueProperty(
      properties,
      "cdx:mcpb:secretFieldCount",
      String(userConfig.secretFieldCount),
    );
    addUniqueProperty(properties, "cdx:mcpb:injectsSecretEnv", "true");
  }
  const binaryCount = platformBinaryCount(manifest);
  if (binaryCount) {
    addUniqueProperty(
      properties,
      "cdx:mcpb:platformBinaryCount",
      String(binaryCount),
    );
  }
  const component = {
    "bom-ref": `urn:mcp:bundle:${sanitizeMcpRefToken(name)}:${sanitizeMcpRefToken(basename(filePath))}`,
    type: "application",
    name,
    properties,
  };
  if (manifest?.version) {
    component.version = String(manifest.version);
  }
  // The description is attacker-controlled free text from an untrusted zip.
  // It is cut first, so the sanitizer never runs over the whole manifest, and
  // at a boundary, so the sanitizer sees every URL and token whole. It is
  // then scanned for hidden Unicode like the sibling manifest/agent parsers.
  if (typeof manifest?.description === "string") {
    const sanitizedDescription = sanitizeBomPropertyValue(
      "description",
      truncateAtWordBoundary(manifest.description, MAX_DESCRIPTION_BYTES),
    );
    if (sanitizedDescription) {
      component.description = String(sanitizedDescription);
    }
    const hiddenUnicodeScan = scanTextForHiddenUnicode(manifest.description, {
      syntax: "text",
    });
    if (hiddenUnicodeScan.hasHiddenUnicode) {
      addUniqueProperty(
        component.properties,
        "cdx:file:hasHiddenUnicode",
        "true",
      );
      addUniqueProperty(
        component.properties,
        "cdx:file:hiddenUnicodeCodePoints",
        hiddenUnicodeScan.codePoints.join(","),
      );
    }
  }
  return component;
}

/**
 * Parser for MCPB / DXT desktop-extension bundles.
 *
 * A bundle is a zip archive carrying a local MCP server, its dependencies, and
 * a `manifest.json`. This parser reads only the manifest to describe the
 * bundled server, the tools/prompts it exposes, the number of precompiled
 * platform binaries, and whether it injects secret-typed configuration values
 * as environment variables. Only regular files inside `context.rootDir`, the
 * scanned root, are opened.
 *
 * @type {{id: string, patterns: string[], parse(files: string[], options?: Object, context?: {rootDir?: string}): {components: Object[]}}}
 */
export const mcpbBundleParser = {
  id: "mcp-bundle",
  patterns: MCPB_BUNDLE_PATTERNS,
  parse(files, _options = {}, context = {}) {
    const components = [];
    for (const filePath of [...new Set(files || [])]) {
      const manifestText = readManifestFromBundle(filePath, context?.rootDir);
      if (!manifestText) {
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(manifestText);
      } catch {
        continue;
      }
      if (!manifest || typeof manifest !== "object") {
        continue;
      }
      components.push(componentFromManifest(filePath, manifest));
    }
    return { components };
  },
};

import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const asarFixtureSourceDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "asar-fixture-app",
);

function align4(value) {
  return value + ((4 - (value % 4)) % 4);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function makeStringPickle(value) {
  const valueBuffer = Buffer.from(value, "utf8");
  const alignedStringLength = align4(valueBuffer.length);
  const payloadLength = 4 + alignedStringLength;
  const buffer = Buffer.alloc(4 + payloadLength);
  buffer.writeUInt32LE(payloadLength, 0);
  buffer.writeInt32LE(valueBuffer.length, 4);
  valueBuffer.copy(buffer, 8);
  return buffer;
}

function makeSizePickle(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32LE(4, 0);
  buffer.writeUInt32LE(value, 4);
  return buffer;
}

function collectFixtureFiles(rootDir, currentDir = rootDir) {
  const files = [];
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFixtureFiles(rootDir, fullPath));
      continue;
    }
    files.push(relative(rootDir, fullPath).replaceAll("\\", "/"));
  }
  return files.sort();
}

function setFixtureTreeEntry(rootNode, entryPath, value) {
  const pathParts = entryPath.split("/");
  let currentNode = rootNode;
  for (const part of pathParts.slice(0, -1)) {
    currentNode[part] = currentNode[part] || { files: {} };
    currentNode = currentNode[part].files;
  }
  currentNode[pathParts[pathParts.length - 1]] = value;
}

export function createAsarFixture(targetPath, options = {}) {
  const {
    corruptIntegrityPaths = [],
    executablePaths = [],
    extraEntries = {},
    symlinks = {},
    unpackedPaths = [],
  } = options;
  const executablePathSet = new Set(executablePaths);
  const unpackedPathSet = new Set(unpackedPaths);
  const corruptIntegrityPathSet = new Set(corruptIntegrityPaths);
  const rootTree = {};
  const packedBuffers = [];
  let nextOffset = 0;
  for (const relativeFilePath of collectFixtureFiles(asarFixtureSourceDir)) {
    const absoluteFilePath = join(asarFixtureSourceDir, relativeFilePath);
    const fileBuffer = readFileSync(absoluteFilePath);
    const computedHash = sha256Hex(fileBuffer);
    const declaredHash = corruptIntegrityPathSet.has(relativeFilePath)
      ? "0".repeat(64)
      : computedHash;
    setFixtureTreeEntry(rootTree, relativeFilePath, {
      executable: executablePathSet.has(relativeFilePath),
      integrity: {
        algorithm: "SHA256",
        blocks: [computedHash],
        blockSize: fileBuffer.length || 1,
        hash: declaredHash,
      },
      size: fileBuffer.length,
      ...(unpackedPathSet.has(relativeFilePath)
        ? { unpacked: true }
        : { offset: String(nextOffset) }),
    });
    if (unpackedPathSet.has(relativeFilePath)) {
      const unpackedTarget = join(
        `${targetPath}.unpacked`,
        ...relativeFilePath.split("/"),
      );
      mkdirSync(dirname(unpackedTarget), { recursive: true });
      copyFileSync(absoluteFilePath, unpackedTarget);
      continue;
    }
    packedBuffers.push(fileBuffer);
    nextOffset += fileBuffer.length;
  }
  for (const [relativeFilePath, entryValue] of Object.entries(extraEntries)) {
    if (entryValue?.link) {
      setFixtureTreeEntry(rootTree, relativeFilePath, { link: entryValue.link });
      continue;
    }
    if (entryValue?.kind === "directory") {
      setFixtureTreeEntry(rootTree, relativeFilePath, { files: {} });
      continue;
    }
    const contentBuffer = Buffer.isBuffer(entryValue?.content)
      ? entryValue.content
      : Buffer.from(entryValue?.content || "", "utf8");
    const computedHash = sha256Hex(contentBuffer);
    setFixtureTreeEntry(rootTree, relativeFilePath, {
      executable: entryValue?.executable === true,
      integrity: {
        algorithm: "SHA256",
        blocks: [computedHash],
        blockSize: contentBuffer.length || 1,
        hash: entryValue?.declaredHash || computedHash,
      },
      size: entryValue?.size ?? contentBuffer.length,
      ...(entryValue?.unpacked === true
        ? { unpacked: true }
        : { offset: String(entryValue?.offset ?? nextOffset) }),
    });
    if (entryValue?.unpacked === true) {
      const unpackedTarget = join(
        `${targetPath}.unpacked`,
        ...relativeFilePath.split("/"),
      );
      mkdirSync(dirname(unpackedTarget), { recursive: true });
      writeFileSync(unpackedTarget, contentBuffer);
      continue;
    }
    packedBuffers.push(contentBuffer);
    nextOffset += contentBuffer.length;
  }
  for (const [linkPath, linkTarget] of Object.entries(symlinks)) {
    setFixtureTreeEntry(rootTree, linkPath, { link: linkTarget });
  }
  const headerPickle = makeStringPickle(JSON.stringify({ files: rootTree }));
  writeFileSync(
    targetPath,
    Buffer.concat([
      makeSizePickle(headerPickle.length),
      headerPickle,
      ...packedBuffers,
    ]),
  );
}

export function writeElectronAsarIntegrityPlist(plistPath, integrityMap) {
  const escapeXml = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  const plistEntries = Object.entries(integrityMap || {})
    .map(
      ([archivePath, record]) => `        <key>${escapeXml(archivePath)}</key>
        <dict>
          <key>algorithm</key>
          <string>${escapeXml(record.algorithm)}</string>
          <key>hash</key>
          <string>${escapeXml(record.hash)}</string>
        </dict>`,
    )
    .join("\n");
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>ElectronAsarIntegrity</key>
    <dict>
${plistEntries}
    </dict>
  </dict>
</plist>
`,
  );
}

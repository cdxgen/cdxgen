import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { auditBom } from "../stages/postgen/auditBom.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { createAsarBom } from "./index.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "asar-fixture-app",
);

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

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

function setArchiveTreeEntry(rootNode, entryPath, value) {
  const pathParts = entryPath.split("/");
  let currentNode = rootNode;
  for (const part of pathParts.slice(0, -1)) {
    currentNode[part] = currentNode[part] || { files: {} };
    currentNode = currentNode[part].files;
  }
  currentNode[pathParts[pathParts.length - 1]] = value;
}

function createAsarFixture(targetPath, options = {}) {
  const {
    corruptIntegrityPaths = [],
    executablePaths = [],
    symlinks = {},
    unpackedPaths = [],
  } = options;
  const executablePathSet = new Set(executablePaths);
  const unpackedPathSet = new Set(unpackedPaths);
  const corruptIntegrityPathSet = new Set(corruptIntegrityPaths);
  const rootTree = {};
  const packedBuffers = [];
  let nextOffset = 0;
  for (const relativeFilePath of collectFixtureFiles(fixtureDir)) {
    const absoluteFilePath = join(fixtureDir, relativeFilePath);
    const fileBuffer = readFileSync(absoluteFilePath);
    const computedHash = sha256Hex(fileBuffer);
    const declaredHash = corruptIntegrityPathSet.has(relativeFilePath)
      ? "0".repeat(64)
      : computedHash;
    setArchiveTreeEntry(rootTree, relativeFilePath, {
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
  for (const [linkPath, linkTarget] of Object.entries(symlinks)) {
    setArchiveTreeEntry(rootTree, linkPath, { link: linkTarget });
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

describe("createAsarBom()", () => {
  it("catalogs ASAR archives, extracts nested npm metadata, and surfaces audit findings", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cdxgen-asar-cli-"));
    const archivePath = join(fixtureRoot, "app.asar");
    createAsarFixture(archivePath, {
      corruptIntegrityPaths: ["config/settings.json"],
      executablePaths: ["scripts/postinstall.js"],
      symlinks: {
        "config-link": "config/settings.json",
      },
      unpackedPaths: ["native/addon.node"],
    });
    try {
      const bomData = await createAsarBom(archivePath, {
        installDeps: false,
        multiProject: false,
        projectType: ["asar"],
        specVersion: 1.7,
      });
      assert.ok(bomData?.bomJson?.components?.length);
      assert.strictEqual(bomData.parentComponent.name, "Sample Electron App");
      assert.strictEqual(
        getProp(bomData.parentComponent, "cdx:asar:hasEval"),
        "true",
      );
      assert.strictEqual(
        getProp(bomData.parentComponent, "cdx:asar:hasDynamicFetch"),
        "true",
      );
      assert.strictEqual(
        getProp(bomData.parentComponent, "cdx:asar:hasNativeAddons"),
        "true",
      );
      const mainFileComponent = bomData.bomJson.components.find(
        (component) => getProp(component, "cdx:asar:path") === "src/main.js",
      );
      assert.ok(mainFileComponent, "expected src/main.js component");
      assert.strictEqual(
        getProp(mainFileComponent, "cdx:asar:js:capability:network"),
        "true",
      );
      const sketchyAddon = bomData.bomJson.components.find(
        (component) => component.name === "sketchy-addon",
      );
      assert.ok(sketchyAddon, "expected extracted npm component");
      assert.ok(
        String(getProp(sketchyAddon, "SrcFile") || "").includes(
          `${archivePath}#/`,
        ),
      );

      const postProcessed = postProcess(bomData, {
        bomAudit: true,
        bomAuditCategories: ["asar-archive"],
        installDeps: false,
        projectType: ["asar"],
        specVersion: 1.7,
      });
      const findings = await auditBom(postProcessed.bomJson, {
        bomAuditCategories: ["asar-archive"],
      });
      assert.ok(
        findings.some((finding) => finding.ruleId === "ASAR-001"),
        "expected ASAR eval/dynamic execution finding",
      );
      assert.ok(
        findings.some((finding) => finding.ruleId === "ASAR-004"),
        "expected embedded npm install-script finding",
      );
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});

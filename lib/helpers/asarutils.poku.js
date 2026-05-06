import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
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

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  cleanupAsarTempDir,
  extractAsarToTempDir,
  listAsarEntries,
  parseAsarArchive,
  rewriteExtractedArchivePaths,
} from "./asarutils.js";

const baseTempDir = mkdtempSync(join(tmpdir(), "cdxgen-asar-poku-"));
const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "asar-fixture-app",
);

process.on("exit", () => {
  rmSync(baseTempDir, { force: true, recursive: true });
});

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

function setTreeEntry(rootNode, entryPath, value) {
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
    const fileEntry = {
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
    };
    setTreeEntry(rootTree, relativeFilePath, fileEntry);
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
    setTreeEntry(rootTree, linkPath, { link: linkTarget });
  }
  const headerPickle = makeStringPickle(JSON.stringify({ files: rootTree }));
  const archiveBuffer = Buffer.concat([
    makeSizePickle(headerPickle.length),
    headerPickle,
    ...packedBuffers,
  ]);
  writeFileSync(targetPath, archiveBuffer);
}

describe("extractAsarToTempDir()", () => {
  it("returns undefined when dry-run blocks ASAR extraction", async () => {
    const safeExtractArchive = sinon.stub().resolves(false);
    const { extractAsarToTempDir: extractAsarToTempDirMocked } = await esmock(
      "./asarutils.js",
      {
        "./utils.js": {
          DEBUG_MODE: false,
          getTmpDir: sinon.stub().returns("/tmp"),
          isDryRun: false,
          recordActivity: sinon.stub(),
          safeCopyFileSync: sinon.stub(),
          safeExtractArchive,
          safeMkdirSync: sinon.stub(),
          safeMkdtempSync: sinon.stub().returns("/tmp/asar-deps-test"),
          safeRmSync: sinon.stub(),
          safeWriteSync: sinon.stub(),
        },
      },
    );

    const extractedDir = await extractAsarToTempDirMocked("/tmp/sample.asar");

    assert.strictEqual(extractedDir, undefined);
    sinon.assert.calledOnce(safeExtractArchive);
  });
});

describe("parseAsarArchive()", () => {
  it("catalogs file inventory, hashes, evidence, and security-sensitive properties", async () => {
    const archivePath = join(baseTempDir, "fixture.asar");
    createAsarFixture(archivePath, {
      corruptIntegrityPaths: ["config/settings.json"],
      executablePaths: ["scripts/postinstall.js"],
      symlinks: {
        "config-link": "config/settings.json",
      },
      unpackedPaths: ["native/addon.node"],
    });

    const analysis = await parseAsarArchive(archivePath, {});
    const entryList = listAsarEntries(archivePath);

    assert.ok(entryList.entries.some((entry) => entry.path === "config-link"));
    assert.strictEqual(analysis.parentComponent.name, "Sample Electron App");
    assert.strictEqual(
      analysis.parentComponent.purl,
      "pkg:npm/sample-electron-app@1.2.3",
    );
    assert.strictEqual(
      analysis.summary.integrityMismatchCount,
      1,
      "expected one mismatched declared integrity hash",
    );
    assert.ok(analysis.summary.capabilities.includes("fileAccess"));
    assert.ok(analysis.summary.capabilities.includes("network"));
    assert.ok(analysis.summary.capabilities.includes("hardware"));
    assert.ok(analysis.summary.capabilities.includes("dynamicFetch"));
    assert.ok(analysis.summary.capabilities.includes("dynamicImport"));
    assert.strictEqual(analysis.summary.hasEval, true);
    const archiveProps = analysis.parentComponent.properties;
    assert.strictEqual(
      archiveProps.find((property) => property.name === "cdx:asar:hasEval")?.value,
      "true",
    );
    assert.strictEqual(
      archiveProps.find(
        (property) => property.name === "cdx:asar:hasNativeAddons",
      )?.value,
      "true",
    );
    assert.strictEqual(
      archiveProps.find(
        (property) => property.name === "cdx:asar:hasIntegrityMismatch",
      )?.value,
      "true",
    );

    const mainFileComponent = analysis.components.find(
      (component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:asar:path" && property.value === "src/main.js",
        ),
    );
    assert.ok(mainFileComponent, "expected src/main.js file component");
    assert.ok(mainFileComponent.hashes?.length, "expected SHA-256 hash");
    assert.strictEqual(
      mainFileComponent.evidence?.occurrences?.[0]?.location,
      `${archivePath}#/src/main.js`,
    );
    assert.strictEqual(
      mainFileComponent.properties.find(
        (property) => property.name === "cdx:asar:js:hasDynamicFetch",
      )?.value,
      "true",
    );
    assert.strictEqual(
      mainFileComponent.properties.find(
        (property) => property.name === "cdx:asar:js:capability:hardware",
      )?.value,
      "true",
    );

    const unpackedComponent = analysis.components.find(
      (component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:asar:path" && property.value === "native/addon.node",
        ),
    );
    assert.ok(unpackedComponent, "expected native addon component");
    assert.strictEqual(
      unpackedComponent.properties.find(
        (property) => property.name === "cdx:asar:unpacked",
      )?.value,
      "true",
    );
  });

  it("extracts ASAR archives and rewrites extracted source paths back to archive paths", async () => {
    const archivePath = join(baseTempDir, "fixture-extract.asar");
    createAsarFixture(archivePath, {
      unpackedPaths: ["native/addon.node"],
    });

    const extractedDir = await extractAsarToTempDir(archivePath);
    assert.ok(extractedDir, "expected extraction temp dir");
    assert.ok(existsSync(join(extractedDir, "src", "main.js")));
    assert.ok(existsSync(join(extractedDir, "native", "addon.node")));

    const component = {
      evidence: {
        identity: {
          methods: [
            {
              confidence: 1,
              technique: "manifest-analysis",
              value: join(extractedDir, "package.json"),
            },
          ],
        },
        occurrences: [
          {
            location: join(extractedDir, "src", "main.js"),
          },
        ],
      },
      properties: [
        {
          name: "SrcFile",
          value: join(extractedDir, "node_modules", "sketchy-addon", "package.json"),
        },
      ],
    };
    rewriteExtractedArchivePaths(component, extractedDir, archivePath);
    assert.strictEqual(
      component.properties[0].value,
      `${archivePath}#/node_modules/sketchy-addon/package.json`,
    );
    assert.strictEqual(
      component.evidence.identity.methods[0].value,
      `${archivePath}#/package.json`,
    );
    assert.strictEqual(
      component.evidence.occurrences[0].location,
      `${archivePath}#/src/main.js`,
    );

    cleanupAsarTempDir(extractedDir);
    assert.ok(!existsSync(extractedDir), "expected extracted temp dir cleanup");
  });
});

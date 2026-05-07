import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  createAsarFixture,
  writeElectronAsarIntegrityPlist,
} from "../../test/helpers/asar-fixture-builder.js";
import {
  cleanupAsarTempDir,
  extractAsarToTempDir,
  listAsarEntries,
  parseAsarArchive,
  readAsarArchiveHeaderSync,
  rewriteExtractedArchivePaths,
} from "./asarutils.js";
import { safeRmSync } from "./utils.js";

const baseTempDir = mkdtempSync(join(tmpdir(), "cdxgen-asar-poku-"));

process.on("exit", () => {
  safeRmSync(baseTempDir, { force: true, recursive: true });
});

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
      archiveProps.find((property) => property.name === "cdx:asar:hasEval")
        ?.value,
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

    const mainFileComponent = analysis.components.find((component) =>
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

    const unpackedComponent = analysis.components.find((component) =>
      component.properties?.some(
        (property) =>
          property.name === "cdx:asar:path" &&
          property.value === "native/addon.node",
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
          value: join(
            extractedDir,
            "node_modules",
            "sketchy-addon",
            "package.json",
          ),
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

  it("verifies Electron ASAR signing metadata and emits a crypto component", async () => {
    const appDir = join(baseTempDir, "Signed.app");
    const archivePath = join(
      appDir,
      "Contents",
      "Resources",
      "app & signed.asar",
    );
    mkdirSync(join(appDir, "Contents", "Resources"), { recursive: true });
    createAsarFixture(archivePath);
    const { headerString } = readAsarArchiveHeaderSync(archivePath);
    const headerHash = createHash("sha256")
      .update(headerString, "utf8")
      .digest("hex");
    writeElectronAsarIntegrityPlist(join(appDir, "Contents", "Info.plist"), {
      "Resources/app & signed.asar": {
        algorithm: "SHA256",
        hash: headerHash,
      },
    });

    const analysis = await parseAsarArchive(archivePath, { specVersion: 1.7 });
    const signingComponent = analysis.components.find(
      (component) =>
        component.type === "cryptographic-asset" &&
        component.properties?.some(
          (property) =>
            property.name === "cdx:asar:signingVerified" &&
            property.value === "true",
        ),
    );
    assert.strictEqual(
      analysis.parentComponent.properties.find(
        (property) => property.name === "cdx:asar:hasSigningMetadata",
      )?.value,
      "true",
    );
    assert.strictEqual(
      analysis.parentComponent.properties.find(
        (property) => property.name === "cdx:asar:signingVerified",
      )?.value,
      "true",
    );
    assert.strictEqual(
      analysis.parentComponent.properties.find(
        (property) => property.name === "cdx:asar:signingScope",
      )?.value,
      "header-only",
    );
    assert.ok(signingComponent, "expected ASAR signing crypto component");
    assert.strictEqual(
      signingComponent.properties.find(
        (property) => property.name === "cdx:asar:signingScope",
      )?.value,
      "header-only",
    );
    assert.ok(
      analysis.dependencies.some(
        (dependency) =>
          dependency.ref === analysis.parentComponent["bom-ref"] &&
          dependency.dependsOn.includes(signingComponent["bom-ref"]),
      ),
      "expected parent archive to depend on the signing component",
    );
  });

  it("rejects ASAR headers with oversized file entries", async () => {
    const archivePath = join(baseTempDir, "fixture-oversized.asar");
    createAsarFixture(archivePath, {
      extraEntries: {
        "huge.bin": {
          content: "x",
          size: 256 * 1024 * 1024 + 1,
        },
      },
    });

    await assert.rejects(
      () => parseAsarArchive(archivePath, {}),
      /Invalid ASAR file entry/,
    );
  });

  it("rejects ASAR entries with offsets beyond the safe read limit", async () => {
    const archivePath = join(baseTempDir, "fixture-offset.asar");
    createAsarFixture(archivePath, {
      extraEntries: {
        "too-far.bin": {
          content: "x",
          offset: Number.MAX_SAFE_INTEGER + 10,
          size: 1,
        },
      },
    });

    await assert.rejects(
      () => parseAsarArchive(archivePath, {}),
      /offset exceeds the safe read limit/,
    );
  });

  it("rejects ASAR headers with excessive nesting depth", async () => {
    const archivePath = join(baseTempDir, "fixture-deep.asar");
    const deeplyNestedPath = `${Array.from({ length: 260 }, (_, index) => `d${index}`).join("/")}/payload.txt`;
    createAsarFixture(archivePath, {
      extraEntries: {
        [deeplyNestedPath]: {
          content: "payload",
        },
      },
    });

    await assert.rejects(
      () => parseAsarArchive(archivePath, {}),
      /nesting exceeds 256 levels/,
    );
  });

  it("rejects symlinks that escape the extraction root", async () => {
    const archivePath = join(baseTempDir, "fixture-link-escape.asar");
    createAsarFixture(archivePath, {
      symlinks: {
        "escape-link": "../../outside.txt",
      },
    });

    const extractedDir = await extractAsarToTempDir(archivePath);
    assert.strictEqual(extractedDir, undefined);
  });

  it("rejects circular symlink chains during extraction", async () => {
    const archivePath = join(baseTempDir, "fixture-link-cycle.asar");
    createAsarFixture(archivePath, {
      symlinks: {
        a: "b",
        b: "a",
      },
    });

    const extractedDir = await extractAsarToTempDir(archivePath);
    assert.strictEqual(extractedDir, undefined);
  });
});

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import {
  createAsarFixture,
  writeElectronAsarIntegrityPlist,
} from "../../test/helpers/asar-fixture-builder.js";
import { readAsarArchiveHeaderSync } from "../helpers/asarutils.js";
import { auditBom } from "../stages/postgen/auditBom.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { validateBom } from "../validator/bomValidator.js";
import { createAsarBom } from "./index.js";

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

if (process.platform !== "win32") {
  describe("createAsarBom()", () => {
    it("catalogs ASAR archives, extracts nested npm metadata, and surfaces audit findings", async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "cdxgen-asar-cli-"));
      const archivePath = join(fixtureRoot, "app.asar");
      createAsarFixture(archivePath, {
        corruptIntegrityPaths: ["config/settings.json"],
        executablePaths: ["scripts/postinstall.js"],
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

    it("scans directories containing multiple ASAR archives", async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "cdxgen-asar-dir-"));
      const firstArchivePath = join(fixtureRoot, "app-one.asar");
      const secondArchivePath = join(fixtureRoot, "nested", "app-two.asar");
      mkdirSync(join(fixtureRoot, "nested"), { recursive: true });
      createAsarFixture(firstArchivePath, {
        extraEntries: {
          "src/one.js": { content: "export const one = 1;\n" },
        },
      });
      createAsarFixture(secondArchivePath, {
        extraEntries: {
          "package.json": {
            content: JSON.stringify({
              name: "sample-electron-app-two",
              version: "2.0.0",
              main: "src/two.js",
            }),
          },
          "src/two.js": { content: "export const two = 2;\n" },
        },
      });
      try {
        const bomData = await createAsarBom(fixtureRoot, {
          installDeps: false,
          multiProject: true,
          projectType: ["asar"],
          specVersion: 1.7,
        });
        const archiveComponents = (bomData.bomJson?.components || []).filter(
          (component) => getProp(component, "cdx:file:kind") === "asar-archive",
        );
        assert.strictEqual(archiveComponents.length, 2);
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });

    it("keeps distinct nested ASAR archives with different virtual paths", async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "cdxgen-asar-case-"));
      const outerArchivePath = join(fixtureRoot, "outer.asar");
      const firstNestedArchivePath = join(fixtureRoot, "first-nested.asar");
      const secondNestedArchivePath = join(fixtureRoot, "second-nested.asar");
      createAsarFixture(firstNestedArchivePath);
      createAsarFixture(secondNestedArchivePath, {
        extraEntries: {
          "package.json": {
            content: JSON.stringify({
              name: "sample-electron-app-upper",
              version: "4.5.6",
              main: "src/main.js",
            }),
          },
        },
      });
      createAsarFixture(outerArchivePath, {
        extraEntries: {
          "nested/first/core.asar": {
            content: readFileSync(firstNestedArchivePath),
          },
          "nested/second/core.asar": {
            content: readFileSync(secondNestedArchivePath),
          },
        },
      });
      try {
        const bomData = await createAsarBom(outerArchivePath, {
          installDeps: false,
          multiProject: false,
          projectType: ["asar"],
          specVersion: 1.7,
        });
        const nestedArchiveComponents = (
          bomData.bomJson?.components || []
        ).filter(
          (component) =>
            getProp(component, "cdx:file:kind") === "asar-archive" &&
            String(getProp(component, "SrcFile") || "").startsWith(
              `${outerArchivePath}#/nested/`,
            ),
        );
        assert.strictEqual(nestedArchiveComponents.length, 2);
        assert.ok(
          nestedArchiveComponents.some(
            (component) =>
              getProp(component, "SrcFile") ===
              `${outerArchivePath}#/nested/first/core.asar`,
          ),
        );
        assert.ok(
          nestedArchiveComponents.some(
            (component) =>
              getProp(component, "SrcFile") ===
              `${outerArchivePath}#/nested/second/core.asar`,
          ),
        );
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });

    it("recursively scans nested ASAR archives and rewrites nested evidence paths", async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "cdxgen-asar-nested-"));
      const archivePath = join(fixtureRoot, "outer.asar");
      const nestedArchivePath = join(fixtureRoot, "inner.asar");
      createAsarFixture(nestedArchivePath, {
        extraEntries: {
          "node_modules/inner-addon/package.json": {
            content: JSON.stringify({
              name: "inner-addon",
              version: "1.0.0",
            }),
          },
          "package-lock.json": {
            content: JSON.stringify({
              lockfileVersion: 3,
              name: "inner-electron-app",
              packages: {
                "": {
                  dependencies: {
                    "inner-addon": "1.0.0",
                  },
                  name: "inner-electron-app",
                  version: "9.9.9",
                },
                "node_modules/inner-addon": {
                  name: "inner-addon",
                  version: "1.0.0",
                },
              },
            }),
          },
          "package.json": {
            content: JSON.stringify({
              dependencies: {
                "inner-addon": "1.0.0",
              },
              name: "inner-electron-app",
              version: "9.9.9",
              main: "src/main.js",
            }),
          },
        },
      });
      createAsarFixture(archivePath, {
        extraEntries: {
          "nested/core.asar": {
            content: readFileSync(nestedArchivePath),
          },
        },
      });
      try {
        const bomData = await createAsarBom(archivePath, {
          installDeps: false,
          multiProject: false,
          projectType: ["asar"],
          specVersion: 1.7,
        });
        const nestedArchiveComponent = bomData.bomJson.components.find(
          (component) =>
            getProp(component, "cdx:file:kind") === "asar-archive" &&
            getProp(component, "SrcFile") ===
              `${archivePath}#/nested/core.asar`,
        );
        const nestedMainFileComponent = bomData.bomJson.components.find(
          (component) =>
            getProp(component, "cdx:asar:path") === "src/main.js" &&
            component.evidence?.occurrences?.some(
              (occurrence) =>
                occurrence.location ===
                `${archivePath}#/nested/core.asar#/src/main.js`,
            ),
        );
        const nestedNpmComponent = bomData.bomJson.components.find(
          (component) =>
            component.name === "inner-addon" &&
            String(getProp(component, "SrcFile") || "").startsWith(
              `${archivePath}#/nested/core.asar#/`,
            ),
        );
        assert.ok(nestedArchiveComponent, "expected nested archive component");
        assert.ok(
          nestedMainFileComponent,
          "expected nested archive file inventory component",
        );
        assert.ok(nestedNpmComponent, "expected nested archive npm component");
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });

    it("produces a schema-valid BOM with ASAR signing crypto components", async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "cdxgen-asar-signed-"));
      const appDir = join(fixtureRoot, "Signed.app");
      const archivePath = join(appDir, "Contents", "Resources", "app.asar");
      mkdirSync(join(appDir, "Contents", "Resources"), { recursive: true });
      createAsarFixture(archivePath);
      const { headerString } = readAsarArchiveHeaderSync(archivePath);
      const headerHash = createHash("sha256")
        .update(headerString, "utf8")
        .digest("hex");
      writeElectronAsarIntegrityPlist(join(appDir, "Contents", "Info.plist"), {
        "Resources/app.asar": {
          algorithm: "SHA256",
          hash: headerHash,
        },
      });
      try {
        const bomData = await createAsarBom(archivePath, {
          installDeps: false,
          multiProject: false,
          projectType: ["asar"],
          specVersion: 1.7,
        });
        const postProcessed = postProcess(bomData, {
          installDeps: false,
          projectType: ["asar"],
          specVersion: 1.7,
        });
        assert.strictEqual(validateBom(postProcessed.bomJson), true);
        assert.ok(
          postProcessed.bomJson.components.some(
            (component) =>
              component.type === "cryptographic-asset" &&
              getProp(component, "cdx:asar:signingVerified") === "true",
          ),
          "expected a verified ASAR signing crypto component",
        );
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });
  });
}

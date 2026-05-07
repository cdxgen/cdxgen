import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { createAsarFixture } from "../../test/helpers/asar-fixture-builder.js";
import { auditBom } from "../stages/postgen/auditBom.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { createAsarBom } from "./index.js";

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
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
});

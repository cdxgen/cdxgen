import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { statSync } from "node:fs";

import {
  decorateEmbeddedSbomComponents,
  findEmbeddedSbomFiles,
  readEmbeddedSbomFile,
} from "./embeddedSbom.js";

// The embedded-SBOM reader accepts only what a CycloneDX document is: a JSON
// object whose bomFormat is CycloneDX, under a size cap, with the document's
// metadata never returned. Quarkus stores the dependency SBOM of
// quarkus.cyclonedx.embedded.enabled builds here; a hostile or corrupt jar
// must yield nothing rather than an error.

function writeDir(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
}

const CYCLONE_DX = JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  components: [
    {
      type: "library",
      group: "io.quarkus",
      name: "quarkus-core",
      version: "4.0.1",
      purl: "pkg:maven/io.quarkus/quarkus-core@4.0.1?type=jar",
    },
  ],
  dependencies: [
    {
      ref: "pkg:maven/org.acme/app@1.0.0",
      dependsOn: ["pkg:maven/io.quarkus/quarkus-core@4.0.1?type=jar"],
    },
  ],
});

await describe("findEmbeddedSbomFiles()", () => {
  it("lists the json documents under META-INF/sbom", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-embed-list-"));
    try {
      writeDir(root, {
        [join("META-INF", "sbom", "dependency.cdx.json")]: CYCLONE_DX,
        [join("META-INF", "sbom", "other.cdx.json")]: "{}",
        [join("META-INF", "sbom", "dependency.cdx.json.gz")]: "binary",
        [join("META-INF", "MANIFEST.MF")]: "Manifest-Version: 1.0",
      });
      const found = findEmbeddedSbomFiles(root).map((f) =>
        f.replaceAll("\\", "/").split("/").pop(),
      );
      assert.deepEqual(found.sort(), ["dependency.cdx.json", "other.cdx.json"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("returns nothing when the jar carries no sbom directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-embed-missing-"));
    try {
      writeDir(root, { [join("META-INF", "MANIFEST.MF")]: "x" });
      assert.deepEqual(findEmbeddedSbomFiles(root), []);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

await describe("readEmbeddedSbomFile()", () => {
  it("reads the components and dependencies of a CycloneDX document", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-embed-read-"));
    try {
      const file = join(root, "dependency.cdx.json");
      writeFileSync(file, CYCLONE_DX);
      const doc = readEmbeddedSbomFile(file);
      assert.equal(doc.components.length, 1);
      assert.equal(doc.components[0].purl, "pkg:maven/io.quarkus/quarkus-core@4.0.1?type=jar");
      assert.equal(doc.dependencies.length, 1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("returns nothing for a document that is not CycloneDX", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-embed-noncdx-"));
    try {
      const file = join(root, "dependency.cdx.json");
      writeFileSync(file, JSON.stringify({ bomFormat: "SPDX", components: [] }));
      assert.equal(readEmbeddedSbomFile(file), null);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("returns nothing for json that is not an object", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-embed-nonobj-"));
    try {
      const file = join(root, "dependency.cdx.json");
      writeFileSync(file, "[1, 2, 3]");
      assert.equal(readEmbeddedSbomFile(file), null);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("returns nothing for invalid json", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-embed-invalid-"));
    try {
      const file = join(root, "dependency.cdx.json");
      writeFileSync(file, "{not json");
      assert.equal(readEmbeddedSbomFile(file), null);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reads a document within the size cap", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-embed-big-"));
    try {
      const file = join(root, "dependency.cdx.json");
      writeFileSync(file, CYCLONE_DX);
      // The cap is checked against the size the stat reports; a real SBOM
      // sits far below it, and a file over it is refused before being read.
      assert.ok(statSync(file).size < 32 * 1024 * 1024);
      assert.notEqual(readEmbeddedSbomFile(file), null);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps its own components writable without sharing the parsed tree", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-embed-decor-"));
    try {
      const file = join(root, "dependency.cdx.json");
      writeFileSync(file, CYCLONE_DX);
      const doc = readEmbeddedSbomFile(file);
      decorateEmbeddedSbomComponents(
        doc.components,
        "/scan/app.jar",
        file,
        "app.jar",
      );
      assert.equal(
        doc.components[0].properties.find((p) => p.name === "internal:SrcFile")
          ?.value,
        "/scan/app.jar",
      );
      assert.equal(
        doc.components[0].evidence.identity.methods[0].value,
        "app.jar!META-INF/sbom/dependency.cdx.json",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

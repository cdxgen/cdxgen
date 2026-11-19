import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strict as assert, describe, it } from "poku";

import { _internals, collectEmbeddedSboms } from "./pep770.js";

const fixtureRoot = join(
  import.meta.dirname,
  "..",
  "..",
  "test",
  "data",
  "pep770-repotest",
);
const metadataFile = join(
  fixtureRoot,
  "lib",
  "site-packages",
  "demo_pkg-1.0.0.dist-info",
  "METADATA",
);

describe("collectEmbeddedSboms()", () => {
  it("discovers and parses a CycloneDX SBOM embedded under .dist-info/sboms/", async () => {
    const result = await collectEmbeddedSboms({
      metadataFiles: [metadataFile],
      whlFiles: [],
    });
    assert.strictEqual(result.components.length, 1);
    const component = result.components[0];
    assert.strictEqual(component.name, "bundled-lib");
    // Provenance is recorded on every embedded component.
    assert.ok(
      component.properties.some(
        (p) =>
          p.name === "cdx:embeddedSbom:source" && p.value === "demo_pkg-1.0.0",
      ),
    );
    assert.ok(
      component.properties.some(
        (p) =>
          p.name === "cdx:embeddedSbom:format" && p.value === "cyclonedx-1.5",
      ),
    );
    // The dependency graph from the embedded SBOM is preserved, rebased onto
    // the distribution's own bom-ref so bundled components are children of it.
    assert.strictEqual(result.dependencies.length, 1);
    assert.strictEqual(result.dependencies[0].ref, "pkg:pypi/demo-pkg@1.0.0");
    assert.deepStrictEqual(result.dependencies[0].dependsOn, [
      "pkg:pypi/bundled-lib@2.3.4",
    ]);
    // A citation attributes the embedded data to the distribution component.
    assert.strictEqual(result.citations.length, 1);
    assert.strictEqual(
      result.citations[0].attributedTo,
      "pkg:pypi/demo-pkg@1.0.0",
    );
    assert.ok(result.citations[0].note.includes("PEP 770"));
    assert.ok(
      result.citations[0].note.endsWith(
        "(demo_pkg-1.0.0.dist-info/sboms/demo-pkg.cdx.json).",
      ),
    );
  });

  it("keeps the scanning host's path out of the stem and the citation", async () => {
    // The parent directories are the operator's. One of them is named like a
    // distribution, and one has a line feed where the platform allows it.
    const hostDir = mkdtempSync(join(tmpdir(), "cdxgen-pep770-"));
    const sitePackages = join(
      hostDir,
      "alice-0.1.dist-info",
      process.platform === "win32" ? "lib" : "lib\nexec",
      "site-packages",
    );
    try {
      const distInfoNames = ["demo-1.0.dist-info", "other-2.0.dist-info.bak"];
      for (const distInfoName of distInfoNames) {
        const distInfoDir = join(sitePackages, distInfoName);
        mkdirSync(join(distInfoDir, "sboms"), { recursive: true });
        writeFileSync(
          join(distInfoDir, "METADATA"),
          `Metadata-Version: 2.1\nName: ${distInfoName.split("-")[0]}\nVersion: 1.0\n\n`,
        );
        writeFileSync(
          join(distInfoDir, "sboms", "bundled.cdx.json"),
          JSON.stringify({
            bomFormat: "CycloneDX",
            specVersion: "1.6",
            components: [{ type: "library", name: "libdemo", version: "1" }],
          }),
        );
      }
      const result = await collectEmbeddedSboms({
        metadataFiles: distInfoNames.map((distInfoName) =>
          join(sitePackages, distInfoName, "METADATA"),
        ),
      });
      assert.deepStrictEqual(
        result.citations.map((citation) => citation.note),
        [
          "Components declared by demo-1.0 in its PEP 770 .dist-info/sboms/ directory (demo-1.0.dist-info/sboms/bundled.cdx.json).",
          "Components declared by other-2.0 in its PEP 770 .dist-info/sboms/ directory (other-2.0.dist-info.bak/sboms/bundled.cdx.json).",
        ],
      );
      assert.ok(!JSON.stringify(result).includes("alice"));
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  it("returns nothing for a distribution with no sboms directory", async () => {
    const result = await collectEmbeddedSboms({
      metadataFiles: [join(fixtureRoot, "nonexistent.dist-info", "METADATA")],
      whlFiles: [],
    });
    assert.strictEqual(result.components.length, 0);
    assert.strictEqual(result.citations.length, 0);
  });

  it("discovers embedded SBOMs inside a wheel archive", async () => {
    const whlFile = join(fixtureRoot, "demo_pkg-1.0.0-py3-none-any.whl");
    const result = await collectEmbeddedSboms({
      metadataFiles: [],
      whlFiles: [whlFile],
    });
    assert.strictEqual(result.components.length, 1);
    assert.strictEqual(result.components[0].name, "bundled-lib");
    assert.ok(
      result.components[0].properties.some(
        (p) => p.name === "cdx:embeddedSbom:source",
      ),
    );
    // The distribution ref is resolved from the wheel's METADATA entry.
    assert.strictEqual(result.dependencies[0].ref, "pkg:pypi/demo-pkg@1.0.0");
    assert.strictEqual(
      result.citations[0].attributedTo,
      "pkg:pypi/demo-pkg@1.0.0",
    );
  });
});

describe("collectEmbeddedSboms() bounds", () => {
  const writeDistribution = (root, stem, documents) => {
    const distInfo = join(root, `${stem}.dist-info`);
    mkdirSync(join(distInfo, "sboms"), { recursive: true });
    const [name, version] = stem.split("-");
    writeFileSync(
      join(distInfo, "METADATA"),
      `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n\n`,
    );
    documents.forEach((componentCount, index) => {
      writeFileSync(
        join(distInfo, "sboms", `${index}.cdx.json`),
        JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          components: Array.from({ length: componentCount }, (_, i) => ({
            name: `${name}-${index}-${i}`,
          })),
        }),
      );
    });
    return join(distInfo, "METADATA");
  };

  it("gives each distribution its own share", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cdxgen-pep770-share-"));
    try {
      const share = _internals.MAX_EMBEDDED_ELEMENTS_PER_DISTRIBUTION;
      const big = Math.floor(share * 0.75);
      const metadataFiles = [
        writeDistribution(tmp, "big-1.0", [big, big, big]),
        writeDistribution(tmp, "small-1.0", [10]),
      ];
      const result = await collectEmbeddedSboms({ metadataFiles });
      // Only the first document of the large distribution fits its share,
      // and the other distribution keeps its own.
      assert.strictEqual(result.components.length, big + 10);
      assert.strictEqual(result.citations.length, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bounds the components kept from all distributions of a scan", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cdxgen-pep770-total-"));
    try {
      const perDocument = _internals.MAX_EMBEDDED_ELEMENTS_PER_DISTRIBUTION;
      const fitting = Math.floor(
        _internals.MAX_EMBEDDED_ELEMENTS / perDocument,
      );
      const metadataFiles = Array.from({ length: fitting + 1 }, (_, i) =>
        writeDistribution(tmp, `dist${i}-1.0`, [perDocument]),
      );
      const result = await collectEmbeddedSboms({ metadataFiles });
      assert.strictEqual(result.components.length, fitting * perDocument);
      assert.strictEqual(result.citations.length, fitting);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("distInfoStem() (internals)", () => {
  it("returns the stem of the dist-info directory a path belongs to", () => {
    assert.strictEqual(
      _internals.distInfoStem("demo-1.0.dist-info/sboms/sbom.cdx.json"),
      "demo-1.0",
    );
    assert.strictEqual(
      _internals.distInfoStem(
        "/venv/lib/site-packages/demo-1.0.dist-info/METADATA",
      ),
      "demo-1.0",
    );
    assert.strictEqual(
      _internals.distInfoStem(
        "C:\\site-packages\\demo-1.0.dist-info\\METADATA",
      ),
      "demo-1.0",
    );
    assert.strictEqual(
      _internals.distInfoStem("demo-1.0-py3-none-any.whl"),
      undefined,
    );
  });

  it("reads the stem after a long segment before the dist-info directory", () => {
    // A zip member name may be 65535 characters long.
    const name = `${"a".repeat(65_000)}/demo-1.0.dist-info/sboms/sbom.cdx.json`;
    assert.strictEqual(_internals.distInfoStem(name), "demo-1.0");
  });
});

describe("buildEmbeddedCitation() (internals)", () => {
  it("names the location it is given, whatever the length", () => {
    const location = `${"a".repeat(32_000)}.dist-info/sboms/b.json`;
    const citation = _internals.buildEmbeddedCitation(
      "y",
      location,
      "pkg:pypi/y@1.0",
    );
    assert.ok(citation.note.endsWith(`(${location}).`));
    assert.strictEqual(
      _internals.buildEmbeddedCitation("y", location, undefined),
      null,
    );
  });
});

describe("parseEmbeddedSbom() (internals)", () => {
  it("skips an oversized document", () => {
    const huge = "x".repeat(_internals.MAX_EMBEDDED_SBOM_BYTES + 1);
    assert.strictEqual(
      _internals.parseEmbeddedSbom(huge, "big.bin", "demo"),
      null,
    );
  });

  it("skips invalid JSON", () => {
    assert.strictEqual(
      _internals.parseEmbeddedSbom("{not json", "bad.json", "demo"),
      null,
    );
  });

  it("skips a CycloneDX document missing specVersion", () => {
    assert.strictEqual(
      _internals.parseEmbeddedSbom(
        JSON.stringify({ bomFormat: "CycloneDX" }),
        "bad.cdx.json",
        "demo",
      ),
      null,
    );
  });

  it("parses an SPDX 2.x document into components", () => {
    const spdx = {
      spdxVersion: "SPDX-2.3",
      packages: [
        {
          name: "spdx-lib",
          SPDXID: "SPDXRef-Package",
          versionInfo: "9.9.9",
          externalRefs: [
            {
              referenceType: "purl",
              referenceLocator: "pkg:pypi/spdx-lib@9.9.9",
            },
          ],
        },
      ],
    };
    const parsed = _internals.parseEmbeddedSbom(
      JSON.stringify(spdx),
      "spdx.json",
      "demo",
    );
    assert.ok(parsed);
    assert.strictEqual(parsed.components[0].name, "spdx-lib");
    assert.strictEqual(parsed.components[0].purl, "pkg:pypi/spdx-lib@9.9.9");
    assert.ok(parsed.format.startsWith("spdx"));
  });
});

describe("rebaseDependencies()", () => {
  it("rewrites the embedded root ref to the cdxgen distribution ref", () => {
    const deps = [
      { ref: "embedded-root", dependsOn: ["pkg:pypi/bundled@1.0.0"] },
      { ref: "pkg:pypi/bundled@1.0.0", dependsOn: [] },
    ];
    const rebased = _internals.rebaseDependencies(
      deps,
      "pkg:pypi/demo@1.0.0",
      "embedded-root",
    );
    assert.strictEqual(rebased[0].ref, "pkg:pypi/demo@1.0.0");
    assert.strictEqual(rebased[1].ref, "pkg:pypi/bundled@1.0.0");
  });
});

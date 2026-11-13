import { strict as assert, describe, it } from "poku";

import {
  MAX_SBOM_DOCUMENT_BYTES,
  parseSbomDocument,
  repairPurl,
  tagSbomComponents,
} from "./sbomDocument.js";

describe("parseSbomDocument()", () => {
  it("reads components, dependencies and the root ref from CycloneDX", () => {
    const parsed = parseSbomDocument(
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        metadata: { component: { "bom-ref": "root-ref", name: "dist" } },
        components: [{ name: "bundled", "bom-ref": "bundled-ref" }],
        dependencies: [{ ref: "root-ref", dependsOn: ["bundled-ref"] }],
      }),
      { source: "wheel" },
    );
    assert.strictEqual(parsed.format, "cyclonedx-1.6");
    assert.strictEqual(parsed.rootRef, "root-ref");
    assert.strictEqual(parsed.components.length, 1);
    assert.deepStrictEqual(parsed.dependencies[0].dependsOn, ["bundled-ref"]);
  });

  it("reads packages out of SPDX 2.x JSON", () => {
    const parsed = parseSbomDocument(
      JSON.stringify({
        spdxVersion: "SPDX-2.3",
        packages: [
          {
            name: "libfoo",
            SPDXID: "SPDXRef-libfoo",
            versionInfo: "1.2.3",
            externalRefs: [
              {
                referenceType: "purl",
                referenceLocator: "pkg:generic/libfoo@1.2.3",
              },
            ],
          },
        ],
      }),
      { source: "sboms/libfoo.spdx.json" },
    );
    assert.strictEqual(parsed.format, "spdx-SPDX-2.3");
    assert.strictEqual(parsed.components[0].purl, "pkg:generic/libfoo@1.2.3");
    assert.strictEqual(
      parsed.components[0]["bom-ref"],
      "pkg:generic/libfoo@1.2.3",
    );
  });

  it("rejects a document that is not JSON, not an SBOM, or empty", () => {
    assert.strictEqual(parseSbomDocument("not json", {}), null);
    assert.strictEqual(parseSbomDocument("", {}), null);
    assert.strictEqual(parseSbomDocument(JSON.stringify({ a: 1 }), {}), null);
    // CycloneDX without a specVersion is unusable, however well-formed.
    assert.strictEqual(
      parseSbomDocument(
        JSON.stringify({ bomFormat: "CycloneDX", components: [{ name: "x" }] }),
        {},
      ),
      null,
    );
  });

  it("refuses a document over the size bound instead of parsing it", () => {
    const oversized = `{"bomFormat":"CycloneDX","specVersion":"1.6","note":"${"x".repeat(
      MAX_SBOM_DOCUMENT_BYTES,
    )}"}`;
    assert.strictEqual(parseSbomDocument(oversized, { source: "big" }), null);
  });

  it("bounds the format label the document names for itself", () => {
    // The label lands on every component, so a long version must not.
    const parsed = parseSbomDocument(
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6".padEnd(10000, "x"),
        components: [{ name: "bundled" }],
      }),
      { source: "wheel" },
    );
    assert.ok(parsed.format.startsWith("cyclonedx-1.6"));
    assert.ok(parsed.format.length <= "cyclonedx-".length + 32);
    const spdx = parseSbomDocument(
      JSON.stringify({
        spdxVersion: "SPDX-2.3".padEnd(10000, "x"),
        packages: [{ name: "bundled" }],
      }),
      { source: "wheel" },
    );
    assert.ok(spdx.format.startsWith("spdx-SPDX-2.3"));
    assert.ok(spdx.format.length <= "spdx-".length + 32);
  });
});

describe("credentials in a third-party document", () => {
  const secrets = [
    "PURL-SECRET",
    "REF-SECRET",
    "VCS-SECRET",
    "PROP-SECRET",
    "COMMIT-SECRET",
    "NESTED-SECRET",
    "ROOT-SECRET",
    "SIGNED-SECRET",
  ];
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: {
      component: {
        "bom-ref": "https://ci:ROOT-SECRET@build.example/acme@2.1.0",
        name: "acme",
      },
    },
    components: [
      {
        type: "library",
        name: "libjpeg-turbo",
        version: "3.0.1",
        author: "The libjpeg-turbo authors",
        purl: "pkg:generic/libjpeg-turbo@3.0.1?download_url=https://ci-bot:PURL-SECRET@artifacts.example.com/src/libjpeg-turbo-3.0.1.tar.gz",
        "bom-ref":
          "pkg:generic/libjpeg-turbo@3.0.1?download_url=https://ci-bot:REF-SECRET@artifacts.example.com/src/libjpeg-turbo-3.0.1.tar.gz",
        externalReferences: [
          {
            type: "vcs",
            url: "https://x-access-token:VCS-SECRET@git.example.com/acme/libjpeg-turbo.git",
          },
          {
            type: "distribution",
            url: "https://bucket.example.com/z.tgz?X-Amz-Signature=SIGNED-SECRET&X-Amz-Expires=60",
          },
        ],
        properties: [
          {
            name: "build:source",
            value:
              "fetched from https://ci:PROP-SECRET@mirror.example.com/x.tgz (cached)",
          },
        ],
        pedigree: {
          commits: [
            {
              uid: "abc",
              url: "https://bot:COMMIT-SECRET@git.example.com/acme/x/commit/abc",
            },
          ],
        },
        components: [
          {
            type: "file",
            name: "nested",
            purl: "pkg:generic/nested@1?download_url=https%3A%2F%2Fci%3ANESTED-SECRET%40host.example%2Fn.tgz",
          },
        ],
      },
    ],
    dependencies: [
      {
        ref: "https://ci:ROOT-SECRET@build.example/acme@2.1.0",
        dependsOn: [
          "pkg:generic/libjpeg-turbo@3.0.1?download_url=https://ci-bot:REF-SECRET@artifacts.example.com/src/libjpeg-turbo-3.0.1.tar.gz",
        ],
      },
    ],
  };

  it("removes URL credentials from every field and keeps refs consistent", () => {
    const parsed = parseSbomDocument(JSON.stringify(document), {
      source: "bundled.cdx.json",
    });
    const serialized = JSON.stringify(parsed);
    for (const secret of secrets) {
      assert.ok(!serialized.includes(secret), secret);
    }
    const [component] = parsed.components;
    assert.strictEqual(
      component.purl,
      "pkg:generic/libjpeg-turbo@3.0.1?download_url=https:%2F%2Fartifacts.example.com%2Fsrc%2Flibjpeg-turbo-3.0.1.tar.gz",
    );
    assert.strictEqual(
      component.externalReferences[0].url,
      "https://git.example.com/acme/libjpeg-turbo.git",
    );
    assert.strictEqual(
      component.externalReferences[1].url,
      "https://bucket.example.com/z.tgz",
    );
    assert.strictEqual(
      component.properties[0].value,
      "fetched from https://mirror.example.com/x.tgz (cached)",
    );
    // Free text that is not a credential is left alone.
    assert.strictEqual(component.author, "The libjpeg-turbo authors");
    // The dependency graph still points at the cleaned refs.
    assert.strictEqual(parsed.rootRef, "https://build.example/acme@2.1.0");
    assert.strictEqual(parsed.dependencies[0].ref, parsed.rootRef);
    assert.deepStrictEqual(parsed.dependencies[0].dependsOn, [
      component["bom-ref"],
    ]);
  });

  it("keeps identifiers that differ only in a fragment distinct", () => {
    const parsed = parseSbomDocument(
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        components: [
          { name: "a", "bom-ref": "https://acme.example/doc#SPDXRef-a" },
          { name: "b", "bom-ref": "https://acme.example/doc#SPDXRef-b" },
        ],
        dependencies: [
          {
            ref: "https://acme.example/doc#SPDXRef-a",
            dependsOn: ["https://acme.example/doc#SPDXRef-b"],
          },
        ],
      }),
      { source: "wheel" },
    );
    assert.deepStrictEqual(
      parsed.components.map((component) => component["bom-ref"]),
      [
        "https://acme.example/doc#SPDXRef-a",
        "https://acme.example/doc#SPDXRef-b",
      ],
    );
    assert.deepStrictEqual(parsed.dependencies[0].dependsOn, [
      "https://acme.example/doc#SPDXRef-b",
    ]);
  });

  it("cleans a large document in linear time", () => {
    const parsed = parseSbomDocument(
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        components: [
          {
            name: "big",
            description: "-eyJ".repeat(50000),
            properties: [{ name: "p", value: "a://".repeat(50000) }],
          },
        ],
      }),
      { source: "wheel" },
    );
    assert.strictEqual(parsed.components[0].description.length, 200000);
  });
});

describe("repairPurl()", () => {
  const repaired = (purl) => {
    const component = { purl };
    repairPurl(component);
    return component.purl;
  };

  it("escapes a reserved character anywhere a producer left it raw", () => {
    assert.strictEqual(
      repaired("pkg:file/libstdc++.so.6"),
      "pkg:file/libstdc%2B%2B.so.6",
    );
    assert.strictEqual(
      repaired("pkg:file/libc++.1.dylib@1300.36.0?compatibility_version=1.0.0"),
      "pkg:file/libc%2B%2B.1.dylib@1300.36.0?compatibility_version=1.0.0",
    );
    assert.strictEqual(
      repaired("pkg:cargo/toml@1.1.3+spec-1.1.0"),
      "pkg:cargo/toml@1.1.3%2Bspec-1.1.0",
    );
    assert.strictEqual(
      repaired("pkg:npm/@scope/pkg@1.0.0"),
      "pkg:npm/%40scope/pkg@1.0.0",
    );
  });

  it("escapes a download_url but drops a file: one", () => {
    assert.strictEqual(
      repaired("pkg:generic/openssl@4.0.1?download_url=https://example/o.tgz"),
      "pkg:generic/openssl@4.0.1?download_url=https:%2F%2Fexample%2Fo.tgz",
    );
    assert.strictEqual(
      repaired("pkg:cargo/uv-audit@0.0.70?download_url=file://../uv-audit"),
      "pkg:cargo/uv-audit@0.0.70",
    );
  });

  it("leaves a well-formed purl and a non-purl alone", () => {
    assert.strictEqual(
      repaired("pkg:golang/github.com/a/b@v1.2.3#sub/dir"),
      "pkg:golang/github.com/a/b@v1.2.3#sub/dir",
    );
    assert.strictEqual(repaired("not-a-purl"), "not-a-purl");
    assert.strictEqual(repaired(undefined), undefined);
  });
});

describe("tagSbomComponents()", () => {
  it("appends provenance properties and skips valueless ones", () => {
    const components = [{ name: "a" }, null, { name: "b", properties: [] }];
    tagSbomComponents(components, [
      { name: "cdx:tea:source", value: "https://example/bom.json" },
      { name: "cdx:tea:collection", value: undefined },
    ]);
    assert.deepStrictEqual(components[0].properties, [
      { name: "cdx:tea:source", value: "https://example/bom.json" },
    ]);
    assert.strictEqual(components[2].properties.length, 1);
  });
});

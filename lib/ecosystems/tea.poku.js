import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { strict as assert, describe, it } from "poku";

import {
  buildPublishCollectionPayload,
  compareTeaVersions,
  mergeTeaBom,
  parseTei,
  selectTeaEndpoint,
} from "./tea.js";

const sampleBom = JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  components: [
    {
      type: "library",
      name: "upstream-lib",
      version: "4.5.6",
      purl: "pkg:npm/upstream-lib@4.5.6",
      "bom-ref": "pkg:npm/upstream-lib@4.5.6",
    },
  ],
});

function sha256Of(content) {
  return createHash("sha256").update(content).digest("hex");
}

function startTeaMockServer() {
  const seenTokens = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const authorization = req.headers.authorization || "";
    if (authorization) {
      seenTokens.push(authorization);
    }
    if (url.pathname === "/.well-known/tea") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          endpoints: [
            {
              url: `http://localhost:${server.address().port}`,
              versions: ["0.4.0"],
              priority: 1,
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/v0.4.0/discovery") {
      const tei = url.searchParams.get("tei");
      if (
        tei ===
        "urn:tei:uuid:products.example.com:d4d9f54a-abcf-11ee-ac79-1a52914d44b1"
      ) {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            productReleaseUuid: "123e4567-e89b-12d3-a456-426614174000",
            servers: [
              {
                rootUrl: `http://localhost:${server.address().port}`,
                versions: ["0.4.0"],
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (
      url.pathname ===
      "/v0.4.0/productRelease/123e4567-e89b-12d3-a456-426614174000/collection/latest"
    ) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          uuid: "c0ffeec0-ffee-c0ff-ee-c0ffeec0ffee",
          version: 3,
          date: "2026-01-01T00:00:00Z",
          belongsTo: "PRODUCT_RELEASE",
          artifacts: [
            {
              uuid: "1cb47b95-8bf8-3bad-a5a4-0d54d86e10ce",
              name: "Upstream SBOM",
              type: "BOM",
              formats: [
                {
                  mediaType: "application/vnd.cyclonedx+json",
                  url: `http://localhost:${server.address().port}/artifacts/upstream.json`,
                  checksums: [
                    { algType: "SHA-256", algValue: sha256Of(sampleBom) },
                  ],
                },
              ],
            },
            {
              uuid: "2cb47b95-8bf8-3bad-a5a4-0d54d86e10ce",
              name: "Upstream VEX",
              type: "VULNERABILITIES",
              formats: [
                {
                  mediaType: "application/vnd.cyclonedx+json",
                  url: "http://unused.example",
                },
              ],
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/artifacts/upstream.json") {
      res.setHeader("Content-Type", "application/json");
      res.end(sampleBom);
      return;
    }
    if (url.pathname === "/collection") {
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          identifier: "c0ffeec0-ffee-c0ff-ee-c0ffeec0ffee",
          version: 4,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, seenTokens, port: server.address().port });
    });
  });
}

describe("parseTei()", () => {
  it("parses a UUID TEI", () => {
    const parsed = parseTei(
      "urn:tei:uuid:products.example.com:d4d9f54a-abcf-11ee-ac79-1a52914d44b1",
    );
    assert.deepStrictEqual(parsed, {
      type: "uuid",
      domain: "products.example.com",
      id: "d4d9f54a-abcf-11ee-ac79-1a52914d44b1",
    });
  });

  it("rejects a malformed TEI", () => {
    assert.strictEqual(parseTei("not-a-tei"), null);
  });
});

describe("compareTeaVersions()", () => {
  it("orders versions semantically", () => {
    assert.strictEqual(compareTeaVersions("1.0.0", "0.4.0"), 1);
    assert.strictEqual(compareTeaVersions("0.4.0", "0.4.0"), 0);
    assert.strictEqual(compareTeaVersions("0.4.0", "1.0.0"), -1);
    assert.strictEqual(compareTeaVersions("1.0.0", "1.0.0-beta.1"), 1);
  });
});

describe("selectTeaEndpoint()", () => {
  it("picks the highest matching version and priority", () => {
    const selected = selectTeaEndpoint([
      { url: "https://a.example", versions: ["0.3.0", "1.0.0"], priority: 0.5 },
      { url: "https://b.example", versions: ["0.4.0"], priority: 0.9 },
    ]);
    assert.strictEqual(selected.url, "https://b.example");
    assert.strictEqual(selected.version, "0.4.0");
  });

  it("returns null without endpoints", () => {
    assert.strictEqual(selectTeaEndpoint([]), null);
  });
});

describe("TEA fetch (mock server)", () => {
  it("fetches the latest collection, downloads and merges the BOM artifact", async () => {
    const { server, seenTokens } = await startTeaMockServer();
    try {
      const { fetchLatestCollection, fetchBomArtifacts } = await import(
        "./tea.js"
      );
      const collection = await fetchLatestCollection({
        rootUrl: `http://127.0.0.1:${server.address().port}`,
        version: "0.4.0",
        releaseUuid: "123e4567-e89b-12d3-a456-426614174000",
        options: { teaToken: "super-secret-token" },
      });
      assert.strictEqual(collection.version, 3);
      const artifacts = await fetchBomArtifacts(collection, {
        teaToken: "super-secret-token",
      });
      assert.strictEqual(artifacts.length, 1);
      assert.strictEqual(artifacts[0].name, "Upstream SBOM");
      // The VEX artifact is not a BOM, so it is skipped.
      const merged = mergeTeaBom(artifacts, {
        collectionUuid: collection.uuid,
        attributedTo: "pkg:npm/@cdxgen/cdxgen@13.0.0",
      });
      assert.strictEqual(merged.components.length, 1);
      assert.strictEqual(merged.components[0].name, "upstream-lib");
      assert.ok(
        merged.components[0].properties.some(
          (p) => p.name === "cdx:tea:source",
        ),
      );
      assert.ok(
        merged.components[0].properties.some(
          (p) => p.name === "cdx:tea:collection",
        ),
      );
      assert.strictEqual(merged.citations.length, 1);
      assert.strictEqual(
        merged.citations[0].attributedTo,
        "pkg:npm/@cdxgen/cdxgen@13.0.0",
      );
      assert.ok(merged.citations[0].note.includes("Transparency Exchange API"));
      // With no ref to attribute to, the components still merge but the
      // citation is dropped rather than aimed at an invented ref.
      assert.deepStrictEqual(mergeTeaBom(artifacts, {}).citations, []);
      // Credentials were sent only as Authorization headers, never logged.
      assert.strictEqual(seenTokens.length, 2);
      for (const header of seenTokens) {
        assert.ok(header.startsWith("Bearer super-secret-token"));
      }
    } finally {
      server.close();
    }
  });

  it("fails checksum verification and skips the artifact", async () => {
    const { server } = await startTeaMockServer();
    try {
      const { fetchBomArtifacts } = await import("./tea.js");
      const collection = {
        artifacts: [
          {
            name: "Tampered SBOM",
            type: "BOM",
            formats: [
              {
                mediaType: "application/vnd.cyclonedx+json",
                url: `http://127.0.0.1:${server.address().port}/artifacts/upstream.json`,
                checksums: [{ algType: "SHA-256", algValue: "0".repeat(64) }],
              },
            ],
          },
        ],
      };
      const artifacts = await fetchBomArtifacts(collection);
      assert.strictEqual(artifacts.length, 0);
    } finally {
      server.close();
    }
  });
});

describe("buildPublishCollectionPayload()", () => {
  it("builds the draft publisher API payload with checksum and size", () => {
    const payload = buildPublishCollectionPayload({
      leafIdentifier: "123e4567-e89b-12d3-a456-426614174000",
      productName: "Example Product",
      productVersion: "1.0.0",
      authorName: "Jane Doe",
      authorEmail: "jane@example.com",
      reasonType: "INITIAL_RELEASE",
      artifactName: "Example SBOM",
      artifactUrl: "https://example.com/bom.json",
      artifactContent: sampleBom,
    });
    assert.strictEqual(
      payload.tea_leaf_identifier,
      "123e4567-e89b-12d3-a456-426614174000",
    );
    assert.strictEqual(payload.product_name, "Example Product");
    assert.strictEqual(payload.reason.type, "INITIAL_RELEASE");
    const object = payload.artifacts[0].objects[0];
    assert.strictEqual(object.artifact_checksum_type, "SHA256");
    assert.strictEqual(object.artifact_checksum, sha256Of(sampleBom));
    assert.strictEqual(
      object.artifact_size_in_bytes,
      Buffer.byteLength(sampleBom),
    );
  });
});

describe("credential handling", () => {
  it("never serialises the token into the BOM", async () => {
    const { server } = await startTeaMockServer();
    try {
      const { fetchBomArtifacts } = await import("./tea.js");
      const collection = {
        artifacts: [
          {
            name: "SBOM",
            type: "BOM",
            formats: [
              {
                mediaType: "application/vnd.cyclonedx+json",
                url: `http://127.0.0.1:${server.address().port}/artifacts/upstream.json`,
              },
            ],
          },
        ],
      };
      const artifacts = await fetchBomArtifacts(collection, {
        teaToken: "SENTINEL-TOKEN-1234",
      });
      const merged = mergeTeaBom(artifacts);
      const serialized = JSON.stringify(merged);
      assert.ok(!serialized.includes("SENTINEL-TOKEN-1234"));
    } finally {
      server.close();
    }
  });
});

describe("publishTeaCollection() (draft publisher API)", () => {
  it("posts the collection and reports the server-assigned version", async () => {
    const { server, seenTokens } = await startTeaMockServer();
    try {
      const { publishTeaCollection } = await import("./tea.js");
      const payload = buildPublishCollectionPayload({
        leafIdentifier: "123e4567-e89b-12d3-a456-426614174000",
        productName: "Example Product",
        productVersion: "1.0.0",
        authorName: "Jane Doe",
        reasonType: "ARTIFACT_UPDATED",
        artifactName: "Example SBOM",
        artifactUrl: "https://example.com/bom.json",
        artifactContent: sampleBom,
      });
      const result = await publishTeaCollection(
        `http://127.0.0.1:${server.address().port}`,
        payload,
        { teaToken: "super-secret-token" },
      );
      assert.strictEqual(result.status, 201);
      assert.strictEqual(result.body.version, 4);
      // The token went out as a header only.
      assert.ok(seenTokens.some((h) => h === "Bearer super-secret-token"));
    } finally {
      server.close();
    }
  });

  it("propagates a publish failure without touching the local BOM", async () => {
    // A failing server must reject so the caller can report it separately; the
    // locally written BOM is the caller's concern and is untouched by this
    // function.
    const failingServer = createServer((_req, res) => {
      res.statusCode = 500;
      res.end("{}");
    });
    await new Promise((resolve) =>
      failingServer.listen(0, "127.0.0.1", resolve),
    );
    try {
      const { publishTeaCollection } = await import("./tea.js");
      await assert.rejects(
        publishTeaCollection(
          `http://127.0.0.1:${failingServer.address().port}`,
          {},
        ),
      );
    } finally {
      failingServer.close();
    }
  });
});

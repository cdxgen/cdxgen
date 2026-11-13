import { createHash } from "node:crypto";
import { createServer } from "node:http";

import esmock from "esmock";
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
          uuid: "c0ffeec0-ffee-c0ff-eec0-ffeec0ffeec0",
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
          identifier: "c0ffeec0-ffee-c0ff-eec0-ffeec0ffeec0",
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

  it("orders pre-releases by SemVer precedence in linear time", () => {
    assert.strictEqual(compareTeaVersions("1.0.0-beta.11", "1.0.0-beta.2"), 1);
    assert.strictEqual(compareTeaVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
    assert.strictEqual(
      compareTeaVersions("1.0.0-alpha.1", "1.0.0-alpha.beta"),
      -1,
    );
    assert.strictEqual(compareTeaVersions("1.0.0-rc.1", "1.0.0-beta.2"), 1);
    assert.strictEqual(compareTeaVersions("1.0.0-rc.1", "1.0.0-rc.1"), 0);
    // A discovery document is remote input: two pre-releases that differ in
    // an accent and continue with a run of combining marks must not cost
    // collation time.
    const tail = `${"\u0F71".repeat(4000)}${"\u0334".repeat(4000)}`;
    const started = performance.now();
    assert.strictEqual(
      compareTeaVersions(`1.0.0-\u0301${tail}`, `1.0.0-\u0300${tail}`),
      1,
    );
    assert.ok(performance.now() - started < 1000);
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
      // The mock Collection names its artifact on `localhost`, the origin of
      // the server that served it.
      const artifacts = await fetchBomArtifacts(
        collection,
        { teaToken: "super-secret-token" },
        `http://localhost:${server.address().port}`,
      );
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

  it("hashes once per algorithm however long the checksum list is", async () => {
    const { server } = await startTeaMockServer();
    try {
      const hashed = [];
      const { fetchBomArtifacts } = await esmock("./tea.js", {
        "node:crypto": {
          createHash: (algorithm) => {
            hashed.push(algorithm);
            return createHash(algorithm);
          },
        },
      });
      // A remote Collection controls the length of this list. Valueless,
      // duplicate and unsupported entries must cost nothing and change nothing.
      const checksums = [
        { algType: "SHA-256", algValue: sha256Of(sampleBom) },
        { algType: "MD4", algValue: "0".repeat(32) },
      ];
      for (let i = 0; i < 20000; i++) {
        checksums.push({ algType: "MD5" });
        checksums.push({ algType: "SHA-256", algValue: sha256Of(sampleBom) });
      }
      const collection = {
        artifacts: [
          {
            name: "Padded SBOM",
            type: "BOM",
            formats: [
              {
                mediaType: "application/vnd.cyclonedx+json",
                url: `http://127.0.0.1:${server.address().port}/artifacts/upstream.json`,
                checksums,
              },
            ],
          },
        ],
      };
      const artifacts = await fetchBomArtifacts(collection);
      assert.strictEqual(artifacts.length, 1);
      assert.deepStrictEqual(hashed, ["sha256"]);
    } finally {
      server.close();
    }
  });

  it("keeps oversized remote labels off every merged component", () => {
    const merged = mergeTeaBom(
      [
        {
          name: "Upstream SBOM",
          url: `https://tea.example/bom.json?sig=1#${"f".repeat(5000)}`,
          content: sampleBom,
        },
        {
          name: "Other SBOM",
          url: `https://tea.example/${"p".repeat(5000)}.json`,
          content: sampleBom,
        },
        {
          name: "Third SBOM",
          url: `https://tea.example/${"q".repeat(300)}.json`,
          content: sampleBom,
        },
      ],
      {
        collectionUuid: "u".repeat(5000),
        attributedTo: "pkg:npm/@cdxgen/cdxgen@13.0.0",
      },
    );
    const values = (component, name) =>
      component.properties.filter((p) => p.name === name).map((p) => p.value);
    // Query and fragment are dropped like every other URL in the BOM; a URL
    // that is still too long gives way to the artifact name.
    assert.deepStrictEqual(values(merged.components[0], "cdx:tea:source"), [
      "https://tea.example/bom.json",
    ]);
    assert.deepStrictEqual(values(merged.components[1], "cdx:tea:source"), [
      "Other SBOM",
    ]);
    assert.deepStrictEqual(values(merged.components[2], "cdx:tea:source"), [
      "Third SBOM",
    ]);
    // A collection uuid that is not a UUID is not copied onto any component.
    for (const component of merged.components) {
      assert.deepStrictEqual(values(component, "cdx:tea:collection"), []);
    }
    assert.strictEqual(merged.citations.length, 3);
    for (const citation of merged.citations) {
      assert.ok(citation.note.includes("(collection unknown)"));
      assert.ok(citation.note.length < 256);
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
  it("sends the token only to artifacts on the TEA server's origin", async () => {
    const { server, seenTokens } = await startTeaMockServer();
    try {
      const { fetchBomArtifacts } = await import("./tea.js");
      const port = server.address().port;
      const collection = {
        artifacts: [
          {
            name: "SBOM",
            type: "BOM",
            formats: [
              {
                mediaType: "application/vnd.cyclonedx+json",
                url: `http://127.0.0.1:${port}/artifacts/upstream.json`,
              },
            ],
          },
        ],
      };
      const options = { teaToken: "SENTINEL-TOKEN-1234" };
      // The Collection may name an artifact on any host; one on another
      // origin than the TEA server is fetched without the token.
      await fetchBomArtifacts(collection, options, `http://localhost:${port}`);
      await fetchBomArtifacts(collection, options);
      assert.deepStrictEqual(seenTokens, []);
      await fetchBomArtifacts(collection, options, `http://127.0.0.1:${port}`);
      assert.deepStrictEqual(seenTokens, ["Bearer SENTINEL-TOKEN-1234"]);
    } finally {
      server.close();
    }
  });

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

describe("TEA token scope across discovery", () => {
  const tei =
    "urn:tei:uuid:products.example.com:d4d9f54a-abcf-11ee-ac79-1a52914d44b1";
  const releaseUuid = "123e4567-e89b-12d3-a456-426614174000";
  const responses = {
    "https://products.example.com/.well-known/tea": {
      schemaVersion: 1,
      endpoints: [
        {
          url: "https://api.example.com/tea",
          versions: ["0.4.0"],
          priority: 1,
        },
      ],
    },
    [`https://api.example.com/tea/v0.4.0/discovery?tei=${encodeURIComponent(tei)}`]:
      {
        productReleaseUuid: releaseUuid,
        servers: [
          { rootUrl: "https://mirror.example.net/tea", versions: ["0.4.0"] },
        ],
      },
    [`https://mirror.example.net/tea/v0.4.0/productRelease/${releaseUuid}/collection/latest`]:
      {
        uuid: "c0ffeec0-ffee-c0ff-eec0-ffeec0ffeec0",
        artifacts: [
          "https://mirror.example.net/a.json",
          "https://api.example.com/b.json",
        ].map((url, i) => ({
          name: `SBOM ${i}`,
          type: "BOM",
          formats: [{ mediaType: "application/vnd.cyclonedx+json", url }],
        })),
      },
    "https://mirror.example.net/a.json": sampleBom,
    "https://api.example.com/b.json": sampleBom,
  };

  async function runFetch(options) {
    const seen = [];
    const { applyTeaFetch } = await esmock("./tea.js", {
      "../core/activity.js": {
        cdxgenAgent: async (url, requestOptions) => {
          seen.push([url, requestOptions?.headers?.Authorization || ""]);
          if (!(url in responses)) {
            throw new Error(`unexpected request ${url}`);
          }
          return { body: responses[url] };
        },
        readEnvironmentVariable: () => undefined,
      },
    });
    await applyTeaFetch(
      { bomJson: { components: [], dependencies: [] } },
      { teaFetch: tei, ...options },
    );
    return seen;
  }

  it("sends the token only to the server the TEI's domain advertises", async () => {
    const seen = await runFetch({ teaToken: "SENTINEL-TOKEN-1234" });
    const bearer = "Bearer SENTINEL-TOKEN-1234";
    assert.deepStrictEqual(seen, [
      ["https://products.example.com/.well-known/tea", ""],
      [
        `https://api.example.com/tea/v0.4.0/discovery?tei=${encodeURIComponent(tei)}`,
        bearer,
      ],
      [
        `https://mirror.example.net/tea/v0.4.0/productRelease/${releaseUuid}/collection/latest`,
        "",
      ],
      ["https://mirror.example.net/a.json", ""],
      ["https://api.example.com/b.json", bearer],
    ]);
  });

  it("sends no token for a TEI named in a config file", async () => {
    const seen = await runFetch({
      teaToken: "SENTINEL-TOKEN-1234",
      teaFetchFromConfigFile: true,
    });
    assert.strictEqual(seen.length, 5);
    assert.ok(seen.every(([, authorization]) => authorization === ""));
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

  it("sends no token to a publish target named in a config file", async () => {
    const { server, seenTokens } = await startTeaMockServer();
    try {
      const { publishTeaCollection } = await import("./tea.js");
      const result = await publishTeaCollection(
        `http://127.0.0.1:${server.address().port}`,
        { name: "x" },
        { teaToken: "super-secret-token", teaPublishFromConfigFile: true },
      );
      assert.strictEqual(result.status, 201);
      assert.deepStrictEqual(seenTokens, []);
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

describe("TEA fetch bounds", () => {
  it("requests each BOM url once and at most 32 of them", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.setHeader("Content-Type", "application/json");
      res.end(sampleBom);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { fetchBomArtifacts } = await import("./tea.js");
      const base = `http://127.0.0.1:${server.address().port}/artifacts`;
      const listing = (url) => ({
        name: "Upstream SBOM",
        type: "BOM",
        formats: [
          {
            mediaType: "application/vnd.cyclonedx+json",
            url,
            checksums: [{ algType: "SHA-256", algValue: sha256Of(sampleBom) }],
          },
        ],
      });
      const repeated = await fetchBomArtifacts({
        artifacts: Array.from({ length: 100 }, (_, i) =>
          listing(`${base}/same.json#${i}`),
        ),
      });
      assert.strictEqual(repeated.length, 1);
      requests = 0;
      const distinct = await fetchBomArtifacts({
        artifacts: Array.from({ length: 40 }, (_, i) =>
          listing(`${base}/doc${i}.json`),
        ),
      });
      assert.strictEqual(distinct.length, 32);
      assert.strictEqual(requests, 32);
    } finally {
      server.close();
    }
  });

  it("merges at most a bounded number of components from one collection", () => {
    const content = JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: Array.from({ length: 60000 }, () => ({
        type: "library",
        name: "c",
      })),
    });
    const artifacts = Array.from({ length: 3 }, (_, i) => ({
      name: `listing-${i}`,
      url: `https://tea.example.com/artifacts/upstream.json?copy=${i}`,
      content,
    }));
    const merged = mergeTeaBom(artifacts, {});
    assert.strictEqual(merged.components.length, 60000);
  });
});

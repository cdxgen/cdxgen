import { createServer } from "node:http";
import process from "node:process";

import { assert, it } from "poku";

// crates.io enrichment against a local stand-in. RUST_CRATES_URL and the
// batch transport are process-wide, so this file holds one sequential test.

it("getCratesMetadata takes nothing from a document that lacks the locked version", async () => {
  const crateDocument = (name, versions) => ({
    crate: {
      name,
      description: `the crates.io ${name}`,
      repository: `https://github.com/example/${name}`,
      newest_version: versions[0].num,
    },
    versions: versions.map((version, index) => ({
      id: 100 + index,
      dl_path: `/api/v1/crates/${name}/${version.num}/download`,
      ...version,
    })),
  });
  const documents = {
    // Only an unrelated, newer release of the same name is published.
    mylocal: crateDocument("mylocal", [
      { num: "9.9.9", license: "GPL-3.0-only", checksum: "f".repeat(64) },
    ]),
    serde: crateDocument("serde", [
      {
        num: "1.0.200",
        license: "MIT OR Apache-2.0",
        checksum: "a".repeat(64),
      },
      {
        num: "1.0.100",
        license: "MIT OR Apache-2.0",
        checksum: "b".repeat(64),
      },
    ]),
  };
  const requested = [];
  const server = createServer((req, res) => {
    requested.push(req.url);
    const [, name, owners] =
      req.url.match(/^\/api\/v1\/crates\/([^/]+)(\/owners)?$/) || [];
    res.writeHead(documents[name] ? 200 : 404, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(owners ? { users: [] } : documents[name] || {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const saved = {
    RUST_CRATES_URL: process.env.RUST_CRATES_URL,
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
  };
  process.env.RUST_CRATES_URL = `http://127.0.0.1:${server.address().port}/api/v1/crates/`;
  process.env.CDXGEN_RS_DISABLE = "fetch";
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { getCratesMetadata, normalizeCargoIntegrity } = await import(
      "./ecosystems.js"
    );
    const [local, published] = await getCratesMetadata(
      [
        { name: "mylocal", version: "0.2.0" },
        { name: "serde", version: "1.0.100" },
      ],
      { preferLocalCache: false },
    );

    // Nothing describing another version is taken, but the version itself
    // is recorded as one crates.io does not list.
    assert.deepStrictEqual(local, {
      name: "mylocal",
      version: "0.2.0",
      properties: [
        { name: "cdx:cargo:versionMissing", value: "true" },
        { name: "cdx:cargo:versionCount", value: "1" },
      ],
    });

    assert.strictEqual(published.license, "MIT OR Apache-2.0");
    assert.strictEqual(published.description, "the crates.io serde");
    assert.strictEqual(
      published.distribution.url,
      "https://crates.io/api/v1/crates/serde/1.0.100/download",
    );
    const crateId = published.properties.find(
      (prop) => prop.name === "cdx:cargo:crate_id",
    );
    assert.strictEqual(crateId.value, "101");
    assert.strictEqual(
      published._integrity,
      normalizeCargoIntegrity("b".repeat(64)),
    );
    // The registry path asks for the owners listing by default: the predictive
    // audit scores the publisher.
    assert.deepStrictEqual(
      requested.filter((url) => url.endsWith("/owners")).sort(),
      ["/api/v1/crates/mylocal/owners", "/api/v1/crates/serde/owners"],
    );
    requested.length = 0;
    const [withoutOwners] = await getCratesMetadata(
      [{ name: "serde", version: "1.0.100" }],
      { fetchOwners: false, preferLocalCache: false },
    );
    assert.deepStrictEqual(
      requested.filter((url) => url.endsWith("/owners")),
      [],
      "fetchOwners: false skips the second request per crate",
    );
    assert.strictEqual(
      withoutOwners.properties.find(
        (prop) => prop.name === "cdx:cargo:crate_id",
      )?.value,
      "101",
      "the crate's metadata still arrives without the owners listing",
    );
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

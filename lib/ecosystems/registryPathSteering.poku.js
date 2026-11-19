import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// The names and versions of a lockfile are appended to registry URLs, which
// may carry the operator's credential. Each registry lookup is checked against
// a stubbed agent, so the assertions are about the exact requests made: a name
// that is not one path segment is not asked about, and an ordinary one is.

it("registry lookups are made only for names that are one path segment", async () => {
  const saved = {
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
    FETCH_LICENSE: process.env.FETCH_LICENSE,
    CDXGEN_FETCH_PKG_METADATA: process.env.CDXGEN_FETCH_PKG_METADATA,
    CDXGEN_NO_CACHE: process.env.CDXGEN_NO_CACHE,
  };
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_FETCH_PKG_METADATA = "true";
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    throw Object.assign(new Error("Not Found"), {
      response: { statusCode: 404, headers: {} },
    });
  });
  const mocks = {
    "../core/httpClient.js": {
      createHttpClient: sinon.stub().returns({ get: agentGet }),
    },
  };
  const take = () => requested.splice(0).sort();
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const ecosystems = await esmock("./ecosystems.js", {}, mocks);

    await ecosystems.getPyMetadata(
      [
        { name: "../simple/requests", version: "1.0.0" },
        { name: "requests", version: "1.0/../../x" },
        { name: "a/b", version: "1.0.0" },
        { name: "requests", version: "2.0.0" },
      ],
      true,
    );
    const pypiRequests = take();
    assert.ok(
      pypiRequests.every((url) => !url.includes("..") && !url.includes("a/b")),
      pypiRequests.join("\n"),
    );
    assert.ok(pypiRequests.some((url) => url.endsWith("/requests/2.0.0/json")));

    await ecosystems.getCratesMetadata(
      [
        { name: "../crates/serde", version: "1.0.0" },
        { name: "serde/../../x", version: "1.0.0" },
        { name: "serde_json", version: "1.0.0" },
      ],
      { preferLocalCache: false },
    );
    const crateRequests = take();
    assert.ok(crateRequests.length > 0);
    assert.ok(
      crateRequests.every(
        (url) => !url.includes("..") && url.includes("/serde_json"),
      ),
      crateRequests.join("\n"),
    );

    await ecosystems.getDartMetadata(
      [
        { name: "../packages/x", version: "1.0.0" },
        { name: "http", version: "1.0.0/../../x" },
        { name: "http", version: "1.2.0" },
      ],
      { secureMode: false },
    );
    const dartRequests = take();
    assert.ok(
      dartRequests.some((url) =>
        url.endsWith("/api/packages/http/versions/1.2.0"),
      ),
    );
    assert.ok(
      dartRequests.every((url) => !url.includes("..")),
      dartRequests.join("\n"),
    );

    assert.strictEqual(
      ecosystems.composePomXmlUrl({
        urlPrefix: "https://repo.example/maven2/",
        group: "org.example",
        name: "../../secret",
        version: "1.0",
      }),
      undefined,
    );
    assert.strictEqual(
      ecosystems.composePomXmlUrl({
        urlPrefix: "https://repo.example/maven2/",
        group: "org.example",
        name: "lib",
        version: "%2e%2e",
      }),
      undefined,
    );
    assert.strictEqual(
      ecosystems.composePomXmlUrl({
        urlPrefix: "https://repo.example/maven2/",
        group: "org.example",
        name: "lib",
        version: "1.0",
      }),
      "https://repo.example/maven2/org/example/lib/1.0/lib-1.0.pom",
    );
    requested.length = 0;
    await ecosystems.getMvnMetadata(
      [
        { group: "org.example", name: "../../secret", version: "1.0" },
        { group: "..", name: "lib", version: "1.0" },
      ],
      {},
      true,
    );
    assert.deepStrictEqual(
      requested.filter((url) => url.includes("..")),
      [],
    );

    const rubyutils = await esmock("./rubyutils.js", {}, mocks);
    await rubyutils.getRubyGemsMetadata([
      { name: "..", version: "1.0.0" },
      { name: "rake/../../x", version: "1.0.0" },
      { name: "rake", version: "13.0/../../x" },
      { name: "rake", version: "13.0.6" },
    ]);
    const gemRequests = take();
    assert.ok(
      gemRequests.every((url) => !url.includes("..")),
      gemRequests.join("\n"),
    );
    assert.ok(gemRequests.some((url) => url.includes("/rake/versions/13.0.6")));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

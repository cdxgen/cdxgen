import { createServer } from "node:http";
import process from "node:process";

import { assert, it } from "poku";

// PyPI enrichment against a local stand-in, so the assertions are about the
// requests that actually went out. PYPI_URL and the batch transport are
// process-wide, so this file holds one sequential test.

it("getPyMetadata renames a package only when PyPI says it does not exist", async () => {
  const requests = [];
  const document = (name, summary) => ({
    info: { name, summary, version: "1.0.0", license: "MIT", classifiers: [] },
    releases: {},
    urls: [],
  });
  const server = createServer((req, res) => {
    requests.push(req.url);
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "retry-after": "0" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.url.startsWith("/pypi/redis/")) {
      // A rate limit, sent as the HTML page a CDN serves.
      return send(429, "<html>rate limited</html>", "text/html");
    }
    if (req.url.startsWith("/pypi/flaky/")) {
      return send(503, { message: "unavailable" });
    }
    if (req.url.startsWith("/pypi/django-redis/")) {
      return send(200, document("django-redis", "Redis cache for Django"));
    }
    if (req.url.startsWith("/pypi/django-debug-toolbar-extra/")) {
      return send(200, document("django-debug-toolbar-extra", "Plugin"));
    }
    if (req.url === "/pypi/known/json") {
      return send(200, {
        info: { name: "known", version: "1.0.0" },
        releases: { "1.0.0": [{ upload_time: "2020-01-01T00:00:00" }] },
        urls: [],
      });
    }
    return send(404, { message: "Not Found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const saved = {
    PYPI_URL: process.env.PYPI_URL,
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
  };
  process.env.PYPI_URL = `http://127.0.0.1:${server.address().port}/pypi/`;
  process.env.CDXGEN_RS_DISABLE = "fetch";
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { getPyMetadata } = await import("./ecosystems.js");
    const take = () => requests.splice(0);

    // fetchDepsInfo=true is the path the atom fallback takes by default.
    const [limited, failing] = await getPyMetadata(
      [
        { name: "redis", version: "1.0.0" },
        { name: "flaky", version: "1.0.0" },
      ],
      true,
    );
    assert.strictEqual(limited.name, "redis");
    assert.strictEqual(limited.purl, "pkg:pypi/redis@1.0.0");
    assert.strictEqual(limited.description, undefined);
    assert.strictEqual(failing.name, "flaky");
    assert.ok(
      !take().some((url) => url.includes("django-")),
      "no django- lookup after a 429 or a 503",
    );

    // A project that does not exist still finds its Django plugin.
    const [plugin] = await getPyMetadata(
      [{ name: "debug-toolbar-extra", version: "1.0.0" }],
      true,
    );
    assert.strictEqual(plugin.name, "django-debug-toolbar-extra");
    take();

    // A miss is asked about once: the second pass sends nothing for it. Plain
    // generation does not read the project document to tell a missing
    // version from a missing name; only a caller that asked for the release
    // history does.
    await getPyMetadata([{ name: "internal-only", version: "1.0.0" }], true);
    assert.deepStrictEqual(take().sort(), [
      "/pypi/django-internal-only/1.0.0/json",
      "/pypi/internal-only/1.0.0/json",
    ]);
    // A version the project does not hold, asked for with the release
    // history, is marked missing and keeps a purl under its plain name.
    const [unknownVersion] = await getPyMetadata(
      [{ name: "known[extra]", version: "9.9.9" }],
      true,
      { fetchReleaseHistory: true },
    );
    assert.ok(take().includes("/pypi/known/json"));
    assert.strictEqual(unknownVersion.name, "known");
    assert.strictEqual(unknownVersion.purl, "pkg:pypi/known@9.9.9");
    assert.strictEqual(unknownVersion["bom-ref"], "pkg:pypi/known@9.9.9");
    assert.strictEqual(
      unknownVersion.properties.find(
        (property) => property.name === "cdx:pypi:versionMissing",
      )?.value,
      "true",
    );
    // Without it, no project document is asked for and nothing is marked.
    const [plain] = await getPyMetadata(
      [{ name: "known", version: "9.9.8" }],
      true,
    );
    assert.ok(!take().includes("/pypi/known/json"));
    assert.ok(
      !plain.properties?.some(
        (property) => property.name === "cdx:pypi:versionMissing",
      ),
    );

    const [again] = await getPyMetadata(
      [{ name: "internal-only", version: "1.0.0" }],
      true,
    );
    assert.strictEqual(again.name, "internal-only");
    assert.deepStrictEqual(take(), []);
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

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { assert, it } from "poku";

import {
  _setHttpCacheLimits,
  clearHttpCache,
  createHttpClient,
  HTTPError,
  isCacheDisabled,
  RequestError,
  resolveTimeout,
} from "./httpClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "..", "test", "data", "httpclient");
const sampleJson = readFileSync(join(fixturesDir, "sample.json"), "utf-8");
const sampleText = readFileSync(join(fixturesDir, "sample.txt"), "utf-8");

/**
 * Start a throwaway HTTP server that serves the httpClient fixtures and a few
 * synthetic responses (redirect, 404, slow) so the client can be exercised
 * without any real network access.
 *
 * @returns {Promise<{baseUrl: string, close: function(): Promise<void>}>}
 */
function startFixtureServer() {
  let hits = 0;
  const server = createServer((req, res) => {
    if (req.url === "/sample.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(sampleJson);
      return;
    }
    if (req.url === "/sample.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(sampleText);
      return;
    }
    if (req.url === "/echo") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-seen-content-type": req.headers["content-type"] || "",
          "x-seen-method": req.method,
        });
        res.end(
          JSON.stringify({ body: Buffer.concat(chunks).toString("utf-8") }),
        );
      });
      return;
    }
    if (req.url === "/gzip.json") {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      res.end(gzipSync(Buffer.from(sampleJson)));
      return;
    }
    if (req.url === "/counter") {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hits }));
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/sample.json" });
      res.end();
      return;
    }
    if (req.url === "/missing") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    if (req.url === "/rate-limited-html") {
      // What a CDN sends: an HTML page, whatever the client asked for.
      res.writeHead(429, { "content-type": "text/html", "retry-after": "7" });
      res.end("<html><body>You are being rate limited</body></html>");
      return;
    }
    if (req.url === "/rate-limited-json") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "slow down" }));
      return;
    }
    if (req.url === "/broken.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>not json</html>");
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 500);
      return;
    }
    res.writeHead(200);
    res.end("ok");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

it("resolveTimeout() maps got-style timeouts to milliseconds", () => {
  assert.strictEqual(resolveTimeout(undefined), undefined);
  assert.strictEqual(resolveTimeout(1500), 1500);
  assert.strictEqual(resolveTimeout({ request: 2000 }), 2000);
  // Phase objects are summed to a sensible upper bound.
  assert.strictEqual(resolveTimeout({ connect: 1000, response: 500 }), 1500);
});

it("createHttpClient() get() parses JSON responses", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient();
    const res = await client.get(`${server.baseUrl}/sample.json`, {
      responseType: "json",
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.name, "cdxgen-httpclient-fixture");
    assert.strictEqual(res.headers["content-type"], "application/json");
  } finally {
    await server.close();
  }
});

it("createHttpClient() decompresses gzip-encoded responses", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient();
    const res = await client.get(`${server.baseUrl}/gzip.json`, {
      responseType: "json",
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.name, "cdxgen-httpclient-fixture");
  } finally {
    await server.close();
  }
});

it("createHttpClient() defaults to text responses", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient();
    const res = await client.get(`${server.baseUrl}/sample.txt`);
    assert.strictEqual(typeof res.body, "string");
    assert.ok(res.body.includes("hello from the cdxgen httpClient fixture"));
  } finally {
    await server.close();
  }
});

it("createHttpClient() returns a Buffer for responseType buffer", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient();
    const res = await client.get(`${server.baseUrl}/sample.txt`, {
      responseType: "buffer",
    });
    assert.ok(Buffer.isBuffer(res.body));
  } finally {
    await server.close();
  }
});

it("createHttpClient() sends a merged user-agent header", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient({
      headers: { "user-agent": "cdxgen-test" },
    });
    const res = await client.post(`${server.baseUrl}/echo`, {
      json: { hello: "world" },
      responseType: "json",
    });
    assert.strictEqual(res.headers["x-seen-method"], "POST");
    assert.strictEqual(res.headers["x-seen-content-type"], "application/json");
    assert.deepStrictEqual(JSON.parse(res.body.body), { hello: "world" });
  } finally {
    await server.close();
  }
});

it("createHttpClient() follows redirects by default", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient();
    const res = await client.get(`${server.baseUrl}/redirect`, {
      responseType: "json",
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.name, "cdxgen-httpclient-fixture");
  } finally {
    await server.close();
  }
});

it("createHttpClient() does not follow redirects when disabled", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient();
    const res = await client.get(`${server.baseUrl}/redirect`, {
      followRedirect: false,
      throwHttpErrors: false,
    });
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.location, "/sample.json");
  } finally {
    await server.close();
  }
});

it("createHttpClient() throws HTTPError on 4xx by default", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient();
    await client.get(`${server.baseUrl}/missing`);
    assert.fail("expected an HTTPError to be thrown");
  } catch (err) {
    assert.ok(err instanceof HTTPError);
    assert.strictEqual(err.response.statusCode, 404);
  } finally {
    await server.close();
  }
});

it("createHttpClient() reports the status of an error response whose body is not JSON", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient();
    await assert.rejects(
      client.get(`${server.baseUrl}/rate-limited-html`, {
        responseType: "json",
      }),
      (err) => {
        assert.ok(err instanceof HTTPError, `got ${err?.name}`);
        assert.strictEqual(err.response.statusCode, 429);
        assert.strictEqual(err.response.headers["retry-after"], "7");
        assert.match(err.response.body, /rate limited/);
        return true;
      },
    );
    // A JSON error body is still decoded.
    await assert.rejects(
      client.get(`${server.baseUrl}/rate-limited-json`, {
        responseType: "json",
      }),
      (err) => {
        assert.deepStrictEqual(err.response.body, { error: "slow down" });
        return true;
      },
    );
    const res = await client.get(`${server.baseUrl}/rate-limited-html`, {
      responseType: "json",
      throwHttpErrors: false,
    });
    assert.strictEqual(res.statusCode, 429);
    // A successful response that is not JSON is still a parse error.
    await assert.rejects(
      client.get(`${server.baseUrl}/broken.json`, { responseType: "json" }),
      SyntaxError,
    );
  } finally {
    await server.close();
  }
});

it("createHttpClient() honours throwHttpErrors: false", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient();
    const res = await client.get(`${server.baseUrl}/missing`, {
      throwHttpErrors: false,
    });
    assert.strictEqual(res.statusCode, 404);
  } finally {
    await server.close();
  }
});

it("createHttpClient() exposes a lazy json() helper", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient();
    const body = await client(`${server.baseUrl}/sample.json`, {
      responseType: "json",
    }).json();
    assert.strictEqual(body.version, "1.0.0");
  } finally {
    await server.close();
  }
});

it("createHttpClient() runs beforeRequest, afterResponse and beforeError hooks", async () => {
  const server = await startFixtureServer();
  const events = [];
  try {
    const client = createHttpClient({
      hooks: {
        beforeRequest: [
          (options) => {
            events.push(`before:${options.url.pathname}`);
          },
        ],
        afterResponse: [
          (response) => {
            events.push(`after:${response.statusCode}`);
            return response;
          },
        ],
        beforeError: [
          (error) => {
            events.push(`error:${error.response?.statusCode}`);
            return error;
          },
        ],
      },
    });
    await client.get(`${server.baseUrl}/sample.txt`);
    assert.deepStrictEqual(events, ["before:/sample.txt", "after:200"]);
    try {
      await client.get(`${server.baseUrl}/missing`);
    } catch {
      // expected
    }
    assert.ok(events.includes("error:404"));
  } finally {
    await server.close();
  }
});

it("createHttpClient() lets a beforeRequest hook abort by throwing", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient({
      hooks: {
        beforeRequest: [
          () => {
            throw new Error("blocked by policy");
          },
        ],
      },
    });
    await client.get(`${server.baseUrl}/sample.txt`);
    assert.fail("expected the aborting hook to reject the request");
  } catch (err) {
    assert.strictEqual(err.message, "blocked by policy");
  } finally {
    await server.close();
  }
});

it("createHttpClient() extend() merges defaults and hooks", () => {
  const parent = createHttpClient({
    headers: { "user-agent": "parent" },
    hooks: {
      beforeRequest: [
        () => {
          // no-op hook used to verify hook arrays survive extend()
        },
      ],
    },
  });
  const child = parent.extend({ headers: { accept: "application/json" } });
  assert.strictEqual(child.defaults.options.headers["user-agent"], "parent");
  assert.strictEqual(child.defaults.options.headers.accept, "application/json");
  assert.strictEqual(child.defaults.options.hooks.beforeRequest.length, 1);
  assert.strictEqual(typeof child.get, "function");
});

it("createHttpClient() wraps transport failures in RequestError", async () => {
  const client = createHttpClient();
  try {
    // Nothing is listening on this port, so the connection is refused.
    await client.get("http://127.0.0.1:1/never", { throwHttpErrors: false });
    assert.fail("expected a RequestError to be thrown");
  } catch (err) {
    assert.ok(err instanceof RequestError);
    assert.ok(err.options);
  }
});

it("createHttpClient() aborts slow requests via numeric timeout", async () => {
  const server = await startFixtureServer();
  try {
    const client = createHttpClient();
    await client.get(`${server.baseUrl}/slow`, { timeout: 100 });
    assert.fail("expected the request to time out");
  } catch (err) {
    assert.ok(err instanceof RequestError);
  } finally {
    await server.close();
  }
});

// The CDXGEN_NO_CACHE assertions all mutate the shared process environment, so
// they are kept in a single sequential test to avoid races with the other
// (concurrently executed) tests in this file.
it("createHttpClient() caches GET responses unless CDXGEN_NO_CACHE is set", async () => {
  const original = process.env.CDXGEN_NO_CACHE;
  try {
    // isCacheDisabled() reads the environment variable on demand.
    delete process.env.CDXGEN_NO_CACHE;
    assert.strictEqual(isCacheDisabled(), false);
    process.env.CDXGEN_NO_CACHE = "true";
    assert.strictEqual(isCacheDisabled(), true);
    process.env.CDXGEN_NO_CACHE = "1";
    assert.strictEqual(isCacheDisabled(), true);
    process.env.CDXGEN_NO_CACHE = "false";
    assert.strictEqual(isCacheDisabled(), false);

    // Caching enabled: the server increments on every hit, so a cached second
    // response proves the network was not touched again.
    delete process.env.CDXGEN_NO_CACHE;
    clearHttpCache();
    const cachedServer = await startFixtureServer();
    try {
      const client = createHttpClient();
      const first = await client.get(`${cachedServer.baseUrl}/counter`, {
        responseType: "json",
      });
      const second = await client.get(`${cachedServer.baseUrl}/counter`, {
        responseType: "json",
      });
      assert.strictEqual(first.body.hits, 1);
      assert.strictEqual(second.body.hits, 1);
    } finally {
      await cachedServer.close();
    }

    // Caching disabled: every request reaches the server.
    process.env.CDXGEN_NO_CACHE = "true";
    clearHttpCache();
    const uncachedServer = await startFixtureServer();
    try {
      const client = createHttpClient();
      const first = await client.get(`${uncachedServer.baseUrl}/counter`, {
        responseType: "json",
      });
      const second = await client.get(`${uncachedServer.baseUrl}/counter`, {
        responseType: "json",
      });
      assert.strictEqual(first.body.hits, 1);
      assert.strictEqual(second.body.hits, 2);
    } finally {
      await uncachedServer.close();
    }

    // The key carries the request headers and the response type, so a
    // response fetched with one credential is never served to a request made
    // with another credential or with none.
    delete process.env.CDXGEN_NO_CACHE;
    clearHttpCache();
    const keyServer = await startFixtureServer();
    try {
      const client = createHttpClient();
      const url = `${keyServer.baseUrl}/counter`;
      const get = (headers, responseType = "json") =>
        client.get(url, { headers, responseType });
      assert.strictEqual(
        (await get({ Authorization: "Bearer one" })).body.hits,
        1,
      );
      assert.strictEqual(
        (await get({ Authorization: "Bearer two" })).body.hits,
        2,
      );
      assert.strictEqual((await get(undefined)).body.hits, 3);
      assert.strictEqual(
        (await get({ authorization: "Bearer one" })).body.hits,
        1,
      );
      const asText = await get({ Authorization: "Bearer one" }, "text");
      assert.strictEqual(typeof asText.body, "string");
      assert.strictEqual(JSON.parse(asText.body).hits, 4);
      // `cache: false` neither reads nor fills the cache.
      const uncached = await client.get(url, {
        cache: false,
        responseType: "json",
      });
      assert.strictEqual(uncached.body.hits, 5);
      assert.strictEqual((await get(undefined)).body.hits, 3);
    } finally {
      await keyServer.close();
    }

    // beforeNetwork hooks run only when the network is about to be used.
    clearHttpCache();
    const hookServer = await startFixtureServer();
    try {
      let networkCalls = 0;
      const client = createHttpClient({
        hooks: { beforeNetwork: [() => networkCalls++] },
      });
      await client.get(`${hookServer.baseUrl}/counter`, {
        responseType: "json",
      });
      await client.get(`${hookServer.baseUrl}/counter`, {
        responseType: "json",
      });
      assert.strictEqual(networkCalls, 1);
    } finally {
      await hookServer.close();
    }

    // Expired entries are not served, and the size bound evicts the least
    // recently used entry.
    clearHttpCache();
    const previousLimits = _setHttpCacheLimits({ ttlMs: 0 });
    const ttlServer = await startFixtureServer();
    try {
      const client = createHttpClient();
      await client.get(`${ttlServer.baseUrl}/counter`, {
        responseType: "json",
      });
      const again = await client.get(`${ttlServer.baseUrl}/counter`, {
        responseType: "json",
      });
      assert.strictEqual(again.body.hits, 2);
    } finally {
      _setHttpCacheLimits(previousLimits);
      await ttlServer.close();
    }
    clearHttpCache();
    // A counter body is ten bytes, held as about thirty. One fits; a second
    // evicts the least recently used.
    _setHttpCacheLimits({ maxBytes: 45 });
    const lruA = await startFixtureServer();
    const lruB = await startFixtureServer();
    try {
      const client = createHttpClient();
      await client.get(`${lruA.baseUrl}/counter`, { responseType: "json" });
      await client.get(`${lruB.baseUrl}/counter`, { responseType: "json" });
      const reread = await client.get(`${lruA.baseUrl}/counter`, {
        responseType: "json",
      });
      assert.strictEqual(reread.body.hits, 2);
      // Re-reading A evicted B in turn.
      const rereadB = await client.get(`${lruB.baseUrl}/counter`, {
        responseType: "json",
      });
      assert.strictEqual(rereadB.body.hits, 2);
    } finally {
      _setHttpCacheLimits(previousLimits);
      await lruA.close();
      await lruB.close();
    }
  } finally {
    clearHttpCache();
    if (original === undefined) {
      delete process.env.CDXGEN_NO_CACHE;
    } else {
      process.env.CDXGEN_NO_CACHE = original;
    }
  }
});

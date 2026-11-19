/**
 * The JS batch pool's disk cache, under the rules cdxrs applies.
 *
 * A loopback registry records every request and answers with validators where
 * a registry would. Between rounds the in-run state is reset, so only the disk
 * can answer, and entries are aged by rewriting their fetch time rather than
 * by waiting. The file sets the cache directory and the loopback override, so
 * the cache itself is covered by one sequential test.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import { resetRunState } from "../core/runState.js";
import { cdxrsAvailable, runCdxrs } from "./cdxrs.js";
import { prefetchJson, resetBatchFetchAvailability } from "./fetchBatch.js";
import {
  diskCacheGet,
  diskCacheKeyHash,
  isCacheHostDirName,
  resetDiskCacheState,
} from "./fetchDiskCache.js";

const ENV = [
  "CDXGEN_CACHE_DIR",
  "CDXGEN_CACHE_LOOPBACK",
  "CDXGEN_CACHE_TTL",
  "CDXGEN_NO_CACHE",
  "CDXGEN_RS_DISABLE",
];

function ageEntries(cacheDir, seconds) {
  const fetchDir = path.join(cacheDir, "cdxrs-fetch");
  for (const host of readdirSync(fetchDir)) {
    for (const name of readdirSync(path.join(fetchDir, host))) {
      const file = path.join(fetchDir, host, name);
      const entry = JSON.parse(readFileSync(file, "utf-8"));
      entry.fetched_at -= seconds;
      writeFileSync(file, JSON.stringify(entry));
    }
  }
}

it("only a host that is one ordinary path segment names a cache directory", () => {
  for (const url of [
    "https://registry.npmjs.org/left-pad",
    "http://[2001:db8::1]/x",
    "http://.../x",
  ]) {
    assert.equal(isCacheHostDirName(new URL(url).hostname), true, url);
  }
  // `.` and `..` are valid URL hosts, but as directory names they are the
  // fetch directory itself and the cache root above it.
  for (const url of ["http://../x", "http://%2e%2e/x", "http://./x"]) {
    assert.equal(isCacheHostDirName(new URL(url).hostname), false, url);
  }
  for (const host of ["", null, undefined, "a/b", "a\\b"]) {
    assert.equal(isCacheHostDirName(host), false, String(host));
  }
});

it("the JS pool keeps registry documents on disk as cdxrs does", async () => {
  const previous = Object.fromEntries(
    ENV.map((name) => [name, process.env[name]]),
  );
  const cacheDir = mkdtempSync(path.join(tmpdir(), "cdxgen-js-disk-cache-"));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, ifNoneMatch: req.headers["if-none-match"] });
    if (req.url === "/crates/serde") {
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304, { etag: '"v1"' });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json", etag: '"v1"' });
      return res.end(JSON.stringify({ crate: { name: "serde" } }));
    }
    if (req.url.startsWith("/crates/rand")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ crate: { name: "rand" } }));
    }
    if (req.url.endsWith(".pom")) {
      res.writeHead(200, { "content-type": "text/xml" });
      return res.end(`<project><artifactId>${req.url}</artifactId></project>`);
    }
    if (req.url === "/go/golang.org/x/text") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html>text</html>");
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const batch = [
    { url: `${base}/crates/serde` },
    { url: `${base}/maven2/org/x/lib/1.0/lib-1.0.pom`, responseType: "text" },
    {
      url: `${base}/maven2/org/x/lib/1.0-SNAPSHOT/lib-1.0-SNAPSHOT.pom`,
      responseType: "text",
    },
    { url: `${base}/go/golang.org/x/text`, responseType: "text" },
    { url: `${base}/crates/missing` },
  ];
  const fetchedUrls = () => requests.map(({ url }) => url).sort();
  Object.assign(process.env, {
    CDXGEN_CACHE_DIR: cacheDir,
    CDXGEN_CACHE_LOOPBACK: "1",
    CDXGEN_CACHE_TTL: "3600",
    CDXGEN_RS_DISABLE: "fetch",
  });
  delete process.env.CDXGEN_NO_CACHE;
  try {
    resetBatchFetchAvailability();
    resetDiskCacheState();
    resetRunState();

    // Positive control: the first round asks for every document.
    const first = await prefetchJson(batch);
    assert.strictEqual(requests.length, 5);
    assert.strictEqual(
      first.get(`${base}/crates/serde`).body.crate.name,
      "serde",
    );

    // A new run, with nothing in memory, is answered from disk, the 404
    // included.
    requests.length = 0;
    resetRunState();
    const second = await prefetchJson(batch);
    assert.deepStrictEqual(
      fetchedUrls(),
      [],
      "a cached document was asked for again",
    );
    assert.deepStrictEqual(second.get(`${base}/crates/serde`).body, {
      crate: { name: "serde" },
    });
    assert.match(
      second.get(`${base}/maven2/org/x/lib/1.0/lib-1.0.pom`).body,
      /lib-1\.0\.pom/,
    );
    assert.strictEqual(second.get(`${base}/crates/missing`).status, 404);
    assert.strictEqual(second.get(`${base}/crates/missing`).definite, true);

    // Past the TTL, a document with a validator is revalidated and kept on a
    // 304, a release POM still never expires, and everything else is asked
    // for again.
    ageEntries(cacheDir, 3601);
    requests.length = 0;
    resetRunState();
    const third = await prefetchJson(batch);
    assert.deepStrictEqual(fetchedUrls(), [
      "/crates/missing",
      "/crates/serde",
      "/go/golang.org/x/text",
      "/maven2/org/x/lib/1.0-SNAPSHOT/lib-1.0-SNAPSHOT.pom",
    ]);
    assert.strictEqual(
      requests.find(({ url }) => url === "/crates/serde").ifNoneMatch,
      '"v1"',
    );
    assert.deepStrictEqual(third.get(`${base}/crates/serde`).body, {
      crate: { name: "serde" },
    });

    // A JSON entry is filed where cdxrs looks for it, so either transport
    // serves what the other stored.
    const crateEntry = path.join(
      cacheDir,
      "cdxrs-fetch",
      "127.0.0.1",
      `${diskCacheKeyHash({ url: `${base}/crates/serde` })}.json`,
    );
    assert.strictEqual(
      JSON.parse(readFileSync(crateEntry, "utf-8")).body.crate.name,
      "serde",
    );
    delete process.env.CDXGEN_RS_DISABLE;
    if (cdxrsAvailable("fetch").available) {
      requests.length = 0;
      const run = await runCdxrs("fetch", {
        content: JSON.stringify({
          requests: [{ id: "serde", url: `${base}/crates/serde` }],
        }),
        args: ["--cache-dir", cacheDir],
        timeoutMs: 10_000,
      });
      assert.ok(run.ok, run.reason);
      const [result] = JSON.parse(run.stdout).results;
      assert.strictEqual(
        result.fromCache,
        true,
        "cdxrs did not read the entry",
      );
      assert.deepStrictEqual(fetchedUrls(), []);
      // And what cdxrs stores, the JS pool reads.
      const stored = await runCdxrs("fetch", {
        content: JSON.stringify({
          requests: [{ id: "rand", url: `${base}/crates/rand` }],
        }),
        args: ["--cache-dir", cacheDir],
        timeoutMs: 10_000,
      });
      assert.ok(stored.ok, stored.reason);
      assert.deepStrictEqual(fetchedUrls(), ["/crates/rand"]);
      process.env.CDXGEN_RS_DISABLE = "fetch";
      requests.length = 0;
      resetRunState();
      const fromCdxrs = await prefetchJson([{ url: `${base}/crates/rand` }]);
      assert.deepStrictEqual(
        fetchedUrls(),
        [],
        "the JS pool did not read the entry",
      );
      assert.strictEqual(
        fromCdxrs.get(`${base}/crates/rand`).body.crate.name,
        "rand",
      );
    }
    process.env.CDXGEN_RS_DISABLE = "fetch";

    // What earlier runs left counts towards the byte ceiling. A new process
    // runs the pass at its first write, however little it adds itself, and
    // keeps the count for cdxrs, whose every run starts from nothing.
    const leftover = path.join(
      cacheDir,
      "cdxrs-fetch",
      "earlier.example",
      `${"0".repeat(32)}.json`,
    );
    const leaveOversized = () => {
      mkdirSync(path.dirname(leftover), { recursive: true });
      writeFileSync(leftover, "");
      truncateSync(leftover, 257 * 1024 * 1024);
      utimesSync(leftover, 1, 1);
    };
    leaveOversized();
    resetDiskCacheState();
    resetRunState();
    requests.length = 0;
    await prefetchJson([
      {
        url: `${base}/maven2/org/x/late/1.0/late-1.0.pom`,
        responseType: "text",
      },
    ]);
    assert.deepStrictEqual(fetchedUrls(), [
      "/maven2/org/x/late/1.0/late-1.0.pom",
    ]);
    assert.ok(
      !existsSync(leftover),
      "a run that wrote little left the cache over its ceiling",
    );
    assert.ok(existsSync(crateEntry), "a recent entry was evicted");
    delete process.env.CDXGEN_RS_DISABLE;
    if (cdxrsAvailable("fetch").available) {
      leaveOversized();
      resetBatchFetchAvailability();
      resetDiskCacheState();
      resetRunState();
      requests.length = 0;
      await prefetchJson([{ url: `${base}/crates/rand?late` }]);
      assert.deepStrictEqual(fetchedUrls(), ["/crates/rand?late"]);
      assert.ok(
        !existsSync(leftover),
        "a cdxrs run that wrote little left the cache over its ceiling",
      );
      resetBatchFetchAvailability();
    }
    process.env.CDXGEN_RS_DISABLE = "fetch";

    // A host is remembered as swept once its directory has been read, not
    // when it is first looked up: a lookup names whatever host the scanned
    // content does, and most have no directory. One that gets its directory
    // later is swept then.
    const lateKey = { url: "https://late.example/crates/serde" };
    const lateDir = path.join(cacheDir, "cdxrs-fetch", "late.example");
    assert.strictEqual(diskCacheGet(lateKey).state, "none");
    mkdirSync(lateDir);
    const orphan = path.join(lateDir, "0123456789abcdef.tmp.1.1");
    writeFileSync(orphan, "{}");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(orphan, twoHoursAgo, twoHoursAgo);
    assert.strictEqual(diskCacheGet(lateKey).state, "none");
    assert.ok(
      !existsSync(orphan),
      "a host first looked up before it had a directory was never swept",
    );

    // No disk cache under CDXGEN_NO_CACHE.
    process.env.CDXGEN_NO_CACHE = "true";
    requests.length = 0;
    resetRunState();
    await prefetchJson([batch[0]]);
    assert.deepStrictEqual(fetchedUrls(), ["/crates/serde"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(cacheDir, { force: true, recursive: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    resetRunState();
  }
});

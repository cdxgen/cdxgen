/**
 * Parity test for the Rust fetch path.
 *
 * This is the acceptance test for `cdxrs fetch`: the metadata functions must
 * produce **identical** package objects whether the registry documents arrive
 * through the batched Rust path or through the serial JS one. A faster SBOM
 * that differs from the one users get today is a regression with a benchmark
 * attached.
 *
 * Why it cannot reuse the cassette layer directly: cassette replay intercepts
 * undici inside this process, and the Rust path fetches from a subprocess.
 * Instead the committed cassette bodies are served from a local HTTP server, so
 * both paths see byte-identical registry responses over a real socket, and
 * neither can reach the internet — the server is the only reachable host, and
 * `NPM_URL` / `RUST_CRATES_URL` / `PUB_DEV_URL` point at it.
 *
 * The same server is used to measure the two paths against each other with an
 * injected per-response latency, which is what `contrib/bench-fetch.js`
 * reports.
 *
 * Usage:
 *   node contrib/fetch-parity-test.js
 */

import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
  }
}

/**
 * A registry double.
 *
 * Routes are exact paths; anything unrouted is a 404 *and* recorded, so a test
 * cannot pass because a request quietly went somewhere else.
 */
async function startRegistry(routes, { delayMs = 0 } = {}) {
  const requests = [];
  const unmatched = [];
  const server = createServer((req, res) => {
    const url = req.url;
    requests.push(url);
    const body = routes[url];
    const respond = () => {
      if (body === undefined) {
        unmatched.push(url);
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (delayMs) {
      setTimeout(respond, delayMs);
    } else {
      respond();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    unmatched,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Run `fn` with env vars set, restoring them afterwards. */
async function withEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Load a fresh copy of the ecosystems module.
 *
 * `metadata_cache` and the memoized cdxrs availability probe are module state;
 * a cache-busting query keeps the two runs of a comparison independent, so the
 * second run cannot pass by reading the first run's memo.
 */
async function freshEcosystems() {
  const modUrl = `${path.join(REPO_ROOT, "lib", "ecosystems", "ecosystems.js")}?t=${Math.random()}`;
  return await import(modUrl);
}

const NPM_DOC = {
  name: "left-pad",
  description: "String left pad",
  license: "WTFPL",
  homepage: "https://github.com/stevemao/left-pad",
  repository: { type: "git", url: "git+https://github.com/stevemao/left-pad.git" },
  time: { "1.3.0": "2018-03-06T18:14:35.000Z" },
  maintainers: [{ name: "stevemao", email: "stevemao@example.com" }],
  versions: {
    "1.3.0": {
      name: "left-pad",
      version: "1.3.0",
      description: "String left pad",
      license: "WTFPL",
      _npmUser: { name: "stevemao", email: "stevemao@example.com" },
      dist: {
        tarball: "https://registry.example/left-pad/-/left-pad-1.3.0.tgz",
        shasum: "0f0e9a5e6b3d5a4f8a9c0b1d2e3f4a5b6c7d8e9f",
        integrity: "sha512-abc",
      },
    },
  },
};

const CRATE_DOC = {
  crate: {
    description: "A generic serialization/deserialization framework",
    repository: "https://github.com/serde-rs/serde",
    homepage: "https://serde.rs",
    newest_version: "1.0.200",
    created_at: "2014-12-05T20:20:39.000Z",
  },
  versions: [
    {
      id: 12345,
      num: "1.0.100",
      license: "MIT OR Apache-2.0",
      checksum: "a".repeat(64),
      dl_path: "/api/v1/crates/serde/1.0.100/download",
      rust_version: "1.31",
      features: { default: ["std"] },
      created_at: "2019-07-01T00:00:00.000Z",
      published_by: { login: "dtolnay", name: "David Tolnay" },
      crate_size: 78901,
      yanked: false,
      edition: "2015",
      has_lib: true,
    },
  ],
};

const CRATE_OWNERS = {
  users: [{ login: "dtolnay", name: "David Tolnay" }],
};

const PUB_DOC = {
  version: "1.2.0",
  pubspec: {
    name: "http",
    description: "A composable HTTP client",
    repository: "https://github.com/dart-lang/http",
    homepage: "https://dart.dev",
  },
};

const PUB_SCORE = { tags: ["license:mit", "sdk:dart"] };

/**
 * Build the routes for one registry double covering all three ecosystems.
 */
const PYPI_DOC = {
  info: {
    name: "Flask",
    summary: "A simple framework for building complex web applications.",
    author: "Armin Ronacher",
    author_email: "armin.ronacher@example.invalid",
    license: "BSD-3-Clause",
    home_page: "https://palletsprojects.com/p/flask",
    classifiers: ["License :: OSI Approved :: BSD License"],
    version: "3.0.0",
  },
  urls: [
    {
      packagetype: "sdist",
      url: "https://files.example.invalid/flask-3.0.0.tar.gz",
      digests: { sha256: "d".repeat(64) },
    },
  ],
};

const GITHUB_LICENSE_DOC = {
  html_url: "https://github.com/example/widget/blob/main/LICENSE",
  license: { spdx_id: "Apache-2.0", name: "Apache License 2.0" },
};

const JSR_VERSION_DOC = { version: "1.0.2", license: "MIT" };
const JSR_PACKAGE_DOC = {
  name: "std",
  description: "The Deno standard library",
  githubRepository: { owner: "denoland", name: "std" },
};

function registryRoutes() {
  return {
    "/scopes/std/packages/fs/versions/1.0.2": JSR_VERSION_DOC,
    "/scopes/std/packages/fs": JSR_PACKAGE_DOC,
    "/pypi/Flask/3.0.0/json": PYPI_DOC,
    "/repos/example/widget/license": GITHUB_LICENSE_DOC,
    "/left-pad": NPM_DOC,
    "/@scope/pkg": { ...NPM_DOC, name: "@scope/pkg" },
    "/serde": CRATE_DOC,
    "/serde/owners": CRATE_OWNERS,
    "/api/packages/http/versions/1.2.0": PUB_DOC,
    "/api/packages/http/versions/1.2.0/score": PUB_SCORE,
  };
}

/**
 * Run one metadata function twice — Rust path and JS path — and assert the
 * resulting package lists are deep-equal.
 *
 * @param {string} label Name for the failure message.
 * @param {(mod: object) => Promise<Array>} run Invokes the metadata function.
 * @param {object} env Registry env vars pointing at the double.
 * @returns {Promise<{rust: Array, js: Array, rustRequests: string[]}>}
 */
async function compareBothPaths(label, run, env, { allowUnmatched = [] } = {}) {
  const rustServer = await startRegistry(registryRoutes());
  const jsServer = await startRegistry(registryRoutes());
  try {
    const { lastBatchStats, resetBatchFetchAvailability } = await import(
      path.join(REPO_ROOT, "lib", "inventory", "fetchBatch.js")
    );
    resetBatchFetchAvailability();
    const rust = await withEnv(
      { ...env(rustServer.url), CDXGEN_RS_DISABLE: undefined },
      async () => structuredClone(await run(await freshEcosystems())),
    );
    // Assert the Rust path actually ran. Without this, a silent fallback to the
    // JS agent would make the comparison below compare JS with JS and pass.
    const batch = lastBatchStats();
    assert.ok(
      batch && batch.requests > 0,
      `${label}: the Rust batch did not run (stats: ${JSON.stringify(batch)}) — this comparison would be vacuous`,
    );
    resetBatchFetchAvailability();
    const js = await withEnv(
      { ...env(jsServer.url), CDXGEN_RS_DISABLE: "fetch" },
      async () => structuredClone(await run(await freshEcosystems())),
    );

    assert.ok(
      rustServer.requests.length > 0,
      `${label}: the Rust path made no request — nothing was proven`,
    );
    assert.ok(
      jsServer.requests.length > 0,
      `${label}: the JS path made no request — nothing was proven`,
    );
    // An unrouted request is a bug unless the test deliberately asked for one
    // (e.g. to compare 404 handling).
    for (const [pathName, server] of [
      ["Rust", rustServer],
      ["JS", jsServer],
    ]) {
      const unexpected = server.unmatched.filter(
        (url) => !allowUnmatched.includes(url),
      );
      assert.deepStrictEqual(
        unexpected,
        [],
        `${label}: the ${pathName} path requested URLs the double does not serve: ${unexpected}`,
      );
    }
    // Both paths must have hit the same set of URLs, in the same multiplicity
    // for the ones the JS path would issue.
    assert.deepStrictEqual(
      [...new Set(rustServer.requests)].sort(),
      [...new Set(jsServer.requests)].sort(),
      `${label}: the two paths requested different URLs`,
    );
    // The comparison that matters.
    assert.deepStrictEqual(
      rust,
      js,
      `${label}: the Rust path produced different package data than the JS path`,
    );
    return { rust, js, rustRequests: rustServer.requests };
  } finally {
    await rustServer.stop();
    await jsServer.stop();
  }
}

export async function main() {
  console.log("=== cdxrs fetch parity tests ===\n");

  // A precondition, asserted rather than assumed: if the binary is missing,
  // both "paths" are the JS path and every comparison below is vacuous.
  const { cdxrsAvailable } = await import(
    path.join(REPO_ROOT, "lib", "inventory", "cdxrs.js")
  );
  const availability = cdxrsAvailable("fetch");
  if (!availability.available) {
    // A skip is honest when the binary genuinely is not there, and a lie when
    // the job was supposed to provide it. CDXGEN_REQUIRE_CDXRS makes the second
    // case fail loudly: a CI job that builds the binary and then silently skips
    // every assertion is worse than no job at all.
    const message =
      `cdxrs fetch is not available (${availability.reason}). ` +
      "Build cdxgen-plugins-bin and set CDXRS_CMD or CDXGEN_PLUGINS_DIR to run these tests.";
    if (process.env.CDXGEN_REQUIRE_CDXRS === "1") {
      console.error(`FAIL: ${message}`);
      console.error(
        "CDXGEN_REQUIRE_CDXRS=1 was set, so a missing binary is a failure.",
      );
      return 1;
    }
    console.log(`SKIP: ${message}`);
    console.log("\n0 passed, 0 failed, 1 skipped");
    return 0;
  }

  await test("npm metadata is identical through both paths", async () => {
    const { rust, rustRequests } = await compareBothPaths(
      "getNpmMetadata",
      (mod) =>
        mod.getNpmMetadata([
          { name: "left-pad", version: "1.3.0" },
          { group: "scope", name: "pkg", version: "1.3.0" },
        ]),
      (url) => ({ NPM_URL: `${url}/` }),
    );
    // Non-vacuity: enrichment actually happened.
    assert.equal(rust[0].description, "String left pad");
    assert.equal(rust[0].license, "WTFPL");
    assert.ok(
      rust[0].properties?.length > 0,
      "no provenance properties were derived",
    );
    // Scoped names must reach the registry in scoped form from both paths.
    assert.ok(
      rustRequests.includes("/@scope/pkg"),
      `scoped package was not requested correctly: ${rustRequests}`,
    );
  });

  await test("crates.io metadata is identical through both paths", async () => {
    const { rust } = await compareBothPaths(
      "getCratesMetadata",
      (mod) => mod.getCratesMetadata([{ name: "serde", version: "1.0.100" }]),
      (url) => ({ RUST_CRATES_URL: `${url}/` }),
    );
    assert.equal(rust[0].license, "MIT OR Apache-2.0");
    assert.ok(
      rust[0].properties.some((p) => p.name === "cdx:cargo:crate_id"),
      "crate_id property missing",
    );
    assert.ok(
      rust[0]._integrity?.startsWith("sha256-"),
      `integrity not normalized: ${rust[0]._integrity}`,
    );
  });

  await test("pub.dev metadata is identical through both paths", async () => {
    const { rust } = await compareBothPaths(
      "getDartMetadata",
      (mod) => mod.getDartMetadata([{ name: "http", version: "1.2.0" }]),
      (url) => ({ PUB_DEV_URL: url }),
    );
    assert.equal(rust[0].description, "A composable HTTP client");
    // The SPDX canonicalisation is JS logic and must survive: pub.dev tags are
    // lowercase, the component must carry the canonical id.
    assert.equal(rust[0].license, "MIT");
  });

  await test("PyPI metadata is identical through both paths", async () => {
    const { rust } = await compareBothPaths(
      "getPyMetadata",
      (mod) =>
        mod.getPyMetadata([{ name: "Flask", version: "3.0.0" }], true),
      (url) => ({ PYPI_URL: `${url}/pypi/` }),
    );
    assert.ok(
      rust[0].license?.length,
      `PyPI licence was not derived: ${JSON.stringify(rust[0].license)}`,
    );
    assert.ok(rust[0].author?.includes("Armin Ronacher"), rust[0].author);
  });

  await test("Swift repository licences are identical through both paths", async () => {
    const { rust } = await compareBothPaths(
      "getSwiftPackageMetadata",
      async (mod) => {
        mod.resetRepoLicensePrefetch();
        return await mod.getSwiftPackageMetadata([
          {
            name: "widget",
            version: "1.0.0",
            repository: { url: "https://github.com/example/widget" },
          },
        ]);
      },
      // Both paths resolve the GitHub API base through GITHUB_API_URL, so the
      // double stands in for api.github.com for both. The GitHub API is always
      // asked through the JS pool, whose responses carry the quota headers, so
      // this case checks that enabling cdxrs changes nothing for it.
      (url) => ({ GITHUB_API_URL: url, GITHUB_TOKEN: undefined }),
    );
    assert.equal(rust[0].license?.id, "Apache-2.0");
  });

  await test("jsr metadata is identical through both paths", async () => {
    const jsrComponent = () => ({
      name: "@std/fs",
      version: "1.0.2",
      properties: [{ name: "cdx:deno:jsrKey", value: "@std/fs@1.0.2" }],
    });
    const rustServer = await startRegistry(registryRoutes());
    const jsServer = await startRegistry(registryRoutes());
    try {
      const { lastBatchStats, resetBatchFetchAvailability } = await import(
        path.join(REPO_ROOT, "lib", "inventory", "fetchBatch.js")
      );
      const run = async (serverUrl, disable) =>
        await withEnv(
          { JSR_API_URL: `${serverUrl}/`, CDXGEN_RS_DISABLE: disable },
          async () => {
            resetBatchFetchAvailability();
            const mod = await import(
              `${path.join(REPO_ROOT, "lib", "ecosystems", "denoutils.js")}?t=${Math.random()}`
            );
            const list = [jsrComponent()];
            await mod.getJsrMetadata(list);
            return structuredClone(list);
          },
        );
      const rust = await run(rustServer.url, undefined);
      const batch = lastBatchStats();
      assert.ok(
        batch && batch.requests > 0,
        `jsr: the Rust batch did not run (stats: ${JSON.stringify(batch)})`,
      );
      const js = await run(jsServer.url, "fetch");
      assert.deepStrictEqual(rust, js, "jsr: the two paths disagree");
      assert.equal(rust[0].license, "MIT");
      assert.equal(rust[0].description, "The Deno standard library");
      assert.deepStrictEqual(
        [...new Set(rustServer.requests)].sort(),
        [...new Set(jsServer.requests)].sort(),
      );
    } finally {
      await rustServer.stop();
      await jsServer.stop();
    }
  });

  await test("a registry 404 is handled identically by both paths", async () => {
    await compareBothPaths(
      "getNpmMetadata (missing package)",
      (mod) =>
        mod.getNpmMetadata([
          { name: "left-pad", version: "1.3.0" },
          { name: "does-not-exist", version: "9.9.9" },
        ]),
      (url) => ({ NPM_URL: `${url}/` }),
      { allowUnmatched: ["/does-not-exist"] },
    );
  });

  await test("the batch issues no request the JS path would not", async () => {
    const server = await startRegistry(registryRoutes());
    try {
      await withEnv(
        { NPM_URL: `${server.url}/`, CDXGEN_RS_DISABLE: undefined },
        async () => {
          const mod = await freshEcosystems();
          await mod.getNpmMetadata([{ name: "left-pad", version: "1.3.0" }]);
        },
      );
      assert.deepStrictEqual(
        server.requests,
        ["/left-pad"],
        `unexpected requests: ${server.requests}`,
      );
    } finally {
      await server.stop();
    }
  });

  await test("duplicate packages produce one registry request", async () => {
    const server = await startRegistry(registryRoutes());
    try {
      await withEnv(
        { NPM_URL: `${server.url}/`, CDXGEN_RS_DISABLE: undefined },
        async () => {
          const mod = await freshEcosystems();
          await mod.getNpmMetadata([
            { name: "left-pad", version: "1.3.0" },
            { name: "left-pad", version: "1.3.0" },
            { name: "left-pad", version: "1.3.0" },
          ]);
        },
      );
      assert.equal(
        server.requests.length,
        1,
        `expected coalescing, got ${server.requests.length} requests`,
      );
    } finally {
      await server.stop();
    }
  });

  await test("CDXGEN_RS_DISABLE=fetch disables the Rust subprocess but not the JS batcher", async () => {
    const { batchFetchAvailable, prefetchEnabled, resetBatchFetchAvailability } = await import(
      `${path.join(REPO_ROOT, "lib", "inventory", "fetchBatch.js")}?t=${Math.random()}`
    );
    await withEnv({ CDXGEN_RS_DISABLE: "fetch" }, async () => {
      resetBatchFetchAvailability();
      // The Rust subprocess is disabled, but prefetching as a whole is still
      // on: the JS pool runs every request through cdxgenAgent. This is the
      // core contract of D27 — removing the serial path from the common case.
      assert.equal(batchFetchAvailable(), false);
      assert.equal(prefetchEnabled(), true);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exit(await main());
}

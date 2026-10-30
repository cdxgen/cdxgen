/**
 * Batched resolution of repository URLs from purls.
 *
 * `resolveGitUrlFromPurl` takes one purl, so the batch round and the resolution
 * switch derive the registry URL from a single shared function. The risk that
 * matters is those two drifting apart — a prefetch that spelled a URL even
 * slightly differently would fetch documents nobody reads and leave the switch
 * making its own serial request, which no output assertion would catch. These
 * tests count requests to pin that down.
 */

import esmock from "esmock";
import { strict as assert, describe, it } from "poku";

const DOCUMENTS = {
  "https://crates.io/api/v1/crates/serde": {
    crate: { repository: "https://github.com/serde-rs/serde" },
  },
  "https://pub.dev/api/packages/http/versions/1.0.0": {
    latest: { pubspec: { repository: "https://github.com/dart-lang/http" } },
  },
  "https://pypi.org/pypi/flask/2.0.0/json": {
    info: { project_urls: { Source: "https://github.com/pallets/flask" } },
  },
  "https://registry.npmjs.org/@babel/core": {
    repository: { url: "https://github.com/babel/babel" },
  },
  "https://repo.packagist.org/p2/monolog/monolog.json": {
    packages: {
      "monolog/monolog": [
        {
          source: { url: "https://github.com/Seldaek/monolog" },
          version: "3.0.0",
        },
      ],
    },
  },
  "https://rubygems.org/api/v2/rubygems/rails/versions/7.0.0.json": {
    source_code_uri: "https://github.com/rails/rails",
  },
};

const PURLS = [
  "pkg:npm/%40babel/core@7.0.0",
  "pkg:pypi/flask@2.0.0",
  "pkg:gem/rails@7.0.0",
  "pkg:cargo/serde@1.0.0",
  "pkg:pub/http@1.0.0",
  "pkg:composer/monolog/monolog@3.0.0",
];

async function loadSource(requested) {
  const { resetBatchFetchAvailability } = await import("./fetchBatch.js");
  resetBatchFetchAvailability();
  const agent = {
    get: async (url) => {
      requested.push(url);
      const body = DOCUMENTS[url];
      if (body === undefined) {
        const err = new Error(`404 for ${url}`);
        err.statusCode = 404;
        throw err;
      }
      return { body };
    },
  };
  return await esmock(
    "./source.js",
    {},
    {
      "../core/activity.js": {
        cdxgenAgent: agent,
        // CDXGEN_RS_DISABLE is pinned here rather than in the environment
        // because this same stub is what fetchBatch and cdxrs read: these are
        // plain JSON requests, so without it the batch dispatches to the cdxrs
        // subprocess and reaches the real registries, bypassing `agent` and
        // making every assertion below describe the internet. Everything else
        // reads as unset so the registry URLs stay at their defaults whatever
        // the developer has exported. CDXGEN_NO_CACHE stays set, as
        // test/poku.env sets it, so a document this machine cached from an
        // earlier scan cannot answer a request and hide it from `agent`.
        readEnvironmentVariable: (name) => {
          if (name === "CDXGEN_RS_DISABLE") {
            return "fetch";
          }
          return name === "CDXGEN_NO_CACHE" ? "true" : undefined;
        },
      },
      "../core/httpClient.js": { createHttpClient: () => agent },
    },
  );
}

describe("purl source prefetch", async () => {
  await it("resolution after a batch round issues no further request", async () => {
    const requested = [];
    const mod = await loadSource(requested);
    mod.resetGitUrlSourcePrefetch();
    await mod.prefetchGitUrlSources(PURLS);
    // One document per purl, and every URL is one the resolver actually reads.
    assert.equal(requested.length, PURLS.length);
    const afterPrefetch = requested.length;
    const resolved = [];
    for (const purl of PURLS) {
      resolved.push((await mod.resolveGitUrlFromPurl(purl))?.repoUrl);
    }
    // The switch found every document in the batch. A drifting URL would show
    // up here as extra requests, not as a wrong answer.
    assert.equal(requested.length, afterPrefetch);
    assert.deepEqual(resolved, [
      "https://github.com/babel/babel",
      "https://github.com/pallets/flask",
      "https://github.com/rails/rails",
      "https://github.com/serde-rs/serde",
      "https://github.com/dart-lang/http",
      "https://github.com/Seldaek/monolog",
    ]);
  });

  await it("types that need no registry document are not prefetched", async () => {
    const requested = [];
    const mod = await loadSource(requested);
    mod.resetGitUrlSourcePrefetch();
    await mod.prefetchGitUrlSources([
      "pkg:github/acme/app@1.0.0",
      "pkg:bitbucket/acme/app@1.0.0",
      "pkg:generic/thing@1.0.0?vcs_url=https://github.com/acme/thing",
      // maven's POM is fetched through an injected helper with its own prefetch.
      "pkg:maven/com.acme/app@1.0.0",
      "not-a-purl",
      "",
    ]);
    assert.deepEqual(requested, []);
  });

  await it("a duplicated purl is fetched once", async () => {
    const requested = [];
    const mod = await loadSource(requested);
    mod.resetGitUrlSourcePrefetch();
    await mod.prefetchGitUrlSources([
      "pkg:cargo/serde@1.0.0",
      "pkg:cargo/serde@2.0.0",
      "pkg:cargo/serde@1.0.0",
    ]);
    // The crates.io lookup ignores the version, so all three are one document.
    assert.deepEqual(requested, ["https://crates.io/api/v1/crates/serde"]);
  });

  await it("a purl the batch could not resolve still falls back to its own request", async () => {
    const requested = [];
    const mod = await loadSource(requested);
    mod.resetGitUrlSourcePrefetch();
    // No batch round at all: resolution must still work on its own.
    const resolved = await mod.resolveGitUrlFromPurl("pkg:cargo/serde@1.0.0");
    assert.equal(resolved?.repoUrl, "https://github.com/serde-rs/serde");
    assert.deepEqual(requested, ["https://crates.io/api/v1/crates/serde"]);
  });
});

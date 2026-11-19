/**
 * The ambient GITHUB_TOKEN is part of what a cached answer is keyed on.
 *
 * Both transports attach the token on their own, after the caller has built
 * its request. GitHub is played by a stubbed agent that releases a private
 * repository to one token only, and the cdxrs bridge is stubbed to record the
 * realm it is handed. Between rounds the in-run state is reset, so only the
 * disk can answer. The file sets GITHUB_TOKEN and the cache directory, so it
 * holds one sequential test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";

import * as activity from "../core/activity.js";
import { resetRunState } from "../core/runState.js";
import { resetDiskCacheState } from "./fetchDiskCache.js";

const ENV = [
  "CDXGEN_ALLOWED_HOSTS",
  "CDXGEN_CACHE_DIR",
  "CDXGEN_NO_CACHE",
  "GITHUB_TOKEN",
];

function httpError(status) {
  const err = new Error(`Response code ${status}`);
  err.name = "HTTPError";
  err.response = { statusCode: status, headers: {} };
  return err;
}

it("an answer obtained with GITHUB_TOKEN is cached for that token only", async () => {
  const previous = Object.fromEntries(
    ENV.map((name) => [name, process.env[name]]),
  );
  const cacheDir = mkdtempSync(path.join(tmpdir(), "cdxgen-cache-realm-"));
  const owner = "ghp_owner";
  const seen = [];
  const get = async (_url, options) => {
    const authorization = options.headers?.Authorization;
    seen.push(authorization);
    if (authorization !== `Bearer ${owner}`) {
      throw httpError(404);
    }
    return { statusCode: 200, headers: {}, body: { description: "private" } };
  };
  let cdxrs = false;
  const payloads = [];
  const mod = await esmock("./fetchBatch.js", {
    "../core/activity.js": { ...activity, cdxgenAgent: { get } },
    "./cdxrs.js": {
      cdxrsAvailable: () => ({ available: cdxrs }),
      cdxrsDisabled: () => !cdxrs,
      runCdxrs: async (_subcommand, opts) => {
        const { requests } = JSON.parse(opts.content);
        payloads.push(...requests);
        return {
          ok: true,
          stdout: JSON.stringify({
            schemaVersion: 1,
            results: requests.map(({ id }) => ({ id, ok: true, body: {} })),
          }),
        };
      },
    },
  });
  const lookup = async (url, token) => {
    if (token) {
      process.env.GITHUB_TOKEN = token;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    seen.length = 0;
    payloads.length = 0;
    resetRunState();
    return (await mod.prefetchJson([{ url, ambientGitHubAuth: true }])).get(
      url,
    );
  };
  process.env.CDXGEN_CACHE_DIR = cacheDir;
  delete process.env.CDXGEN_ALLOWED_HOSTS;
  delete process.env.CDXGEN_NO_CACHE;
  try {
    mod.resetBatchFetchAvailability();
    resetDiskCacheState();
    const billing = "https://api.github.com/repos/acme/billing-core";

    // Positive control: the token's owner is answered by GitHub once, and from
    // the disk after that.
    assert.strictEqual(
      (await lookup(billing, owner)).body.description,
      "private",
    );
    assert.deepStrictEqual(seen, [`Bearer ${owner}`]);
    assert.strictEqual(
      (await lookup(billing, owner)).body.description,
      "private",
    );
    assert.deepStrictEqual(seen, [], "the owner's answer was not cached");

    // A run without the token, or with another one, has to ask for itself.
    assert.strictEqual((await lookup(billing, undefined)).ok, false);
    assert.deepStrictEqual(seen, [undefined]);
    assert.strictEqual((await lookup(billing, "ghp_other")).ok, false);
    assert.deepStrictEqual(seen, ["Bearer ghp_other"]);

    // Nor is the 404 an anonymous run was given held against the owner.
    const ledger = "https://api.github.com/repos/acme/ledger";
    assert.strictEqual((await lookup(ledger, undefined)).status, 404);
    assert.strictEqual((await lookup(ledger, undefined)).status, 404);
    assert.deepStrictEqual(seen, [], "the anonymous 404 was not cached");
    assert.strictEqual(
      (await lookup(ledger, owner)).body.description,
      "private",
    );

    // cdxrs keys its cache on the realm it is handed, and sends the token too.
    cdxrs = true;
    mod.resetBatchFetchAvailability();
    const manifest = "https://api.github.com/repos/acme/billing-core/license";
    await lookup(manifest, undefined);
    assert.strictEqual(payloads[0].authRealm, undefined);
    await lookup(manifest, owner);
    const ownerRealm = payloads[0].authRealm;
    assert.ok(ownerRealm, "the token did not reach the realm");
    assert.ok(!ownerRealm.includes(owner), "the realm carries the token");
    await lookup(manifest, "ghp_other");
    assert.notStrictEqual(payloads[0].authRealm, ownerRealm);

    // A host the token is not sent to keeps the key every run shares.
    await lookup("https://registry.npmjs.org/left-pad", owner);
    assert.strictEqual(payloads[0].authRealm, undefined);
  } finally {
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

/**
 * Staged batching of remote CocoaPods podspec lookups.
 *
 * The probe is speculative — up to four URLs per pod — so the property that
 * matters is not "fewer round trips" but "never more requests than the serial
 * probe made". These tests assert the request set exactly.
 *
 * They live in their own file, and inside an awaited `describe`, because one of
 * them mutates COCOA_FULL_SCAN: poku fires `it` calls as fire-and-forget
 * promises, so without both the flag would reach the other two mid-run and they
 * would observe an empty request set.
 */
import process from "node:process";

import esmock from "esmock";
import { strict as assert, describe, it } from "poku";

const BASE = "https://raw.githubusercontent.com/acme";

/** A pod whose podspec location still carries the unresolved default branch. */
function podMetadata(name) {
  return {
    name,
    properties: [
      {
        name: "cdx:pods:podspecLocation",
        value: `${BASE}/${name}/<DEFAULT>/${name}.podspec`,
      },
    ],
    version: "1.0.0",
  };
}

/**
 * Load parsers-misc with an agent that answers only `available`, recording
 * every URL requested.
 */
async function loadWithAgent(available, requested) {
  const agent = {
    get: async (url) => {
      requested.push(url);
      if (!available.has(url)) {
        const err = new Error(`404 for ${url}`);
        err.statusCode = 404;
        throw err;
      }
      return { body: available.get(url) };
    },
  };
  // The mock must be global: the batch pool inside fetchBatch.js has its own
  // import of cdxgenAgent, and a direct-slot mock would leave it reaching the
  // real network while parsers-misc.js used the stub.
  return await esmock(
    "./parsers-misc.js",
    {},
    {
      "../core/activity.js": {
        cdxgenAgent: agent,
        readEnvironmentVariable: (name) => process.env[name],
      },
      "../core/httpClient.js": { createHttpClient: () => agent },
    },
  );
}

describe("cocoapods podspec prefetch", async () => {
  await it("a pod whose podspec is on main costs one request, not four", async () => {
    const available = new Map([
      [`${BASE}/alpha/main/alpha.podspec`, "Pod::Spec.new"],
      [`${BASE}/beta/main/beta.podspec`, "Pod::Spec.new"],
    ]);
    const requested = [];
    const mod = await loadWithAgent(available, requested);
    mod.resetCocoaPodspecPrefetch();
    await mod.prefetchCocoaPodspecs([
      podMetadata("alpha"),
      podMetadata("beta"),
    ]);
    // One round, one URL per pod. The `main.json`, `master` and `master.json`
    // positions are never reached because both pods resolved at the first.
    assert.deepEqual(requested.sort(), [
      `${BASE}/alpha/main/alpha.podspec`,
      `${BASE}/beta/main/beta.podspec`,
    ]);
  });

  await it("a later position is requested only for the pods that missed", async () => {
    // alpha resolves at position 0; beta only at position 2 (the master branch).
    const available = new Map([
      [`${BASE}/alpha/main/alpha.podspec`, "Pod::Spec.new"],
      [`${BASE}/beta/master/beta.podspec`, "Pod::Spec.new"],
    ]);
    const requested = [];
    const mod = await loadWithAgent(available, requested);
    mod.resetCocoaPodspecPrefetch();
    await mod.prefetchCocoaPodspecs([
      podMetadata("alpha"),
      podMetadata("beta"),
    ]);
    // alpha appears once and never again; beta walks the probe order until it
    // hits. This is exactly the set the serial probe would have requested.
    assert.deepEqual(requested, [
      `${BASE}/alpha/main/alpha.podspec`,
      `${BASE}/beta/main/beta.podspec`,
      `${BASE}/beta/main/beta.podspec.json`,
      `${BASE}/beta/master/beta.podspec`,
    ]);
  });

  await it("COCOA_FULL_SCAN=false prefetches nothing", async () => {
    const previous = process.env.COCOA_FULL_SCAN;
    process.env.COCOA_FULL_SCAN = "false";
    const requested = [];
    try {
      const mod = await loadWithAgent(new Map(), requested);
      mod.resetCocoaPodspecPrefetch();
      await mod.prefetchCocoaPodspecs([podMetadata("alpha")]);
      assert.deepEqual(requested, []);
    } finally {
      if (previous === undefined) {
        delete process.env.COCOA_FULL_SCAN;
      } else {
        process.env.COCOA_FULL_SCAN = previous;
      }
    }
  });
});

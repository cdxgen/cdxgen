/**
 * A dry run, secure mode and a host allowlist keep the batch off cdxrs.
 *
 * cdxrs opens its own connections, so only requests made through cdxgenAgent
 * see those policies. The bridge is stubbed as available and records every
 * run it is asked for, and a loopback server records every request that
 * arrives. The file mutates CDXGEN_ALLOWED_HOSTS and the dry-run switch, so it
 * holds one sequential test.
 */
import { createServer } from "node:http";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";

import { setDryRunMode } from "../core/activity.js";

async function loadWithStubbedCdxrs(calls, mocks = {}) {
  return await esmock("./fetchBatch.js", {
    "./cdxrs.js": {
      cdxrsAvailable: () => ({ available: true }),
      cdxrsDisabled: () => false,
      runCdxrs: async (subcommand, opts) => {
        calls.push(subcommand);
        const { requests } = JSON.parse(opts.content);
        return {
          ok: true,
          stdout: JSON.stringify({
            schemaVersion: 1,
            results: requests.map(({ id }) => ({ id, ok: true, body: {} })),
          }),
        };
      },
    },
    ...mocks,
  });
}

it("cdxrs is not used while a network policy is in force", async () => {
  const previous = {
    CDXGEN_ALLOWED_HOSTS: process.env.CDXGEN_ALLOWED_HOSTS,
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
  };
  delete process.env.CDXGEN_ALLOWED_HOSTS;
  delete process.env.CDXGEN_RS_DISABLE;
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
  try {
    const mod = await loadWithStubbedCdxrs(calls);

    // Positive control: with no policy in force, the batch goes to cdxrs.
    await mod.prefetchJson([{ url: `${base}/plain` }]);
    assert.deepStrictEqual(calls, ["fetch"]);

    calls.length = 0;
    setDryRunMode(true);
    try {
      const dry = await mod.prefetchJson([{ url: `${base}/dry` }]);
      assert.deepStrictEqual(calls, [], "a dry run sent its batch to cdxrs");
      assert.strictEqual(dry.get(`${base}/dry`)?.ok, false);
    } finally {
      setDryRunMode(false);
    }

    process.env.CDXGEN_ALLOWED_HOSTS = "example.com";
    try {
      const blocked = await mod.prefetchJson([{ url: `${base}/blocked` }]);
      assert.deepStrictEqual(
        calls,
        [],
        "a host outside the allowlist was fetched through cdxrs",
      );
      assert.strictEqual(blocked.get(`${base}/blocked`)?.ok, false);
    } finally {
      delete process.env.CDXGEN_ALLOWED_HOSTS;
    }
    assert.deepStrictEqual(hits, [], "a blocked request reached the server");

    // Secure mode is fixed when the process starts, so it is mocked here.
    const activity = await import("../core/activity.js");
    const secure = await loadWithStubbedCdxrs(calls, {
      "../core/activity.js": { ...activity, isSecureMode: true },
    });
    await secure.prefetchJson([{ url: `${base}/secure` }]);
    assert.deepStrictEqual(calls, [], "secure mode sent its batch to cdxrs");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

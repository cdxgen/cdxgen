import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// GitHub reports a spent quota as a 403 with nothing remaining and says when
// it resets. The batch has to see those headers, pause the API until then and
// not a minute longer, and the licence prefetch has to stop while lookups are
// paused. cdxrs is stubbed as available, to show the API is still asked
// through the JS pool, whose responses carry headers. GITHUB_TOKEN and
// CDXGEN_RS_DISABLE are process-wide, so this file holds one sequential test.

function httpError(status, headers = {}) {
  const err = new Error(`Response code ${status}`);
  err.name = "HTTPError";
  err.response = { statusCode: status, headers };
  return err;
}

async function load(get, cdxrsRuns) {
  return await esmock(
    "./ecosystems.js",
    {},
    {
      "../core/httpClient.js": {
        createHttpClient: sinon.stub().returns({ get }),
      },
      "../inventory/cdxrs.js": {
        cdxrsAvailable: () => ({ available: true }),
        cdxrsDisabled: () => false,
        runCdxrs: async () => {
          cdxrsRuns.push("fetch");
          return { ok: false, reason: "stubbed" };
        },
      },
    },
  );
}

const repos = Array.from(
  { length: 8 },
  (_, i) => `https://github.com/acme/repo${i}`,
);

it("a spent GitHub quota pauses the API until it resets", async () => {
  const previous = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
  };
  delete process.env.GITHUB_TOKEN;
  delete process.env.CDXGEN_RS_DISABLE;
  const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  const warn = sinon.stub(console, "warn");
  try {
    const resetAt = Math.floor(Date.now() / 1000) + 120;
    let quotaSpent = true;
    const calls = [];
    const get = sinon.stub().callsFake(async (url) => {
      calls.push(url);
      if (quotaSpent) {
        throw httpError(403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetAt),
        });
      }
      return {
        statusCode: 200,
        body: { html_url: url, license: { spdx_id: "MIT", name: "MIT" } },
      };
    });
    const cdxrsRuns = [];
    const mod = await load(get, cdxrsRuns);

    await mod.prefetchRepoLicenses(repos);
    // Positive control: the API was asked, by the JS pool and not by cdxrs.
    assert.ok(calls.length > 0, "the stub recorded no request");
    assert.ok(
      calls.length <= 4,
      `${calls.length} requests after a spent quota`,
    );
    assert.deepStrictEqual(cdxrsRuns, []);
    const warnings = warn.args
      .map((args) => String(args[0]))
      .filter((message) => message.includes("api.github.com"));
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /GITHUB_TOKEN/);

    calls.length = 0;
    await mod.prefetchRepoLicenses(repos);
    for (const repo of repos) {
      assert.strictEqual(await mod.getRepoLicense(repo, undefined), undefined);
    }
    assert.deepStrictEqual(
      calls,
      [],
      "the API was asked again while its quota was spent",
    );

    // Once the quota resets, the API is asked again, without waiting for the
    // ten-minute default pause.
    quotaSpent = false;
    clock.tick(121 * 1000);
    await mod.prefetchRepoLicenses([repos[0]]);
    assert.deepStrictEqual(calls, [
      "https://api.github.com/repos/acme/repo0/license",
    ]);
    assert.strictEqual(
      (await mod.getRepoLicense(repos[0], undefined))?.id,
      "MIT",
    );

    // Five failures that are not a spent quota pause the licence lookups,
    // and the prefetch honours that pause.
    const failing = [];
    const refuse = sinon.stub().callsFake(async (url) => {
      failing.push(url);
      throw httpError(401);
    });
    const paused = await load(refuse, cdxrsRuns);
    for (const repo of repos.slice(0, 5)) {
      await paused.getRepoLicense(repo, undefined);
    }
    assert.strictEqual(failing.length, 5);
    await paused.prefetchRepoLicenses(repos);
    assert.strictEqual(
      failing.length,
      5,
      "the prefetch ignored the paused licence lookups",
    );
  } finally {
    warn.restore();
    clock.restore();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

import { Buffer } from "node:buffer";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// Many components can name one repository, and a licence the GitHub API could
// not classify is searched once per known licence name. Each repository's
// answer is therefore derived once per run, and a licence text far larger
// than any real one is not searched at all. GITHUB_API_URL and
// CDXGEN_RS_DISABLE are process-wide, so this file holds one sequential test.

it("getRepoLicense reads each repository's licence once per run", async () => {
  const previous = {
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
    GITHUB_API_URL: process.env.GITHUB_API_URL,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  process.env.CDXGEN_RS_DISABLE = "fetch";
  delete process.env.GITHUB_API_URL;
  delete process.env.GITHUB_TOKEN;
  const answers = {
    "https://api.github.com/repos/acme/small/license": {
      html_url: "https://github.com/acme/small/blob/main/LICENSE",
      license: { spdx_id: "NOASSERTION", name: "Other" },
      content: Buffer.from("Custom terms, see the website.").toString("base64"),
    },
    "https://api.github.com/repos/acme/known/license": {
      html_url: "https://github.com/acme/known/blob/main/LICENSE",
      license: { spdx_id: "MIT", name: "MIT License" },
    },
    "https://api.github.com/repos/acme/huge/license": {
      html_url: "https://github.com/acme/huge/blob/main/LICENSE",
      license: { spdx_id: "NOASSERTION", name: "Other" },
      content: Buffer.from("x".repeat(300 * 1024)).toString("base64"),
    },
  };
  const get = sinon.stub().callsFake(async (url) => ({
    statusCode: 200,
    body: answers[url],
  }));
  const guessLicenseId = sinon.stub().returns(undefined);
  try {
    const mod = await esmock(
      "./ecosystems.js",
      {
        "../inventory/spdx.js": { guessLicenseId },
      },
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get }),
        },
      },
    );
    mod.resetRepoLicensePrefetch();
    for (let i = 0; i < 50; i++) {
      assert.strictEqual(
        await mod.getRepoLicense(
          `https://github.com/acme/small?ref=v${i}`,
          undefined,
        ),
        undefined,
      );
    }
    assert.strictEqual(guessLicenseId.callCount, 1);

    const first = await mod.getRepoLicense(
      "https://github.com/acme/known",
      undefined,
    );
    assert.deepStrictEqual(first, {
      id: "MIT",
      url: "https://github.com/acme/known/blob/main/LICENSE",
    });
    // Callers assign the answer to a component, so each one gets its own copy.
    first.id = "changed";
    assert.strictEqual(
      (await mod.getRepoLicense("https://github.com/acme/known", undefined))
        ?.id,
      "MIT",
    );

    assert.strictEqual(
      await mod.getRepoLicense("https://github.com/acme/huge", undefined),
      undefined,
    );
    assert.strictEqual(guessLicenseId.callCount, 1);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

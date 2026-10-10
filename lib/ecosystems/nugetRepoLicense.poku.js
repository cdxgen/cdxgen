import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// NuGet's catalog sometimes names a licence only by a GitHub URL, and the
// repository's licence is then the remaining source. That lookup is batched,
// remembered when GitHub has no licence, and never made for a package whose
// catalog entry already names its licence. The environment changes are
// process-wide, so this file holds one sequential test.

const NUGET_URL = "http://127.0.0.1:1/nuget/";
const API = "https://api.github.com/repos";

function index(catalogEntry) {
  return {
    items: [
      {
        lower: "1.0.0",
        upper: "1.0.0",
        items: [{ catalogEntry: { version: "1.0.0", ...catalogEntry } }],
      },
    ],
  };
}

const CATALOG = {
  declared: index({
    licenseExpression: "MIT",
    projectUrl: "https://github.com/acme/declared",
  }),
  "by-url": index({
    licenseUrl: "https://github.com/acme/by-url/blob/main/LICENSE",
    projectUrl: "https://github.com/acme/by-url",
  }),
  unlicensed: index({ projectUrl: "https://github.com/acme/unlicensed" }),
};

it("NuGet asks GitHub only for licences its catalog does not name", async () => {
  const previous = {
    NUGET_URL: process.env.NUGET_URL,
    NUGET_PACKAGES: process.env.NUGET_PACKAGES,
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  const emptyPackages = mkdtempSync(join(tmpdir(), "cdxgen-nuget-empty-"));
  process.env.NUGET_URL = NUGET_URL;
  process.env.NUGET_PACKAGES = emptyPackages;
  process.env.CDXGEN_RS_DISABLE = "fetch";
  delete process.env.GITHUB_TOKEN;
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    const name = url.slice(NUGET_URL.length).split("/")[0];
    if (CATALOG[name]) {
      return { statusCode: 200, body: CATALOG[name] };
    }
    if (url === `${API}/acme/by-url/license`) {
      return {
        statusCode: 200,
        body: {
          html_url: "https://github.com/acme/by-url/blob/main/LICENSE",
          license: { spdx_id: "Apache-2.0", name: "Apache License 2.0" },
        },
      };
    }
    const err = new Error("Response code 404 (Not Found)");
    err.name = "HTTPError";
    err.response = { statusCode: 404, headers: {} };
    throw err;
  });
  try {
    const { getNugetMetadata } = await esmock(
      "./ecosystems.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    const pkgs = () =>
      ["declared", "by-url", "unlicensed"].map((name) => ({
        group: "",
        name,
        version: "1.0.0",
      }));

    const byName = new Map(
      (await getNugetMetadata(pkgs(), [])).pkgList.map((p) => [p.name, p]),
    );
    const github = requested.filter((url) => url.startsWith(API));
    // Positive control, and the batched lookups: the two packages without a
    // licence id are asked about, the one with a declared licence is not.
    assert.deepStrictEqual(github.sort(), [
      `${API}/acme/by-url/license`,
      `${API}/acme/unlicensed/license`,
    ]);
    assert.strictEqual(byName.get("declared").license, "MIT");
    assert.strictEqual(byName.get("by-url").license.id, "Apache-2.0");
    assert.strictEqual(byName.get("unlicensed").license, undefined);

    // GitHub's 404 for the unlicensed repository is not asked again.
    requested.length = 0;
    await getNugetMetadata(pkgs(), []);
    assert.deepStrictEqual(
      requested.filter((url) => url.endsWith("/unlicensed/license")),
      [],
      "a repository GitHub has no licence for was asked again",
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(emptyPackages, { force: true, recursive: true });
  }
});

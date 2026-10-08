import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// Each ecosystem remembers the registry answers of a run on its own, so a Go
// parse in the middle of a scan does not make the NuGet lookups ask again.
// The assertions are on the exact requests a stubbed agent records. NUGET_URL,
// NUGET_PACKAGES and CDXGEN_RS_DISABLE are process-wide, so this file holds one
// sequential test.

const NUGET_URL = "http://127.0.0.1:1/nuget/";

function nugetIndex(version) {
  return {
    items: [
      {
        lower: version,
        upper: version,
        items: [
          {
            catalogEntry: {
              version,
              description: "from the service",
              licenseExpression: "Apache-2.0",
            },
          },
        ],
      },
    ],
  };
}

it("a Go parse keeps the answers other ecosystems remembered", async () => {
  const previous = {
    NUGET_URL: process.env.NUGET_URL,
    NUGET_PACKAGES: process.env.NUGET_PACKAGES,
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
    FETCH_LICENSE: process.env.FETCH_LICENSE,
  };
  const emptyPackages = mkdtempSync(join(tmpdir(), "cdxgen-nuget-empty-"));
  process.env.NUGET_URL = NUGET_URL;
  process.env.NUGET_PACKAGES = emptyPackages;
  process.env.CDXGEN_RS_DISABLE = "fetch";
  delete process.env.FETCH_LICENSE;
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return { statusCode: 200, body: nugetIndex(url.includes("serilog") ? "3.0.1" : "13.0.1") };
  });
  try {
    const { getNugetMetadata, parseGoModData } = await esmock(
      "./utils.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    const serilog = () => ({ group: "", name: "Serilog", version: "3.0.1" });

    await getNugetMetadata([serilog()], []);
    // Positive control: the stub records the lookup.
    assert.deepStrictEqual(requested, [`${NUGET_URL}serilog/index.json`]);

    await parseGoModData(
      "module example.com/app\n\ngo 1.22\n\nrequire golang.org/x/text v0.3.0\n",
      {},
    );

    requested.length = 0;
    const [again] = (await getNugetMetadata([serilog()], [])).pkgList;
    assert.deepStrictEqual(
      requested,
      [],
      "the NuGet answer was forgotten by the Go parse",
    );
    assert.strictEqual(again.license, "Apache-2.0");

    // A package not asked about before is still requested.
    await getNugetMetadata(
      [{ group: "", name: "Newtonsoft.Json", version: "13.0.1" }],
      [],
    );
    assert.deepStrictEqual(requested, [
      `${NUGET_URL}newtonsoft.json/index.json`,
    ]);
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

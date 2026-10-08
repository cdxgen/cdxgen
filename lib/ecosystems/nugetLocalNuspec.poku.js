import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// The nuspec of a package installed in the global NuGet packages folder
// answers before the service: its licence expression and description keep the
// registry out, and a package that is not installed is still asked about. The
// assertions are on the exact requests a stubbed agent records.

it("installed nuspecs answer before the NuGet service", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousNugetUrl = process.env.NUGET_URL;
  const previousNugetPackages = process.env.NUGET_PACKAGES;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.NUGET_URL = "http://127.0.0.1:1/nuget/";
  process.env.NUGET_PACKAGES = join(
    import.meta.dirname,
    "../../test/data/registry-stub/nuget",
  );
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    if (url.endsWith("/serilog/index.json")) {
      return {
        statusCode: 200,
        body: {
          items: [
            {
              lower: "3.0.1",
              upper: "3.0.1",
              items: [
                {
                  catalogEntry: {
                    version: "3.0.1",
                    description: "from the service",
                    authors: "Serilog",
                    licenseExpression: "Apache-2.0",
                  },
                },
              ],
            },
          ],
        },
      };
    }
    return { statusCode: 404, body: {} };
  });
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { getNugetMetadata } = await esmock(
      "./ecosystems.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );

    const ardalis = { group: "", name: "Ardalis.Result", version: "7.0.0" };
    const serilog = { group: "", name: "Serilog", version: "3.0.1" };
    const result = (await getNugetMetadata([ardalis, serilog], [])).pkgList;
    // Only the package the machine does not hold is asked about.
    assert.deepStrictEqual(requested, [
      "http://127.0.0.1:1/nuget/serilog/index.json",
    ]);
    const byName = new Map(result.map((p) => [p.name, p]));
    // The licence expression of the installed nuspec, not the registry's view.
    assert.strictEqual(byName.get("Ardalis.Result").license, "MIT");
    assert.strictEqual(
      byName.get("Ardalis.Result").description,
      "A simple package to implement the Result pattern for returning from services.",
    );
    assert.ok(
      byName
        .get("Ardalis.Result")
        .properties.some(
          (prop) =>
            prop.name === "cdx:nuget:metadataSource" &&
            prop.value === "local-nuspec",
        ),
    );
    // The uninstalled package was enriched by the service.
    assert.strictEqual(byName.get("Serilog").license, "Apache-2.0");
    assert.strictEqual(byName.get("Serilog").description, "from the service");

    // A name that is not a single path segment cannot be a folder in the
    // global packages folder, so nothing is read from disk for it.
    requested.length = 0;
    const [climbing] = (
      await getNugetMetadata(
        [{ group: "", name: "x/../Ardalis.Result", version: "7.0.0" }],
        [],
      )
    ).pkgList;
    assert.deepStrictEqual(requested, [
      "http://127.0.0.1:1/nuget/x/../ardalis.result/index.json",
    ]);
    // The service does not know it either, and it stays in the BOM.
    assert.ok(climbing, "a package the service does not know is kept");
    assert.strictEqual(climbing.license, undefined);
  } finally {
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      NUGET_URL: previousNugetUrl,
      NUGET_PACKAGES: previousNugetPackages,
      CDXGEN_RS_DISABLE: previousRsDisable,
    })) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

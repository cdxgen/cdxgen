import path from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { startReplay } from "../../contrib/cassette.js";
import { getNugetMetadata } from "./ecosystems.js";

// A nuspec in this machine's global NuGet packages folder would answer for the
// component before the registry is asked, so the packages folder is pointed
// somewhere empty for the duration of the run.
const previousNugetPackages = process.env.NUGET_PACKAGES;
process.env.NUGET_PACKAGES = "/nonexistent-nuget-packages";

// Every request is served from the committed cassette, so these run with the
// network blocked. The cassette holds nuget.org's service index and the
// registration index for Newtonsoft.Json, whose newest release the metadata
// lookup falls back to when a component states no version.
const CASSETTE = path.join(
  import.meta.dirname,
  "..",
  "..",
  "test",
  "repotests",
  "_cassettes",
  "metadata_nuget.json",
);

async function withCassette(fn) {
  const controller = startReplay(CASSETTE);
  try {
    const result = await fn();
    assert.ok(
      controller.hitCount > 0,
      "zero cassette hits - the lookup never reached the registry, so this test proves nothing",
    );
    assert.deepStrictEqual(
      controller.missCount,
      0,
      "a request escaped toward the live network",
    );
    return result;
  } finally {
    controller.stop();
  }
}

process.on("exit", () => {
  if (previousNugetPackages === undefined) {
    delete process.env.NUGET_PACKAGES;
  } else {
    process.env.NUGET_PACKAGES = previousNugetPackages;
  }
});

// The cassette interceptor is process-wide, so the tests run one after the
// other: a second replay started meanwhile would take the first one's hits.
describe("nuget metadata never invents a version", async () => {
  await it("leaves a versionless component versionless", async () => {
    // #4359: a component built from `<Reference Include="Newtonsoft.Json" />`
    // states no version. Filling the version field from the registry's newest
    // release, while the purl kept none, described one package two ways.
    const { pkgList } = await withCassette(() =>
      getNugetMetadata(
        [
          {
            group: "",
            name: "Newtonsoft.Json",
            purl: "pkg:nuget/Newtonsoft.Json",
            "bom-ref": "pkg:nuget/Newtonsoft.Json",
          },
        ],
        [],
      ),
    );
    const pkg = pkgList[0];
    assert.deepStrictEqual(pkg.version, undefined);
    assert.deepStrictEqual(pkg.purl, "pkg:nuget/Newtonsoft.Json");
    assert.deepStrictEqual(pkg["bom-ref"], "pkg:nuget/Newtonsoft.Json");
    // The description and licence came from a release, and that release is
    // recorded rather than adopted as the component's version.
    const metadataVersion = pkg.properties?.find(
      (p) => p.name === "cdx:nuget:metadata_version",
    );
    assert.ok(
      metadataVersion?.value,
      "the release the metadata was read from must be recorded",
    );
    assert.ok(pkg.license, "licence enrichment must survive");
    assert.deepStrictEqual(
      pkg.homepage?.url,
      "https://www.nuget.org/packages/Newtonsoft.Json/",
    );
  });

  await it("keeps the purl in step when a placeholder version is resolved", async () => {
    // A `latest` placeholder asks to be replaced. The bom-ref was rebuilt and the
    // purl was not, which left the two disagreeing.
    const { pkgList } = await withCassette(() =>
      getNugetMetadata(
        [
          {
            group: "",
            name: "Newtonsoft.Json",
            version: "latest",
            purl: "pkg:nuget/Newtonsoft.Json@latest",
            "bom-ref": "pkg:nuget/Newtonsoft.Json@latest",
          },
        ],
        [],
      ),
    );
    const pkg = pkgList[0];
    assert.notDeepStrictEqual(pkg.version, "latest");
    assert.ok(pkg.version, "a placeholder version must be resolved");
    assert.deepStrictEqual(
      pkg.purl,
      `pkg:nuget/Newtonsoft.Json@${pkg.version}`,
    );
    assert.deepStrictEqual(pkg["bom-ref"], pkg.purl);
  });
});

import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// A gem that ships several native builds appears once per platform in the
// lockfile. The versions listing answers every variant of such a gem in one
// request, so no per-variant direct lookup is added beside it. The
// assertions are on the exact requests a stubbed agent records and on the
// components the lockfile parse returns.

const GEMFILE_LOCK = [
  "GEM",
  "  remote: https://rubygems.org/",
  "  specs:",
  "    nokogiri (1.16.7)",
  "    nokogiri (1.16.7-aarch64-linux)",
  "    nokogiri (1.16.7-arm64-darwin)",
  "    nokogiri (1.16.7-x64-mingw-ucrt)",
  "    nokogiri (1.16.7-x86_64-darwin)",
  "    nokogiri (1.16.7-x86_64-linux)",
  "    rake (13.0.6)",
  "",
  "PLATFORMS",
  "  ruby",
  "",
  "DEPENDENCIES",
  "  nokogiri",
  "  rake",
  "",
  "BUNDLED WITH",
  "   2.4.10",
].join("\n");

// The versions listing: one entry per version and platform, each carrying
// the fields the direct endpoint would have supplied.
const NOKOGIRI_VERSIONS = [
  ["ruby", "MIT-RUBY"],
  ["aarch64-linux", "MIT-AARCH64"],
  ["arm64-darwin", "MIT-ARM64"],
  ["x64-mingw-ucrt", "MIT-UCRT"],
  ["x86_64-darwin", "MIT-X8664-DARWIN"],
  ["x86_64-linux", "MIT-X8664-LINUX"],
].map(([platform, license]) => ({
  authors: "Aaron Patterson",
  gem_uri: "https://rubygems.org/gems/nokogiri-1.16.7.gem",
  licenses: [license],
  number: "1.16.7",
  platform,
  project_uri: "https://nokogiri.org",
  sha: `${platform}-sha256`,
}));

it("a multi platform gem costs one versions request, not one per variant", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousRubygemsV2 = process.env.RUBYGEMS_V2_URL;
  const previousRubygemsV1 = process.env.RUBYGEMS_V1_URL;
  const previousRubygemsVersions = process.env.RUBYGEMS_V1_VERSIONS_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.RUBYGEMS_V2_URL = "http://127.0.0.1:1/gems/v2/";
  process.env.RUBYGEMS_V1_URL = "http://127.0.0.1:1/gems/v1/";
  process.env.RUBYGEMS_V1_VERSIONS_URL = "http://127.0.0.1:1/gems/versions/";
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    if (url === "http://127.0.0.1:1/gems/versions/nokogiri.json") {
      return { statusCode: 200, body: NOKOGIRI_VERSIONS };
    }
    return {
      statusCode: 200,
      body: {
        name: "rake",
        version: "13.0.6",
        licenses: ["MIT"],
        project_uri: "https://github.com/ruby/rake",
      },
    };
  });
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { parseGemfileLockData } = await esmock(
      "./rubyutils.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    const { pkgList } = await parseGemfileLockData(
      GEMFILE_LOCK,
      "/project/Gemfile.lock",
    );
    // Positive control: the stub saw the requests, and the six variants plus
    // the single platform gem cost exactly two of them: one listing and one
    // direct lookup.
    assert.deepStrictEqual(requested.sort(), [
      "http://127.0.0.1:1/gems/v2/rake/versions/13.0.6.json",
      "http://127.0.0.1:1/gems/versions/nokogiri.json",
    ]);
    const byPlatform = new Map(
      pkgList
        .filter((p) => p.name === "nokogiri")
        .map((p) => [
          /platform=([^&]+)/.exec(p.purl)?.[1] || "ruby",
          p,
        ]),
    );
    assert.strictEqual(byPlatform.size, 6);
    // Every variant carries what its own listing entry supplied.
    for (const [platform, expected] of [
      ["ruby", "MIT-RUBY"],
      ["aarch64-linux", "MIT-AARCH64"],
      ["arm64-darwin", "MIT-ARM64"],
      ["x64-mingw-ucrt", "MIT-UCRT"],
      ["x86_64-darwin", "MIT-X8664-DARWIN"],
      ["x86_64-linux", "MIT-X8664-LINUX"],
    ]) {
      assert.deepStrictEqual(
        byPlatform.get(platform)?.license,
        [expected],
        `platform ${platform}`,
      );
      assert.strictEqual(
        byPlatform.get(platform)?._integrity,
        `sha256-${platform}-sha256`,
        `platform ${platform} hash`,
      );
    }
    const rake = pkgList.find((p) => p.name === "rake");
    assert.deepStrictEqual(rake?.license, ["MIT"]);
  } finally {
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      RUBYGEMS_V2_URL: previousRubygemsV2,
      RUBYGEMS_V1_URL: previousRubygemsV1,
      RUBYGEMS_V1_VERSIONS_URL: previousRubygemsVersions,
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

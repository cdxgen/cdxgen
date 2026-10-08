import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// The caches on this machine answer before rubygems.org, a gem served from a
// git remote or a path outside the project is never sent there, and the
// installed-gemspec reader asks the registry nothing on its own. The
// assertions are on the exact requests a stubbed agent records.

const GEMFILE_LOCK = [
  "PATH",
  "  remote: ../vendor/sidegem",
  "  specs:",
  "    sidegem (0.5.0)",
  "",
  "GIT",
  "  remote: https://github.com/acme/gitgem.git",
  "  revision: 0123456789abcdef0123456789abcdef01234567",
  "  branch: main",
  "  specs:",
  "    gitgem (1.2.3)",
  "",
  "GEM",
  "  remote: https://rubygems.org/",
  "  specs:",
  "    rake (13.0.6)",
  "    uncachedgem (2.0.0)",
  "",
  "PLATFORMS",
  "  ruby",
  "",
  "DEPENDENCIES",
  "  sidegem!",
  "  gitgem!",
  "  rake",
  "  uncachedgem",
  "",
  "BUNDLED WITH",
  "   2.4.10",
].join("\n");

const RAKE_GEMSPEC = [
  "Gem::Specification.new do |s|",
  '  s.name = "rake".freeze',
  '  s.version = "13.0.6"',
  '  s.licenses = ["MIT".freeze]',
  '  s.summary = "Rake is a Make-like program".freeze',
  "end",
].join("\n");

const FRESH_GEMSPEC = [
  "Gem::Specification.new do |s|",
  '  s.name = "freshgem".freeze',
  '  s.version = "0.1.0"',
  '  s.licenses = ["Apache-2.0".freeze]',
  '  s.summary = "A gem the lockfile round never saw".freeze',
  "end",
].join("\n");

it("ruby gems read the local caches before the registry", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousRubygemsV2 = process.env.RUBYGEMS_V2_URL;
  const previousRubygemsV1 = process.env.RUBYGEMS_V1_URL;
  const previousRubygemsVersions = process.env.RUBYGEMS_V1_VERSIONS_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return {
      statusCode: 200,
      body: { name: "gem", version: "0.0.0", licenses: ["REMOTE-GEM"] },
    };
  });
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-ruby-local-"));
  const gemHome = join(dir, "gems");
  mkdirSync(join(gemHome, "specifications"), { recursive: true });
  writeFileSync(
    join(gemHome, "specifications", "rake-13.0.6.gemspec"),
    RAKE_GEMSPEC,
  );
  writeFileSync(
    join(gemHome, "specifications", "freshgem-0.1.0.gemspec"),
    FRESH_GEMSPEC,
  );
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    process.env.RUBYGEMS_V2_URL = "http://127.0.0.1:1/gems/v2/";
    process.env.RUBYGEMS_V1_URL = "http://127.0.0.1:1/gems/v1/";
    process.env.RUBYGEMS_V1_VERSIONS_URL = "http://127.0.0.1:1/gems/versions/";
    const { parseGemfileLockData, enrichGemsFromLocalCache } = await esmock(
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
      join(dir, "Gemfile.lock"),
      { gemHome, compactIndexCacheDir: join(dir, "none") },
    );
    // The installed gemspec answered rake's licence, so the registry round
    // runs only for the gem the caches know nothing about. The path and git
    // gems are never sent.
    assert.deepStrictEqual(requested.sort(), [
      "http://127.0.0.1:1/gems/v2/rake/versions/13.0.6.json",
      "http://127.0.0.1:1/gems/v2/uncachedgem/versions/2.0.0.json",
    ]);
    const byName = new Map(pkgList.map((p) => [p.name, p]));
    assert.deepStrictEqual(byName.get("rake").license, ["MIT"]);
    assert.deepStrictEqual(byName.get("uncachedgem").license, ["REMOTE-GEM"]);
    assert.strictEqual(byName.get("sidegem").license, undefined);
    assert.strictEqual(byName.get("gitgem").license, undefined);

    // The gemspec reader inside the local cache enricher asks the registry
    // nothing, even for a gem no lockfile round has covered.
    requested.length = 0;
    const fresh = [{ name: "freshgem", version: "0.1.0", properties: [] }];
    await enrichGemsFromLocalCache(fresh, {
      gemHome,
      compactIndexCacheDir: join(dir, "none"),
    });
    assert.deepStrictEqual(requested, []);
    assert.deepStrictEqual(fresh[0].license, ["Apache-2.0"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
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

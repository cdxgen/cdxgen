import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// rubygems.org lookups against a stubbed agent, so the assertions are about
// the exact requests made. The project's own gem, whether sighted through its
// gemspec or through the lockfile's PATH remote: . entry, is held by no
// registry; the gems from the GEM section are.

const GEMFILE_LOCK = [
  "PATH",
  "  remote: .",
  "  specs:",
  "    acme-tool (0.1.0)",
  "",
  "GEM",
  "  remote: https://rubygems.org/",
  "  specs:",
  "    publicgem (1.0.0)",
  "",
  "PLATFORMS",
  "  ruby",
  "",
  "DEPENDENCIES",
  "  acme-tool!",
  "  publicgem",
  "",
  "BUNDLED WITH",
  "   2.4.10",
].join("\n");

it("the project's own gem is never looked up", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousRubygemsUrl = process.env.RUBYGEMS_V2_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return {
      statusCode: 200,
      body: { name: "publicgem", version: "1.0.0", licenses: ["REMOTE-GEM"] },
    };
  });
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-ruby-"));
  writeFileSync(
    join(dir, "acme-tool.gemspec"),
    [
      "Gem::Specification.new do |s|",
      '  s.name = "acme-tool".freeze',
      '  s.version = "0.1.0"',
      '  s.licenses = ["MIT".freeze]',
      '  s.summary = "The acme tool".freeze',
      "end",
    ].join("\n"),
  );
  writeFileSync(join(dir, "Gemfile.lock"), GEMFILE_LOCK);
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    process.env.RUBYGEMS_V2_URL = "http://127.0.0.1:1/gems/v2/";
    const { parseGemspecData, parseGemfileLockData } = await esmock(
      "./rubyutils.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );

    // The gemspec of the project being scanned.
    const gemspecData = await import("node:fs").then((fs) =>
      fs.readFileSync(join(dir, "acme-tool.gemspec"), "utf-8"),
    );
    await parseGemspecData(gemspecData, join(dir, "acme-tool.gemspec"), {
      projectGemspec: true,
    });
    assert.deepStrictEqual(requested, []);

    // A dependency's gemspec still goes to the registry.
    writeFileSync(
      join(dir, "publicgem.gemspec"),
      [
        "Gem::Specification.new do |s|",
        '  s.name = "publicgem".freeze',
        '  s.version = "1.0.0"',
        "end",
      ].join("\n"),
    );
    const publicGemData = await import("node:fs").then((fs) =>
      fs.readFileSync(join(dir, "publicgem.gemspec"), "utf-8"),
    );
    const [publicGem] = await parseGemspecData(
      publicGemData,
      join(dir, "publicgem.gemspec"),
    );
    assert.deepStrictEqual(requested, [
      "http://127.0.0.1:1/gems/v2/publicgem/versions/1.0.0.json",
    ]);
    assert.deepStrictEqual(publicGem.license, ["REMOTE-GEM"]);
    requested.splice(0);

    // The lockfile's PATH remote: . entry is the same project gem.
    const { pkgList } = await parseGemfileLockData(
      GEMFILE_LOCK,
      join(dir, "Gemfile.lock"),
    );
    assert.deepStrictEqual(requested, [
      "http://127.0.0.1:1/gems/v2/publicgem/versions/1.0.0.json",
    ]);
    const byName = new Map(pkgList.map((p) => [p.name, p]));
    assert.strictEqual(byName.get("acme-tool").license, undefined);
    assert.deepStrictEqual(byName.get("publicgem").license, ["REMOTE-GEM"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      RUBYGEMS_V2_URL: previousRubygemsUrl,
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

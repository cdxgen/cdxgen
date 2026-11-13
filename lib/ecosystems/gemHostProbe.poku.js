import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { findGemHomes, probeHostRubyGems } from "./gemHostProbe.js";
import * as rubyutils from "./rubyutils.js";

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-gem-host-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function put(root, file, content = "") {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

// The gemspec RubyGems writes into specifications/ on install.
const gemspec = (name, version) => `# -*- encoding: utf-8 -*-
# stub: ${name} ${version} ruby lib

Gem::Specification.new do |s|
  s.name = "${name}".freeze
  s.version = "${version}".freeze
  s.required_ruby_version = Gem::Requirement.new(">= 2.5.0".freeze)
  s.summary = "${name} summary".freeze
  s.licenses = ["Ruby".freeze, "BSD-2-Clause".freeze]
end
`;

function gem(root, home, name, version, isDefault = false) {
  return put(
    root,
    `${home}/specifications/${isDefault ? "default/" : ""}${name}-${version}.gemspec`,
    gemspec(name, version),
  );
}

const prop = (component, name) =>
  component.properties?.find((p) => p.name === name)?.value;

describe("probeHostRubyGems()", () => {
  it("reads the gem homes of distros, version managers and users", () =>
    withRoot(async (root) => {
      gem(root, "usr/lib/ruby/gems/3.2.0", "resolv", "0.2.2", true);
      gem(root, "var/lib/gems/3.2.0", "rack", "3.1.8");
      gem(root, "usr/share/gems", "json", "2.5.1", true);
      gem(
        root,
        "home/dev/.rbenv/versions/3.3.6/lib/ruby/gems/3.3.0",
        "resolv",
        "0.3.0",
        true,
      );
      gem(
        root,
        "opt/hostedtoolcache/Ruby/3.3.6/x64/lib/ruby/gems/3.3.0",
        "resolv",
        "0.3.0",
        true,
      );
      gem(root, "home/dev/.gem/ruby/3.3.0", "rails", "7.2.1");
      // Not a gem home: no specifications directory
      put(root, "usr/local/lib/ruby/gems/3.3.0/cache/x-1.0.gem", "x");
      // A gem's own sources are not read
      put(
        root,
        "usr/lib/ruby/gems/3.2.0/gems/rbs-2.8.2/rbs.gemspec",
        gemspec("rbs", "2.8.2"),
      );
      assert.strictEqual(findGemHomes(root, "linux").length, 6);
      const gems = await probeHostRubyGems({
        rootPath: root,
        platform: "linux",
      });
      assert.deepStrictEqual(
        gems.map((g) => g["bom-ref"]),
        [
          "pkg:gem/json@2.5.1",
          "pkg:gem/rack@3.1.8",
          "pkg:gem/rails@7.2.1",
          "pkg:gem/resolv@0.2.2",
          "pkg:gem/resolv@0.3.0",
        ],
      );
      const resolv = gems.find((g) => g["bom-ref"] === "pkg:gem/resolv@0.3.0");
      assert.strictEqual(prop(resolv, "cdx:gem:defaultGem"), "true");
      assert.deepStrictEqual(
        resolv.evidence.occurrences.map((o) => o.location).sort(),
        [
          "/home/dev/.rbenv/versions/3.3.6/lib/ruby/gems/3.3.0/specifications/default/resolv-0.3.0.gemspec",
          "/opt/hostedtoolcache/Ruby/3.3.6/x64/lib/ruby/gems/3.3.0/specifications/default/resolv-0.3.0.gemspec",
        ],
      );
      assert.strictEqual(
        prop(
          gems.find((g) => g.name === "rails"),
          "cdx:gem:defaultGem",
        ),
        undefined,
      );
    }));

  it("marks the gems a package database lists with their package", () =>
    withRoot(async (root) => {
      gem(root, "usr/lib/ruby/gems/3.2.0", "resolv", "0.2.2", true);
      gem(root, "var/lib/gems/3.2.0", "rack", "3.1.8");
      // json is the distro's in one gem home, and gem install's in another
      gem(root, "usr/lib/ruby/gems/3.2.0", "json", "2.7.1", true);
      gem(root, "var/lib/gems/3.2.0", "json", "2.7.1");
      put(
        root,
        // dpkg names a list <package>:<arch>.list, which Windows cannot name a file
        `var/lib/dpkg/info/libruby3.2${process.platform === "win32" ? "" : ":amd64"}.list`,
        [
          "/.",
          "/usr/lib/ruby/gems/3.2.0/specifications/default/resolv-0.2.2.gemspec",
          "/usr/lib/ruby/gems/3.2.0/specifications/default/json-2.7.1.gemspec",
        ].join("\n"),
      );
      const libruby =
        "pkg:deb/ubuntu/libruby3.2@3.2.3-1ubuntu0.24.04.8?arch=amd64&distro=ubuntu-24.04";
      const gems = await probeHostRubyGems({
        rootPath: root,
        platform: "linux",
        packageComponents: [
          { name: "libruby3.2", purl: libruby.replace("+", "%2B") },
        ],
      });
      const byName = Object.fromEntries(gems.map((g) => [g.name, g]));
      assert.strictEqual(prop(byName.resolv, "cdx:os:installedBy"), libruby);
      assert.strictEqual(prop(byName.rack, "cdx:os:installedBy"), undefined);
      assert.strictEqual(prop(byName.json, "cdx:os:installedBy"), undefined);
      assert.strictEqual(byName.json.evidence.occurrences.length, 2);
    }));

  it("reads the gem homes of a Windows Ruby", () =>
    withRoot(async (root) => {
      gem(root, "tools/ruby34/lib/ruby/gems/3.4.0", "resolv", "0.7.1", true);
      gem(root, "Ruby33-x64/lib/ruby/gems/3.3.0", "rack", "3.1.8");
      const gems = await probeHostRubyGems({
        rootPath: root,
        platform: "win32",
      });
      assert.deepStrictEqual(
        gems.map((g) => g["bom-ref"]),
        ["pkg:gem/rack@3.1.8", "pkg:gem/resolv@0.7.1"],
      );
    }));

  it("returns nothing without gem homes", () =>
    withRoot(async (root) => {
      assert.deepStrictEqual(
        await probeHostRubyGems({ rootPath: root, platform: "linux" }),
        [],
      );
    }));

  it("is blocked in dry-run mode", async () => {
    const recordActivity = sinon.stub();
    const { probeHostRubyGems: mocked } = await esmock("./gemHostProbe.js", {
      "../core/activity.js": { isDryRun: true, recordActivity },
    });
    await withRoot(async (root) => {
      gem(root, "var/lib/gems/3.2.0", "rack", "3.1.8");
      assert.deepStrictEqual(
        await mocked({ rootPath: root, platform: "linux" }),
        [],
      );
    });
    sinon.assert.calledWithMatch(recordActivity, {
      capability: "ruby-gem-probe",
      status: "blocked",
    });
  });
});

describe("probeHostRubyGems() review findings (#4645)", () => {
  it("never reads a gemspec that is a device or a link", () =>
    withRoot(async (root) => {
      if (process.platform === "win32") {
        return;
      }
      gem(root, "home/u/.gem/ruby/3.3.0", "rack", "3.1.8");
      symlinkSync(
        "/dev/zero",
        join(root, "home/u/.gem/ruby/3.3.0/specifications/evil-1.0.gemspec"),
      );
      const gems = await probeHostRubyGems({
        rootPath: root,
        platform: "linux",
      });
      assert.deepStrictEqual(
        gems.map((g) => g["bom-ref"]),
        ["pkg:gem/rack@3.1.8"],
      );
    }));
  it("never opens the version file or bindir next to a gemspec", () =>
    withRoot(async (root) => {
      gem(root, "home/u/.gem/ruby/3.3.0", "rack", "3.1.8");
      // A project-style gemspec in a user's gem home, whose version and
      // executables would be read from a version.rb and a bin beside it
      put(
        root,
        "home/u/.gem/ruby/3.3.0/specifications/lister.gemspec",
        `require_relative "version"

Gem::Specification.new do |s|
  s.name = "lister"
  s.version = VERSION
  s.executables = s.files.grep(%r{\\Abin/}) { |f| File.basename(f) }
end
`,
      );
      put(
        root,
        "home/u/.gem/ruby/3.3.0/specifications/version.rb",
        'VERSION = "6.6.6"\n',
      );
      const parseGemspecData = sinon.spy(rubyutils.parseGemspecData);
      const { probeHostRubyGems: mocked } = await esmock("./gemHostProbe.js", {
        "./rubyutils.js": { parseGemspecData },
      });
      const gems = await mocked({ rootPath: root, platform: "linux" });
      assert.deepStrictEqual(
        gems.map((g) => g["bom-ref"]),
        ["pkg:gem/rack@3.1.8"],
      );
      // The parser is told to read the text it was given and nothing else
      sinon.assert.alwaysCalledWithMatch(
        parseGemspecData,
        sinon.match.string,
        sinon.match.string,
        { noFetch: true, textOnly: true },
      );
    }));
  it("reads the gems Debian's ruby-* packages register", () =>
    withRoot(async (root) => {
      gem(root, "usr/share/rubygems-integration/all", "rack", "2.2.6.4");
      gem(
        root,
        "usr/lib/x86_64-linux-gnu/rubygems-integration/3.1.0",
        "nokogiri",
        "1.13.10",
      );
      const gems = await probeHostRubyGems({
        rootPath: root,
        platform: "linux",
      });
      assert.deepStrictEqual(
        gems.map((g) => g["bom-ref"]),
        ["pkg:gem/nokogiri@1.13.10", "pkg:gem/rack@2.2.6.4"],
      );
    }));
  it("names an owner only by the purl the OBOM gave its package", () =>
    withRoot(async (root) => {
      gem(root, "usr/share/gems", "json", "2.5.1", true);
      put(
        root,
        "var/lib/dpkg/info/ruby-json.list",
        "/.\n/usr/share/gems/specifications/default/json-2.5.1.gemspec\n",
      );
      const [json] = await probeHostRubyGems({
        rootPath: root,
        platform: "linux",
        packageComponents: [],
      });
      assert.strictEqual(prop(json, "cdx:os:installedBy"), undefined);
    }));
});

describe("probeHostRubyGems() and links in a user's home", () => {
  // Creating symbolic links needs extra rights on Windows, and the probe reads
  // no home directories there
  const posixOnly = process.platform === "win32";

  it("follows no link below a home directory when running as root", async () => {
    if (posixOnly) {
      return;
    }
    const { findGemHomes: asRoot, probeHostRubyGems: probeAsRoot } =
      await esmock("./gemHostProbe.js", {
        "../core/boundedFile.js": { isRunningAsRoot: () => true },
      });
    await withRoot(async (root) => {
      gem(root, "home/u/.gem/ruby/3.3.0", "rack", "3.1.8");
      // Directories only root can enter, linked from the user's home
      gem(root, "srv/private", "secret", "1.0.0");
      gem(root, "srv/private2", "hidden", "2.0.0", true);
      mkdirSync(join(root, "srv/exists"));
      symlinkSync(
        join(root, "srv/private"),
        join(root, "home/u/.gem/ruby/home-link"),
      );
      mkdirSync(join(root, "home/u/.gem/ruby/spec-link"));
      symlinkSync(
        join(root, "srv/private/specifications"),
        join(root, "home/u/.gem/ruby/spec-link/specifications"),
      );
      mkdirSync(join(root, "home/u/.gem/ruby/3.4.0/specifications"), {
        recursive: true,
      });
      symlinkSync(
        join(root, "srv/private2/specifications/default"),
        join(root, "home/u/.gem/ruby/3.4.0/specifications/default"),
      );
      // Resolves to the user's own gem home only while srv/exists is there
      symlinkSync(
        join(root, "srv/exists/../../home/u/.gem/ruby/3.3.0"),
        join(root, "home/u/.gem/ruby/guess"),
      );
      assert.deepStrictEqual(asRoot(root, "linux"), [
        join(root, "home/u/.gem/ruby/3.3.0"),
        join(root, "home/u/.gem/ruby/3.4.0"),
      ]);
      const gems = await probeAsRoot({ rootPath: root, platform: "linux" });
      assert.deepStrictEqual(
        gems.map((g) => g["bom-ref"]),
        ["pkg:gem/rack@3.1.8"],
      );
      assert.deepStrictEqual(gems[0].evidence.occurrences, [
        {
          location: "/home/u/.gem/ruby/3.3.0/specifications/rack-3.1.8.gemspec",
        },
      ]);
    });
  });

  it("does not read a gemspec whose directory became a link after listing", async () => {
    if (posixOnly) {
      return;
    }
    await withRoot(async (root) => {
      gem(root, "home/u/.gem/ruby/3.3.0", "rack", "3.1.8");
      gem(root, "srv/private", "secret", "1.0.0");
      // The user's own gemspec under the name of root's, so it is listed
      const specs = join(root, "home/u/.gem/ruby/3.5.0/specifications");
      put(
        root,
        "home/u/.gem/ruby/3.5.0/specifications/secret-1.0.0.gemspec",
        gemspec("decoy", "0.0.1"),
      );
      // Swapped for a link while the package databases are asked
      const findHostPathOwners = () => {
        renameSync(specs, `${specs}.real`);
        symlinkSync(join(root, "srv/private/specifications"), specs);
        return { owners: new Map(), unreadable: [] };
      };
      const { probeHostRubyGems: probeAsRoot } = await esmock(
        "./gemHostProbe.js",
        {
          "../core/boundedFile.js": { isRunningAsRoot: () => true },
          "../inventory/hostRuntimeProbe.js": { findHostPathOwners },
        },
      );
      const gems = await probeAsRoot({ rootPath: root, platform: "linux" });
      assert.deepStrictEqual(
        gems.map((g) => g["bom-ref"]),
        ["pkg:gem/rack@3.1.8"],
      );
    });
  });

  it("follows a user's own links when not running as root", async () => {
    if (posixOnly) {
      return;
    }
    const { probeHostRubyGems: probeAsUser } = await esmock(
      "./gemHostProbe.js",
      { "../core/boundedFile.js": { isRunningAsRoot: () => false } },
    );
    await withRoot(async (root) => {
      // A version manager's alias of a Ruby it installed
      gem(
        root,
        "home/u/.rbenv/versions/3.3.6/lib/ruby/gems/3.3.0",
        "rack",
        "3.1.8",
      );
      symlinkSync("3.3.6", join(root, "home/u/.rbenv/versions/3.3"));
      const gems = await probeAsUser({ rootPath: root, platform: "linux" });
      assert.deepStrictEqual(
        gems.map((g) => g["bom-ref"]),
        ["pkg:gem/rack@3.1.8"],
      );
      assert.strictEqual(gems[0].evidence.occurrences.length, 2);
    });
  });
});

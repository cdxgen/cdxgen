import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { probeHostRuby } from "./rubyHostProbe.js";

// rbconfig.rb fixtures are trimmed copies of real installs.
const rbconfig = (name) =>
  readFileSync(join("test", "data", "ruby-runtime", name), "utf-8");
const X86_64 = "rbconfig-3.3.6-x86_64-linux.rb";

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-ruby-host-"));
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

// A Ruby install under a prefix: the launcher and its rbconfig.rb.
function install(root, prefix, fixture = X86_64, arch = "x86_64-linux") {
  put(root, `${prefix}/bin/ruby`, "\x7fELF launcher");
  put(root, `${prefix}/lib/ruby/3.3.0/${arch}/rbconfig.rb`, rbconfig(fixture));
}

const files = (components) =>
  components
    .filter((component) => component.type === "file")
    .map(
      (component) =>
        component.properties.find((prop) => prop.name === "internal:SrcFile")
          .value,
    )
    .sort();
const runtimes = (components) =>
  components
    .filter((component) => component.type === "platform")
    .map((component) => [component.purl, component.cpe]);

describe("probeHostRuby()", () => {
  it("finds version-manager, toolcache and /usr/local installs", () =>
    withRoot((root) => {
      install(root, "home/dev/.rbenv/versions/3.3.6");
      install(root, "home/dev/.rvm/rubies/ruby-3.3.6");
      install(root, "home/dev/.asdf/installs/ruby/3.3.6");
      install(root, "home/dev/.local/share/mise/installs/ruby/3.3.6");
      install(root, "home/dev/.rubies/ruby-3.3.6");
      install(root, "root/.frum/versions/3.3.6");
      install(root, "opt/rubies/ruby-3.3.6");
      install(root, "opt/hostedtoolcache/Ruby/3.3.6/x64");
      install(
        root,
        "usr/local",
        "rbconfig-3.3.6-aarch64-linux.rb",
        "aarch64-linux",
      );
      const { components, dependencies } = probeHostRuby({
        rootPath: root,
        platform: "linux",
      });
      assert.deepStrictEqual(files(components), [
        "/home/dev/.asdf/installs/ruby/3.3.6/bin/ruby",
        "/home/dev/.local/share/mise/installs/ruby/3.3.6/bin/ruby",
        "/home/dev/.rbenv/versions/3.3.6/bin/ruby",
        "/home/dev/.rubies/ruby-3.3.6/bin/ruby",
        "/home/dev/.rvm/rubies/ruby-3.3.6/bin/ruby",
        "/opt/hostedtoolcache/Ruby/3.3.6/x64/bin/ruby",
        "/opt/rubies/ruby-3.3.6/bin/ruby",
        "/root/.frum/versions/3.3.6/bin/ruby",
        "/usr/local/bin/ruby",
      ]);
      assert.deepStrictEqual(runtimes(components), [
        [
          "pkg:generic/ruby@3.3.6",
          "cpe:2.3:a:ruby-lang:ruby:3.3.6:*:*:*:*:*:*:*",
        ],
      ]);
      const file = components.find(
        (component) =>
          component.type === "file" &&
          component.purl.endsWith("usr/local/bin/ruby"),
      );
      assert.deepStrictEqual(
        Object.fromEntries(
          file.properties
            .filter((prop) => prop.name.startsWith("cdx:ruby:"))
            .map((prop) => [prop.name, prop.value]),
        ),
        {
          "cdx:ruby:buildVersion": "3.3.6",
          "cdx:ruby:buildVersionSource": "rbconfig",
          "cdx:ruby:patchlevel": "108",
          "cdx:ruby:abiVersion": "3.3.0",
          "cdx:ruby:platform": "aarch64-linux",
        },
      );
      assert.ok(
        dependencies.some(
          (dep) =>
            dep.ref === file["bom-ref"] &&
            dep.dependsOn.includes("pkg:generic/ruby@3.3.6"),
        ),
      );
    }));

  it("leaves a dpkg, apk or Homebrew Ruby to its package", () =>
    withRoot((root) => {
      install(root, "usr/local");
      // dpkg names a list <package>:<arch>.list, which Windows cannot name a file
      put(
        root,
        `var/lib/dpkg/info/ruby-local${process.platform === "win32" ? "" : ":amd64"}.list`,
        "/.\n/usr/local/bin/ruby\n",
      );
      install(root, "opt/homebrew/Cellar/ruby/3.4.8");
      mkdirSync(join(root, "opt/homebrew/bin"), { recursive: true });
      try {
        symlinkSync(
          join(root, "opt/homebrew/Cellar/ruby/3.4.8/bin/ruby"),
          join(root, "opt/homebrew/bin/ruby"),
        );
      } catch (err) {
        if (err.code !== "EPERM") {
          throw err;
        }
      }
      assert.deepStrictEqual(
        probeHostRuby({ rootPath: root, platform: "linux" }).components,
        [],
      );
      assert.deepStrictEqual(
        probeHostRuby({ rootPath: root, platform: "darwin" }).components.filter(
          (component) => component.purl?.includes("homebrew"),
        ),
        [],
      );
    }));

  it("records unknown ownership when a package database cannot be read", async () => {
    const recordDegradation = sinon.stub();
    const { probeHostRuby: mocked } = await esmock("./rubyHostProbe.js", {
      "../core/buildLedger.js": { recordDegradation },
    });
    await withRoot((root) => {
      install(root, "usr/local");
      mkdirSync(join(root, "var/lib/rpm"), { recursive: true });
      // rpm exists but no osquery executor can be asked
      assert.deepStrictEqual(
        mocked({ rootPath: root, platform: "linux" }).components,
        [],
      );
    });
    sinon.assert.calledWithMatch(
      recordDegradation,
      "ruby.host-probe.package-db-unreadable",
      { ecosystem: "ruby", tool: "rpm" },
    );
  });

  it("finds a Windows RubyInstaller and leaves Chocolatey's to it", () =>
    withRoot((root) => {
      put(root, "Ruby34-x64/bin/ruby.exe", "MZ");
      put(
        root,
        "Ruby34-x64/lib/ruby/3.4.0/x64-mingw-ucrt/rbconfig.rb",
        rbconfig("rbconfig-3.4.10-x64-mingw-ucrt.rb"),
      );
      put(root, "tools/ruby34/bin/ruby.exe", "MZ");
      put(
        root,
        "tools/ruby34/lib/ruby/3.4.0/x64-mingw-ucrt/rbconfig.rb",
        rbconfig("rbconfig-3.4.10-x64-mingw-ucrt.rb"),
      );
      mkdirSync(join(root, "ProgramData/chocolatey"), { recursive: true });
      const { components } = probeHostRuby({
        rootPath: root,
        platform: "win32",
        env: { ChocolateyInstall: join(root, "ProgramData/chocolatey") },
        packageComponents: [
          { name: "chocolatey", purl: "pkg:chocolatey/chocolatey@2.7.4" },
          { name: "ruby", purl: "pkg:chocolatey/ruby@3.4.10.1" },
        ],
      });
      const sources = files(components);
      assert.strictEqual(sources.length, 1);
      assert.ok(sources[0].endsWith("Ruby34-x64\\bin\\ruby.exe"), sources[0]);
      assert.deepStrictEqual(runtimes(components), [
        [
          "pkg:generic/ruby@3.4.10",
          "cpe:2.3:a:ruby-lang:ruby:3.4.10:*:*:*:*:*:*:*",
        ],
      ]);
    }));

  it("skips a ruby it cannot read a version from", () =>
    withRoot((root) => {
      put(root, "usr/local/bin/ruby", '#!/bin/sh\nexec /opt/real/ruby "$@"\n');
      assert.deepStrictEqual(
        probeHostRuby({ rootPath: root, platform: "linux" }).components,
        [],
      );
    }));

  it("is blocked in dry-run mode", async () => {
    const recordActivity = sinon.stub();
    const { probeHostRuby: mocked } = await esmock("./rubyHostProbe.js", {
      "../core/activity.js": { isDryRun: true, recordActivity },
    });
    await withRoot((root) => {
      install(root, "usr/local");
      assert.deepStrictEqual(mocked({ rootPath: root, platform: "linux" }), {
        components: [],
        dependencies: [],
      });
    });
    sinon.assert.calledWithMatch(recordActivity, {
      capability: "ruby-host-probe",
      status: "blocked",
    });
  });
});

describe("findHostPathOwners() review findings (#4645)", () => {
  it("asks rpm about a long list of paths in chunks", async () => {
    const { findHostPathOwners } = await import("./hostRuntimeProbe.js");
    await withRoot((root) => {
      mkdirSync(join(root, "var/lib/rpm"), { recursive: true });
      const paths = Array.from(
        { length: 1500 },
        (_, index) =>
          `/home/dev/.rbenv/versions/3.3.6/lib/ruby/gems/3.3.0/specifications/gem-${index}-1.0.0.gemspec`,
      );
      paths.push("/usr/share/gems/specifications/json-2.5.1.gemspec");
      const queries = [];
      const { owners, unreadable } = findHostPathOwners(
        {
          rootPath: root,
          platform: "linux",
          executeOsQuery: (query) => {
            queries.push(query);
            return query.includes("json-2.5.1")
              ? [
                  {
                    package: "rubygem-json",
                    path: "/usr/share/gems/specifications/json-2.5.1.gemspec",
                  },
                ]
              : [];
          },
        },
        paths,
      );
      assert.deepStrictEqual(unreadable, []);
      assert.strictEqual(queries.length, 8);
      assert.ok(queries.every((query) => query.length < 64 * 1024));
      assert.deepStrictEqual(
        owners.get("/usr/share/gems/specifications/json-2.5.1.gemspec"),
        { database: "rpm", packageName: "rubygem-json" },
      );
    });
  });
});

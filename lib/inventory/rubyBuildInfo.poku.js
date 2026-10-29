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

import { assert, describe, it } from "poku";

import {
  attachRubyBuild,
  createRubyRuntimeComponent,
  createRubyRuntimeInventory,
  defaultGemInstall,
  deriveOsPackagedRubyRuntimes,
  findRbConfigFiles,
  isInsideInstalledGem,
  isLibrubyName,
  isRubyBinaryName,
  linkDefaultGemsToRuntimes,
  parseRbConfig,
  parseRubyDescription,
  parseRubyVersion,
  readRubyBuildVersion,
  readRubyDescription,
  rubyCpe,
  rubyInstallPrefix,
  rubyRuntimeRef,
  upstreamRubyVersion,
  versionFromLibrubyName,
} from "./rubyBuildInfo.js";

// The rbconfig.rb fixtures are trimmed copies of the files real installs
// carry: the Docker Official image (aarch64), Alpine's ruby-libs (musl),
// Debian's libruby3.1 layout, a ruby-builder tarball under rbenv (x86_64) and
// the Chocolatey RubyInstaller (x64-mingw-ucrt).
const FIXTURES = join("test", "data", "ruby-runtime");
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf-8");

// The description a libruby carries, as a C string among others.
const libruby = (description) =>
  Buffer.concat([
    Buffer.from("\0\x7fELF padding ruby is not a description\0"),
    Buffer.from(`${description}\0`),
    Buffer.from("ruby_version\0ruby 1.2.3 is not one either\0"),
  ]);

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-ruby-build-"));
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

describe("parseRubyVersion()", () => {
  it("accepts releases and normalizes pre-releases", () => {
    assert.strictEqual(parseRubyVersion("3.3.6"), "3.3.6");
    assert.strictEqual(parseRubyVersion("3.4.0preview2"), "3.4.0-preview2");
    assert.strictEqual(parseRubyVersion("3.4.0-preview2"), "3.4.0-preview2");
    assert.strictEqual(parseRubyVersion("3.4.0rc1"), "3.4.0-rc1");
    assert.strictEqual(parseRubyVersion("3.5.0dev"), "3.5.0-dev");
  });
  it("rejects partial, decorated and oversized versions", () => {
    for (const text of [
      "3.3",
      "3.3.6p108",
      "ruby-3.3.6",
      "3.3.6.1",
      "",
      undefined,
      "9".repeat(40),
    ]) {
      assert.strictEqual(parseRubyVersion(text), undefined, `${text}`);
    }
  });
});

describe("parseRubyDescription()", () => {
  it("reads MRI descriptions, with and without a patchlevel", () => {
    assert.deepStrictEqual(
      parseRubyDescription(
        "ruby 3.3.6 (2024-11-05 revision 75015d4c1f) [x86_64-linux]",
      ),
      { engine: "ruby", version: "3.3.6", platform: "x86_64-linux" },
    );
    assert.deepStrictEqual(
      parseRubyDescription(
        "ruby 3.1.2p20 (2022-04-12 revision 4491bb740a) [aarch64-linux-gnu]",
      ),
      {
        engine: "ruby",
        version: "3.1.2",
        patchlevel: "20",
        platform: "aarch64-linux-gnu",
      },
    );
    assert.deepStrictEqual(
      parseRubyDescription(
        "ruby 3.4.10 (2026-06-30 revision 2b0b7728dc) +PRISM [x64-mingw-ucrt]\r\nmore",
      ),
      { engine: "ruby", version: "3.4.10", platform: "x64-mingw-ucrt" },
    );
  });
  it("keeps the tag of a preview and the dev marker", () => {
    assert.strictEqual(
      parseRubyDescription(
        "ruby 3.4.0preview2 (2024-10-07 master 32c733f57b) +PRISM [x86_64-linux]",
      ).version,
      "3.4.0-preview2",
    );
    assert.strictEqual(
      parseRubyDescription(
        "ruby 3.5.0dev (2025-01-01T00:00:00Z master abc) +PRISM [arm64-darwin24]",
      ).version,
      "3.5.0-dev",
    );
  });
  it("names JRuby and TruffleRuby with the Ruby they implement", () => {
    assert.deepStrictEqual(
      parseRubyDescription(
        "jruby 9.4.8.0 (3.1.4) 2024-07-02 4d41e55a67 OpenJDK 64-Bit Server VM",
      ),
      { engine: "jruby", version: "9.4.8.0", rubyVersion: "3.1.4" },
    );
    assert.deepStrictEqual(
      parseRubyDescription(
        "truffleruby 24.1.0, like ruby 3.2.4, Oracle GraalVM Native [x86_64-linux]",
      ),
      { engine: "truffleruby", version: "24.1.0", rubyVersion: "3.2.4" },
    );
  });
  it("reads nothing from text that is not a description", () => {
    for (const text of [
      "",
      "ruby",
      "ruby is great",
      "ruby 3.3.6",
      "mruby 3.3.0 (2024-02-14)",
      "PHP 8.4.26 (cli)",
      undefined,
    ]) {
      assert.strictEqual(parseRubyDescription(text), undefined, `${text}`);
    }
  });
});

describe("parseRbConfig()", () => {
  it("assembles the version from MAJOR, MINOR and TEENY", () => {
    // RUBY_PROGRAM_VERSION is the unexpanded "$(MAJOR).$(MINOR).$(TEENY)"
    assert.deepStrictEqual(
      parseRbConfig(fixture("rbconfig-3.3.6-x86_64-linux.rb")),
      {
        version: "3.3.6",
        patchlevel: "108",
        abi: "3.3.0",
        arch: "x86_64-linux",
        baseName: "ruby",
      },
    );
    assert.deepStrictEqual(
      parseRbConfig(fixture("rbconfig-3.3.10-aarch64-linux-musl.rb")),
      {
        version: "3.3.10",
        patchlevel: "183",
        abi: "3.3.0",
        arch: "aarch64-linux-musl",
        baseName: "ruby",
      },
    );
    assert.strictEqual(
      parseRbConfig(fixture("rbconfig-3.1.2-debian.rb")).version,
      "3.1.2",
    );
    assert.deepStrictEqual(
      parseRbConfig(fixture("rbconfig-3.4.10-x64-mingw-ucrt.rb")),
      {
        version: "3.4.10",
        patchlevel: "104",
        abi: "3.4.0",
        arch: "x64-mingw-ucrt",
        baseName: "ruby",
      },
    );
  });
  it("falls back to a literal RUBY_PROGRAM_VERSION", () => {
    assert.strictEqual(
      parseRbConfig('  CONFIG["RUBY_PROGRAM_VERSION"] = "3.2.9"\n').version,
      "3.2.9",
    );
  });
  it("reads only literal assignments and never evaluates Ruby", () => {
    assert.strictEqual(
      parseRbConfig(
        '  CONFIG["MAJOR"] = "#{3}"\n  CONFIG["MINOR"] = MINOR\n  CONFIG["TEENY"] = "6"\n',
      ),
      undefined,
    );
    assert.strictEqual(parseRbConfig(""), undefined);
    assert.strictEqual(parseRbConfig(undefined), undefined);
  });
});

describe("file names", () => {
  it("recognizes ruby executables", () => {
    for (const name of [
      "ruby",
      "/usr/bin/ruby3.1",
      "ruby3.3.6",
      "C:\\tools\\ruby34\\bin\\ruby.exe",
      "RUBYW.EXE",
    ]) {
      assert.ok(isRubyBinaryName(name), name);
    }
    for (const name of ["rubocop", "ruby-build", "jruby", "irb", "", null]) {
      assert.ok(!isRubyBinaryName(name), `${name}`);
    }
  });
  it("recognizes libruby in every layout", () => {
    for (const name of [
      "libruby.so",
      "libruby.so.3.3",
      "/usr/local/lib/libruby.so.3.3.6",
      "libruby-3.1.so.3.1.2",
      "libruby-static.so",
      "libruby.3.4.dylib",
      "x64-ucrt-ruby340.dll",
      "x64-msvcrt-ruby270.dll",
    ]) {
      assert.ok(isLibrubyName(name), name);
    }
    for (const name of ["libruby.a", "librubyx.so", "ruby.dll", ""]) {
      assert.ok(!isLibrubyName(name), name);
    }
  });
  it("reads the version a soname spells", () => {
    assert.strictEqual(versionFromLibrubyName("libruby.so.3.3.6"), "3.3.6");
    assert.strictEqual(versionFromLibrubyName("libruby-3.1.so.3.1.2"), "3.1.2");
    assert.strictEqual(versionFromLibrubyName("libruby.3.3.6.dylib"), "3.3.6");
    assert.strictEqual(versionFromLibrubyName("libruby.so.3.3"), undefined);
  });
  it("finds the install prefix whatever the separator", () => {
    assert.strictEqual(rubyInstallPrefix("/usr/local/bin/ruby"), "/usr/local");
    assert.strictEqual(
      rubyInstallPrefix("/usr/local/lib/libruby.so.3.3.6"),
      "/usr/local",
    );
    assert.strictEqual(rubyInstallPrefix("/bin/ruby"), "/");
    assert.strictEqual(
      rubyInstallPrefix("C:\\tools\\ruby34\\bin\\ruby.exe"),
      "C:\\tools\\ruby34",
    );
    assert.strictEqual(rubyInstallPrefix("ruby"), undefined);
  });
});

describe("readRubyBuildVersion()", () => {
  it("reads an official-image layout from rbconfig.rb", () =>
    withRoot((root) => {
      const ruby = put(root, "usr/local/bin/ruby", "#!ELF small launcher");
      const lib = put(root, "usr/local/lib/libruby.so.3.3.6", "ELF");
      put(
        root,
        "usr/local/lib/ruby/3.3.0/aarch64-linux/rbconfig.rb",
        fixture("rbconfig-3.3.6-aarch64-linux.rb"),
      );
      // dozens of library directories sort before the arch directory
      for (let index = 0; index < 60; index++) {
        mkdirSync(join(root, `usr/local/lib/ruby/3.3.0/lib${index}`), {
          recursive: true,
        });
        put(root, `usr/local/lib/ruby/3.3.0/file${index}.rb`, "");
      }
      const expected = {
        version: "3.3.6",
        source: "rbconfig",
        patchlevel: "108",
        abi: "3.3.0",
        arch: "aarch64-linux",
      };
      assert.deepStrictEqual(readRubyBuildVersion(ruby, root), expected);
      assert.deepStrictEqual(readRubyBuildVersion(lib, root), expected);
    }));
  it("finds the arch directory past many library directories on x86_64", () =>
    withRoot((root) => {
      const ruby = put(root, "home/u/.rbenv/versions/3.3.6/bin/ruby", "x");
      put(
        root,
        "home/u/.rbenv/versions/3.3.6/lib/ruby/3.3.0/x86_64-linux/rbconfig.rb",
        fixture("rbconfig-3.3.6-x86_64-linux.rb"),
      );
      for (const name of ["bigdecimal", "bundler", "cgi", "did_you_mean"]) {
        mkdirSync(
          join(root, "home/u/.rbenv/versions/3.3.6/lib/ruby/3.3.0", name),
          { recursive: true },
        );
      }
      assert.strictEqual(readRubyBuildVersion(ruby, root).source, "rbconfig");
    }));
  it("reads the Debian layout", () =>
    withRoot((root) => {
      const ruby = put(root, "usr/bin/ruby3.1", "x");
      put(
        root,
        "usr/lib/aarch64-linux-gnu/ruby/3.1.0/rbconfig.rb",
        fixture("rbconfig-3.1.2-debian.rb"),
      );
      assert.deepStrictEqual(readRubyBuildVersion(ruby, root), {
        version: "3.1.2",
        source: "rbconfig",
        patchlevel: "20",
        abi: "3.1.0",
        arch: "aarch64-linux-gnu",
      });
    }));
  it("reads a Windows RubyInstaller layout", () =>
    withRoot((root) => {
      const ruby = put(root, "tools/ruby34/bin/ruby.exe", "MZ");
      put(
        root,
        "tools/ruby34/lib/ruby/3.4.0/x64-mingw-ucrt/rbconfig.rb",
        fixture("rbconfig-3.4.10-x64-mingw-ucrt.rb"),
      );
      const build = readRubyBuildVersion(ruby, root);
      assert.strictEqual(build.version, "3.4.10");
      assert.strictEqual(build.arch, "x64-mingw-ucrt");
    }));
  it("takes the preview tag from libruby when rbconfig.rb says -1", () =>
    withRoot((root) => {
      const ruby = put(root, "opt/r/bin/ruby", "x");
      put(
        root,
        "opt/r/lib/ruby/3.4.0/x86_64-linux/rbconfig.rb",
        '  CONFIG["MAJOR"] = "3"\n  CONFIG["MINOR"] = "4"\n  CONFIG["TEENY"] = "0"\n  CONFIG["PATCHLEVEL"] = "-1"\n  CONFIG["ruby_version"] = "3.4.0"\n',
      );
      put(
        root,
        "opt/r/lib/libruby.so.3.4.0",
        libruby(
          "ruby 3.4.0preview2 (2024-10-07 master 32c733f57b) +PRISM [x86_64-linux]",
        ),
      );
      const build = readRubyBuildVersion(ruby, root);
      assert.strictEqual(build.version, "3.4.0-preview2");
      assert.strictEqual(build.source, "rbconfig");
    }));
  it("reads the description when rbconfig.rb is missing", () =>
    withRoot((root) => {
      const lib = put(
        root,
        "opt/r/lib/libruby.so.3.3.6",
        libruby("ruby 3.3.6 (2024-11-05 revision 75015d4c1f) [x86_64-linux]"),
      );
      assert.deepStrictEqual(readRubyBuildVersion(lib, root), {
        version: "3.3.6",
        source: "binary",
        arch: "x86_64-linux",
      });
      assert.deepStrictEqual(readRubyDescription(lib, root), {
        engine: "ruby",
        version: "3.3.6",
        platform: "x86_64-linux",
      });
    }));
  it("falls back to the soname, and to nothing", () =>
    withRoot((root) => {
      const lib = put(root, "opt/r/lib/libruby.so.3.2.9", "no description");
      assert.deepStrictEqual(readRubyBuildVersion(lib, root), {
        version: "3.2.9",
        source: "soname",
      });
      const ruby = put(root, "opt/s/bin/ruby", "no description");
      assert.strictEqual(readRubyBuildVersion(ruby, root), undefined);
    }));
  it("picks the rbconfig.rb a versioned name pins when a prefix holds two", () =>
    withRoot((root) => {
      put(
        root,
        "usr/local/lib/ruby/3.3.0/x86_64-linux/rbconfig.rb",
        fixture("rbconfig-3.3.6-x86_64-linux.rb"),
      );
      put(
        root,
        "usr/local/lib/ruby/3.4.0/x64-mingw-ucrt/rbconfig.rb",
        fixture("rbconfig-3.4.10-x64-mingw-ucrt.rb"),
      );
      assert.strictEqual(findRbConfigFiles(join(root, "usr/local")).length, 2);
      const pinned = put(root, "usr/local/bin/ruby3.3", "x");
      assert.strictEqual(readRubyBuildVersion(pinned, root).version, "3.3.6");
      // An unpinned name cannot tell the two apart
      const plain = put(root, "usr/local/bin/ruby", "x");
      assert.strictEqual(readRubyBuildVersion(plain, root), undefined);
    }));
  it("does not follow an rbconfig.rb out of the root", () =>
    withRoot((root) =>
      withRoot((outside) => {
        const ruby = put(root, "usr/local/bin/ruby", "x");
        put(outside, "rbconfig.rb", fixture("rbconfig-3.3.6-x86_64-linux.rb"));
        mkdirSync(join(root, "usr/local/lib/ruby/3.3.0/x86_64-linux"), {
          recursive: true,
        });
        symlinkSync(
          join(outside, "rbconfig.rb"),
          join(root, "usr/local/lib/ruby/3.3.0/x86_64-linux/rbconfig.rb"),
        );
        assert.strictEqual(readRubyBuildVersion(ruby, root), undefined);
      }),
    ));
});

describe("runtime components", () => {
  it("names MRI by pkg:generic/ruby with the NVD CPE", () => {
    assert.deepStrictEqual(createRubyRuntimeComponent("3.3.6"), {
      type: "platform",
      name: "ruby",
      version: "3.3.6",
      cpe: "cpe:2.3:a:ruby-lang:ruby:3.3.6:*:*:*:*:*:*:*",
      purl: "pkg:generic/ruby@3.3.6",
      "bom-ref": "pkg:generic/ruby@3.3.6",
    });
    assert.strictEqual(
      rubyCpe("3.4.0-preview2"),
      "cpe:2.3:a:ruby-lang:ruby:3.4.0:preview2:*:*:*:*:*:*",
    );
    assert.strictEqual(rubyRuntimeRef("3.3.6"), "pkg:generic/ruby@3.3.6");
  });
  it("leaves the CPE out when asked, and for engines NVD does not name", () => {
    assert.strictEqual(
      createRubyRuntimeComponent("3.1.2", { withCpe: false }).cpe,
      undefined,
    );
    const jruby = createRubyRuntimeComponent("9.4.8.0", { engine: "jruby" });
    assert.strictEqual(jruby.purl, "pkg:generic/jruby@9.4.8.0");
    assert.strictEqual(
      jruby.cpe,
      "cpe:2.3:a:jruby:jruby:9.4.8.0:*:*:*:*:*:*:*",
    );
    const truffle = createRubyRuntimeComponent("24.1.0", {
      engine: "truffleruby",
    });
    assert.strictEqual(truffle.purl, "pkg:generic/truffleruby@24.1.0");
    assert.strictEqual(truffle.cpe, undefined);
    assert.strictEqual(
      createRubyRuntimeComponent("1.0.0", { engine: "mruby" }).name,
      "ruby",
    );
  });
  it("links each file to one runtime per version", () => {
    const inventory = createRubyRuntimeInventory();
    const build = {
      version: "3.3.6",
      source: "rbconfig",
      patchlevel: "108",
      abi: "3.3.0",
      arch: "x86_64-linux",
    };
    const a = { "bom-ref": "file-a", properties: [] };
    const b = { "bom-ref": "file-b", properties: [] };
    attachRubyBuild(inventory, a, build);
    attachRubyBuild(inventory, b, build);
    assert.strictEqual(inventory.runtimeComponents.length, 1);
    assert.deepStrictEqual(inventory.runtimeComponents[0].properties, [
      { name: "cdx:ruby:patchlevel", value: "108" },
    ]);
    assert.deepStrictEqual(
      a.properties.map((prop) => prop.name),
      [
        "cdx:ruby:buildVersion",
        "cdx:ruby:buildVersionSource",
        "cdx:ruby:patchlevel",
        "cdx:ruby:abiVersion",
        "cdx:ruby:platform",
      ],
    );
    assert.deepStrictEqual(inventory.dependencies, [
      { ref: "pkg:generic/ruby@3.3.6", dependsOn: [] },
      { ref: "file-a", dependsOn: ["pkg:generic/ruby@3.3.6"] },
      { ref: "file-b", dependsOn: ["pkg:generic/ruby@3.3.6"] },
    ]);
  });
});

describe("deriveOsPackagedRubyRuntimes()", () => {
  const pkg = (name, version, purl) => ({
    name,
    version,
    purl,
    "bom-ref": decodeURIComponent(purl),
  });
  it("prefers the library package of a distro and leaves out the CPE", () => {
    const runtimes = deriveOsPackagedRubyRuntimes([
      pkg(
        "ruby3.2",
        "3.2.3-1ubuntu0.24.04.8",
        "pkg:deb/ubuntu/ruby3.2@3.2.3-1ubuntu0.24.04.8?arch=amd64&distro=ubuntu-24.04",
      ),
      pkg(
        "libruby3.2",
        "3.2.3-1ubuntu0.24.04.8",
        "pkg:deb/ubuntu/libruby3.2@3.2.3-1ubuntu0.24.04.8?arch=amd64&distro=ubuntu-24.04",
      ),
      // the defaults metapackage is not an interpreter
      pkg(
        "ruby",
        "1:3.2~ubuntu1",
        "pkg:deb/ubuntu/ruby@1:3.2~ubuntu1?arch=amd64&distro=ubuntu-24.04&epoch=1",
      ),
      pkg("rack", "3.1.8", "pkg:gem/rack@3.1.8"),
    ]);
    assert.deepStrictEqual(runtimes, [
      {
        type: "platform",
        name: "ruby",
        version: "3.2.3",
        purl: "pkg:generic/ruby@3.2.3",
        "bom-ref": "pkg:generic/ruby@3.2.3",
        properties: [
          {
            name: "cdx:os:installedBy",
            value:
              "pkg:deb/ubuntu/libruby3.2@3.2.3-1ubuntu0.24.04.8?arch=amd64&distro=ubuntu-24.04",
          },
          { name: "cdx:ruby:buildVersionSource", value: "os-package" },
        ],
      },
    ]);
  });
  it("covers rpm, apk, Arch, Homebrew, Chocolatey and the RubyInstaller", () => {
    const versions = (components) =>
      deriveOsPackagedRubyRuntimes(components).map((runtime) => [
        runtime.version,
        Boolean(runtime.cpe),
      ]);
    assert.deepStrictEqual(
      versions([
        pkg(
          "ruby-libs",
          "3.0.7-168.el9_8",
          "pkg:rpm/redhat/ruby-libs@3.0.7-168.el9_8?arch=aarch64",
        ),
      ]),
      [["3.0.7", false]],
    );
    assert.deepStrictEqual(
      versions([
        pkg("ruby", "3.3.10-r0", "pkg:apk/alpine/ruby@3.3.10-r0?arch=aarch64"),
        pkg(
          "ruby-libs",
          "3.3.10-r0",
          "pkg:apk/alpine/ruby-libs@3.3.10-r0?arch=aarch64",
        ),
      ]),
      [["3.3.10", false]],
    );
    assert.deepStrictEqual(
      versions([pkg("ruby", "3.4.7-1", "pkg:alpm/arch/ruby@3.4.7-1")]),
      [["3.4.7", false]],
    );
    assert.deepStrictEqual(
      versions([pkg("ruby", "3.4.8_1", "pkg:brew/ruby@3.4.8_1")]),
      [["3.4.8", true]],
    );
    assert.deepStrictEqual(
      versions([
        pkg("ruby", "3.4.10.1", "pkg:chocolatey/ruby@3.4.10.1"),
        pkg(
          "Ruby+3.4.10-1-x64",
          "3.4.10-1",
          "pkg:swid/Ruby%2B3.4.10-1-x64@3.4.10-1?tag_id=Ruby%2B3.4.10-1-x64",
        ),
      ]),
      [["3.4.10", true]],
    );
  });
  it("adds nothing a scan already found, nor for other packages", () => {
    const existing = createRubyRuntimeComponent("3.3.10");
    assert.deepStrictEqual(
      deriveOsPackagedRubyRuntimes([
        existing,
        pkg("ruby-libs", "3.3.10-r0", "pkg:apk/alpine/ruby-libs@3.3.10-r0"),
      ]),
      [],
    );
    assert.deepStrictEqual(
      deriveOsPackagedRubyRuntimes([
        pkg("ruby-rack", "3.0.8-1", "pkg:deb/debian/ruby-rack@3.0.8-1"),
        pkg("rubygems", "3.3.15-2", "pkg:deb/debian/rubygems@3.3.15-2"),
      ]),
      [],
    );
    assert.deepStrictEqual(deriveOsPackagedRubyRuntimes(undefined), []);
  });
  it("reads the upstream version out of each package manager's", () => {
    assert.strictEqual(upstreamRubyVersion("1:3.1.2-7+deb12u1"), "3.1.2");
    assert.strictEqual(upstreamRubyVersion("3.3.10-r0"), "3.3.10");
    assert.strictEqual(upstreamRubyVersion("3.0.7-168.el9_8"), "3.0.7");
    assert.strictEqual(upstreamRubyVersion("3.4.8_1"), "3.4.8");
    assert.strictEqual(upstreamRubyVersion("3.4.10.1", "chocolatey"), "3.4.10");
    assert.strictEqual(upstreamRubyVersion("1:3.2~ubuntu1"), undefined);
    assert.strictEqual(upstreamRubyVersion(""), undefined);
  });
});

describe("default and installed gems", () => {
  it("knows a default gem's install", () => {
    assert.deepStrictEqual(
      defaultGemInstall(
        "/usr/local/lib/ruby/gems/3.3.0/specifications/default/resolv-0.3.0.gemspec",
      ),
      { prefix: "/usr/local", abi: "3.3.0" },
    );
    assert.strictEqual(
      defaultGemInstall(
        "/usr/local/lib/ruby/gems/3.3.0/specifications/rack-3.1.8.gemspec",
      ),
      undefined,
    );
  });
  it("links the default gems of an unpackaged Ruby to it", () => {
    const runtime = createRubyRuntimeComponent("3.3.6");
    const file = {
      type: "file",
      "bom-ref": "pkg:generic/ruby",
      properties: [
        { name: "internal:SrcFile", value: "/tmp/x/usr/local/bin/ruby" },
        { name: "cdx:ruby:buildVersion", value: "3.3.6" },
      ],
    };
    const gem = (name, extra = []) => ({
      "bom-ref": `pkg:gem/${name}`,
      properties: [
        {
          name: "internal:SrcFile",
          value: `/tmp/x/usr/local/lib/ruby/gems/3.3.0/specifications/default/${name}.gemspec`,
        },
        { name: "cdx:gem:defaultGem", value: "true" },
        ...extra,
      ],
    });
    const owned = gem("json-2.7.2", [
      { name: "cdx:os:installedBy", value: "pkg:deb/debian/libruby3.3" },
    ]);
    assert.deepStrictEqual(
      linkDefaultGemsToRuntimes(
        [runtime, file, gem("resolv-0.3.0"), gem("uri-0.13.1"), owned],
        "/tmp/x",
      ),
      [
        {
          ref: "pkg:generic/ruby@3.3.6",
          dependsOn: ["pkg:gem/resolv-0.3.0", "pkg:gem/uri-0.13.1"],
        },
      ],
    );
    // Without the runtime component there is nothing to link to
    assert.deepStrictEqual(
      linkDefaultGemsToRuntimes([file, gem("resolv-0.3.0")], "/tmp/x"),
      [],
    );
  });
  it("tells files inside an installed gem from a project's own", () =>
    withRoot((root) => {
      mkdirSync(join(root, "usr/local/lib/ruby/gems/3.3.0/specifications"), {
        recursive: true,
      });
      const exists = (path) => {
        try {
          return readFileSync(path) && true;
        } catch (error) {
          return error.code === "EISDIR";
        }
      };
      assert.ok(
        isInsideInstalledGem(
          join(
            root,
            "usr/local/lib/ruby/gems/3.3.0/gems/rbs-3.4.0/steep/Gemfile.lock",
          ),
          exists,
        ),
      );
      assert.ok(
        isInsideInstalledGem(
          join(
            root,
            "usr/local/lib/ruby/gems/3.3.0/gems/typeprof-0.21.9/vscode/package-lock.json",
          ),
          exists,
        ),
      );
      // A project directory named gems with no specifications beside it
      assert.ok(
        !isInsideInstalledGem(
          join(root, "src/gems/app-1.0/Gemfile.lock"),
          exists,
        ),
      );
      assert.ok(!isInsideInstalledGem(join(root, "app/Gemfile.lock"), exists));
    }));
});

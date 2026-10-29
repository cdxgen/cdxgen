import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  addRubyRuntimeComponent,
  collectProjectRubyDeclarations,
  isDefaultGemspecPath,
  parseGemfileLockRubyVersion,
  parseGemfileRubyDirective,
  parseMiseRuby,
  parseRubyVersionFile,
  parseToolVersionsRuby,
  resolveProjectRuby,
} from "./rubyutils.js";

const PROJECTS = join("test", "data", "ruby-runtime", "projects");

describe("Ruby pin files", () => {
  it("reads .ruby-version as the version managers do", () => {
    assert.deepStrictEqual(parseRubyVersionFile("3.3.6\n"), {
      engine: "ruby",
      version: "3.3.6",
      source: ".ruby-version",
    });
    assert.deepStrictEqual(parseRubyVersionFile("ruby-3.3.13"), {
      engine: "ruby",
      version: "3.3.13",
      source: ".ruby-version",
    });
    assert.deepStrictEqual(parseRubyVersionFile("# pinned\n\n3.3\n"), {
      engine: "ruby",
      requirement: "~> 3.3.0",
      source: ".ruby-version",
    });
    assert.deepStrictEqual(parseRubyVersionFile("jruby-9.4.8.0"), {
      engine: "jruby",
      version: "9.4.8.0",
      source: ".ruby-version",
    });
    assert.deepStrictEqual(parseRubyVersionFile("truffleruby+graalvm-24.1.0"), {
      engine: "truffleruby",
      version: "24.1.0",
      source: ".ruby-version",
    });
    // the old parser turned these into `j9.4.8.0` and `3.4.0`
    assert.strictEqual(parseRubyVersionFile("mruby-3.3.0"), undefined);
    assert.strictEqual(
      parseRubyVersionFile("3.4.0-preview2").version,
      "3.4.0-preview2",
    );
    assert.strictEqual(parseRubyVersionFile("system"), undefined);
    assert.strictEqual(parseRubyVersionFile(""), undefined);
  });
  it("reads the ruby line of .tool-versions", () => {
    assert.deepStrictEqual(
      parseToolVersionsRuby("nodejs 24.13.0\nruby 3.4.10 3.3.6 # fallback\n"),
      { engine: "ruby", version: "3.4.10", source: ".tool-versions" },
    );
    assert.strictEqual(
      parseToolVersionsRuby("ruby jruby-9.4.8.0\n").engine,
      "jruby",
    );
    assert.strictEqual(parseToolVersionsRuby("rubyx 3.3.6"), undefined);
  });
  it("reads the [tools] table of mise.toml", () => {
    assert.deepStrictEqual(
      parseMiseRuby(
        '[env]\nruby = "no"\n[tools]\nnode = "24"\nruby = "3.2.9"\n',
      ),
      { engine: "ruby", version: "3.2.9", source: "mise.toml" },
    );
    assert.strictEqual(
      parseMiseRuby('[tools]\nruby = ["3.3.6", "3.2"]\n').version,
      "3.3.6",
    );
    assert.strictEqual(
      parseMiseRuby('[tools]\nruby = { version = "3.3.6" }\n', ".mise.toml")
        .source,
      ".mise.toml",
    );
    assert.strictEqual(parseMiseRuby('[tools]\nnode = "24"\n'), undefined);
  });
});

describe("Gemfile and Gemfile.lock", () => {
  it("reads the Gemfile ruby directive without evaluating it", () => {
    assert.deepStrictEqual(parseGemfileRubyDirective('ruby "3.3.6"'), {
      engine: "ruby",
      version: "3.3.6",
      source: "Gemfile",
    });
    assert.deepStrictEqual(parseGemfileRubyDirective("ruby '~> 3.3'"), {
      engine: "ruby",
      requirement: "~> 3.3",
      source: "Gemfile",
    });
    assert.deepStrictEqual(
      parseGemfileRubyDirective(
        'ruby "3.1.4", engine: "jruby", engine_version: "9.4.8.0"',
      ),
      {
        engine: "jruby",
        version: "9.4.8.0",
        source: "Gemfile",
        rubyVersion: "3.1.4",
      },
    );
    assert.deepStrictEqual(
      parseGemfileRubyDirective('ruby file: ".ruby-version"'),
      { engine: "ruby", file: ".ruby-version", source: "Gemfile" },
    );
    for (const text of [
      "ruby RUBY_VERSION",
      'ruby "#{ENV["RUBY"]}"',
      'gem "ruby-progressbar"',
      'rubygems_version = "3.5"',
    ]) {
      assert.strictEqual(parseGemfileRubyDirective(text), undefined, text);
    }
  });
  it("reads the RUBY VERSION section Bundler writes", () => {
    const lock = (line) =>
      `GEM\n  specs:\n\nRUBY VERSION\n   ${line}\n\nBUNDLED WITH\n   2.5.22\n`;
    assert.deepStrictEqual(
      parseGemfileLockRubyVersion(lock("ruby 3.3.6p108")),
      {
        engine: "ruby",
        version: "3.3.6",
        source: "Gemfile.lock",
        patchlevel: "108",
      },
    );
    assert.deepStrictEqual(parseGemfileLockRubyVersion(lock("ruby 3.4.0p-1")), {
      engine: "ruby",
      version: "3.4.0",
      source: "Gemfile.lock",
      prerelease: true,
    });
    assert.deepStrictEqual(
      parseGemfileLockRubyVersion(lock("ruby 3.1.4p0 (jruby 9.4.8.0)")),
      {
        engine: "jruby",
        version: "9.4.8.0",
        rubyVersion: "3.1.4",
        source: "Gemfile.lock",
      },
    );
    assert.strictEqual(
      parseGemfileLockRubyVersion("GEM\n  specs:\n"),
      undefined,
    );
  });
  it("knows a default gem by where its gemspec is", () => {
    assert.ok(
      isDefaultGemspecPath(
        "/usr/local/lib/ruby/gems/3.3.0/specifications/default/resolv-0.3.0.gemspec",
      ),
    );
    assert.ok(
      isDefaultGemspecPath(
        "C:\\tools\\ruby34\\lib\\ruby\\gems\\3.4.0\\specifications\\default\\uri-1.0.3.gemspec",
      ),
    );
    assert.ok(
      isDefaultGemspecPath(
        "/usr/share/gems/specifications/default/json-2.5.1.gemspec",
      ),
    );
    assert.ok(
      !isDefaultGemspecPath(
        "/usr/local/lib/ruby/gems/3.3.0/specifications/rack-3.1.8.gemspec",
      ),
    );
  });
});

describe("collectProjectRubyDeclarations() and resolveProjectRuby()", () => {
  it("prefers the lockfile and reports a conflicting pin", () => {
    const declarations = collectProjectRubyDeclarations(
      join(PROJECTS, "pinned"),
    );
    assert.deepStrictEqual(
      declarations.map((d) => [d.source, d.version]),
      [
        ["Gemfile.lock", "3.3.6"],
        [".ruby-version", "3.3.5"],
        ["Gemfile", "3.3.6"],
      ],
    );
    assert.deepStrictEqual(resolveProjectRuby(declarations), {
      engine: "ruby",
      requirements: [],
      conflicts: [".ruby-version: ruby 3.3.5"],
      version: "3.3.6",
      patchlevel: "108",
      source: "Gemfile.lock",
    });
  });
  it("follows ruby file: to the version file inside the project", () => {
    const resolved = resolveProjectRuby(
      collectProjectRubyDeclarations(join(PROJECTS, "gemfile-file")),
    );
    assert.strictEqual(resolved.version, "3.3.13");
    assert.strictEqual(resolved.source, ".ruby-version");
  });
  it("reads asdf, mise and partial pins", () => {
    const resolve = (name) =>
      resolveProjectRuby(collectProjectRubyDeclarations(join(PROJECTS, name)));
    assert.strictEqual(resolve("tool-versions").version, "3.4.10");
    assert.strictEqual(resolve("mise").version, "3.2.9");
    const partial = resolve("partial");
    assert.strictEqual(partial.version, undefined);
    assert.deepStrictEqual(partial.requirements, ["~> 3.3.0"]);
    const jruby = resolve("jruby");
    assert.strictEqual(jruby.engine, "jruby");
    assert.strictEqual(jruby.version, "9.4.8.0");
    assert.strictEqual(jruby.rubyVersion, "3.1.4");
    assert.strictEqual(resolveProjectRuby([]), undefined);
  });
});

describe("addRubyRuntimeComponent() with a pinned Ruby", () => {
  const parent = { "bom-ref": "pkg:gem/app@1.0.0" };
  const rack = {
    "bom-ref": "pkg:gem/rack@3.1.8",
    properties: [{ name: "cdx:gem:rubyVersionSpecifiers", value: ">= 2.4.0" }],
  };
  it("names the pinned version with its CPE and keeps the range apart", () => {
    const { pkgList, dependencies } = addRubyRuntimeComponent(
      [rack],
      parent,
      [{ ref: parent["bom-ref"], dependsOn: [rack["bom-ref"]] }],
      {
        engine: "ruby",
        version: "3.3.6",
        patchlevel: "108",
        source: "Gemfile.lock",
        requirements: [],
        conflicts: [".ruby-version: ruby 3.3.5"],
      },
    );
    const runtime = pkgList.at(-1);
    assert.deepStrictEqual(runtime, {
      type: "platform",
      name: "ruby",
      version: "3.3.6",
      cpe: "cpe:2.3:a:ruby-lang:ruby:3.3.6:*:*:*:*:*:*:*",
      purl: "pkg:generic/ruby@3.3.6",
      "bom-ref": "pkg:generic/ruby@3.3.6",
      scope: "required",
      isExternal: true,
      properties: [
        { name: "cdx:ruby:isExternal", value: "true" },
        { name: "cdx:ruby:versionSource", value: "Gemfile.lock" },
        { name: "cdx:ruby:patchlevel", value: "108" },
        { name: "cdx:ruby:requiredVersionRange", value: "vers:gem/>=2.4.0" },
        {
          name: "cdx:ruby:conflictingDeclarations",
          value: ".ruby-version: ruby 3.3.5",
        },
      ],
    });
    assert.deepStrictEqual(dependencies, [
      {
        ref: "pkg:gem/app@1.0.0",
        dependsOn: ["pkg:gem/rack@3.1.8", "pkg:generic/ruby@3.3.6"],
      },
      { ref: "pkg:gem/rack@3.1.8", dependsOn: ["pkg:generic/ruby@3.3.6"] },
      { ref: "pkg:generic/ruby@3.3.6", dependsOn: [] },
    ]);
  });
  it("names another engine, and leaves a pre-release without a CPE", () => {
    const jruby = addRubyRuntimeComponent([], parent, [], {
      engine: "jruby",
      version: "9.4.8.0",
      rubyVersion: "3.1.4",
      source: "Gemfile.lock",
      requirements: [],
      conflicts: [],
    }).pkgList[0];
    assert.strictEqual(jruby.purl, "pkg:generic/jruby@9.4.8.0");
    assert.ok(
      jruby.properties.some(
        (p) => p.name === "cdx:ruby:languageVersion" && p.value === "3.1.4",
      ),
    );
    const preview = addRubyRuntimeComponent([], parent, [], {
      engine: "ruby",
      version: "3.4.0",
      prerelease: true,
      source: "Gemfile.lock",
      requirements: [],
      conflicts: [],
    }).pkgList[0];
    assert.strictEqual(preview.cpe, undefined);
  });
  it("narrows an unpinned range by a partial pin", () => {
    const runtime = addRubyRuntimeComponent([rack], parent, [], {
      engine: "ruby",
      requirements: ["~> 3.3.0"],
      conflicts: [],
    }).pkgList.at(-1);
    assert.strictEqual(runtime.purl, "pkg:generic/ruby");
    assert.strictEqual(runtime.versionRange, "vers:gem/>=3.3.0|<3.4");
  });
});

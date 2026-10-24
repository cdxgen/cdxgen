import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import { determinePackageType } from "../cli/bomAssembly.js";
import {
  addRubyGemsDistributionUrls,
  addRubyRuntimeComponent,
  describeProjectGem,
  enrichGemsFromLocalCache,
  isRubyPlatform,
  normalizeGemPlatform,
  parseBundleConfig,
  parseCompactIndexInfo,
  parseGemChecksumLine,
  parseGemfileLockData,
  parseGemspecData,
  readRubyStringList,
  readRubyStringLiteral,
  rubyRequirementToVers,
  simplifyRubyVersion,
  splitRubyVersionPlatform,
  toGemModuleNames,
  toGemPurl,
} from "./rubyutils.js";

const COMPACT_INDEX_CACHE = "./test/data/ruby-cache/compact_index";
const CACHED_GEM_HOME = "./test/data/ruby-cache/gemhome";

// Collect the purls of every component with the given name.
const purlsFor = (retMap, name) =>
  retMap.pkgList
    .filter((pkg) => pkg.name === name)
    .map((pkg) => pkg.purl)
    .sort();

it("splitRubyVersionPlatform", () => {
  // Plain versions are returned untouched
  for (const version of [
    "3.25.1",
    "1.0",
    "7.2.0.alpha",
    "2.0.0.pre.beta1",
    "16.10.0.0",
  ]) {
    assert.deepStrictEqual(splitRubyVersionPlatform(version), {
      version,
      platform: undefined,
    });
  }
  // cpu-os platforms
  assert.deepStrictEqual(splitRubyVersionPlatform("3.25.1-x86_64-linux"), {
    version: "3.25.1",
    platform: "x86_64-linux",
  });
  assert.deepStrictEqual(
    splitRubyVersionPlatform("1.19.4-aarch64-linux-musl"),
    {
      version: "1.19.4",
      platform: "aarch64-linux-musl",
    },
  );
  assert.deepStrictEqual(splitRubyVersionPlatform("3.23.4-arm64-darwin"), {
    version: "3.23.4",
    platform: "arm64-darwin",
  });
  assert.deepStrictEqual(splitRubyVersionPlatform("1.16.3-x64-mingw-ucrt"), {
    version: "1.16.3",
    platform: "x64-mingw-ucrt",
  });
  assert.deepStrictEqual(splitRubyVersionPlatform("1.1.0-x86-mingw32"), {
    version: "1.1.0",
    platform: "x86-mingw32",
  });
  // An os version suffix is part of the platform
  assert.deepStrictEqual(
    splitRubyVersionPlatform("16.10.0.0-universal-darwin-20"),
    { version: "16.10.0.0", platform: "universal-darwin-20" },
  );
  assert.deepStrictEqual(splitRubyVersionPlatform("1.8.6-x86-mswin32-60"), {
    version: "1.8.6",
    platform: "x86-mswin32-60",
  });
  // cpu-agnostic platforms
  assert.deepStrictEqual(splitRubyVersionPlatform("1.16.7-java"), {
    version: "1.16.7",
    platform: "java",
  });
  assert.deepStrictEqual(splitRubyVersionPlatform("1.0.0-universal-java-11"), {
    version: "1.0.0",
    platform: "universal-java-11",
  });
  // The cpu is an open token in RubyGems, so unknown platforms are supported
  assert.deepStrictEqual(splitRubyVersionPlatform("25.0.0-wasm32-wasi"), {
    version: "25.0.0",
    platform: "wasm32-wasi",
  });
  assert.deepStrictEqual(splitRubyVersionPlatform("0.7.7-x86_64-cygwin"), {
    version: "0.7.7",
    platform: "x86_64-cygwin",
  });
  // Degenerate input
  assert.deepStrictEqual(splitRubyVersionPlatform(undefined), {
    version: undefined,
    platform: undefined,
  });
  assert.deepStrictEqual(splitRubyVersionPlatform(""), {
    version: "",
    platform: undefined,
  });
  assert.deepStrictEqual(splitRubyVersionPlatform("-x86_64-linux"), {
    version: "-x86_64-linux",
    platform: undefined,
  });
  assert.deepStrictEqual(splitRubyVersionPlatform("1.0.0-"), {
    version: "1.0.0-",
    platform: undefined,
  });
  assert.deepStrictEqual(simplifyRubyVersion("3.25.1-x86_64-linux"), "3.25.1");
  assert.deepStrictEqual(simplifyRubyVersion("3.25.1"), "3.25.1");
});

it("isRubyPlatform", () => {
  for (const platform of [
    "x86_64-linux",
    "x86_64-linux-musl",
    "arm64-darwin",
    "universal-darwin-20",
    "x64-mingw-ucrt",
    "x86-mswin32-60",
    "java",
    "universal-java-11",
    "wasm32-wasi",
    "ruby",
  ]) {
    assert.ok(isRubyPlatform(platform), platform);
  }
  for (const notPlatform of ["", undefined, "beta1", "3.25.1", "CURRENT"]) {
    assert.ok(!isRubyPlatform(notPlatform), `${notPlatform}`);
  }
});

it("normalizeGemPlatform", () => {
  // Gem::Platform maps the jruby engine name onto the java os
  assert.deepStrictEqual(normalizeGemPlatform("jruby"), "java");
  assert.deepStrictEqual(normalizeGemPlatform("java"), "java");
  assert.deepStrictEqual(
    normalizeGemPlatform("universal-java-11"),
    "universal-java-11",
  );
  assert.deepStrictEqual(normalizeGemPlatform("x86_64-linux"), "x86_64-linux");
  assert.deepStrictEqual(normalizeGemPlatform(undefined), undefined);
  // A jruby suffix and a java suffix must not produce two different purls
  assert.deepStrictEqual(
    toGemPurl("jruby-launcher", "1.1.2", "jruby"),
    "pkg:gem/jruby-launcher@1.1.2?platform=java",
  );
  // truffleruby is not a Gem::Platform at all. Gem::Platform.new("truffleruby")
  // is `unknown`, and TruffleRuby reports a conventional platform such as
  // x86_64-linux, so it must never be treated as a platform suffix.
  assert.ok(!isRubyPlatform("truffleruby"));
  assert.deepStrictEqual(normalizeGemPlatform("truffleruby"), "truffleruby");
});

it("parseGemChecksumLine", () => {
  assert.deepStrictEqual(
    parseGemChecksumLine(
      "nokogiri (1.16.0) sha256=341388184e975d091e6e38ce3f3b3388bfb7e4ac3d790efd8e39124844040bd1",
    ),
    {
      lockName: "nokogiri (1.16.0)",
      hashes: [
        {
          alg: "SHA-256",
          content:
            "341388184e975d091e6e38ce3f3b3388bfb7e4ac3d790efd8e39124844040bd1",
        },
      ],
    },
  );
  // The lock name of a native gem carries the platform
  assert.deepStrictEqual(
    parseGemChecksumLine(
      "sqlite3 (2.9.5-arm64-darwin) sha256=d0cf444a70fc9395d513cfbcc1e6719e224aa645314e3824cb0474c721425aa2",
    )?.lockName,
    "sqlite3 (2.9.5-arm64-darwin)",
  );
  // Several algorithms may be recorded, comma joined
  assert.deepStrictEqual(
    parseGemChecksumLine("agem (1.0) sha256=abcdef,sha512=012345")?.hashes,
    [
      { alg: "SHA-256", content: "abcdef" },
      { alg: "SHA-512", content: "012345" },
    ],
  );
  // An entry may carry no checksum at all
  assert.deepStrictEqual(parseGemChecksumLine("agem (1.0)"), undefined);
  assert.deepStrictEqual(parseGemChecksumLine("not a checksum"), undefined);
  assert.deepStrictEqual(parseGemChecksumLine(""), undefined);
  assert.deepStrictEqual(parseGemChecksumLine(undefined), undefined);
  // Only hex digests are accepted
  assert.deepStrictEqual(
    parseGemChecksumLine("agem (1.0) sha256=not-hex!"),
    undefined,
  );
});

it("parseCompactIndexInfo", () => {
  const releases = parseCompactIndexInfo(
    readFileSync(
      `${COMPACT_INDEX_CACHE}/rubygems.org.443.b7f1e/info/nokogiri`,
      {
        encoding: "utf-8",
      },
    ),
  );
  assert.deepStrictEqual(Object.keys(releases).sort(), [
    "1.16.6",
    "1.16.7",
    "1.16.7-java",
    "1.16.7-x86_64-linux",
  ]);
  assert.deepStrictEqual(releases["1.16.7"], {
    checksum:
      "341388184e975d091e6e38ce3f3b3388bfb7e4ac3d790efd8e39124844040bd1",
    ruby: ">= 3.0",
    rubygems: ">= 3.3.22",
    created_at: "2024-07-01T10:00:00Z",
  });
  // Each native build has its own checksum, which is the whole point of
  // tracking the platform separately from the version
  assert.notDeepStrictEqual(
    releases["1.16.7-x86_64-linux"].checksum,
    releases["1.16.7-java"].checksum,
  );
  // Alternative requirements are joined with `&` by the compact index
  assert.deepStrictEqual(
    releases["1.16.7-x86_64-linux"].ruby,
    ">= 3.0&< 3.4.dev",
  );
  // A release with no dependencies still parses
  const ffi = parseCompactIndexInfo(
    readFileSync(`${COMPACT_INDEX_CACHE}/rubygems.org.443.b7f1e/info/ffi`, {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(Object.keys(ffi), ["1.17.0"]);
  assert.deepStrictEqual(parseCompactIndexInfo(""), {});
  assert.deepStrictEqual(parseCompactIndexInfo(undefined), {});
});

it("parseBundleConfig", () => {
  assert.deepStrictEqual(parseBundleConfig("./test/data/bundle-config"), {
    BUNDLE_PATH: "vendor/bundle",
    BUNDLE_WITHOUT: "development:test",
    BUNDLE_JOBS: "4",
  });
  assert.deepStrictEqual(parseBundleConfig("./test/data/does-not-exist"), {});
  assert.deepStrictEqual(parseBundleConfig(undefined), {});
});

it("enrichGemsFromLocalCache", async () => {
  const pkgList = [
    {
      name: "nokogiri",
      version: "1.16.7",
      purl: "pkg:gem/nokogiri@1.16.7?platform=x86_64-linux",
      properties: [],
    },
    {
      name: "nokogiri",
      version: "1.16.7",
      purl: "pkg:gem/nokogiri@1.16.7?platform=java",
      properties: [],
    },
    {
      name: "nokogiri",
      version: "1.16.7",
      purl: "pkg:gem/nokogiri@1.16.7",
      properties: [],
    },
    {
      name: "ffi",
      version: "1.17.0",
      purl: "pkg:gem/ffi@1.17.0",
      properties: [],
    },
    // Not in either cache
    {
      name: "unknown-gem",
      version: "9.9.9",
      purl: "pkg:gem/unknown-gem@9.9.9",
      properties: [],
    },
  ];
  await enrichGemsFromLocalCache(pkgList, {
    gemHome: CACHED_GEM_HOME,
    compactIndexCacheDir: COMPACT_INDEX_CACHE,
  });
  const [nativeGem, javaGem, rubyGem, ffiGem, unknownGem] = pkgList;
  // Each platform resolves to its own checksum
  assert.deepStrictEqual(
    nativeGem._integrity,
    "sha256-aa1388184e975d091e6e38ce3f3b3388bfb7e4ac3d790efd8e39124844040bd1",
  );
  assert.deepStrictEqual(
    javaGem._integrity,
    "sha256-bb1388184e975d091e6e38ce3f3b3388bfb7e4ac3d790efd8e39124844040bd1",
  );
  assert.deepStrictEqual(
    rubyGem._integrity,
    "sha256-341388184e975d091e6e38ce3f3b3388bfb7e4ac3d790efd8e39124844040bd1",
  );
  // The compact index requirement separator is normalized
  assert.deepStrictEqual(
    nativeGem.properties.find(
      (prop) => prop.name === "cdx:gem:rubyVersionSpecifiers",
    )?.value,
    ">= 3.0, < 3.4.dev",
  );
  assert.deepStrictEqual(
    nativeGem.properties.find(
      (prop) => prop.name === "cdx:gem:rubygemsVersionSpecifiers",
    )?.value,
    ">= 3.3.22",
  );
  // `>= 0` carries no information and is not recorded
  assert.deepStrictEqual(
    ffiGem.properties.find(
      (prop) => prop.name === "cdx:gem:rubygemsVersionSpecifiers",
    ),
    undefined,
  );
  // The installed gemspec of the native build supplies the license
  assert.deepStrictEqual(nativeGem.license, ["MIT"]);
  assert.deepStrictEqual(nativeGem.description?.length > 0, true);
  // There is no installed gemspec for the java build
  assert.deepStrictEqual(javaGem.license, undefined);
  // An unknown gem is left untouched
  assert.deepStrictEqual(unknownGem._integrity, undefined);
  assert.deepStrictEqual(unknownGem.properties, []);
  // Absent caches are not an error
  assert.deepStrictEqual(await enrichGemsFromLocalCache([]), []);
  assert.deepStrictEqual(
    await enrichGemsFromLocalCache([{ name: "a", version: "1" }], {
      gemHome: "./test/data/does-not-exist",
      compactIndexCacheDir: "./test/data/does-not-exist",
    }),
    [{ name: "a", version: "1" }],
  );
});

it("toGemPurl", () => {
  assert.deepStrictEqual(
    toGemPurl("ruby-advisory-db-check", "0.12.4", undefined),
    "pkg:gem/ruby-advisory-db-check@0.12.4",
  );
  // Matches the example in the purl specification for the gem type
  assert.deepStrictEqual(
    toGemPurl("jruby-launcher", "1.1.2", "java"),
    "pkg:gem/jruby-launcher@1.1.2?platform=java",
  );
  assert.deepStrictEqual(
    toGemPurl("google-protobuf", "3.25.1", "x86_64-linux"),
    "pkg:gem/google-protobuf@3.25.1?platform=x86_64-linux",
  );
  // `ruby` is the implied default platform and must not be emitted
  assert.deepStrictEqual(
    toGemPurl("rake", "13.0.6", "ruby"),
    "pkg:gem/rake@13.0.6",
  );
  assert.deepStrictEqual(toGemPurl("wdm", null, null), "pkg:gem/wdm");
});

it("parseGemfileLockData platform qualifiers", async () => {
  const lockFile = "./test/data/Gemfile-platforms.lock";
  const retMap = await parseGemfileLockData(
    readFileSync(lockFile, { encoding: "utf-8" }),
    lockFile,
  );
  assert.deepStrictEqual(retMap.pkgList.length, 27);
  assert.deepStrictEqual(retMap.dependenciesList.length, 27);
  // Every native variant is tracked as a distinct component, distinguished by
  // the platform qualifier rather than by a platform suffix in the version.
  assert.deepStrictEqual(purlsFor(retMap, "ffi"), [
    "pkg:gem/ffi@1.17.0",
    "pkg:gem/ffi@1.17.0?platform=aarch64-linux-gnu",
    "pkg:gem/ffi@1.17.0?platform=arm64-darwin",
    "pkg:gem/ffi@1.17.0?platform=java",
    "pkg:gem/ffi@1.17.0?platform=x64-mingw-ucrt",
    "pkg:gem/ffi@1.17.0?platform=x86_64-linux-gnu",
    "pkg:gem/ffi@1.17.0?platform=x86_64-linux-musl",
  ]);
  for (const pkg of retMap.pkgList.filter((p) => p.name === "ffi")) {
    assert.deepStrictEqual(pkg.version, "1.17.0");
  }
  // The reported issue: the version must not retain the platform suffix
  const protobuf = retMap.pkgList.find(
    (pkg) =>
      pkg.purl === "pkg:gem/google-protobuf@3.25.1?platform=x86_64-linux",
  );
  assert.deepStrictEqual(protobuf.version, "3.25.1");
  assert.deepStrictEqual(
    protobuf["bom-ref"],
    "pkg:gem/google-protobuf@3.25.1?platform=x86_64-linux",
  );
  // A prerelease version is never mistaken for a platform
  assert.deepStrictEqual(purlsFor(retMap, "prerelease-gem"), [
    "pkg:gem/prerelease-gem@2.0.0.pre.beta1",
  ]);
  assert.deepStrictEqual(purlsFor(retMap, "rails"), [
    "pkg:gem/rails@7.2.0.alpha",
  ]);
  // An open ended cpu token and an os version suffix are both preserved
  assert.deepStrictEqual(purlsFor(retMap, "wasmtime"), [
    "pkg:gem/wasmtime@25.0.0?platform=wasm32-wasi",
  ]);
  assert.deepStrictEqual(purlsFor(retMap, "libv8-node"), [
    "pkg:gem/libv8-node@16.10.0.0?platform=universal-darwin-20",
  ]);
  assert.deepStrictEqual(purlsFor(retMap, "json"), [
    "pkg:gem/json@1.8.6?platform=x86-mswin32-60",
  ]);
  // PATH and GIT sourced gems keep their platform too
  assert.deepStrictEqual(purlsFor(retMap, "local-gem"), [
    "pkg:gem/local-gem@0.1.0?platform=x86_64-linux",
  ]);
  // The platform qualifier is no longer duplicated as a property
  for (const pkg of retMap.pkgList) {
    assert.deepStrictEqual(
      pkg.properties.filter((prop) => prop.name === "cdx:gem:platform"),
      [],
    );
  }
  // Bundler 2.5 records a sha256 per gem in the CHECKSUMS section
  const withHashes = retMap.pkgList.filter((pkg) => pkg.hashes?.length);
  assert.deepStrictEqual(withHashes.map((pkg) => pkg.purl).sort(), [
    "pkg:gem/concurrent-ruby@1.3.4",
    "pkg:gem/ffi@1.17.0",
  ]);
  assert.deepStrictEqual(
    retMap.pkgList.find((pkg) => pkg.purl === "pkg:gem/concurrent-ruby@1.3.4")
      .hashes,
    [
      {
        alg: "SHA-256",
        content:
          "1a1bb9b4ea9e94d8b8b0a8ea2a4d0a5e9e0a1a5d3f5cb1a3f2b0e8b7a6c5d4e3",
      },
    ],
  );
  // No component is left without a version now that the native builds present
  // in the lockfile are reported instead of a phantom placeholder
  assert.deepStrictEqual(
    retMap.pkgList.filter((pkg) => !pkg.version),
    [],
  );
  // Both native variants of a gem resolve their pure ruby dependency
  const dependsOn = (ref) =>
    retMap.dependenciesList.find((d) => d.ref === ref)?.dependsOn;
  assert.deepStrictEqual(dependsOn("pkg:gem/nokogiri@1.16.7?platform=java"), [
    "pkg:gem/racc@1.8.1",
  ]);
  assert.deepStrictEqual(
    dependsOn("pkg:gem/nokogiri@1.16.7?platform=x86_64-linux"),
    ["pkg:gem/racc@1.8.1"],
  );
  assert.deepStrictEqual(
    dependsOn("pkg:gem/sqlite3@2.0.4?platform=x86_64-linux-gnu"),
    ["pkg:gem/mini_portile2@2.8.7"],
  );
});

it("parseGemspecData platform qualifiers", async () => {
  // Installed gemspecs of native gems use the marshalled Gem::Platform form
  let deps = await parseGemspecData(
    readFileSync("./test/data/gem-native.gemspec", { encoding: "utf-8" }),
    "./test/data/gem-native.gemspec",
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0].name, "nokogiri");
  assert.deepStrictEqual(deps[0].version, "1.16.7");
  assert.deepStrictEqual(
    deps[0].purl,
    "pkg:gem/nokogiri@1.16.7?platform=x86_64-linux",
  );
  assert.deepStrictEqual(
    deps[0]["bom-ref"],
    "pkg:gem/nokogiri@1.16.7?platform=x86_64-linux",
  );
  // A plain string platform is also supported
  deps = await parseGemspecData(
    readFileSync("./test/data/gem-java.gemspec", { encoding: "utf-8" }),
    "./test/data/gem-java.gemspec",
  );
  assert.deepStrictEqual(
    deps[0].purl,
    "pkg:gem/jruby-launcher@1.1.2?platform=java",
  );
  // A pure ruby gem declares no platform
  deps = await parseGemspecData(
    readFileSync("./test/data/nokogiri-1.10.10.gemspec", { encoding: "utf-8" }),
    "./test/data/nokogiri-1.10.10.gemspec",
  );
  assert.deepStrictEqual(deps[0].purl, "pkg:gem/nokogiri@1.10.10");
});

it("parseGemfileLockData", async () => {
  let retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 140);
  assert.deepStrictEqual(retMap.rootList.length, 42);
  assert.deepStrictEqual(retMap.dependenciesList.length, 140);
  assert.deepStrictEqual(retMap.pkgList[0], {
    name: "actioncable",
    version: "6.0.0",
    purl: "pkg:gem/actioncable@6.0.0",
    "bom-ref": "pkg:gem/actioncable@6.0.0",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/Gemfile.lock" },
      {
        name: "cdx:gem:remote",
        value: "https://rubygems.org/",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.8,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.8,
            value: "./test/data/Gemfile.lock",
          },
        ],
      },
    },
  });
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile1.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile1.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 36);
  assert.deepStrictEqual(retMap.rootList.length, 2);
  assert.deepStrictEqual(retMap.dependenciesList.length, 36);
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile2.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile2.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 89);
  assert.deepStrictEqual(retMap.rootList.length, 2);
  assert.deepStrictEqual(retMap.dependenciesList.length, 89);
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile4.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile4.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 182);
  assert.deepStrictEqual(retMap.rootList.length, 78);
  assert.deepStrictEqual(retMap.dependenciesList.length, 182);
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile5.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile5.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 42);
  assert.deepStrictEqual(retMap.rootList.length, 11);
  assert.deepStrictEqual(retMap.dependenciesList.length, 42);
  assert.deepStrictEqual(purlsFor(retMap, "google-protobuf"), [
    "pkg:gem/google-protobuf@3.25.1?platform=x64-mingw-ucrt",
    "pkg:gem/google-protobuf@3.25.1?platform=x86_64-linux",
  ]);
  // sass-embedded is only referenced as a version constrained child of a
  // platform independent parent. Since the lockfile has no pure ruby build, we
  // report the native builds that do exist rather than a versionless component.
  assert.deepStrictEqual(purlsFor(retMap, "sass-embedded"), [
    "pkg:gem/sass-embedded@1.69.5?platform=x64-mingw-ucrt",
    "pkg:gem/sass-embedded@1.69.5?platform=x86_64-linux-gnu",
  ]);
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile6.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile6.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 139);
  // Every native variant of a direct dependency is itself a direct dependency,
  // so bcrypt_pbkdf and ffi contribute their mingw builds here too.
  assert.deepStrictEqual(retMap.rootList.length, 25);
  assert.deepStrictEqual(retMap.dependenciesList.length, 139);
  // Multiple native variants of the same version remain distinct components
  assert.deepStrictEqual(purlsFor(retMap, "bcrypt_pbkdf"), [
    "pkg:gem/bcrypt_pbkdf@1.1.0",
    "pkg:gem/bcrypt_pbkdf@1.1.0?platform=x64-mingw32",
    "pkg:gem/bcrypt_pbkdf@1.1.0?platform=x86-mingw32",
  ]);
  assert.deepStrictEqual(purlsFor(retMap, "mixlib-shellout"), [
    "pkg:gem/mixlib-shellout@3.2.5",
    "pkg:gem/mixlib-shellout@3.2.5?platform=universal-mingw32",
  ]);
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile-opt.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile-opt.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 36);
  assert.deepStrictEqual(retMap.rootList.length, 8);
  assert.deepStrictEqual(purlsFor(retMap, "google-protobuf"), [
    "pkg:gem/google-protobuf@3.23.4?platform=arm64-darwin",
    "pkg:gem/google-protobuf@3.23.4?platform=x86_64-linux",
  ]);
  assert.deepStrictEqual(retMap.rootList, [
    "pkg:gem/http_parser.rb@0.8.0",
    "pkg:gem/jekyll@4.3.4",
    "pkg:gem/jekyll-feed@0.17.0",
    "pkg:gem/jekyll-readme-index@0.3.0",
    "pkg:gem/tzinfo@2.0.6",
    "pkg:gem/tzinfo-data",
    "pkg:gem/wdm",
    "pkg:gem/webrick@1.8.2",
  ]);
  assert.deepStrictEqual(retMap.dependenciesList.length, 36);
});

it("toGemModuleName", () => {
  assert.deepStrictEqual(toGemModuleNames("ruby_parser"), ["RubyParser"]);
  assert.deepStrictEqual(toGemModuleNames("public_suffix"), ["PublicSuffix"]);
  assert.deepStrictEqual(toGemModuleNames("unicode-display_width"), [
    "Unicode",
    "Unicode::DisplayWidth",
  ]);
  assert.deepStrictEqual(toGemModuleNames("net-http-persistent"), [
    "Net",
    "Net::Http",
    "Net::Http::Persistent",
  ]);
  assert.deepStrictEqual(toGemModuleNames("ruby-prof"), ["RubyProf"]);
  assert.deepStrictEqual(toGemModuleNames("thread_safe"), ["ThreadSafe"]);
  assert.deepStrictEqual(toGemModuleNames("pluck_to_hash"), ["PluckToHash"]);
  assert.deepStrictEqual(toGemModuleNames("sinatra"), ["Sinatra"]);
  assert.deepStrictEqual(toGemModuleNames("passenger"), ["Passenger"]);
  assert.deepStrictEqual(toGemModuleNames("simplecov-html"), [
    "Simplecov",
    "Simplecov::Html",
  ]);
});

it("parseGemspecData", async () => {
  let deps = await parseGemspecData(
    readFileSync("./test/data/xmlrpc.gemspec", { encoding: "utf-8" }),
    "./test/data/xmlrpc.gemspec",
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    authors: [
      {
        name: "SHIBATA Hiroshi",
        email: "hsbt@ruby-lang.org",
      },
    ],
    "bom-ref": "pkg:gem/xmlrpc@0.3.0",
    licenses: [
      {
        license: {
          name: "Ruby",
        },
      },
    ],
    description:
      "XMLRPC is a lightweight protocol that enables remote procedure calls over HTTP.",
    evidence: {
      identity: {
        confidence: 0.5,
        field: "purl",
        methods: [
          {
            confidence: 0.5,
            technique: "manifest-analysis",
            value: "./test/data/xmlrpc.gemspec",
          },
        ],
      },
    },
    externalReferences: [
      {
        type: "website",
        url: "https://github.com/ruby/xmlrpc",
      },
    ],
    name: "xmlrpc",
    properties: [
      {
        name: "cdx:gem:rubyVersionSpecifiers",
        value: ">= 2.3",
      },
      {
        name: "internal:SrcFile",
        value: "./test/data/xmlrpc.gemspec",
      },
    ],
    purl: "pkg:gem/xmlrpc@0.3.0",
    version: "0.3.0",
  });
  deps = await parseGemspecData(
    readFileSync("./test/data/loofah-2.3.1.gemspec", { encoding: "utf-8" }),
    "./test/data/loofah-2.3.1.gemspec",
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    authors: [
      {
        name: "Mike Dalessio",
        email: "mike.dalessio@gmail.com",
      },
      {
        name: "Bryan Helmkamp",
        email: "bryan@brynary.com",
      },
    ],
    "bom-ref": "pkg:gem/loofah@2.3.1",
    licenses: [
      {
        license: {
          name: "MIT",
        },
      },
    ],
    description:
      "Loofah is a general library for manipulating and transforming HTML/XML documents and fragments, built on top of Nokogiri.\\n\\nLoofah excels at HTML sanitization (XSS prevention). It includes some nice HTML sanitizers, which are based on HTML5lib's safelist, so it most likely won't make your codes less secure. (These statements have not been evaluated by Netexperts.)\\n\\nActiveRecord extensions for sanitization are available in the [`loofah-activerecord` gem](https://github.com/flavorjones/loofah-activerecord).",
    evidence: {
      identity: {
        confidence: 0.5,
        field: "purl",
        methods: [
          {
            confidence: 0.5,
            technique: "manifest-analysis",
            value: "./test/data/loofah-2.3.1.gemspec",
          },
        ],
      },
    },
    externalReferences: [
      {
        type: "website",
        url: "https://github.com/flavorjones/loofah",
      },
    ],
    name: "loofah",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/loofah-2.3.1.gemspec",
      },
    ],
    purl: "pkg:gem/loofah@2.3.1",
    version: "2.3.1",
  });
  deps = await parseGemspecData(
    readFileSync("./test/data/nokogiri-1.10.10.gemspec", { encoding: "utf-8" }),
    "./test/data/nokogiri-1.10.10.gemspec",
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    authors: [
      {
        name: "Aaron Patterson",
        email: "aaronp@rubyforge.org",
      },
      {
        name: "Mike Dalessio",
        email: "mike.dalessio@gmail.com",
      },
      {
        name: "Yoko Harada",
        email: "yokolet@gmail.com",
      },
      {
        name: "Tim Elliott",
        email: "tle@holymonkey.com",
      },
      {
        name: "Akinori MUSHA",
        email: "knu@idaemons.org",
      },
      {
        name: "John Shahid",
        email: "jvshahid@gmail.com",
      },
      {
        name: "Lars Kanis",
        email: "lars@greiz-reinsdorf.de",
      },
    ],
    "bom-ref": "pkg:gem/nokogiri@1.10.10",
    licenses: [
      {
        license: {
          name: "MIT",
        },
      },
    ],
    description:
      "Nokogiri (\\u92F8) is an HTML, XML, SAX, and Reader parser. Among\\nNokogiri's many features is the ability to search documents via XPath\\nor CSS3 selectors.",
    evidence: {
      identity: {
        confidence: 0.5,
        field: "purl",
        methods: [
          {
            confidence: 0.5,
            technique: "manifest-analysis",
            value: "./test/data/nokogiri-1.10.10.gemspec",
          },
        ],
      },
    },
    externalReferences: [
      {
        type: "issue-tracker",
        url: "https://github.com/sparklemotion/nokogiri/issues",
        comment: "bug_tracker_uri",
      },
      {
        type: "release-notes",
        url: "https://nokogiri.org/CHANGELOG.html",
        comment: "changelog_uri",
      },
      {
        type: "documentation",
        url: "https://nokogiri.org/rdoc/index.html",
        comment: "documentation_uri",
      },
      {
        type: "website",
        url: "https://nokogiri.org",
        comment: "homepage_uri",
      },
      {
        type: "vcs",
        url: "https://github.com/sparklemotion/nokogiri",
        comment: "source_code_uri",
      },
    ],
    name: "nokogiri",
    properties: [
      {
        name: "cdx:gem:extensions",
        value: "ext/nokogiri/extconf.rb",
      },
      {
        name: "cdx:gem:rubyVersionSpecifiers",
        value: ">= 2.3.0",
      },
      {
        name: "internal:SrcFile",
        value: "./test/data/nokogiri-1.10.10.gemspec",
      },
      {
        name: "cdx:gem:executables",
        value: "nokogiri",
      },
    ],
    purl: "pkg:gem/nokogiri@1.10.10",
    version: "1.10.10",
  });
  deps = await parseGemspecData(
    readFileSync("./test/data/activerecord-import.gemspec", {
      encoding: "utf-8",
    }),
    "./test/data/activerecord-import.gemspec",
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    authors: [
      {
        name: "Zach Dennis",
        email: "zach.dennis@gmail.com",
      },
    ],
    "bom-ref": "pkg:gem/activerecord-import",
    licenses: [
      {
        license: {
          name: "MIT",
        },
      },
    ],
    version: undefined,
    description: "A library for bulk inserting data using ActiveRecord.",
    evidence: {
      identity: {
        confidence: 0.2,
        field: "purl",
        methods: [
          {
            confidence: 0.2,
            technique: "manifest-analysis",
            value: "./test/data/activerecord-import.gemspec",
          },
        ],
      },
    },
    externalReferences: [
      {
        type: "release-notes",
        url: "https://github.com/zdennis/activerecord-import/blob/master/CHANGELOG.md",
        comment: "changelog_uri",
      },
      {
        type: "website",
        url: "https://github.com/zdennis/activerecord-import",
      },
    ],
    name: "activerecord-import",
    properties: [
      {
        name: "cdx:gem:rubyVersionSpecifiers",
        value: ">= 2.4.0",
      },
      {
        name: "internal:SrcFile",
        value: "./test/data/activerecord-import.gemspec",
      },
    ],
    purl: "pkg:gem/activerecord-import",
  });
});

// The OpenTelemetry instrumentation gemspec is the canonical shape of a gem
// built from source: the version is a constant loaded with a require, the
// metadata URIs are built with `#{spec.name}` interpolation, and the license
// and email use the singular spellings. Files are taken verbatim from
// open-telemetry/opentelemetry-ruby-contrib (Apache-2.0).
it("parseGemspecData resolves versions, emails, and metadata URIs from a source gemspec (discussions 4388/4390)", async () => {
  const fixtureDir = "./test/data/otel-action-mailer";
  const deps = await parseGemspecData(
    readFileSync(
      `${fixtureDir}/opentelemetry-instrumentation-action_mailer.gemspec`,
      { encoding: "utf-8" },
    ),
    `${fixtureDir}/opentelemetry-instrumentation-action_mailer.gemspec`,
  );
  assert.deepStrictEqual(deps.length, 1);
  const pkg = deps[0];
  // The version constant is resolved from the required lib/**/version.rb file
  assert.deepStrictEqual(pkg.version, "0.8.1");
  assert.deepStrictEqual(
    pkg.purl,
    "pkg:gem/opentelemetry-instrumentation-action_mailer@0.8.1",
  );
  assert.deepStrictEqual(
    pkg["bom-ref"],
    "pkg:gem/opentelemetry-instrumentation-action_mailer@0.8.1",
  );
  // The gemspec email is attached to the author it belongs to
  assert.deepStrictEqual(pkg.authors, [
    {
      name: "OpenTelemetry Authors",
      email: "cncf-opentelemetry-contributors@lists.cncf.io",
    },
  ]);
  // The singular `spec.license` spelling is honoured
  assert.deepStrictEqual(pkg.licenses, [{ license: { name: "Apache-2.0" } }]);
  // Single quoted strings must not leak their quotes into the BOM
  assert.deepStrictEqual(
    pkg.description,
    "ActionMailer instrumentation for the OpenTelemetry framework",
  );
  // `#{spec.name}` / `#{spec.version}` interpolation in the metadata URIs is
  // expanded, and the block survives lines that merely contain a `}`
  assert.deepStrictEqual(pkg.externalReferences, [
    {
      type: "release-notes",
      url: "https://rubydoc.info/gems/opentelemetry-instrumentation-action_mailer/0.8.1/file/CHANGELOG.md",
      comment: "changelog_uri",
    },
    {
      type: "vcs",
      url: "https://github.com/open-telemetry/opentelemetry-ruby-contrib/tree/opentelemetry-instrumentation-action_mailer/v0.8.1/instrumentation/action_mailer",
      comment: "source_code_uri",
    },
    {
      type: "issue-tracker",
      url: "https://github.com/open-telemetry/opentelemetry-ruby-contrib/issues",
      comment: "bug_tracker_uri",
    },
    {
      type: "documentation",
      url: "https://rubydoc.info/gems/opentelemetry-instrumentation-action_mailer/0.8.1",
      comment: "documentation_uri",
    },
    {
      type: "website",
      url: "https://github.com/open-telemetry/opentelemetry-ruby-contrib",
    },
  ]);
});

it("parseGemspecData parses an installed gemspec serialized by gem specification", async () => {
  const gemspecFile =
    "./test/data/opentelemetry-instrumentation-action_mailer-0.8.1.gemspec";
  const deps = await parseGemspecData(
    readFileSync(gemspecFile, { encoding: "utf-8" }),
    gemspecFile,
  );
  assert.deepStrictEqual(deps.length, 1);
  const pkg = deps[0];
  assert.deepStrictEqual(pkg.version, "0.8.1");
  assert.deepStrictEqual(
    pkg.purl,
    "pkg:gem/opentelemetry-instrumentation-action_mailer@0.8.1",
  );
  assert.deepStrictEqual(pkg.authors, [
    {
      name: "OpenTelemetry Authors",
      email: "cncf-opentelemetry-contributors@lists.cncf.io",
    },
  ]);
  assert.deepStrictEqual(pkg.licenses, [{ license: { name: "Apache-2.0" } }]);
  // The single-line metadata hash keeps every URI, including the ones that a
  // trailing `} if s.respond_to?` used to hide
  assert.deepStrictEqual(
    pkg.externalReferences.map((ref) => ref.type).sort(),
    [
      "documentation",
      "issue-tracker",
      "release-notes",
      "vcs",
      "website",
    ].sort(),
  );
});

it("parseGemspecData drops metadata URIs whose interpolation cannot be resolved", async () => {
  // The gemspec content is the OpenTelemetry one, but pointed at a directory
  // without the lib/**/version.rb file it requires
  const deps = await parseGemspecData(
    readFileSync(
      "./test/data/otel-action-mailer/opentelemetry-instrumentation-action_mailer.gemspec",
      { encoding: "utf-8" },
    ),
    "./test/data/xmlrpc-unavailable.gemspec",
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0].version, undefined);
  assert.deepStrictEqual(
    deps[0].purl,
    "pkg:gem/opentelemetry-instrumentation-action_mailer",
  );
  // `#{spec.version}` has no value, so the URIs built from it would be wrong
  // links. Only the literal ones remain.
  assert.deepStrictEqual(deps[0].externalReferences, [
    {
      type: "issue-tracker",
      url: "https://github.com/open-telemetry/opentelemetry-ruby-contrib/issues",
      comment: "bug_tracker_uri",
    },
    {
      type: "website",
      url: "https://github.com/open-telemetry/opentelemetry-ruby-contrib",
    },
  ]);
});

/**
 * Parse a gemspec written to a temporary directory next to the given files.
 *
 * @param {string} gemspec Gemspec source
 * @param {Object<string, string>} files Extra files by relative path
 * @param {string} [dirPrefix] Prefix of the temporary directory name
 * @returns {Promise<{pkg: object, tmpDir: string}>}
 */
async function parseTempGemspec(
  gemspec,
  files = {},
  dirPrefix = "cdxgen-gemspec-",
) {
  const tmpDir = mkdtempSync(join(tmpdir(), dirPrefix));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      mkdirSync(dirname(join(tmpDir, relPath)), { recursive: true });
      writeFileSync(join(tmpDir, relPath), content);
    }
    writeFileSync(join(tmpDir, "sample.gemspec"), gemspec);
    const deps = await parseGemspecData(
      gemspec,
      join(tmpDir, "sample.gemspec"),
    );
    assert.deepStrictEqual(deps.length, 1);
    return deps[0];
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

it("parseGemspecData maps summary, mailing_list_uri, and require_relative versions", async () => {
  const pkg = await parseTempGemspec(
    `# frozen_string_literal: true
require_relative 'version'

Gem::Specification.new do |spec|
  spec.name = "sample-gem"
  spec.version = Sample::VERSION
  spec.summary = "A sample gem"
  spec.email = "dev@example.com"
  spec.metadata["mailing_list_uri"] = "https://example.com/lists"
end
`,
    {
      "version.rb":
        '# frozen_string_literal: true\n\nmodule Sample\n  VERSION = "3.2.1"\nend\n',
    },
  );
  // require_relative versions resolve like plain requires
  assert.deepStrictEqual(pkg.version, "3.2.1");
  // A gem with only a summary still gets a description
  assert.deepStrictEqual(pkg.description, "A sample gem");
  // An email without an author is dropped instead of inventing an author
  assert.deepStrictEqual(pkg.authors, undefined);
  assert.ok(!("email" in pkg));
  assert.deepStrictEqual(pkg.externalReferences, [
    {
      type: "mailing-list",
      url: "https://example.com/lists",
      comment: "mailing_list_uri",
    },
  ]);
});

it("parseGemspecData reads string lists the way Ruby writes them", async () => {
  const pkg = await parseTempGemspec(`Gem::Specification.new do |spec|
  spec.name = "sample-gem"
  spec.version = "1.0.0"
  spec.authors = ["Aaron Patterson", "Mike O'Brien"]
  spec.email = %w[aaron@example.com mike@example.com]
  spec.license = 'MIT' # see LICENSE.txt
end
`);
  // A quote inside a name, a word array, and a trailing comment must not
  // split or pollute the values
  assert.deepStrictEqual(pkg.authors, [
    { name: "Aaron Patterson", email: "aaron@example.com" },
    { name: "Mike O'Brien", email: "mike@example.com" },
  ]);
  assert.deepStrictEqual(pkg.licenses, [{ license: { name: "MIT" } }]);
});

it("parseGemspecData follows heredocs and arrays spread over several lines", async () => {
  const pkg = await parseTempGemspec(`Gem::Specification.new do |s|
  s.name = "sample-gem"
  s.version = "1.0.0"
  s.author = "Solo Maintainer"
  s.email = [
    "solo@example.com",
    "team@example.com",
  ]
  s.licenses = [
    "MIT",
    "Apache-2.0"
  ]
  s.summary = "Short summary"
  s.description = <<~DESC
    A longer description
    # that has a heading
  DESC
  s.homepage = "https://example.com/#{s.name}"
end
`);
  // A single author gets the first address, the other one is the team's
  assert.deepStrictEqual(pkg.authors, [
    { name: "Solo Maintainer", email: "solo@example.com" },
  ]);
  assert.deepStrictEqual(pkg.licenses, [
    { license: { name: "MIT" } },
    { license: { name: "Apache-2.0" } },
  ]);
  assert.deepStrictEqual(
    pkg.description,
    "A longer description # that has a heading",
  );
  assert.deepStrictEqual(pkg.externalReferences, [
    { type: "website", url: "https://example.com/sample-gem" },
  ]);
});

it("parseGemspecData resolves metadata URIs built from other spec fields", async () => {
  const pkg = await parseTempGemspec(`Gem::Specification.new do |spec|
  spec.name = "sample-gem"
  spec.version = "2.1.0"
  spec.homepage = "https://github.com/acme/sample-gem"
  spec.metadata = {
    "source_code_uri" => spec.homepage,
    "changelog_uri" => "#{spec.homepage}/blob/v#{spec.version}/CHANGELOG.md",
    "wiki_uri" => "#{other.homepage}/wiki",
  }
  spec.extra = { "documentation_uri" => "https://example.com/not-metadata" }
  spec.metadata["bug_tracker_uri"] = "#{spec.homepage}/issues"
end
`);
  assert.deepStrictEqual(pkg.externalReferences, [
    {
      type: "vcs",
      url: "https://github.com/acme/sample-gem",
      comment: "source_code_uri",
    },
    {
      type: "release-notes",
      url: "https://github.com/acme/sample-gem/blob/v2.1.0/CHANGELOG.md",
      comment: "changelog_uri",
    },
    {
      type: "issue-tracker",
      url: "https://github.com/acme/sample-gem/issues",
      comment: "bug_tracker_uri",
    },
  ]);
});

it("parseGemspecData resolves the version constant named by spec.version", async () => {
  const pkg = await parseTempGemspec(
    `require File.expand_path("../lib/sample/deps/version", __FILE__)
require File.expand_path("../lib/sample/version", __FILE__)

Gem::Specification.new do |gem|
  gem.name = "sample-gem"
  gem.version = Sample::GEM_VERSION
end
`,
    {
      // A dependency's version file is required first and must not win
      "lib/sample/deps/version.rb": 'module Dep\n  VERSION = "9.9.9"\nend\n',
      "lib/sample/version.rb":
        'module Sample\n  API_VERSION = "v1"\n  GEM_VERSION = "2.0.0".freeze\nend\n',
    },
  );
  assert.deepStrictEqual(pkg.version, "2.0.0");
  assert.deepStrictEqual(pkg.purl, "pkg:gem/sample-gem@2.0.0");
});

it("parseGemspecData never reads a version file outside the gemspec directory", async () => {
  // `<dir>-sibling` shares the gemspec directory as a string prefix, which a
  // plain startsWith() confinement check would let through
  const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-gemspec-"));
  const siblingDir = `${tmpDir}-sibling`;
  try {
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(siblingDir, "version.rb"), 'VERSION = "6.6.6"\n');
    const gemspec = `require_relative "../${basename(siblingDir)}/version"
Gem::Specification.new do |spec|
  spec.name = "sample-gem"
  spec.version = Sample::VERSION
end
`;
    const [pkg] = await parseGemspecData(
      gemspec,
      join(tmpDir, "sample.gemspec"),
    );
    assert.deepStrictEqual(pkg.version, undefined);
    assert.deepStrictEqual(pkg.purl, "pkg:gem/sample-gem");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(siblingDir, { recursive: true, force: true });
  }
});

it("parseGemspecData leaves values it cannot read statically unresolved", async () => {
  const pkg = await parseTempGemspec(`Gem::Specification.new do |spec|
  spec.name = GEM_NAME
  spec.version = ENV.fetch("GEM_VERSION", "1.0.0")
  spec.summary = "The summary"
  spec.description = spec.summary
  spec.license = LICENSE_NAME
end
`);
  // The file name stands in for a name that is not a literal
  assert.deepStrictEqual(pkg.name, "sample");
  assert.deepStrictEqual(pkg.version, undefined);
  assert.deepStrictEqual(pkg.description, "The summary");
  assert.deepStrictEqual(pkg.licenses, undefined);
});

it("parseGemfileLockData lists the gems served from the project directory", async () => {
  const lockFile = "./test/data/otel-action-mailer/Gemfile.lock";
  const retMap = await parseGemfileLockData(
    readFileSync(lockFile, { encoding: "utf-8" }),
    lockFile,
  );
  // `PATH remote: ../base` and `../active_support` are sibling gems, only
  // `remote: .` is the project itself
  assert.deepStrictEqual(retMap.projectGemRefs, [
    "pkg:gem/opentelemetry-instrumentation-action_mailer@0.8.1",
  ]);
  const plainLock = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile.lock",
  );
  assert.deepStrictEqual(plainLock.projectGemRefs, []);
});

it("parseGemspecData falls back to the locked version of the project gem", async () => {
  const gemspecFile =
    "./test/data/otel-action-mailer/opentelemetry-instrumentation-action_mailer.gemspec";
  const gemspec = readFileSync(gemspecFile, { encoding: "utf-8" });
  // Pointed away from its version file, the constant cannot be resolved
  const [pkg] = await parseGemspecData(
    gemspec,
    "./test/data/xmlrpc-unavailable.gemspec",
    {
      lockedVersions: {
        "opentelemetry-instrumentation-action_mailer": "0.8.1",
      },
    },
  );
  assert.deepStrictEqual(pkg.version, "0.8.1");
  // The URIs built from the version expand against the locked one
  assert.ok(
    pkg.externalReferences.some(
      (ref) =>
        ref.url ===
        "https://rubydoc.info/gems/opentelemetry-instrumentation-action_mailer/0.8.1",
    ),
  );
  // A resolved constant wins over the lockfile, which may be stale
  const [resolved] = await parseGemspecData(gemspec, gemspecFile, {
    lockedVersions: {
      "opentelemetry-instrumentation-action_mailer": "0.7.0",
    },
  });
  assert.deepStrictEqual(resolved.version, "0.8.1");
});

it("parseGemspecData ignores a __proto__ metadata key", async () => {
  const pkg = await parseTempGemspec(`Gem::Specification.new do |spec|
  spec.name = "sample-gem"
  spec.version = "1.0.0"
  spec.metadata = {
    "__proto__" => "https://example.com/proto",
    "source_code_uri" => "https://github.com/acme/sample-gem",
  }
end
`);
  assert.deepStrictEqual(pkg.externalReferences, [
    {
      type: "vcs",
      url: "https://github.com/acme/sample-gem",
      comment: "source_code_uri",
    },
  ]);
  assert.strictEqual({}.value, undefined);
});

it("readRubyStringLiteral and readRubyStringList", () => {
  assert.deepStrictEqual(readRubyStringLiteral('"a \\"b\\" c".freeze # x'), {
    value: 'a "b" c',
    interpolated: false,
    complete: true,
    rest: ".freeze # x",
  });
  assert.deepStrictEqual(readRubyStringLiteral("%q{a {nested} b}"), {
    value: "a {nested} b",
    interpolated: false,
    complete: true,
    rest: "",
  });
  assert.deepStrictEqual(readRubyStringLiteral('"v#{spec.version}"'), {
    value: "v#{spec.version}",
    interpolated: true,
    complete: true,
    rest: "",
  });
  // Escape sequences other than the delimiter stay as written
  assert.deepStrictEqual(readRubyStringLiteral('"a\\nb"').value, "a\\nb");
  assert.deepStrictEqual(readRubyStringLiteral("'open").complete, false);
  assert.deepStrictEqual(readRubyStringLiteral("Foo::VERSION"), undefined);
  assert.deepStrictEqual(readRubyStringLiteral("%w[a b]"), undefined);
  assert.deepStrictEqual(readRubyStringList("[\"a\".freeze, FOO, 'b']"), {
    values: ["a", "b"],
    complete: true,
  });
  assert.deepStrictEqual(readRubyStringList("%w(a b)"), {
    values: ["a", "b"],
    complete: true,
  });
  assert.deepStrictEqual(readRubyStringList('["a",'), {
    values: ["a"],
    complete: false,
  });
  assert.deepStrictEqual(readRubyStringList('"a, b"'), {
    values: ["a", "b"],
    complete: true,
  });
  assert.deepStrictEqual(readRubyStringList('"a" + suffix'), undefined);
});

it("gem parsing and local cache enrichment work in dry-run mode", async () => {
  // Dry-run blocks writes, subprocesses and network calls. Lockfile parsing and
  // local cache enrichment only read files, so both must still work, which is
  // what makes the cached metadata valuable when the registry is unreachable.
  const {
    enrichGemsFromLocalCache: dryEnrich,
    parseGemfileLockData: dryParse,
  } = await esmock("./rubyutils.js", {
    "../core/env.js": { shouldFetchLicense: () => false, isDryRun: true },
  });
  const lockFile = "./test/data/Gemfile-platforms.lock";
  const retMap = await dryParse(
    readFileSync(lockFile, { encoding: "utf-8" }),
    lockFile,
  );
  assert.deepStrictEqual(retMap.pkgList.length, 27);
  assert.deepStrictEqual(
    retMap.pkgList.filter((pkg) => pkg.hashes?.length).length,
    2,
  );
  const pkgList = [
    {
      name: "nokogiri",
      version: "1.16.7",
      purl: "pkg:gem/nokogiri@1.16.7?platform=x86_64-linux",
      properties: [],
    },
  ];
  await dryEnrich(pkgList, {
    gemHome: CACHED_GEM_HOME,
    compactIndexCacheDir: COMPACT_INDEX_CACHE,
  });
  assert.deepStrictEqual(
    pkgList[0]._integrity,
    "sha256-aa1388184e975d091e6e38ce3f3b3388bfb7e4ac3d790efd8e39124844040bd1",
  );
  assert.deepStrictEqual(pkgList[0].license, ["MIT"]);
});

it("collectGemModuleNames is blocked in dry-run mode", async () => {
  // The module collection shells out to `bundle exec ruby`, which safeSpawnSync
  // refuses to run in dry-run mode. It must degrade to the name based guess
  // rather than throw.
  const { collectGemModuleNames: dryCollect } = await esmock("./rubyutils.js", {
    "../core/fs.js": {
      safeSpawnSync: () => ({
        status: 1,
        stdout: undefined,
        stderr: undefined,
        error: new Error("dry run"),
      }),
      isDryRun: true,
    },
  });
  assert.deepStrictEqual(
    dryCollect("ruby", "bundle", "/tmp/gem-home", "public_suffix", "/tmp"),
    ["PublicSuffix"],
  );
});

// A lockfile in the shape of the one from discussion 4404: a gem first
// sighted as a nested dependency of a `PATH` source, whose own release is
// resolved from the `GEM` section further down, plus a `GIT` source with its
// pinned revision.
const MIXED_SOURCES_LOCKFILE = `GIT
  remote: https://github.com/example/git-gem.git
  revision: 0b7b8e6f3b8ee28eb38f8e98b57b1d5a17c18a1d
  branch: main
  specs:
    git-gem (1.0.0)
      rack (~> 2.0)

PATH
  remote: ../base
  specs:
    opentelemetry-instrumentation-base (0.26.1)
      opentelemetry-api (~> 1.7)

GEM
  remote: https://rubygems.org/
  specs:
    opentelemetry-api (1.11.0)
    rack (2.2.3)

PLATFORMS
  ruby

DEPENDENCIES
  git-gem!
  opentelemetry-api
  opentelemetry-instrumentation-base!
  rack

BUNDLED WITH
   bundler (2.5.23)
`;

it("parseGemfileLockData attributes each gem to the source that resolves it", async () => {
  const retMap = await parseGemfileLockData(
    MIXED_SOURCES_LOCKFILE,
    "Gemfile.lock",
  );
  const byName = Object.fromEntries(
    retMap.pkgList.map((pkg) => [pkg.name, pkg]),
  );
  const prop = (pkg, name) =>
    pkg.properties.find((aprop) => aprop.name === name)?.value;
  // The nested `opentelemetry-api (~> 1.7)` line under PATH remote: ../base
  // is only a constraint; the gem itself comes from the registry
  assert.deepStrictEqual(
    prop(byName["opentelemetry-api"], "cdx:gem:remote"),
    "https://rubygems.org/",
  );
  assert.deepStrictEqual(
    prop(byName.rack, "cdx:gem:remote"),
    "https://rubygems.org/",
  );
  assert.deepStrictEqual(
    prop(byName["opentelemetry-instrumentation-base"], "cdx:gem:remote"),
    "../base",
  );
  assert.deepStrictEqual(
    prop(byName["git-gem"], "cdx:gem:remote"),
    "https://github.com/example/git-gem.git",
  );
  assert.deepStrictEqual(
    prop(byName["git-gem"], "cdx:gem:remoteRevision"),
    "0b7b8e6f3b8ee28eb38f8e98b57b1d5a17c18a1d",
  );
  assert.deepStrictEqual(
    prop(byName["git-gem"], "cdx:gem:remoteBranch"),
    "main",
  );
  // The source properties follow the SrcFile entry, as the inline
  // construction used to order them
  const baseProps = byName["opentelemetry-instrumentation-base"].properties;
  assert.deepStrictEqual(baseProps[0].name, "internal:SrcFile");
  assert.deepStrictEqual(baseProps[1].name, "cdx:gem:remote");
});

it("parseGemfileLockData leaves a gem without a spec entry sourceless", async () => {
  // A dependency Bundler never resolved has no section to come from, so it
  // must not inherit whatever remote was last seen
  const lockfile = `GEM
  remote: https://rubygems.org/
  specs:
    rack (2.2.3)

PLATFORMS
  ruby

DEPENDENCIES
  never-installed-gem (~> 1.0)
  rack
`;
  const retMap = await parseGemfileLockData(lockfile, "Gemfile.lock");
  const untracked = retMap.pkgList.find(
    (pkg) => pkg.name === "never-installed-gem",
  );
  assert.ok(untracked, "the untracked dependency is a component");
  assert.deepStrictEqual(
    untracked.properties.some((aprop) => aprop.name === "cdx:gem:remote"),
    false,
  );
});

it("parseGemfileLockData keeps a gem out of its own dependency tree", async () => {
  const retMap = await parseGemfileLockData(
    MIXED_SOURCES_LOCKFILE,
    "Gemfile.lock",
  );
  const rackRef = retMap.pkgList.find((pkg) => pkg.name === "rack")["bom-ref"];
  const rackEntry = retMap.dependenciesList.find((dep) => dep.ref === rackRef);
  assert.deepStrictEqual(rackEntry.dependsOn, []);
  const gitGemEntry = retMap.dependenciesList.find(
    (dep) => dep.ref === "pkg:gem/git-gem@1.0.0",
  );
  assert.deepStrictEqual(gitGemEntry.dependsOn, [rackRef]);
});

it("enrichGemsFromLocalCache carries the authors and executables of an installed gemspec", async () => {
  // rake's installed gemspec is the real one, captured with
  // `gem fetch rake -v 13.4.2` + `gem specification`
  const pkgList = [
    {
      name: "rake",
      version: "13.4.2",
      purl: "pkg:gem/rake@13.4.2",
      properties: [],
    },
  ];
  await enrichGemsFromLocalCache(pkgList, {
    gemHome: CACHED_GEM_HOME,
    compactIndexCacheDir: "/nonexistent-compact-index",
  });
  const rake = pkgList[0];
  assert.deepStrictEqual(rake.authors, [
    { name: "Hiroshi SHIBATA" },
    { name: "Eric Hodel" },
    { name: "Jim Weirich" },
  ]);
  const executables = rake.properties.find(
    (aprop) => aprop.name === "cdx:gem:executables",
  );
  assert.deepStrictEqual(executables?.value, "rake");
});

it("describeProjectGem types the gem by its executables and records its manifests", async () => {
  const gemspecWithExecutables = readFileSync(
    join(CACHED_GEM_HOME, "specifications", "rake-13.4.2.gemspec"),
    "utf-8",
  );
  const [rakeGem] = await parseGemspecData(
    gemspecWithExecutables,
    "rake.gemspec",
  );
  const executableParent = {
    group: "",
    name: "project",
    version: "latest",
    type: "application",
    properties: [],
  };
  describeProjectGem(executableParent, rakeGem, [], [], [], [], {});
  assert.deepStrictEqual(executableParent.type, "application");
  assert.deepStrictEqual(executableParent.name, "rake");
  assert.ok(
    executableParent.properties.some(
      (aprop) => aprop.name === "internal:SrcFile",
    ),
    "the gemspec is recorded as a source of the parent",
  );

  // A gemspec without executables describes a library, whatever the directory
  // cdxgen happened to run in
  const plainGemspec = `# -*- encoding: utf-8 -*-
Gem::Specification.new do |s|
  s.name = "quiet-gem".freeze
  s.version = "1.0.0".freeze
  s.authors = ["Example Author".freeze]
  s.summary = "A gem with no executables".freeze
  s.licenses = ["MIT".freeze]
end
`;
  const [quietGem] = await parseGemspecData(plainGemspec, "quiet-gem.gemspec");
  const libraryParent = {
    group: "",
    name: "project",
    version: "latest",
    type: "application",
    properties: [],
  };
  describeProjectGem(libraryParent, quietGem, [], [], [], [], {});
  assert.deepStrictEqual(libraryParent.type, "library");
});

it("addRubyGemsDistributionUrls derives the download URL of public gems only", () => {
  const pkgList = [
    {
      name: "opentelemetry-api",
      version: "1.11.0",
      purl: "pkg:gem/opentelemetry-api@1.11.0",
      properties: [{ name: "cdx:gem:remote", value: "https://rubygems.org/" }],
    },
    {
      name: "opentelemetry-api",
      version: "1.11.0",
      purl: "pkg:gem/opentelemetry-api@1.11.0",
      properties: [{ name: "cdx:gem:remote", value: "https://rubygems.org" }],
      externalReferences: [
        {
          type: "distribution",
          url: "https://example.com/api/v2/rubygems/opentelemetry-api-1.11.0.gem",
        },
      ],
    },
    {
      name: "base-gem",
      version: "0.26.1",
      purl: "pkg:gem/base-gem@0.26.1",
      properties: [{ name: "cdx:gem:remote", value: "../base" }],
    },
    {
      name: "nokogiri",
      version: "1.16.7",
      purl: "pkg:gem/nokogiri@1.16.7?platform=x86_64-linux",
      properties: [{ name: "cdx:gem:remote", value: "https://rubygems.org/" }],
    },
    {
      name: "versionless",
      purl: "pkg:gem/versionless",
      properties: [{ name: "cdx:gem:remote", value: "https://rubygems.org/" }],
    },
  ];
  addRubyGemsDistributionUrls(pkgList);
  const [publicGem, alreadyDescribed, pathGem, nativeGem, versionless] =
    pkgList;
  assert.deepStrictEqual(publicGem.externalReferences, [
    {
      type: "distribution",
      url: "https://rubygems.org/gems/opentelemetry-api-1.11.0.gem",
    },
  ]);
  // An existing distribution reference is not duplicated, whatever its URL
  assert.deepStrictEqual(alreadyDescribed.externalReferences.length, 1);
  assert.deepStrictEqual(pathGem.externalReferences, undefined);
  // The native build carries its platform in the file name
  assert.deepStrictEqual(nativeGem.externalReferences, [
    {
      type: "distribution",
      url: "https://rubygems.org/gems/nokogiri-1.16.7-x86_64-linux.gem",
    },
  ]);
  assert.deepStrictEqual(versionless.externalReferences, undefined);
  // An old lockfile's plain http remote is the same registry, while a private
  // one keeps its own layout
  const [httpGem, privateGem] = addRubyGemsDistributionUrls([
    {
      name: "rack",
      version: "2.2.8",
      purl: "pkg:gem/rack@2.2.8",
      properties: [{ name: "cdx:gem:remote", value: "http://rubygems.org/" }],
    },
    {
      name: "sidekiq-pro",
      version: "7.2.0",
      purl: "pkg:gem/sidekiq-pro@7.2.0",
      properties: [
        { name: "cdx:gem:remote", value: "https://gems.contribsys.com/" },
      ],
    },
  ]);
  assert.deepStrictEqual(httpGem.externalReferences, [
    { type: "distribution", url: "https://rubygems.org/gems/rack-2.2.8.gem" },
  ]);
  assert.deepStrictEqual(privateGem.externalReferences, undefined);
});

describe("rubyRequirementToVers", () => {
  it("intersects requirements into one vers range", () => {
    // `>= 2.3` and `>= 2.3.0` are the same version to RubyGems
    assert.equal(
      rubyRequirementToVers([">= 2.3", ">= 3.3", ">= 2.3.0"]),
      "vers:gem/>=3.3",
    );
    assert.equal(
      rubyRequirementToVers([">= 2.7, < 3.5", ">= 3.2, < 4"]),
      "vers:gem/>=3.2|<3.5",
    );
    assert.equal(rubyRequirementToVers(["> 2.7", ">= 2.7"]), "vers:gem/>2.7");
  });

  it("spells the pessimistic operator with vers comparators", () => {
    assert.equal(rubyRequirementToVers(["~> 3.1"]), "vers:gem/>=3.1|<4");
    assert.equal(rubyRequirementToVers(["~> 3.1.2"]), "vers:gem/>=3.1.2|<3.2");
    assert.equal(rubyRequirementToVers(["~> 3"]), "vers:gem/>=3|<4");
    assert.equal(
      rubyRequirementToVers(["~> 3.1.0.pre1"]),
      "vers:gem/>=3.1.0.pre1|<3.2",
    );
  });

  it("orders prereleases before their release", () => {
    assert.equal(
      rubyRequirementToVers([">= 3.1.0.pre1", ">= 3.1.0"]),
      "vers:gem/>=3.1.0",
    );
    assert.equal(
      rubyRequirementToVers([">= 3.1.0.pre1", ">= 3.0"]),
      "vers:gem/>=3.1.0.pre1",
    );
  });

  it("reads pins and exclusions", () => {
    assert.equal(rubyRequirementToVers(["3.3.5"]), "vers:gem/3.3.5");
    assert.equal(
      rubyRequirementToVers(["= 3.3.5", ">= 3.0"]),
      "vers:gem/3.3.5",
    );
    assert.equal(rubyRequirementToVers([">= 3.3", "<= 3.3"]), "vers:gem/3.3");
    assert.equal(
      rubyRequirementToVers([">= 3.0", "!= 3.1.0", "< 4"]),
      "vers:gem/>=3.0|!=3.1.0|<4",
    );
    // An excluded bound becomes exclusive, and an exclusion outside the
    // bounds says nothing
    assert.equal(rubyRequirementToVers([">= 3.0", "!= 3.0"]), "vers:gem/>3.0");
    assert.equal(rubyRequirementToVers([">= 3.0", "!= 2.0"]), "vers:gem/>=3.0");
  });

  it("reports requirements that exclude each other", () => {
    assert.equal(rubyRequirementToVers(["= 3.3.5", ">= 3.4"]), null);
    assert.equal(rubyRequirementToVers([">= 3.3", "< 3.0"]), null);
    assert.equal(rubyRequirementToVers([">= 3.3", "< 3.3"]), null);
    assert.equal(rubyRequirementToVers(["= 3.2", "= 3.3"]), null);
  });

  it("gives up on requirements it cannot read", () => {
    assert.equal(rubyRequirementToVers([">= #{MIN_RUBY}"]), undefined);
    assert.equal(rubyRequirementToVers([""]), undefined);
    assert.equal(rubyRequirementToVers([">= 0"]), "vers:gem/*");
  });
});

it("addRubyRuntimeComponent describes the Ruby the gems require once", () => {
  const gemInRange = (name, version, range) => ({
    name,
    version,
    purl: `pkg:gem/${name}@${version}`,
    "bom-ref": `pkg:gem/${name}@${version}`,
    properties: [
      { name: "internal:SrcFile", value: "Gemfile.lock" },
      { name: "cdx:gem:rubyVersionSpecifiers", value: range },
    ],
  });
  const pkgList = [
    gemInRange("opentelemetry-api", "1.11.0", ">= 3.3"),
    gemInRange("rake", "13.4.2", ">= 2.3"),
    gemInRange("rubocop", "1.90.0", ">= 2.7.0"),
    gemInRange("dynamic", "1.0.0", ">= #{MIN_RUBY}"),
    { name: "logger", version: "1.7.0", purl: "pkg:gem/logger@1.7.0" },
  ];
  const parentComponent = {
    name: "project-gem",
    version: "0.8.1",
    purl: "pkg:gem/project-gem@0.8.1",
    "bom-ref": "pkg:gem/project-gem@0.8.1",
    properties: [{ name: "cdx:gem:rubyVersionSpecifiers", value: ">= 3.3" }],
  };
  const dependencies = [
    { ref: "pkg:gem/project-gem@0.8.1", dependsOn: ["pkg:gem/rake@13.4.2"] },
    { ref: "pkg:gem/opentelemetry-api@1.11.0", dependsOn: [] },
  ];
  const { pkgList: outPkgs, dependencies: outDeps } = addRubyRuntimeComponent(
    pkgList,
    parentComponent,
    dependencies,
  );
  const rubyComponents = outPkgs.filter((pkg) => pkg.name === "ruby");
  assert.deepStrictEqual(rubyComponents, [
    {
      type: "platform",
      name: "ruby",
      scope: "required",
      isExternal: true,
      purl: "pkg:generic/ruby",
      "bom-ref": "pkg:generic/ruby",
      versionRange: "vers:gem/>=3.3",
    },
  ]);
  const dependsOn = Object.fromEntries(
    outDeps.map((dep) => [dep.ref, dep.dependsOn]),
  );
  assert.deepStrictEqual(dependsOn["pkg:gem/project-gem@0.8.1"], [
    "pkg:gem/rake@13.4.2",
    "pkg:generic/ruby",
  ]);
  for (const ref of [
    "pkg:gem/opentelemetry-api@1.11.0",
    "pkg:gem/rake@13.4.2",
    "pkg:gem/rubocop@1.90.0",
  ]) {
    assert.deepStrictEqual(dependsOn[ref], ["pkg:generic/ruby"], ref);
  }
  assert.deepStrictEqual(dependsOn["pkg:generic/ruby"], []);
  // Neither the gem without a requirement nor the one whose requirement
  // cannot be read is linked
  assert.deepStrictEqual(dependsOn["pkg:gem/logger@1.7.0"], undefined);
  assert.deepStrictEqual(dependsOn["pkg:gem/dynamic@1.0.0"], undefined);
  // A tree that declares no Ruby requirement gains nothing
  const rangeless = [{ ...pkgList[4], properties: [] }];
  const untouched = addRubyRuntimeComponent(rangeless, undefined, []);
  assert.deepStrictEqual(untouched.pkgList, rangeless);
  assert.deepStrictEqual(untouched.dependencies, []);
  // Requirements that exclude each other leave the runtime without a range
  const conflicting = addRubyRuntimeComponent(
    [gemInRange("old", "1.0.0", "< 2.0"), gemInRange("new", "1.0.0", ">= 3.0")],
    undefined,
    [],
  );
  const runtime = conflicting.pkgList.find((pkg) => pkg.name === "ruby");
  assert.equal(runtime.versionRange, undefined);
  assert.equal(runtime.isExternal, true);
});

it("parseGemspecData reads the executables however the gemspec lists them", async () => {
  const executablesOf = async (
    body,
    gemspecFile = "/nonexistent/foo.gemspec",
  ) => {
    const [pkg] = await parseGemspecData(
      `Gem::Specification.new do |spec|\n  spec.name = "foo"\n  spec.version = "1.0.0"\n${body}\nend\n`,
      gemspecFile,
    );
    return pkg.properties.find((prop) => prop.name === "cdx:gem:executables")
      ?.value;
  };
  assert.equal(
    await executablesOf('  spec.executables = ["foo".freeze, "bar".freeze]'),
    "foo, bar",
  );
  assert.equal(
    await executablesOf("  spec.executables = %w[foo bar]"),
    "foo, bar",
  );
  assert.equal(await executablesOf("  spec.executables = ['foo']"), "foo");
  assert.equal(await executablesOf('  spec.executable = "foo"'), "foo");
  assert.equal(
    await executablesOf('  spec.executables = [\n    "foo",\n    "bar"\n  ]'),
    "foo, bar",
  );
  // The `bundle gem` template computes them from the files of the bindir
  const gemDir = mkdtempSync(join(tmpdir(), "cdxgen-gem-bindir-"));
  try {
    mkdirSync(join(gemDir, "exe"));
    mkdirSync(join(gemDir, "bin"));
    for (const file of [
      "exe/foo",
      "exe/foo-server",
      "exe/.keep",
      "bin/setup",
    ]) {
      writeFileSync(join(gemDir, file), "");
    }
    const gemspecFile = join(gemDir, "foo.gemspec");
    const computed =
      '  spec.bindir = "exe"\n  spec.executables = spec.files.grep(%r{\\Aexe/}) { |f| File.basename(f) }';
    assert.equal(await executablesOf(computed, gemspecFile), "foo, foo-server");
    // RubyGems installs from `bin` unless the gemspec says otherwise
    assert.equal(
      await executablesOf(
        "  spec.executables = spec.files.grep(%r{^bin/}) { |f| File.basename(f) }",
        gemspecFile,
      ),
      "setup",
    );
    // A bindir outside the gem is not followed
    assert.equal(
      await executablesOf(
        '  spec.bindir = "../"\n  spec.executables = spec.files.grep(%r{x})',
        gemspecFile,
      ),
      undefined,
    );
    // Without a gem directory on disk there is nothing to read
    assert.equal(await executablesOf(computed), undefined);
  } finally {
    rmSync(gemDir, { recursive: true, force: true });
  }
});

describe("gem component typing (discussions 4405/4408)", () => {
  it("types a gem that ships executables as an application", () => {
    const pkg = {
      name: "rake",
      purl: "pkg:gem/rake@13.4.2",
      properties: [{ name: "cdx:gem:executables", value: "rake" }],
    };
    assert.equal(determinePackageType(pkg), "application");
  });

  it("keeps a gem whose description mentions a framework a library", () => {
    // opentelemetry-api describes itself as "A stats collection and
    // distributed tracing framework", which made every otel gem a framework
    const pkg = {
      name: "opentelemetry-api",
      purl: "pkg:gem/opentelemetry-api@1.11.0",
      description: "A stats collection and distributed tracing framework",
    };
    assert.equal(determinePackageType(pkg), "library");
  });

  it("keeps a gem tagged framework by its keywords a library", () => {
    const pkg = {
      name: "some-gem",
      purl: "pkg:gem/some-gem@1.0.0",
      keywords: ["framework", "telemetry"],
    };
    assert.equal(determinePackageType(pkg), "library");
  });

  it("still classifies the curated ruby frameworks", () => {
    assert.equal(
      determinePackageType({ name: "rails", purl: "pkg:gem/rails@7.1.0" }),
      "framework",
    );
    assert.equal(
      determinePackageType({ name: "sinatra", purl: "pkg:gem/sinatra@4.0.0" }),
      "framework",
    );
  });

  it("does not take a gem named after a framework for the framework", () => {
    for (const name of [
      // Prefixed by a curated gem
      "sinatra-contrib",
      "rails-html-sanitizer",
      "trailblazer-option",
      // Prefixed by a bare word the list keeps for another ecosystem
      "childprocess",
      "jquery-rails",
      "playwright-ruby-client",
    ]) {
      assert.equal(
        determinePackageType({ name, purl: `pkg:gem/${name}@1.0.0` }),
        "library",
        name,
      );
    }
  });

  it("types a plain gem a library", () => {
    assert.equal(
      determinePackageType({ name: "logger", purl: "pkg:gem/logger@1.7.0" }),
      "library",
    );
  });

  it("retains the explicit platform type of the ruby runtime component", () => {
    assert.equal(
      determinePackageType({
        type: "platform",
        name: "ruby",
        purl: "pkg:generic/ruby",
      }),
      "platform",
    );
  });

  it("leaves the description heuristic in place for other ecosystems", () => {
    assert.equal(
      determinePackageType({
        name: "some-pypi-package",
        purl: "pkg:pypi/some-pypi-package@1.0.0",
        description: "A web framework",
      }),
      "framework",
    );
  });
});

it("parseGemspecData attributes only valid contact addresses", async () => {
  const gemspec = (authors, emails) => `Gem::Specification.new do |spec|
  spec.name = "demo"
  spec.version = "1.0.0"
  spec.authors = [${authors.map((a) => `"${a}"`).join(", ")}]
  spec.email = [${emails.map((e) => `"${e}"`).join(", ")}]
end
`;
  // Contains "@" and no space, which the old filter took for an address, yet
  // it fails the idn-email format the schema asserts on contact emails.
  let deps = await parseGemspecData(
    gemspec(["Alice"], ["alice@@example.com"]),
    "demo.gemspec",
  );
  assert.deepStrictEqual(deps[0].authors, [{ name: "Alice" }]);
  deps = await parseGemspecData(
    gemspec(["Alice"], [" alice@example.com "]),
    "demo.gemspec",
  );
  assert.deepStrictEqual(deps[0].authors, [
    { name: "Alice", email: "alice@example.com" },
  ]);
  // Dropping an invalid address breaks the one-per-author pairing, so
  // neither author is given one.
  deps = await parseGemspecData(
    gemspec(["Alice", "Bob"], ["alice@example.com", "bob@"]),
    "demo.gemspec",
  );
  assert.deepStrictEqual(deps[0].authors, [{ name: "Alice" }, { name: "Bob" }]);
});

describe("parseGemspecData() with RubyGems' Marshal spec cache", () => {
  it("returns nothing rather than a component named after the file", async () => {
    // ~/.cache/gem/specs/<source>/quick/Marshal.4.8/brotli-0.8.0.gemspec holds
    // a Marshal dump that starts with the 4.8 header bytes.
    const marshal = `\u0004\bu:\u0017Gem::Specification\u0002p\u0001\u0004\b[\u0018I"\n4.0.3`;
    assert.deepStrictEqual(
      await parseGemspecData(
        marshal,
        "/root/.cache/gem/specs/x/quick/Marshal.4.8/brotli-0.8.0.gemspec",
      ),
      [],
    );
  });
});

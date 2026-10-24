import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { parseModuleBazel, parseModuleBazelLock } from "./parsers-bazel.js";

describe("parseModuleBazel", () => {
  it("extracts the module name, BCR deps, and maven artifacts", () => {
    const { pkgList, parentComponent, rootInputs } = parseModuleBazel(
      "./test/data/bzlmod-smoke/MODULE.bazel",
    );
    assert.strictEqual(parentComponent.name, "bzlmod-smoke");
    assert.strictEqual(parentComponent.version, "1.0.0");

    // Three BCR modules + two Maven artifacts.
    assert.strictEqual(pkgList.length, 5);

    const rulesGo = pkgList.find((p) => p.name === "rules_go");
    assert.ok(rulesGo);
    // BCR modules use the registered bazel type — the only legitimate use.
    assert.strictEqual(
      rulesGo.purl,
      "pkg:bazel/rules_go@0.39.1?repository_url=https:%2F%2Fbcr.bazel.build",
    );
    assert.strictEqual(rulesGo.scope, "required");
    assert.strictEqual(rulesGo.version, "0.39.1");

    // repo_name alias is recorded as a property but the canonical name is used.
    const rulesJvm = pkgList.find((p) => p.name === "rules_jvm_external");
    assert.ok(rulesJvm);
    const repoNameProp = rulesJvm.properties.find(
      (p) => p.name === "cdx:bazel:repo_name",
    );
    assert.strictEqual(repoNameProp.value, "rules_jvm");

    // Maven coordinates carry a pkg:maven purl with a group namespace so
    // advisories match. Guava is declared as a coordinate string.
    const guava = pkgList.find((p) => p.name === "guava");
    assert.ok(guava);
    assert.strictEqual(
      guava.purl,
      "pkg:maven/com.google.guava/guava@32.1.1-jre",
    );
    // group and name are split the way every other Maven path in cdxgen
    // splits them, so a bzlmod-sourced artifact dedupes against the same
    // artifact found by the Maven or Gradle collectors.
    assert.strictEqual(guava.group, "com.google.guava");
    assert.strictEqual(guava.name, "guava");

    // slf4j is declared with separate group/artifact/version args.
    const slf4j = pkgList.find((p) => p.name === "slf4j-api");
    assert.ok(slf4j);
    assert.strictEqual(slf4j.purl, "pkg:maven/org.slf4j/slf4j-api@2.0.9");

    // No package may squat an unregistered type.
    for (const pkg of pkgList) {
      assert.ok(
        pkg.purl.startsWith("pkg:bazel/") || pkg.purl.startsWith("pkg:maven/"),
        `${pkg.name} has unexpected purl ${pkg.purl}`,
      );
    }
    assert.strictEqual(rootInputs.length, 5);
  });

  it("returns empty results for a missing file", () => {
    const { pkgList, parentComponent } = parseModuleBazel(
      "./test/data/missing-MODULE.bazel",
    );
    assert.deepEqual(pkgList, []);
    assert.deepEqual(parentComponent, {});
  });
});

describe("parseModuleBazelLock", () => {
  it("parses a legacy lock into BCR modules and a dependency graph", () => {
    const { pkgList, dependencies } = parseModuleBazelLock(
      "./test/data/bzlmod-smoke/MODULE.bazel.lock",
    );
    assert.strictEqual(pkgList.length, 3);
    const skylib = pkgList.find((p) => p.name === "bazel_skylib");
    assert.strictEqual(
      skylib.purl,
      "pkg:bazel/bazel_skylib@1.7.1?repository_url=https:%2F%2Fbcr.bazel.build",
    );

    // rules_go depends on bazel_skylib.
    const goEdge = dependencies.find((d) => d.ref.includes("rules_go@0.39.1"));
    assert.ok(goEdge);
    assert.ok(goEdge.dependsOn.some((r) => r.includes("bazel_skylib@1.7.1")));
  });

  it("maps every extension's resolved repositories to its own ecosystem", () => {
    const { pkgList } = parseModuleBazelLock(
      "./test/data/bzlmod-smoke/MODULE.bazel.lock.modern",
    );
    const byName = new Map(pkgList.map((p) => [p.name, p]));

    assert.strictEqual(
      byName.get("guava").purl,
      "pkg:maven/com.google.guava/guava@32.1.1-jre",
    );
    assert.strictEqual(
      byName.get("slf4j-api").purl,
      "pkg:maven/org.slf4j/slf4j-api@2.0.9",
    );

    // Go module paths keep their separators, matching the Go collectors so one
    // module has one bom-ref however it was discovered. This entry also sits
    // under a platform key rather than `general`.
    const errors = byName.get("github.com/pkg/errors");
    assert.strictEqual(errors.purl, "pkg:golang/github.com/pkg/errors@v0.9.1");
    assert.strictEqual(errors.group, "github.com/pkg");
    // A go.sum `h1:` line is a SHA-256 dirhash, carried in the same shape the
    // Go collectors use.
    assert.ok(errors._integrity.startsWith("sha256-"));

    assert.strictEqual(byName.get("requests").purl, "pkg:pypi/requests@2.31.0");
    assert.strictEqual(byName.get("requests").hashes[0].alg, "SHA-256");

    // A scoped npm package splits into namespace and name.
    const scoped = byName.get("@scope/pkg");
    assert.strictEqual(scoped.purl, "pkg:npm/%40scope/pkg@1.0.0");
    assert.ok(scoped._integrity.startsWith("sha512-"));

    // http_archive carries no ecosystem identity, so it is generic with the
    // download URL and checksum preserved.
    const archive = byName.get("buildtools_archive");
    assert.ok(archive.purl.startsWith("pkg:generic/buildtools_archive@8.5.1?"));
    assert.strictEqual(archive.hashes[0].alg, "SHA-256");

    // Repositories generated by a toolchains extension describe the build
    // machine, not the software being built.
    assert.ok(!byName.has("remotejdk21_linux"));
    // A rule named only by the pre-format-20 `ruleClassName` is still read,
    // and an environment probe with no coordinates yields nothing.
    assert.ok(!byName.has("local_config_apple_cc"));

    assert.strictEqual(pkgList.length, 6);
  });

  it("returns empty results for a malformed lock", () => {
    const { pkgList, dependencies } = parseModuleBazelLock(
      "./test/data/zig-malformed.zon",
    );
    assert.deepEqual(pkgList, []);
    assert.deepEqual(dependencies, []);
  });
});

describe("parseModuleBazel() overrides", () => {
  it("drops a local module and the version an override replaces", () => {
    const moduleFile = join(
      tmpdir(),
      `cdxgen-bazel-${process.pid}-MODULE.bazel`,
    );
    writeFileSync(
      moduleFile,
      [
        'module(name = "consumer", version = "1.0.0")',
        'bazel_dep(name = "brotli", version = "1.1.0", repo_name = "org_brotli")',
        "local_path_override(",
        '    module_name = "brotli",',
        '    path = "..",',
        ")",
        'bazel_dep(name = "zlib", version = "1.2.13")',
        'git_override(module_name = "zlib", remote = "https://github.com/madler/zlib", commit = "abc")',
        'bazel_dep(name = "abseil-cpp", version = "20240116.0")',
        'single_version_override(module_name = "abseil-cpp", version = "20240722.0")',
        'bazel_dep(name = "rules_cc", version = "0.0.9")',
      ].join("\n"),
    );
    try {
      const { pkgList } = parseModuleBazel(moduleFile);
      const byName = Object.fromEntries(pkgList.map((p) => [p.name, p]));
      assert.strictEqual(byName.brotli, undefined, "local_path_override");
      assert.strictEqual(byName.zlib.version, undefined);
      assert.ok(
        byName.zlib.properties.some(
          (p) => p.name === "cdx:bazel:override" && p.value === "git",
        ),
      );
      assert.strictEqual(byName["abseil-cpp"].version, "20240722.0");
      assert.strictEqual(byName.rules_cc.version, "0.0.9");
    } finally {
      rmSync(moduleFile, { force: true });
    }
  });

  it("does not report the vendored brotli tree's own pinned version", () => {
    const { pkgList } = parseModuleBazel(
      join(
        "test",
        "data",
        "brotli-exposure",
        "vendored",
        "third_party",
        "brotli",
        "go",
        "MODULE.bazel",
      ),
    );
    assert.ok(!pkgList.some((p) => p.name === "brotli"));
  });
});

import { assert, it } from "poku";

import {
  encodeForPurl,
  mapConanPkgRefToPurlStringAndNameAndVersion,
  purlFromUrlString,
} from "../ecosystems/utils.js";
import {
  applyPurl,
  canonicalPurlFromLooseString,
  fallbackBomRef,
  hasExcessiveSlashRun,
  isValidPurl,
  npmPurl,
  parsePurlLoose,
  purlTypeIsRegistered,
  purlTypeIsRegisteredString,
  REGISTERED_PURL_TYPES,
  splitPurlLoose,
  tryBuildPurl,
} from "./purl.js";

it("conan package reference mapper to pURL", () => {
  const checkParseResult = (inputPkgRef, expectedPurl) => {
    const [purl, name, version] =
      mapConanPkgRefToPurlStringAndNameAndVersion(inputPkgRef);
    assert.deepStrictEqual(purl, expectedPurl);

    const expectedPurlPrefix = `pkg:conan/${name}@${version}`;
    assert.deepStrictEqual(
      purl.substring(0, expectedPurlPrefix.length),
      expectedPurlPrefix,
    );
  };

  checkParseResult("testpkg", "pkg:conan/testpkg@latest");

  checkParseResult("testpkg/1.2.3", "pkg:conan/testpkg@1.2.3");

  checkParseResult(
    "testpkg/1.2.3#recipe_revision",
    "pkg:conan/testpkg@1.2.3?rrev=recipe_revision",
  );

  checkParseResult(
    "testpkg/1.2.3@someuser/somechannel",
    "pkg:conan/testpkg@1.2.3?channel=somechannel&user=someuser",
  );

  checkParseResult(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision",
    "pkg:conan/testpkg@1.2.3?channel=somechannel&rrev=recipe_revision&user=someuser",
  );

  checkParseResult(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision:package_id#package_revision",
    "pkg:conan/testpkg@1.2.3" +
      "?channel=somechannel" +
      "&prev=package_revision" +
      "&rrev=recipe_revision" +
      "&user=someuser",
  );

  const expectParseError = (pkgRef) => {
    const result = mapConanPkgRefToPurlStringAndNameAndVersion(pkgRef);
    assert.deepStrictEqual(result[0], null);
    assert.deepStrictEqual(result[1], null);
    assert.deepStrictEqual(result[2], null);
  };

  expectParseError("testpkg/"); // empty version
  expectParseError("testpkg/1.2.3@"); // empty user
  expectParseError("testpkg/1.2.3@someuser"); // pkg ref is not allowed to stop here
  expectParseError("testpkg/1.2.3@someuser/"); // empty channel
  expectParseError("testpkg/1.2.3@someuser/somechannel#"); // empty recipe revision
  expectParseError("testpkg/1.2.3@someuser/somechannel#recipe_revision:"); // empty package id
  expectParseError(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision:package_id",
  ); // pkg ref is not allowed to stop here
  expectParseError(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision:package_id#",
  ); // empty package revision
  expectParseError("testpkg/1.2.3/unexpected"); // unexpected pkg ref segment separator
  expectParseError("testpkg/1.2.3@someuser/somechannel/unexpected"); // unexpected pkg ref segment separator
  expectParseError(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision/unexpected",
  ); // unexpected pkg ref segment separator
  expectParseError(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision:package_id/unexpected",
  ); // unexpected pkg ref segment separator
  expectParseError(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision:package_id#package_revision/unexpected",
  ); // unexpected pkg ref segment separator
});

it("returns undefined for local swift paths (no valid namespace) (#2781)", () => {
  const purl = purlFromUrlString("swift", "/Users/arsh/project", "1.0.0");
  assert.equal(purl, undefined);
});

it("assigns name for repoUrls with trailing slash", () => {
  const purl = purlFromUrlString(
    "swift",
    "https://github.com/cdxgen/sample/",
    "1.0.0",
  );
  assert.equal(purl.namespace, "github.com/cdxgen");
  assert.equal(purl.name, "sample");
  assert.equal(purl.version, "1.0.0");
});

it("assigns name for repoUrls without trailing slash", () => {
  const purl = purlFromUrlString(
    "swift",
    "https://github.com/cdxgen/sample",
    "1.0.0",
  );
  assert.equal(purl.namespace, "github.com/cdxgen");
  assert.equal(purl.name, "sample");
  assert.equal(purl.version, "1.0.0");
});

it("purl encode tests", () => {
  assert.deepStrictEqual(
    encodeForPurl("org.apache.commons"),
    "org.apache.commons",
  );
  assert.deepStrictEqual(encodeForPurl("@angular"), "%40angular");
  assert.deepStrictEqual(encodeForPurl("%40angular"), "%40angular");
  assert.deepStrictEqual(encodeForPurl("1.0.0+build"), "1.0.0%2Bbuild");
  // encodeURIComponent leaves these literal; the purl grammar does not.
  assert.deepStrictEqual(encodeForPurl("1!2.0"), "1%212.0");
  assert.deepStrictEqual(encodeForPurl("a'b(c)*"), "a%27b%28c%29%2A");
  assert.ok(isValidPurl(`pkg:generic/x@${encodeForPurl("1!2.0(rc)*")}`));
});

it("npmPurl encodes semver build metadata", () => {
  // An unencoded `+` is rejected by cdx-purl (E_INVALID_CHARACTER), so any
  // hand-assembled `pkg:npm/name@1.0.0+build` string throws. npmPurl exists so
  // callers never have to know that.
  assert.deepStrictEqual(
    npmPurl("foo", "1.0.0+build.1"),
    "pkg:npm/foo@1.0.0%2Bbuild.1",
  );
  assert.deepStrictEqual(
    decodeURIComponent(npmPurl("foo", "1.0.0+build.1")),
    "pkg:npm/foo@1.0.0+build.1",
  );
});

it("npmPurl splits scoped package names into namespace and name", () => {
  assert.deepStrictEqual(
    npmPurl("@scope/foo", "2.0.0"),
    "pkg:npm/%40scope/foo@2.0.0",
  );
  assert.deepStrictEqual(npmPurl("plain", "1.0.0"), "pkg:npm/plain@1.0.0");
});

it("isValidPurl rejects bare names and accepts real purls", () => {
  // Guards the rule that produced `"purl": "swift-smoke"` in a golden: a
  // bom-ref is not a purl and must never be copied into the purl field.
  assert.deepStrictEqual(isValidPurl("swift-smoke"), false);
  assert.deepStrictEqual(isValidPurl("application:swift-smoke:latest"), false);
  assert.deepStrictEqual(isValidPurl(""), false);
  assert.deepStrictEqual(isValidPurl(undefined), false);
  assert.deepStrictEqual(isValidPurl("pkg:npm/foo@1.0.0"), true);
});

it("hands cdx-purl no purl with a long run of slashes", () => {
  const hostile = `pkg:npm/${"/".repeat(400000)}x@1`;
  const started = Date.now();
  assert.deepStrictEqual(hasExcessiveSlashRun(hostile), true);
  assert.deepStrictEqual(isValidPurl(hostile), false);
  assert.deepStrictEqual(parsePurlLoose(hostile), null);
  assert.deepStrictEqual(purlTypeIsRegisteredString(hostile), false);
  assert.ok(Date.now() - started < 2000, "the purl was parsed");
  // Ordinary purls are not affected.
  assert.deepStrictEqual(hasExcessiveSlashRun("pkg:npm/%40a/b@1"), false);
  assert.deepStrictEqual(isValidPurl("pkg:npm/%40a/b@1.0.0"), true);
});

it("tryBuildPurl returns null instead of throwing on invalid parts", () => {
  // maven without a groupId is rejected by cdx-purl.
  assert.deepStrictEqual(tryBuildPurl({ type: "maven", name: "bar" }), null);
  assert.deepStrictEqual(
    tryBuildPurl({ type: "maven", namespace: "com.example", name: "bar" }),
    "pkg:maven/com.example/bar",
  );
});

it("tryBuildPurl builds repository-scoped github purls with a subpath", () => {
  // `uses: actions/cache/save@v4` names the repository actions/cache and the
  // sub-action path save, so the path lands in the subpath (#4739) and the
  // purl deduplicates with actions/cache@v4.
  assert.deepStrictEqual(
    tryBuildPurl({
      type: "github",
      namespace: "actions",
      name: "cache",
      version: "v4",
      subpath: "save",
    }),
    "pkg:github/actions/cache@v4#save",
  );
  assert.deepStrictEqual(
    tryBuildPurl({
      type: "github",
      namespace: "owner",
      name: "repo",
      version: "v1",
      subpath: "a/b",
    }),
    "pkg:github/owner/repo@v1#a/b",
  );
  // A step without a sub-action path keeps the plain repository purl.
  assert.deepStrictEqual(
    tryBuildPurl({
      type: "github",
      namespace: "actions",
      name: "cache",
      version: "v4",
      subpath: null,
    }),
    "pkg:github/actions/cache@v4",
  );
  // The github type rules require a namespace, so a namespace-less step
  // action yields no purl instead of throwing.
  assert.deepStrictEqual(
    tryBuildPurl({
      type: "github",
      namespace: null,
      name: "someaction",
      version: "v1",
    }),
    null,
  );
});

it("applyPurl never writes an invalid purl and clears stale ones", () => {
  const good = applyPurl({ name: "foo" }, "pkg:npm/foo@1.0.0");
  assert.deepStrictEqual(good.purl, "pkg:npm/foo@1.0.0");
  assert.deepStrictEqual(good["bom-ref"], "pkg:npm/foo@1.0.0");

  // No purl: the field is omitted and the ref carries type/name/version so it
  // stays unique when the same name appears at several versions.
  const bad = applyPurl(
    { name: "swift-smoke", type: "application", version: "latest" },
    null,
  );
  assert.deepStrictEqual("purl" in bad, false);
  assert.deepStrictEqual(bad["bom-ref"], "application:swift-smoke:latest");

  assert.deepStrictEqual(
    fallbackBomRef({ name: "go.opencensus.io", version: "v0.24.0" }),
    "library:go.opencensus.io:v0.24.0",
  );
  assert.notDeepStrictEqual(
    fallbackBomRef({ name: "go.opencensus.io", version: "v0.24.0" }),
    fallbackBomRef({ name: "go.opencensus.io", version: "v0.23.0" }),
  );

  const stale = applyPurl({ name: "x", purl: "pkg:npm/x@1" }, null, "x-ref");
  assert.deepStrictEqual("purl" in stale, false);
  assert.deepStrictEqual(stale["bom-ref"], "x-ref");
});

it("REGISTERED_PURL_TYPES is sourced from cdx-purl and covers known types", () => {
  // The set is the single source of truth for the no-type-squatting guardrail.
  // It must contain the types cdxgen relies on for true-ecosystem identity, and
  // must NOT contain the types we deliberately leave unregistered.
  for (const t of [
    "maven",
    "npm",
    "cargo",
    "golang",
    "pypi",
    "generic",
    "hex",
    "bazel",
    "conda",
  ]) {
    assert.ok(REGISTERED_PURL_TYPES.has(t), `expected ${t} to be registered`);
    assert.ok(purlTypeIsRegistered(t));
  }
  // nix, zig, mojo, gleam are deliberately NOT registered. Emitting a purl with
  // one of these types squats a namespace no advisory feed recognises.
  for (const t of ["nix", "zig", "mojo", "gleam"]) {
    assert.ok(
      !REGISTERED_PURL_TYPES.has(t),
      `expected ${t} to be unregistered`,
    );
    assert.ok(!purlTypeIsRegistered(t));
  }
});

it("purlTypeIsRegisteredString vets real purl strings", () => {
  // cdx-purl's build() is permissive — it builds pkg:nix/... without error — so
  // the guardrail must check the registered set, not whether build() throws.
  assert.ok(purlTypeIsRegisteredString("pkg:npm/foo@1.0.0"));
  assert.ok(purlTypeIsRegisteredString("pkg:generic/foo@1.0.0"));
  assert.ok(purlTypeIsRegisteredString("pkg:bazel/rules_go@0.39.1"));
  assert.ok(!purlTypeIsRegisteredString("pkg:nix/flake-utils@1ef2e67"));
  assert.ok(!purlTypeIsRegisteredString("pkg:zig/foo@1.0.0"));
  assert.ok(!purlTypeIsRegisteredString("pkg:mojo/foo@1.0.0"));
  // Unparseable input is treated as unregistered rather than throwing.
  assert.ok(!purlTypeIsRegisteredString("not-a-purl"));
  assert.ok(!purlTypeIsRegisteredString(""));
});

it("splitPurlLoose reads a decoded purl by its separators", () => {
  assert.deepStrictEqual(splitPurlLoose("pkg:npm/@scope/app@1.0.0+build.5"), {
    type: "npm",
    namespace: "@scope",
    name: "app",
    version: "1.0.0+build.5",
    qualifiers: null,
    subpath: null,
  });
  // A composer branch version holds a `/`, which must not split the path.
  assert.deepStrictEqual(
    splitPurlLoose("pkg:composer/acme/branch@dev-feature/x").version,
    "dev-feature/x",
  );
  // A qualifier value keeps its `+`; it is not a form-encoded space.
  assert.deepStrictEqual(
    splitPurlLoose("pkg:npm/foo@1.0.0?vcs_url=git+https://example.com/a.git")
      .qualifiers,
    { vcs_url: "git+https://example.com/a.git" },
  );
  // A segment that starts with `@` is a scope, not a version separator.
  assert.deepStrictEqual(splitPurlLoose("pkg:npm/@scope/app").version, null);
  assert.strictEqual(splitPurlLoose("library:app:1.0.0"), null);
  assert.strictEqual(splitPurlLoose("pkg:npm"), null);
});

it("parsePurlLoose prefers the strict reading of a well-formed purl", () => {
  assert.deepStrictEqual(parsePurlLoose("pkg:npm/%40scope/app@1.0.0%2Bbuild"), {
    type: "npm",
    namespace: "@scope",
    name: "app",
    version: "1.0.0+build",
    qualifiers: null,
    subpath: null,
  });
  assert.strictEqual(
    parsePurlLoose("pkg:golang/github.com/Knetic/govaluate@v3.0.1+incompatible")
      .version,
    "v3.0.1+incompatible",
  );
  assert.strictEqual(parsePurlLoose("app@1.0.0"), null);
  assert.strictEqual(parsePurlLoose(undefined), null);
});

it("canonicalPurlFromLooseString escapes reserved characters exactly once", () => {
  assert.strictEqual(
    canonicalPurlFromLooseString("pkg:npm/app@1.0.0+build.5"),
    "pkg:npm/app@1.0.0%2Bbuild.5",
  );
  assert.strictEqual(
    canonicalPurlFromLooseString("pkg:npm/app@1.0.0%2Bbuild.5"),
    "pkg:npm/app@1.0.0%2Bbuild.5",
  );
  assert.strictEqual(
    canonicalPurlFromLooseString("pkg:npm/@scope/app@1.0.0+build.5"),
    "pkg:npm/%40scope/app@1.0.0%2Bbuild.5",
  );
  // Type rules still apply: golang namespaces are lower-cased, as for any
  // golang purl cdxgen builds.
  assert.strictEqual(
    canonicalPurlFromLooseString(
      "pkg:golang/github.com/Azure/go-autorest@v14.2.0+incompatible",
    ),
    "pkg:golang/github.com/azure/go-autorest@v14.2.0%2Bincompatible",
  );
  assert.strictEqual(
    canonicalPurlFromLooseString("pkg:pypi/epochpkg@1!0.2.0"),
    "pkg:pypi/epochpkg@1%210.2.0",
  );
  // A bom-ref that is not a purl yields nothing rather than a guess.
  assert.strictEqual(canonicalPurlFromLooseString("application:app:1.0"), null);
  assert.strictEqual(
    canonicalPurlFromLooseString("pkg:maven/artifact@1.0"),
    null,
  );
});

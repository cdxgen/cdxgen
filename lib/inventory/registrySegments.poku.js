import { assert, describe, it } from "poku";

import {
  isComposerPackageName,
  isCrateName,
  isGemSegment,
  isJsrSegment,
  isMavenRegistryCoordinate,
  isNpmRegistryKey,
  isPlainPathSegment,
  isPubPackageName,
  isPypiProjectName,
  isPypiReleaseVersion,
} from "./registrySegments.js";

describe("registry name checks", () => {
  it("isNpmRegistryKey accepts a package name and nothing that adds to the URL path", () => {
    for (const key of [
      "left-pad",
      "JSONStream",
      "@babel/core",
      "@types/node",
      "@jsr/std__path",
      "lodash.merge",
      "_private",
    ]) {
      assert.strictEqual(isNpmRegistryKey(key), true, key);
    }
    for (const key of [
      "../npm-private/billing-core",
      "..",
      ".",
      "a/b",
      "a\\..\\b",
      "..%2Fnpm-private%2Fbilling-core",
      "%2e%2e",
      "left-pad?write=true",
      "left-pad#fragment",
      "//registry.example/left-pad",
      "@acme/..",
      "@acme/.",
      "@acme/lib/../../other",
      "@acme/../../lib",
      "@acme",
      "@/lib",
      "left pad",
      "left-pad\n",
      "",
      undefined,
      null,
      {},
    ]) {
      assert.strictEqual(isNpmRegistryKey(key), false, String(key));
    }
  });

  it("isPlainPathSegment and isMavenRegistryCoordinate refuse anything but one segment", () => {
    assert.ok(isPlainPathSegment("1.0.0-rc.1+build.5"));
    for (const value of [
      "",
      ".",
      "..",
      "a/b",
      "a\\b",
      "a?b",
      "a#b",
      "%2e",
      "a b",
      "a\nb",
    ]) {
      assert.strictEqual(
        isPlainPathSegment(value),
        false,
        JSON.stringify(value),
      );
    }
    assert.ok(
      isMavenRegistryCoordinate(
        "org.apache.commons",
        "commons-lang3",
        "3.14.0",
      ),
    );
    for (const [group, name, version] of [
      ["org..apache", "x", "1"],
      ["..", "x", "1"],
      ["org.apache", "../x", "1"],
      ["org.apache", "x", "1/../2"],
      ["org.apache", "x", "%2e%2e"],
      ["org.apache", "x", "1\t2"],
      [undefined, "x", "1"],
    ]) {
      assert.strictEqual(
        isMavenRegistryCoordinate(group, name, version),
        false,
      );
    }
  });

  it("the other ecosystem checks accept real names and refuse path steering", () => {
    assert.ok(isPypiProjectName("Django"));
    assert.ok(isPypiProjectName("zope.interface"));
    assert.ok(isPypiReleaseVersion("1!2.0.0+local.1"));
    assert.ok(isCrateName("serde_json"));
    assert.ok(isGemSegment("rails-html-sanitizer"));
    assert.ok(isGemSegment("1.2.3.pre"));
    assert.ok(isPubPackageName("flutter_test"));
    assert.ok(isComposerPackageName("symfony/console"));
    assert.ok(isJsrSegment("std__path"));
    assert.strictEqual(isPypiProjectName("../simple"), false);
    assert.strictEqual(isPypiProjectName("a/b"), false);
    assert.strictEqual(isPypiProjectName(".."), false);
    assert.strictEqual(isPypiReleaseVersion("1.0/../x"), false);
    assert.strictEqual(isPypiReleaseVersion("1.0?x=y"), false);
    assert.strictEqual(isCrateName("../crates"), false);
    assert.strictEqual(isCrateName("a/b"), false);
    assert.strictEqual(isGemSegment(".."), false);
    assert.strictEqual(isGemSegment("a%2fb"), false);
    assert.strictEqual(isPubPackageName("a/b"), false);
    assert.strictEqual(isComposerPackageName("../x/y"), false);
    assert.strictEqual(isComposerPackageName("a/b/c"), false);
    assert.strictEqual(isComposerPackageName("vendor"), false);
    assert.strictEqual(isJsrSegment(".."), false);
    assert.strictEqual(isJsrSegment("a?b"), false);
  });
});

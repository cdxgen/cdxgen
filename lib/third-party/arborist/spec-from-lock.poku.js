import path from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import specFromLock from "./lib/spec-from-lock.js";

// Expectations come from the upstream committed snapshot at
// workspaces/arborist/tap-snapshots/test/spec-from-lock.js.test.cjs, less the
// two parts of it that are not stable outside upstream's own layout: the
// GitHost helper functions, which the snapshot records as stringified source,
// and the path fields, which the snapshot records relative to the directory
// tap ran from. Both are covered by the identity assertions below and by the
// {CWD}/{..} normalisation upstream itself applies.
const cwd = process.cwd();
const dirName = path.dirname(cwd);
const slash = (p) => (p ?? "").replace(/[A-Z]:/, "").replace(/\\/g, "/");
// Replaces a leading directory with a token, matching whole path segments
// only, so that a parent that is the filesystem root still leaves its
// separator behind.
const replaceDir = (p, dir, token) => {
  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  if (base && p === base) {
    return token;
  }
  return p.startsWith(`${base}/`) ? `${token}${p.slice(base.length)}` : p;
};
const normalise = (p) =>
  replaceDir(replaceDir(slash(p), slash(cwd), "{CWD}"), slash(dirName), "{..}");

function assertStableSpec(result, expected) {
  assert.strictEqual(result.type, expected.type, "type");
  assert.strictEqual(result.name, expected.name, "name");
  assert.strictEqual(result.raw, expected.raw, "raw");
  assert.strictEqual(result.rawSpec, expected.rawSpec, "rawSpec");
  assert.strictEqual(result.registry, expected.registry, "registry");
  assert.strictEqual(result.saveSpec, expected.saveSpec, "saveSpec");
  assert.strictEqual(result.escapedName, expected.escapedName, "escapedName");
  assert.strictEqual(result.scope, expected.scope, "scope");
  assert.strictEqual(
    result.gitCommittish,
    expected.gitCommittish,
    "gitCommittish",
  );
  assert.strictEqual(result.gitRange, expected.gitRange, "gitRange");
  assert.strictEqual(result.gitSubdir, expected.gitSubdir, "gitSubdir");
}

describe("spec-from-lock", () => {
  it("builds a version spec from version and integrity", () => {
    assertStableSpec(
      specFromLock("x", { version: "1.2.3", integrity: "integral" }),
      {
        type: "version",
        name: "x",
        raw: "x@1.2.3",
        rawSpec: "1.2.3",
        registry: true,
        saveSpec: null,
        escapedName: "x",
        scope: undefined,
        gitCommittish: undefined,
        gitRange: undefined,
        gitSubdir: undefined,
      },
    );
  });

  it("builds a git spec from a resolved git repo with a from field", () => {
    const result = specFromLock("gitthing", {
      version:
        "git+ssh://git@github.com/isaacs/abbrev-js#a9ee72ebc8fe3975f1b0c7aeb3a8f2a806a432eb",
      from: "github:isaacs/abbrev-js#some-ref",
    });
    assertStableSpec(result, {
      type: "git",
      name: "gitthing",
      raw: "gitthing@git+ssh://git@github.com/isaacs/abbrev-js#a9ee72ebc8fe3975f1b0c7aeb3a8f2a806a432eb",
      rawSpec:
        "git+ssh://git@github.com/isaacs/abbrev-js#a9ee72ebc8fe3975f1b0c7aeb3a8f2a806a432eb",
      registry: undefined,
      saveSpec:
        "git+ssh://git@github.com/isaacs/abbrev-js.git#a9ee72ebc8fe3975f1b0c7aeb3a8f2a806a432eb",
      escapedName: "gitthing",
      scope: undefined,
      gitCommittish: "a9ee72ebc8fe3975f1b0c7aeb3a8f2a806a432eb",
      gitRange: undefined,
      gitSubdir: undefined,
    });
    // The hosted shortcut resolves to a github GitHost; only its identity
    // fields are asserted, since the helper functions are not stable across
    // host environments.
    assert.strictEqual(result.hosted.type, "github");
    assert.strictEqual(result.hosted.user, "isaacs");
    assert.strictEqual(result.hosted.project, "abbrev-js");
  });

  it("builds a version spec from legacy 'from' metadata with no integrity", () => {
    assertStableSpec(specFromLock("legacy", { from: "1.2.3" }), {
      type: "version",
      name: "legacy",
      raw: "legacy@1.2.3",
      rawSpec: "1.2.3",
      registry: true,
      saveSpec: null,
      escapedName: "legacy",
      scope: undefined,
      gitCommittish: undefined,
      gitRange: undefined,
      gitSubdir: undefined,
    });
  });

  it("builds a file spec when version names a tarball", () => {
    const result = specFromLock("x", {
      version: "foo.tgz",
      integrity: "integral",
    });
    assertStableSpec(result, {
      type: "file",
      name: "x",
      raw: "x@foo.tgz",
      rawSpec: "foo.tgz",
      registry: undefined,
      saveSpec: "file:foo.tgz",
      escapedName: "x",
      scope: undefined,
      gitCommittish: undefined,
      gitRange: undefined,
      gitSubdir: undefined,
    });
    assert.strictEqual(normalise(result.fetchSpec), "{CWD}/foo.tgz");
    assert.strictEqual(normalise(result.where), "{CWD}");
  });

  it("prefers version over range when integrity is absent", () => {
    assertStableSpec(
      specFromLock("x", {
        version: "1.2.3",
        from: "^1.2.0",
        shasum: "deadbeef0cafebad",
        resolved: "https://registry.npmjs.org/x/-/x-1.2.3.tgz",
      }),
      {
        type: "version",
        name: "x",
        raw: "x@1.2.3",
        rawSpec: "1.2.3",
        registry: true,
        saveSpec: null,
        escapedName: "x",
        scope: undefined,
        gitCommittish: undefined,
        gitRange: undefined,
        gitSubdir: undefined,
      },
    );
  });

  it("builds a file spec from version with from", () => {
    const result = specFromLock("x", {
      version: "file:x-1.2.3.tgz",
      from: "x-1.2.3.tgz",
    });
    assertStableSpec(result, {
      type: "file",
      name: "x",
      raw: "x@x-1.2.3.tgz",
      rawSpec: "x-1.2.3.tgz",
      registry: undefined,
      saveSpec: "file:x-1.2.3.tgz",
      escapedName: "x",
      scope: undefined,
      gitCommittish: undefined,
      gitRange: undefined,
      gitSubdir: undefined,
    });
    assert.strictEqual(normalise(result.fetchSpec), "{CWD}/x-1.2.3.tgz");
  });

  it("builds a file spec from version with resolved", () => {
    const result = specFromLock("x", {
      version: "file:x-1.2.3.tgz",
      resolved: "/path/to/x-1.2.3.tgz",
    });
    // A root-relative path is resolved against the current drive on Windows, so
    // the two path-bearing fields are compared through the same {CWD}-style
    // normalisation upstream's own snapshot applies.
    assertStableSpec(
      { ...result, saveSpec: slash(result.saveSpec) },
      {
        type: "file",
        name: "x",
        raw: "x@/path/to/x-1.2.3.tgz",
        rawSpec: "/path/to/x-1.2.3.tgz",
        registry: undefined,
        saveSpec: "file:/path/to/x-1.2.3.tgz",
        escapedName: "x",
        scope: undefined,
        gitCommittish: undefined,
        gitRange: undefined,
        gitSubdir: undefined,
      },
    );
    assert.strictEqual(slash(result.fetchSpec), "/path/to/x-1.2.3.tgz");
  });

  it("builds a directory spec for a symlink-style resolved", () => {
    const result = specFromLock("x", {
      version: "file:../some/path",
    });
    assertStableSpec(result, {
      type: "directory",
      name: "x",
      raw: "x@file:../some/path",
      rawSpec: "file:../some/path",
      registry: undefined,
      saveSpec: "file:../some/path",
      escapedName: "x",
      scope: undefined,
      gitCommittish: undefined,
      gitRange: undefined,
      gitSubdir: undefined,
    });
    assert.strictEqual(normalise(result.fetchSpec), "{..}/some/path");
  });

  it("returns an empty object for completely invalid input", () => {
    const result = specFromLock("really bad and invalid", {
      version: "url:// not even close to a ! valid @ npm @ specifier",
      resolved: "this: is: also: not: valid!",
    });
    assert.deepStrictEqual(Object.keys(result).length, 0);
  });
});

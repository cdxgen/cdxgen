import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { strict as assert, describe, test } from "poku";

import {
  parseGitmodules,
  parseGitRemoteUrl,
  resolveSubmoduleUrl,
  submodulePurlCoordinates,
} from "./gitmodules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "..", "test", "data", "cmake-cache");

describe("parseGitmodules", () => {
  test("parses two absolute-URL leveldb submodules", () => {
    const text = readFileSync(
      join(FIXTURES, "leveldb", ".gitmodules"),
      "utf-8",
    );
    const subs = parseGitmodules(text);
    assert.strictEqual(subs.length, 2);
    assert.strictEqual(subs[0].name, "third_party/benchmark");
    assert.strictEqual(subs[0].path, "third_party/benchmark");
    assert.strictEqual(subs[0].url, "https://github.com/google/benchmark.git");
    assert.strictEqual(subs[1].name, "third_party/googletest");
    assert.strictEqual(subs[1].url, "https://github.com/google/googletest.git");
  });

  test("parses relative URLs from the synthetic fixture", () => {
    const text = readFileSync(
      join(FIXTURES, "relative-submodule", ".gitmodules"),
      "utf-8",
    );
    const subs = parseGitmodules(text);
    assert.strictEqual(subs.length, 2);
    assert.strictEqual(subs[0].name, "dep");
    assert.strictEqual(subs[0].url, "../dep");
    assert.strictEqual(subs[1].name, "libs/contrib");
    assert.strictEqual(subs[1].url, "../../org/contrib");
  });

  test("returns [] for empty/null input", () => {
    assert.deepStrictEqual(parseGitmodules(""), []);
    assert.deepStrictEqual(parseGitmodules(null), []);
  });
});

describe("resolveSubmoduleUrl", () => {
  test("returns an absolute URL unchanged", () => {
    assert.strictEqual(
      resolveSubmoduleUrl(
        "https://github.com/google/benchmark.git",
        "https://github.com/google/leveldb",
      ),
      "https://github.com/google/benchmark.git",
    );
  });

  // Git treats the superproject URL as a directory, so `../dep` is a sibling of
  // the superproject rather than of its owner. Verified against `git submodule
  // add ../bar` with origin https://example.com/repositories/foo, which git
  // resolves to https://example.com/repositories/bar.
  test("resolves ../dep as a sibling of the superproject", () => {
    assert.strictEqual(
      resolveSubmoduleUrl("../dep", "https://github.com/example/root"),
      "https://github.com/example/dep",
    );
  });

  test("resolves ./inner beneath the superproject", () => {
    assert.strictEqual(
      resolveSubmoduleUrl("./inner", "https://example.com/repositories/foo"),
      "https://example.com/repositories/foo/inner",
    );
  });

  test("resolves ../../org/contrib by walking above the owner", () => {
    assert.strictEqual(
      resolveSubmoduleUrl(
        "../../org/contrib",
        "https://github.com/example/root",
      ),
      "https://github.com/org/contrib",
    );
  });

  test("resolves relative URLs against an ssh origin", () => {
    assert.strictEqual(
      resolveSubmoduleUrl("../dep", "git@github.com:example/root.git"),
      "https://github.com/example/dep",
    );
  });

  test("returns null when origin is missing and url is relative", () => {
    assert.strictEqual(resolveSubmoduleUrl("../dep", null), null);
  });
});

describe("submodulePurlCoordinates", () => {
  test("produces github coordinates for a github URL", () => {
    const coords = submodulePurlCoordinates(
      "https://github.com/google/benchmark.git",
      "1a54956777ba672764db09a51960056ea042af7e",
    );
    assert.deepStrictEqual(coords, {
      type: "github",
      namespace: "google",
      name: "benchmark",
      version: "1a54956777ba672764db09a51960056ea042af7e",
    });
  });

  test("produces generic coordinates with vcs_url for a non-github host", () => {
    const coords = submodulePurlCoordinates(
      "https://gitlab.example.com/team/lib.git",
      "v1.2.3",
    );
    assert.strictEqual(coords.type, "generic");
    assert.strictEqual(coords.name, "lib");
    assert.strictEqual(
      coords.qualifiers.vcs_url,
      "https://gitlab.example.com/team/lib.git",
    );
  });

  test("returns null for an unparseable URL", () => {
    assert.strictEqual(submodulePurlCoordinates("not-a-url", "1"), null);
  });
});

describe("parseGitRemoteUrl", () => {
  test("parses an https URL", () => {
    const r = parseGitRemoteUrl("https://github.com/google/benchmark.git");
    assert.strictEqual(r.host, "github.com");
    assert.strictEqual(r.owner, "google");
    assert.strictEqual(r.name, "benchmark");
  });

  test("parses a git@ ssh shorthand", () => {
    const r = parseGitRemoteUrl("git@github.com:google/benchmark.git");
    assert.strictEqual(r.host, "github.com");
    assert.strictEqual(r.owner, "google");
    assert.strictEqual(r.name, "benchmark");
  });
});

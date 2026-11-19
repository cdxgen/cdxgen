import { assert, describe, it } from "poku";

import { parseBuildZigZon, parseZon, tokenizeZon } from "./parsers-zig.js";

describe("ZON tokenizer", () => {
  it("tokenizes a minimal struct with named fields", () => {
    const tokens = tokenizeZon('.{ .name = "x", .version = "1.0" }');
    const kinds = tokens.map((t) => t.type);
    assert.deepEqual(kinds, [
      "STRUCT_START",
      "DOT_IDENT",
      "=",
      "STRING",
      ",",
      "DOT_IDENT",
      "=",
      "STRING",
      "}",
    ]);
    assert.strictEqual(tokens[1].value, "name");
    assert.strictEqual(tokens[3].value, "x");
  });

  it("decodes string escape sequences", () => {
    const tokens = tokenizeZon('"a\\nb\\tc\\\\d\\"e"');
    assert.strictEqual(tokens[0].value, 'a\nb\tc\\d"e');
  });

  it("decodes \\xNN and \\u{...} escapes", () => {
    assert.strictEqual(tokenizeZon('"\\x41"')[0].value, "A");
    assert.strictEqual(tokenizeZon('"\\u{1f4a9}"')[0].value, "\uD83D\uDCA9");
  });

  it("joins multiline string literal lines with newlines", () => {
    const src = "\\\\line one\n\\\\line two\n";
    const tokens = tokenizeZon(src);
    assert.strictEqual(tokens[0].value, "line one\nline two");
  });

  it("normalises hex and underscore integer literals", () => {
    assert.strictEqual(tokenizeZon("0xff")[0].value, "0xff");
    assert.strictEqual(tokenizeZon("1_000_000")[0].value, "1000000");
    // Underscores are stripped; hex digit case is preserved as written.
    assert.strictEqual(tokenizeZon("0xDEAD_BEEF")[0].value, "0xDEADBEEF");
  });

  it("parses floats with exponents", () => {
    assert.strictEqual(tokenizeZon("1.5e3")[0].value, "1.5e3");
    assert.strictEqual(tokenizeZon("-2.0")[0].value, "-2.0");
  });

  it("tokenizes booleans, null, and enum literals", () => {
    const tokens = tokenizeZon(
      ".{ .a = true, .b = false, .c = null, .d = .linux }",
    );
    const byType = Object.fromEntries(tokens.map((t) => [t.type, t.value]));
    assert.strictEqual(byType.BOOL, false);
    assert.strictEqual(byType.NULL, null);
    assert.ok(
      tokens.some((t) => t.type === "DOT_IDENT" && t.value === "linux"),
    );
  });

  it("tokenizes character literals", () => {
    assert.strictEqual(tokenizeZon("'A'")[0].value, "A");
    assert.strictEqual(tokenizeZon("'\\u{26A1}'")[0].value, "⚡");
  });

  it("throws on a malformed \\u escape in a character literal", () => {
    assert.throws(() => tokenizeZon("'\\u41'"), /Expected '\{' after \\u/);
    assert.throws(() => tokenizeZon("'\\u{41'"), /Unterminated \\u/);
    // Without a closing brace the reader must not restart from offset 0 and
    // re-read the same literal forever.
    assert.throws(() => tokenizeZon("1 // '\n'\\u"), /Expected '\{' after \\u/);
  });

  it("throws on an unexpected character", () => {
    assert.throws(() => tokenizeZon("???"));
  });
});

describe("ZON parser", () => {
  it("parses a struct with named and positional fields", () => {
    const parsed = parseZon('.{ .name = "x", .paths = .{ "a", "b" } }');
    assert.strictEqual(parsed.name, "x");
    assert.deepEqual(parsed.paths._positional, ["a", "b"]);
  });

  it("parses nested structs and arrays", () => {
    const parsed = parseZon(
      '.{ .deps = .{ .a = .{ .url = "u", .hash = "h" } }, .tags = ["t1", "t2"] }',
    );
    assert.strictEqual(parsed.deps.a.url, "u");
    assert.strictEqual(parsed.deps.a.hash, "h");
    assert.deepEqual(parsed.tags, ["t1", "t2"]);
  });

  it("unwraps parenthesised expressions", () => {
    assert.strictEqual(parseZon('("x")'), "x");
  });

  it("returns null for null literals", () => {
    assert.strictEqual(parseZon(".{ .a = null }").a, null);
  });

  it("handles trailing commas", () => {
    const parsed = parseZon('.{ .a = "1", .b = "2", }');
    assert.strictEqual(parsed.a, "1");
    assert.strictEqual(parsed.b, "2");
  });

  it("throws on trailing tokens", () => {
    assert.throws(() => parseZon('.{ .a = "1" } extra'));
  });

  it("parses an empty struct", () => {
    assert.deepEqual(parseZon(".{}"), { _positional: [] });
  });
});

describe("parseBuildZigZon", () => {
  it("parses the smoke fixture into a parent and package list", () => {
    const { pkgList, parentComponent } = parseBuildZigZon(
      "./test/data/zig-smoke/build.zig.zon",
    );
    assert.strictEqual(parentComponent.name, "zig_smoke");
    assert.strictEqual(parentComponent.version, "0.2.1");
    assert.strictEqual(parentComponent.type, "application");
    const minZig = parentComponent.properties.find(
      (p) => p.name === "cdx:zig:minimum_zig_version",
    );
    assert.strictEqual(minZig.value, "0.14.0");

    assert.strictEqual(pkgList.length, 3);

    const knownFolders = pkgList.find((p) => p.name === "known_folders");
    assert.ok(knownFolders);
    assert.strictEqual(knownFolders.scope, "required");
    // The tag 0.5.0 is extracted from the archive URL as the version.
    assert.strictEqual(knownFolders.version, "0.5.0");
    assert.ok(
      knownFolders.purl.startsWith(
        "pkg:generic/known_folders@0.5.0?download_url=",
      ),
    );
    // A recognised multihash (1220 = sha2-256) yields a hashes[] entry.
    assert.ok(knownFolders.hashes);
    assert.strictEqual(knownFolders.hashes[0].alg, "SHA-256");
    assert.strictEqual(knownFolders.hashes[0].content.length, 64);
    // The full multihash string is preserved as a property.
    const hashProp = knownFolders.properties.find(
      (p) => p.name === "cdx:zig:hash",
    );
    assert.ok(hashProp.value.startsWith("1220"));
    // The proposed type is recorded so the purl decision is visible.
    const proposed = knownFolders.properties.find(
      (p) => p.name === "cdx:purl:proposedType",
    );
    assert.strictEqual(proposed.value, "zig");

    // A 0.14+ hash carries the dependency's declared version.
    const clap = pkgList.find((p) => p.name === "zig_clap");
    assert.strictEqual(clap.version, "0.10.0");
    assert.ok(
      clap.purl.startsWith("pkg:generic/zig_clap@0.10.0?download_url="),
    );
    // Only a recognised multihash codec yields a hashes[] entry.
    assert.ok(!clap.hashes);

    // Local path dependency: a build input, so required, with no download URL.
    const local = pkgList.find((p) => p.name === "my_local_helper");
    assert.ok(local);
    assert.strictEqual(local.scope, "required");
    assert.ok(!local.purl.includes("download_url"));
    const localProp = local.properties.find((p) => p.name === "cdx:zig:path");
    assert.strictEqual(localProp.value, "../my-local-helper");
    // A directory is not a release, so it contributes a ref rather than a
    // version: the purl stays a plain identity and `version` stays absent.
    assert.strictEqual(
      local["bom-ref"],
      "library:my_local_helper:../my-local-helper",
    );
    assert.strictEqual(local.version, undefined);

    // Every emitted purl must use a registered type — no pkg:zig/ squatting.
    for (const pkg of pkgList) {
      assert.ok(
        pkg.purl.startsWith("pkg:generic/"),
        `${pkg.name} must be generic, got ${pkg.purl}`,
      );
    }
  });

  it("reads a manifest whose comments outnumber its fields", () => {
    // `zig init` emits a manifest that is mostly comments, so this is the
    // common shape rather than an edge case.
    const tokens = tokenizeZon(`.{
      // leading comment
      .name = .demo, // trailing comment
      .version = "1.0.0",
    }`);
    assert.deepEqual(
      tokens.filter((t) => t.type === "DOT_IDENT").map((t) => t.value),
      ["name", "demo", "version"],
    );
  });

  it("returns empty results for a missing file", () => {
    const { pkgList, parentComponent } = parseBuildZigZon(
      "./test/data/missing-build.zig.zon",
    );
    assert.deepEqual(pkgList, []);
    assert.deepEqual(parentComponent, {});
  });

  it("returns empty results for a malformed file", () => {
    const { pkgList, parentComponent } = parseBuildZigZon(
      "./test/data/zig-malformed.zon",
    );
    assert.deepEqual(pkgList, []);
    assert.deepEqual(parentComponent, {});
  });

  it("handles a minimal manifest with only a name", () => {
    const { pkgList, parentComponent } = parseBuildZigZon(
      "./test/data/zig-minimal.zon",
    );
    assert.strictEqual(parentComponent.name, "bare");
    assert.strictEqual(pkgList.length, 0);
  });
});

import { createHash } from "node:crypto";

import { assert, describe, it } from "poku";

import { integrityOf, parseIntegrity } from "./integrity.js";

const SHA512 = createHash("sha512").update("a").digest("base64");
const SHA1 = createHash("sha1").update("a").digest("base64");

describe("parseIntegrity()", () => {
  it("reads a single hash", () => {
    assert.deepStrictEqual(parseIntegrity(`sha512-${SHA512}`), [
      { algorithm: "sha512", digest: SHA512 },
    ]);
  });

  it("reads several hashes separated by any whitespace", () => {
    assert.deepStrictEqual(
      parseIntegrity(`  sha1-${SHA1}\tsha512-${SHA512}\n`),
      [
        { algorithm: "sha1", digest: SHA1 },
        { algorithm: "sha512", digest: SHA512 },
      ],
    );
  });

  it("keeps every hash of one algorithm", () => {
    const parsed = parseIntegrity(`sha512-${SHA512} sha512-AAAA`);
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[1].digest, "AAAA");
  });

  it("ignores options after the digest", () => {
    assert.deepStrictEqual(parseIntegrity(`sha512-${SHA512}?foo=bar?baz`), [
      { algorithm: "sha512", digest: SHA512 },
    ]);
  });

  it("splits at the first dash only", () => {
    assert.deepStrictEqual(parseIntegrity("sha256-ab-cd"), []);
  });

  it("skips unknown algorithms and malformed tokens", () => {
    assert.deepStrictEqual(parseIntegrity("md5-AAAA"), []);
    assert.deepStrictEqual(parseIntegrity("sha512"), []);
    assert.deepStrictEqual(parseIntegrity("-AAAA"), []);
    assert.deepStrictEqual(parseIntegrity("sha512-"), []);
    assert.deepStrictEqual(parseIntegrity("sha512-===="), []);
    assert.deepStrictEqual(parseIntegrity("sha512-AA=A"), []);
    assert.deepStrictEqual(parseIntegrity("sha512-AAA==="), []);
    assert.deepStrictEqual(parseIntegrity("sha512-not_base64"), []);
    assert.deepStrictEqual(parseIntegrity("sha512-AA$A"), []);
  });

  it("keeps the valid hashes next to invalid ones", () => {
    assert.deepStrictEqual(parseIntegrity(`junk md5-AA sha1-${SHA1} sha1-!`), [
      { algorithm: "sha1", digest: SHA1 },
    ]);
  });

  it("returns nothing for empty or non-string input", () => {
    for (const value of ["", "   ", undefined, null, 42, {}]) {
      assert.deepStrictEqual(parseIntegrity(value), []);
    }
  });
});

describe("integrityOf()", () => {
  it("hashes with sha512 by default", () => {
    assert.strictEqual(integrityOf("a"), `sha512-${SHA512}`);
  });

  it("names the algorithm it used", () => {
    assert.strictEqual(integrityOf("a", "sha1"), `sha1-${SHA1}`);
  });

  it("hashes strings as UTF-8 and buffers as given", () => {
    assert.strictEqual(integrityOf("é"), integrityOf(Buffer.from("é", "utf8")));
  });

  it("matches the known SRI value for an empty input", () => {
    assert.strictEqual(
      integrityOf(""),
      "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
    );
  });

  it("round-trips through parseIntegrity()", () => {
    const [entry] = parseIntegrity(integrityOf("payload", "sha384"));
    assert.strictEqual(entry.algorithm, "sha384");
    assert.strictEqual(
      entry.digest,
      createHash("sha384").update("payload").digest("base64"),
    );
  });
});

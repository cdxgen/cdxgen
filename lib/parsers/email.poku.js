import { strict as assert, describe, test } from "poku";

import { isValidIdnEmail, isValidIdnHostname } from "./email.js";

// Each expectation below matches jsonschema-rs 0.59 (the library behind
// `cdxrs validate`) except where a comment says otherwise.
const VALID_EMAILS = [
  "ops@acme.example",
  "a@b",
  "first.last+tag@sub.example.co.uk",
  "root@localhost",
  "a@1.2.3.4",
  "a@b.123",
  "a@[127.0.0.1]",
  "a@[IPv6:::1]",
  "a@[ipv6:2001:db8::1]",
  '""@example.com',
  '"a b"@example.com',
  '"a@b"@example.com',
  '"a\\"b"@example.com',
  "é@example.com",
  "δοκιμή@παράδειγμα.δοκιμή",
  "我買@屋企.香港",
  "user@例え.テスト",
  "a@xn--bcher-kva.example",
  "a@ex­ample.com",
  "a@b。com",
  "a@B.COM",
  `${"x".repeat(64)}@example.com`,
  `a@${"b".repeat(63)}.com`,
];

const INVALID_EMAILS = [
  "",
  "plainly not an email",
  "info at example dot com",
  "John Doe john@example.com",
  "@",
  "a@",
  "@example.com",
  "a@@example.com",
  "<a@example.com>",
  // Not an address per RFC 6531, though jsonschema-rs tolerates it; parsers
  // must not keep a `Name <address>` maintainer string as an email.
  "Ops Team <ops@acme.example>",
  ".a@example.com",
  "a.@example.com",
  "a..b@example.com",
  "a b@example.com",
  'a"b"@example.com',
  '"a\nb"@example.com',
  "a@b c.com",
  "a@-ab.com",
  "a@ab-.com",
  "a@ab--cd.com",
  "a@a_b.com",
  "a@example.com.",
  "a@.example.com",
  "a@b..com",
  "a@example.com\n",
  "a@\texample.com",
  "a@[300.0.0.1]",
  "a@[::1]",
  "a@[IPv6:zz]",
  "a@😀.com",
  "a@xn--a.com",
  "a@xn--invalid-",
  `${"x".repeat(65)}@example.com`,
  `a@${"b".repeat(64)}.com`,
  `a@${`${"b".repeat(60)}.`.repeat(5)}com`,
];

describe("isValidIdnEmail()", () => {
  test("accepts RFC 6531 addresses, including internationalized ones", () => {
    for (const email of VALID_EMAILS) {
      assert.equal(isValidIdnEmail(email), true, JSON.stringify(email));
    }
  });

  test("rejects malformed addresses", () => {
    for (const email of INVALID_EMAILS) {
      assert.equal(isValidIdnEmail(email), false, JSON.stringify(email));
    }
  });

  test("rejects non-strings", () => {
    for (const value of [undefined, null, 42, {}, ["a@b.com"]]) {
      assert.equal(isValidIdnEmail(value), false);
    }
  });

  test("stays linear on long adversarial input", () => {
    const started = process.hrtime.bigint();
    assert.equal(isValidIdnEmail(`${"a.".repeat(200_000)}@example.com`), false);
    assert.equal(isValidIdnEmail(`a@${"b-".repeat(200_000)}c`), false);
    assert.equal(isValidIdnEmail(`"${"\\a".repeat(200_000)}"@x.com`), false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 2000, `took ${elapsedMs} ms`);
  });
});

describe("isValidIdnHostname()", () => {
  test("accepts internationalized domains, A-labels and U-labels alike", () => {
    for (const hostname of [
      "bücher.example",
      "xn--bcher-kva.example",
      "παράδειγμα.δοκιμή",
      "例え.テスト",
      "مثال.إختبار",
      // PVALID by exception: the Catalan middle dot, the Katakana middle dot.
      "col·lega.cat",
      "カ・カ.jp",
    ]) {
      assert.equal(isValidIdnHostname(hostname), true, hostname);
    }
  });

  test("rejects characters IDNA does not allow in a label", () => {
    for (const hostname of [
      "\u{1F600}.com",
      "xn--e28h.com",
      "☃.com",
      "́a.com",
      "xn--a.com",
    ]) {
      assert.equal(isValidIdnHostname(hostname), false, hostname);
    }
  });

  test("checks hyphens on the Unicode form of a label too", () => {
    assert.equal(isValidIdnHostname("α-.com"), false);
    assert.equal(isValidIdnHostname("-α.com"), false);
  });
});

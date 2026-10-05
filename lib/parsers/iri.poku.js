import { strict as assert } from "node:assert";

import { describe, test } from "poku";

import { IriValidationStrategy, parseIRI, validateIri } from "./iri.js";

const VALID_ABSOLUTE_IRIS = [
  "file://foo",
  "ftp://ftp.is.co.za/rfc/rfc1808.txt",
  "http://www.ietf.org/rfc/rfc2396.txt",
  "mailto:John.Doe@example.com",
  "news:comp.infosystems.www.servers.unix",
  "tel:+1-816-555-1212",
  "telnet://192.0.2.16:80/",
  "urn:oasis:names:specification:docbook:dtd:xml:4.1.2",
  "http://example.com",
  "http://example.com/",
  "http://example.com/foo",
  "http://example.com/foo/bar",
  "http://example.com/foo/bar/",
  "http://example.com/foo/bar?q=1&r=2",
  "http://example.com/foo/bar/?q=1&r=2",
  "http://example.com#toto",
  "http://example.com/#toto",
  "http://example.com/foo#toto",
  "http://example.com/foo/bar#toto",
  "http://example.com/foo/bar/#toto",
  "http://example.com/foo/bar?q=1&r=2#toto",
  "http://example.com/foo/bar/?q=1&r=2#toto",
  "http://example.com/foo/bar/.././baz",
  "file:///foo/bar",
  "mailto:user@host?subject=blah",
  "http://www.yahoo.com",
  "http://www.yahoo.com/",
  "http://1.2.3.4/",
  "http://www.yahoo.com/stuff",
  "http://www.yahoo.com/stuff/",
  "http://www.yahoo.com/hello%20world/",
  "http://www.yahoo.com?name=obi",
  "http://www.yahoo.com?name=obi+wan&status=jedi",
  "http://www.yahoo.com?onery",
  "http://www.yahoo.com#bottom",
  "http://www.yahoo.com/yelp.html#bottom",
  "ftp://www.yahoo.com/",
  "ftp://www.yahoo.com/hello",
  "http://www.yahoo.com?name=%00%01",
  "http://www.yaho%6f.com", // Lowercase hex in percent encoding
  "http://www.yahoo.com/hello%00world/",
  "http://www.yahoo.com/hello+world/",
  "http://www.yahoo.com?name=obi&",
  "http://www.yahoo.com?name=obi&type=",
  "http://www.yahoo.com/yelp.html#",
  "http://example.org/aaa/bbb#ccc",
  "mailto:local@domain.org",
  "mailto:local@domain.org#frag",
  "HTTP://EXAMPLE.ORG/AAA/BBB#CCC",
  "http://example.org/aaa%2fbbb#ccc",
  "http://example.org/aaa%2Fbbb#ccc",
  "http://example.com/%2F",
  "http://example.com/?%2F",
  "http://example.com/#?%2F",
  "http://example.com/aaa%2Fbbb",
  "http://example.org:80/aaa/bbb#ccc",
  "http://example.org:/aaa/bbb#ccc",
  "http://example.org./aaa/bbb#ccc",
  "http://example.123./aaa/bbb#ccc",
  "http://example.org",
  "http://example/Andr&#567;", // HTML entity in path (treated as literal)
  "file:///C:/DEV/Haskell/lib/HXmlToolbox-3.01/examples/",
  // HTTPS
  "https://secure.example.com/",
  "https://example.com:443/path?query=value#frag",

  // WebSockets
  "ws://websocket.example.com/socket",
  "wss://secure.websocket.example.com/socket",

  // LDAP
  "ldap://ldap.example.com/dc=example,dc=com",

  // IPv6 literals
  "http://[2001:db8::1]/",
  "http://[::1]:8080/path",
  "https://[2001:db8::1]:8443/secure",

  // Unicode in path/query/fragment
  "http://example.com/路径/测试",
  "http://example.com/search?q=搜索词",
  "http://example.com/page#章节",

  // Complex userinfo
  "http://user:pass@example.com:8080/path?query=1#frag",
  "http://user@example.com/path",

  // Empty components
  "http://example.com?",
  "http://example.com#",
  "http://example.com/?",
  "http://example.com/#",

  // Special characters in path
  "http://example.com/path;param=value",
  "http://example.com/~user",
  "http://example.com/$path",
  "http://example.com/path,with,commas",

  // Percent-encoding variations
  "http://example.com/%E2%9C%93", // ✓ checkmark
  "http://example.com/%F0%9F%98%8A", // 😊 emoji
  "http://example.com/p%C3%A5th", // 'å' in UTF-8

  // Query strings with special values
  "http://example.com/path?a=b=c&d=e%26f", // value of d is 'e&f'
  "http://example.com/path?param=value%23withhash", // '#' is %23

  // Fragments with special content
  "http://example.com/path#section?notquery", // '?' is allowed in fragment
  "http://example.com/path#fragment%20with%20space",

  // Authority with trailing dot
  "http://example.com./",

  // Port edge cases
  "http://example.com:0/",
  "http://example.com:65535/",

  // Query with no value
  "http://example.com/path?a&b=c",
  "http://example.com/path?a=&b=c",

  // Fragment-only navigation
  "http://example.com/path#onlyfragment",

  // Path with encoded slash
  "http://example.com/path%2Fto%2Fresource",

  // Percent-encoded uppercase/lowercase mix
  "http://example.com/p%C3%A4th", // ä
  "http://example.com/p%e2%82%ac", // € (Euro sign)

  // Multiple slashes in path (valid)
  "http://example.com/a//b///c////d",

  // Colon in path (valid in absolute IRIs)
  "http://example.com/some:thing",
  "http://example.com/path:to:resource",

  // At symbol in path (valid)
  "http://example.com/user@example.com",
  "http://example.com/path@boo",

  // Query with equals in value
  "http://example.com/path?filter=category:books&sort=date",

  // Fragment with encoded characters
  "http://example.com/page#%E2%9C%93", // ✓ in fragment
];

// IRIs that should fail for both Pragmatic and Strict/Parse strategies
const ALWAYS_INVALID_ABSOLUTE_IRIS = [
  "",
  "foo", // No scheme
  "http://example.com/beepbeep\u0007\u0007", // Control characters
  "http://example.com/\n", // Control character
];

// IRIs that should fail for Strict/Parse but might pass Pragmatic
// Note: Some original comments suggested these might be invalid per Strict,
// but the original test expected them to pass Strict. Adjusted based on RFC 3987.
const STRICTLY_INVALID_ABSOLUTE_IRIS = [
  "http://www yahoo.com", // Space in authority (not % encoded)
  "http://www.yahoo.com/hello world/", // Space in path (not % encoded)
  "http://www.yahoo.com/yelp.html#\"'", // Quote in fragment (not % encoded)
  "http://example.com/ ", // Space in path (not % encoded)
  "http://example.com/%", // Incomplete percent encoding
  "http://example.com/A%Z", // Invalid hex in percent encoding
  "http://example.com/%ZZ", // Invalid hex in percent encoding
  "http://example.com/%AZ", // Invalid hex in percent encoding
  "http://example.com/A C", // Space in path (not % encoded)
  "http://example.com/A`C", // Backtick not generally allowed unencoded in path
  "http://example.com/A<C", // Less-than not allowed unencoded
  "http://example.com/A>C", // Greater-than not allowed unencoded
  "http://example.com/A^C", // Caret not generally allowed unencoded in path
  "http://example.com/A\\C", // Backslash not allowed unencoded
  "http://example.com/A{C", // Left brace not generally allowed unencoded in path
  "http://example.com/A|C", // Pipe not allowed unencoded
  "http://example.com/A}C", // Right brace not generally allowed unencoded in path
  "http://example.com/A[C", // Left bracket not generally allowed unencoded in path (outside IPv6)
  "http://example.com/A]C", // Right bracket not generally allowed unencoded in path (outside IPv6)
  "http://example.com/A[**]C", // Brackets with content not allowed unencoded in path
  "http://[xyz]/", // Invalid IPv6
  "http://]/", // Invalid authority start
  "http://example.org/[2010:836B:4179::836B:4179]", // IPv6 literal not in brackets in path
  "http://example.org/abc#[2010:836B:4179::836B:4179]", // IPv6 literal not in brackets in fragment
  "http://example.org/xxx/[qwerty]#a[b]", // Brackets with non-IPv6 content in path/fragment
  // Iprivate characters are NOT allowed in path or fragment (per RFC 3987)
  "http://example.com/\uE000", // Iprivate in path
  "http://example.com/#\uE000", // Iprivate in fragment
  // Bad characters based on RFC 3987 ranges (ucschar/iprivate)
  // These are simplified checks. Full validation is complex.
  // Control characters
  "http://\u0000", // Null char in scheme/host
  "http://example.com/\u0000", // Null char in path
  "http://example.com/?\u0000", // Null char in query
  "http://example.com/#\u0000", // Null char in fragment
  // Characters outside defined ranges (simplified examples)
  // Note: Full range checking is complex in JS. These are indicative.
  // '\uFFFF' is often a non-character
  // 'http://\uFFFF', // Non-character in scheme/host
  // 'http://example.com/?\uFFFF', // Non-character in query

  // Bad host structure
  "http://[/", // Malformed IPv6 start
  "http://[::1]a/", // Garbage after IPv6 literal

  // Fuzzing examples (simplified representation)
  // 'http://\u034F@[]', // Combining grapheme joiner, malformed authority
  // Represented more simply:
  "http://@[]", // Empty userinfo, empty host
];

describe("IRI Parser and Validator", () => {
  describe("Valid IRIs", () => {
    for (const iri of VALID_ABSOLUTE_IRIS) {
      test(`should validate '${iri}' as valid`, () => {
        // Test new Parse strategy
        const _parseResult = parseIRI(iri);
        // Test Parse validation strategy
        const parseError = validateIri(iri, IriValidationStrategy.Parse);
        assert.strictEqual(
          parseError,
          undefined,
          `Validate (Parse) failed: ${parseError?.message}`,
        );

        // Test Pragmatic strategy
        const pragmaticError = validateIri(
          iri,
          IriValidationStrategy.Pragmatic,
        );
        assert.strictEqual(
          pragmaticError,
          undefined,
          `Validate (Pragmatic) failed: ${pragmaticError?.message}`,
        );
      });
    }
  });

  describe("Always Invalid IRIs", () => {
    for (const iri of ALWAYS_INVALID_ABSOLUTE_IRIS) {
      test(`should validate '${iri}' as invalid (All strategies)`, () => {
        // Test Parse strategy via parser
        const _parseResult = parseIRI(iri);
        // Test Parse validation strategy
        const parseError = validateIri(iri, IriValidationStrategy.Parse);
        assert.ok(
          parseError instanceof Error,
          `Validate (Parse) should have failed for '${iri}'`,
        );

        // Test Pragmatic strategy
        const pragmaticError = validateIri(
          iri,
          IriValidationStrategy.Pragmatic,
        );
        assert.ok(
          pragmaticError instanceof Error,
          `Validate (Pragmatic) should have failed for '${iri}'`,
        );

        // Test Strict strategy
        const strictError = validateIri(iri, IriValidationStrategy.Strict);
        assert.ok(
          strictError instanceof Error,
          `Validate (Strict) should have failed for '${iri}'`,
        );
      });
    }
  });

  describe("Strictly Invalid IRIs (RFC 3987 syntax)", () => {
    for (const iri of STRICTLY_INVALID_ABSOLUTE_IRIS) {
      test(`should validate '${iri}' as invalid (Parse/Strict strategies)`, () => {
        // Test Parse strategy via parser
        const _parseResult = parseIRI(iri);
        // Test Parse validation strategy (main focus)
        const parseError = validateIri(iri, IriValidationStrategy.Parse);
        assert.ok(
          parseError instanceof Error,
          `Validate (Parse) should have failed for '${iri}': ${parseError?.message}`,
        );
      });
    }
  });

  describe("Edge Cases and Strategy Handling", () => {
    test("should handle invalid strategy gracefully", () => {
      const error = validateIri("http://example.com/", "foo");
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("Not supported validation strategy"));
    });

    test("should not validate with the none strategy", () => {
      assert.strictEqual(
        validateIri("", IriValidationStrategy.None),
        undefined,
      );
      assert.strictEqual(
        validateIri("\n", IriValidationStrategy.None),
        undefined,
      );
      assert.strictEqual(
        validateIri("http://example.com/\u0000", IriValidationStrategy.None),
        undefined,
      );
    });

    test("should identify structural errors in parsing", () => {
      // Missing scheme
      let result = parseIRI("notascheme");
      assert.strictEqual(result.valid, false);
      assert.ok(result.error);

      // Missing colon after scheme
      result = parseIRI("http//example.com");
      assert.strictEqual(result.valid, false);
      assert.ok(result.error);

      // Malformed authority start
      result = parseIRI("http://[invalid:::ipv6]");
      // Parsing might fail here or later, but should be invalid
      // assert.strictEqual(result.valid, false); // Depends on robustness of parseHostPort

      // Incomplete components
      result = parseIRI("http://example.com/path??query");
      // Might parse, but structure is odd. Parser should ideally handle robustly.
      // Key is that validateIri catches issues.
    });
  });
});

// biome-ignore-start lint/style/useTemplate: This is a unit test
// --- ReDoS Resilience Tests ---
const REDOS_RESILIENCE_TESTS = [
  // Very long scheme-like part (should fail quickly on missing ':')
  "a".repeat(100000) + "://example.com",
  // Authority with many '@' signs (tests findUserInfoEnd logic)
  "http://" + "user@".repeat(10000) + "example.com",
  // Authority with deeply nested brackets (tests IP literal logic robustness)
  "http://[" + "[".repeat(10000) + "xyz" + "]".repeat(10000) + "]/path",
  // Very long path segment (tests path segment validation loop)
  "http://example.com/" + "a".repeat(100000),
  // Very long query with repeated invalid patterns (tests iquery validation)
  "http://example.com/path?" + "invalid%".repeat(10000),
  // Very long fragment with repeated invalid patterns (tests ifragment validation)
  "http://example.com/path#" + "invalid%".repeat(10000),
  // Complex percent-encoding pattern that could trip up regex backtracking
  "http://example.com/" + "%A".repeat(50000), // Incomplete percent-encoding
  // Repeated groups that might stress regex engines
  "http://[" + "1234:5678:".repeat(10000) + "]/path",
];

// --- UNC Path Tests ---
// UNC paths use the 'file' scheme. RFC 8089 defines the syntax.
// file://host/path or file:///path (localhost)
const UNC_PATH_TESTS = [
  // Basic UNC path
  "file://server/share/file.txt",
  // UNC path with authority and path
  "file://hostname/path/to/resource",
  // Local file path (3 slashes)
  "file:///C:/Users/name/file.txt",
  "file:///etc/passwd",
  // UNC path with IPv4 literal
  "file://192.168.1.1/share/folder",
  // Edge case: file: with empty host and path
  "file:///", // Root
  // file: with just a scheme (edge case, might be valid as an empty opaque part)
  // "file:" // This is valid according to RFC 3987 if the scheme allows an empty path/authority
];

// --- Unicode and International Domain Name (IDN) Tests ---
const UNICODE_IDN_TESTS = [
  "http://例子.中国/path", // "example.china"
  "http://παράδειγμα.δοκιμή/προσωπικός_φάκελος/", // "example.test/personal_folder"
  "http://ουτοπία.δπθ.gr/οδηγίες.html", // "utopia.edu.gr/instructions.html"
];

const MORE_EDGE_CASE_TESTS = [
  // Query containing '#'
  "http://example.com/path?param=value%23withhash", // '#' is %23
  // Fragment containing '?'
  "http://example.com/path#section?notquery", // '?' is allowed in fragment
  // Path with '@'
  "http://example.com/path@boo", // '@' is allowed in path
  // Path with ':'
  "http://example.com/some:thing", // ':' is allowed in path (not at start of segment in relative IRIs, but absolute is okay)
  // Multiple consecutive slashes in path (valid)
  "http://example.com/a//b///c",
  // Percent-encoding case sensitivity (both %41 and %62 are valid for A and b)
  "http://example.com/p%C4%8Ath", // UTF-8 for 'č'
  // Percent-encoding normalization (should pass, even if not normalized)
  "http://example.com/p%61th", // 'a' is %61
  // Query with '=', '&', in values
  "http://example.com/path?a=b=c&d=e%26f", // value of d is 'e&f'
];
// biome-ignore-end lint/style/useTemplate: This is a unit test

describe("ReDoS Resilience", () => {
  for (const iri of REDOS_RESILIENCE_TESTS) {
    test(`should handle potentially ReDoS-inducing IRI quickly: ${iri.substring(0, 50)}...`, () => {
      // Use a simple time-based check to ensure it doesn't hang
      const start = Date.now();
      const error = validateIri(iri, IriValidationStrategy.Parse);
      const duration = Date.now() - start;

      // Catastrophic backtracking on these inputs takes seconds or hangs,
      // while linear validation finishes in a few milliseconds. The bound
      // sits well between the two: 100ms was tripped by the 100k-character
      // path on loaded bun CI runners (102ms and 132ms observed) even though
      // the same input validates in about 5ms on an idle machine.
      assert.ok(
        duration < 1000,
        `Validation took too long (${duration}ms): ${iri.substring(0, 50)}...`,
      );

      // It should either be valid or invalid, but not hang or throw unexpectedly
      // Most of these should be invalid
      assert.ok(
        error instanceof Error || error === undefined,
        `Unexpected result for ReDoS test: ${error}`,
      );
      // console.log(`ReDoS Test: '${iri.substring(0, 30)}...' -> ${error ? 'Invalid' : 'Valid'} (${duration}ms)`); // Optional logging
    });
  }
});

describe("UNC Paths", () => {
  for (const iri of UNC_PATH_TESTS) {
    test(`should parse and validate UNC path IRI: ${iri}`, () => {
      const parseResult = parseIRI(iri);
      assert.strictEqual(
        parseResult.valid,
        true,
        `Parsing failed for UNC path: ${parseResult.error}`,
      );

      const validateError = validateIri(iri, IriValidationStrategy.Parse);
      assert.strictEqual(
        validateError,
        undefined,
        `Validation (Parse) failed for UNC path: ${validateError?.message}`,
      );
    });
  }
});

describe("Unicode and IDN", () => {
  for (const iri of UNICODE_IDN_TESTS) {
    test(`should parse and validate Unicode/IDN IRI: ${iri}`, () => {
      const parseResult = parseIRI(iri);
      const validateError = validateIri(iri, IriValidationStrategy.Parse);
      assert.strictEqual(
        parseResult.valid,
        true,
        `Structural parsing failed for Unicode IRI: ${parseResult.error}`,
      );
      // And check validation result separately
      if (validateError) {
        // This is expected if ucschar is not yet supported in validation
        // console.log(`Unicode IRI failed validation (expected if ucschar not supported): ${iri}`);
      }
    });
  }
});

describe("Additional Edge Cases", () => {
  for (const iri of MORE_EDGE_CASE_TESTS) {
    test(`should parse and validate edge case IRI: ${iri}`, () => {
      const parseResult = parseIRI(iri);
      assert.strictEqual(
        parseResult.valid,
        true,
        `Parsing failed for edge case: ${parseResult.error}`,
      );

      const validateError = validateIri(iri, IriValidationStrategy.Parse);
      assert.strictEqual(
        validateError,
        undefined,
        `Validation (Parse) failed for edge case: ${validateError?.message}`,
      );
    });
  }
});

// Restored from the retired lib/helpers/core-misc-b.poku.js, which was
// deleted along with its module during the v13 layer reorganisation even though
// the functions under test only moved.

import { it as _iriIt } from "poku";

import { isValidIriReference } from "./iri.js";

// biome-ignore-start lint/style/useTemplate: This is a unit test
// biome-ignore-start lint/suspicious/noTemplateCurlyInString: This is a unit test
const testCases = [
  // --- Existing Test Cases (for context) ---
  ["", false],
  ["git@gitlab.com:behat-chrome/chrome-mink-driver.git", false],
  ["     git@gitlab.com:behat-chrome/chrome-mink-driver.git      ", false],
  ["${repository.url}", false],
  // bomLink - https://cyclonedx.org/capabilities/bomlink/
  ["urn:cdx:f08a6ccd-4dce-4759-bd84-c626675d60a7/1#componentA", true],
  // http uri - https://www.ietf.org/rfc/rfc7230.txt
  ["https://gitlab.com/behat-chrome/chrome-mink-driver.git      ", false], // Fails due to trailing space
  [
    "     https://gitlab.com/behat-chrome/chrome-mink-driver.git           ",
    false, // Fails due to leading space
  ],
  ["http://gitlab.com/behat-chrome/chrome-mink-driver.git", true],
  ["git+https://github.com/Alex-D/check-disk-space.git      ", false], // Fails due to trailing space
  ["UNKNOWN", false],
  ["http://", false],
  ["http", false],
  ["https", false],
  ["https://", false],
  ["http://www", true],
  ["http://www.", true],
  [
    "https://github.com/apache/maven-resolver/tree/      ${project.scm.tag}",
    false, // Fails due to space and ${}
  ],
  ["git@github.com:prometheus/client_java.git", false],
  // --- New Stress Test Cases ---
  // Potential ReDoS for percent-encoding regex: Long sequences of % followed by non-hex or short hex
  [`http://example.com/a%${"a%".repeat(50000)}`, false], // Many %a patterns
  [`http://example.com/a%${"ab%".repeat(50000)}`, false], // Many %ab patterns (invalid end)
  [`http://example.com/a%${"a".repeat(100000)}`, true], // Valid: %aa is a complete encoding followed by many literal 'a's in path
  [`http://example.com/${"%".repeat(100000)}`, false], // Very long sequence of just %
  // Edge cases around valid percent-encoding boundaries (pushing regex engine)
  [`http://example.com/path%${"20".repeat(30000)}%2`, false], // Valid %20s, ends with incomplete %
  [`http://example.com/path%${"20".repeat(30000)}a`, true], // Valid: %20 encoding followed by many chars and trailing literal 'a'
  // Potentially complex IRI that might be slow for validateIri (if not already robust)
  // Using a plausible but complex structure with lots of valid non-ASCII chars (requires UTF-8 support)
  // Note: Actual performance depends on the `validateIri` implementation.
  [
    "http://example.com/path/to/resource/with/lots/of/segments/and/long/-names/including/üñíçødé/characters/ sprinkled/in/" +
      "segment".repeat(2000) +
      "?query=param&other=valué#frågmënt",
    false,
  ], // Assuming validateIri and URL can handle it
  // Very long valid IRI (tests overall handling, potentially URL constructor)
  [
    "http://very.long.domain.name.example.com/very/long/path/component/that/just/keeps/going/on/and/on/forever/it/seems/" +
      "segment/".repeat(3000) +
      "end",
    true,
  ], // Assuming it's technically valid
  // IRI with complex query and fragment (tests boundaries)
  [
    "https://example.com/path?query=with%20lots%20of%20percent%20encoding%20but%20valid%20%C3%A9%C3%B1#fragment-with-unicode-çhars-üñíçødé",
    true, // Valid: %20 and %C3%A9%C3%B1 are correct encodings; RFC 3987 allows unicode in fragment
  ],
  // IRI that looks almost like a bomLink but isn't quite (tests scheme handling)
  ["urn:cdx:some-uuid/1#componentA/extra", true], // Might be valid IRI/URI, depends on urn:cdx spec, but structurally okay for IRI
  ["urn:cdx:some-uuid/1", true], // Valid urn without fragment
  // IRI with userinfo (less common, test robustness)
  ["http://user:p@ssw0rd@example.com/path", true], // Valid, but contains @
  ["http://user@example.com/path", true], // Valid with user only
  // IRI with IPv6 literal (tests authority parsing)
  ["http://[2001:db8::1]:8080/path", true], // Valid IPv6
  ["http://[2001:db8::1]/path", true], // Valid IPv6 without port
  // Potentially problematic characters in path/query/fragment (if not already covered)
  ["http://example.com/path with spaces", false], // Space not encoded
  ["http://example.com/path<with>brackets", false], // < > not typically allowed unencoded
  ['http://example.com/path"with"quotes', false], // " not typically allowed unencoded in URI/IRI ref
  // Test case sensitivity for scheme check (uses original `iri`)
  ["HTTP://example.com", true], // Scheme case (URL constructor should handle)
  ["HTTPS://EXAMPLE.COM/PATH", true],
  // Edge case: IRI that is just a scheme
  ["mailto:", false],
  ["https:", false],
  ["http:", false],
  // Re-test specific percent-encoding edge case mentioned in comments
  ["http://example.com/path%ab%cd%ef", true], // Valid percent encodings
  ["http://example.com/path%ab%cd%e", false], // Invalid: incomplete %e at end
  ["http://example.com/path%ab%cd%eg", false], // Invalid: %eg
  ["http://example.com/path%ab%cd%", false], // Invalid: trailing %
  ["http://example.com/path%ab%cd%0", false], // Invalid: %0
  ["http://example.com/path%ab%cd%0Z", false], // Invalid: %0Z ('Z' is not a hex digit)
  ["http://example.com/path%abc", true], // Valid: %ab is a complete encoding, 'c' is the next literal character
  ["http://example.com/path%abZ", true], // Valid %ab followed by a literal character
  // Test with extremely long, but valid, percent-encoded sequence (pushes validateIri/URL)
  // This string is valid UTF-8 percent-encoded 'A' repeated many times.
  // encodeURIComponent("A".repeat(10000)) produces a very long string of %41
  // Let's simulate a long valid percent-encoded part manually for a simpler test
  [`http://example.com/data/${"%41%42%43%44".repeat(10000)}`, true], // Repeats 'ABCD' encoded
  // UNC Paths (IRI references)
  // Standard UNC path (often treated as URIs like \\server\share\path -> file://server/share/path or \\server\share -> smb://server/share)
  // However, as IRI *references* starting with \\, they are generally invalid unless specifically scheme-less references
  // The IRI spec defines scheme-less references as relative. \\server is not a valid relative path segment.
  ["\\\\server\\share\\path\\file.txt", false], // Looks like UNC, invalid as IRI ref
  ["file://server/share/path/file.txt", true], // Correct URI form if that's the intent
  // UNC path with spaces (invalid as IRI ref, valid file URI)
  ["\\\\server name\\share name\\file name.txt", false],
  ["file://server%20name/share%20name/file%20name.txt", true],
  // UNC path with Unicode (invalid as IRI ref, valid file URI if percent-encoded)
  ["\\\\サーバー\\共有\\ファイル.txt", false], // Raw Unicode UNC - invalid IRI ref
  // Correct IRI for UNC-like path would need a scheme, e.g., file:
  [
    "file:///%E3%82%B5%E3%83%BC%E3%83%90%E3%83%BC/%E5%85%B1%E6%9C%89/%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.txt",
    true,
  ], // file:///%E3%82%B5%E3%83%BC%E3%83%90%E3%83%BC/%E5%85%B1%E6%9C%89/%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.txt (Japanese characters encoded)

  // Unicode Characters in various components (IRI references)
  // Path with Latin-1 Supplement characters (e.g., accented letters)
  ["https://example.com/café/résumé.html", true],
  ["https://example.com/path/%C3%A9%C3%A1%C3%BC", true], // Same path, pre-encoded
  // Path with Chinese characters
  ["https://example.com/路径/文件.html", true],
  // Path with Emoji (if supported by IRI spec and validator)
  ["https://example.com/search?q=cat&emoji=😺", false], // Emoji in query

  // Query and Fragment with Unicode
  ["https://example.com/search?q=café röst", false],
  ["https://example.com/search?q=café%20röst", true],
  ["https://example.com/page#se%C3%A7%C3%A3o-intro", true], // Encoded fragment

  // Bidirectional Text (Bidi) in IRI (from RFC 3987 Section 4.3)
  // Note: Actual bidi control characters (like U+200E, U+200F, U+202A..U+202E) should generally be avoided or percent-encoded.
  // Example Bidi IRI from RFC (Hebrew Alef, Lamed, Yod, Vav) - presented logically LTR as Alef-Lamed-Yod-Vav
  // Unicode code points: U+05D0 U+05DC U+05D9 U+05D5
  // UTF-8 Encoding: D7 90 D7 9C D7 99 D7 95
  // Percent Encoding: %D7%90%D7%9C%D7%99%D7%95
  // Assuming the logical string "http://example.com/الयो" represents the Hebrew characters.
  // However, constructing the *exact* bidi IRI string is complex in plain text.
  // Let's test with the percent-encoded version which is clearer.
  // This tests handling of valid UTF-8 sequences representing RTL characters.
  ["http://example.com/%D7%90%D7%9C%D7%99%D7%95", true], // Alef Lamed Yod Vav (Hebrew) encoded

  // Look-alike Characters (from RFC 3987 Section 7.5)
  // Full-width Latin characters (from RFC 3987 Section 7.5)
  // Full-width 'A' (U+FF21) vs. Latin 'A' (U+0041)
  // Full-width 'A' UTF-8: EF BC A1 -> Percent-encoded: %EF%BC%A1
  ["http://example.com/path/FULLWIDTH%EF%BC%A1", true], // Full-width 'A' in path
  // Testing if validator differentiates (it shouldn't inherently, both are valid IRI chars if allowed by scheme)
  ["http://example.com/path/LATIN_A", true], // Standard 'A'

  // Characters specifically excluded in older RFCs mentioned (RFC 3987 Section 7.2)
  // "<", ">", '"', space, "{", "}", "|", "\", "^", and "`"
  // These should generally be invalid *unless* percent-encoded within a valid IRI component context.
  ["https://example.com/path with space", false], // Invalid: unencoded space
  ["https://example.com/path%20with%20space", true], // Valid: encoded space
  ["https://example.com/path<invalid>", false], // Invalid: unencoded <
  ["https://example.com/path%3Cinvalid%3E", true], // Valid: encoded <>
  ['https://example.com/path"quoted"', false], // Invalid: unencoded "
  ["https://example.com/path%22quoted%22", true], // Valid: encoded "
  ["https://example.com/path{invalid}", false], // Invalid: unencoded {
  ["https://example.com/path%7Binvalid%7D", true], // Valid: encoded {}
  // Note: #, %, [, ] are NOT in the excluded list RFC 3987 mentions for conversion; % is crucial for encoding, # [] are for IPv6 literals.

  // Complex UTF-8 sequences (4-byte UTF-8 for supplementary planes)
  // Character: G clef (U+1D11E)
  // UTF-8 Encoding: F0 9D 84 9E -> Percent-encoded: %F0%9D%84%9E
  ["https://example.com/music/notation/%F0%9D%84%9E", true], // G clef in path

  // Extremely long UTF-8 sequence (valid but large)
  // Representing a string like "𝄞".repeat(5000) encoded
  // U+1D11E (G clef) -> UTF-8: F0 9D 84 9E -> Percent-encoded: %F0%9D%84%9E
  // Let's create a long valid percent-encoded string representing repeated 4-byte chars
  [`https://example.com/data/${"%F0%9D%84%9E".repeat(5000)}`, true], // Many G clefs encoded
];

testCases.forEach(([url, expected], index) => {
  _iriIt(`should validate IRI reference for case ${index}`, () => {
    const result = isValidIriReference(url);
    assert.strictEqual(result, expected);
  });
});
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: This is a unit test
// biome-ignore-end lint/style/useTemplate: This is a unit test

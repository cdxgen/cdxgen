import { assert, describe, it } from "poku";

import {
  encodeUriReference,
  hasInlineCredential,
  sanitizeBomEndpointUrl,
  sanitizeBomPropertyValue,
  sanitizeBomUrl,
} from "./propertySanitizer.js";

describe("propertySanitizer", () => {
  it("redacts additional token formats and sensitive nested keys", () => {
    const sanitized = sanitizeBomPropertyValue("cdx:skill:metadata", {
      apiKey: "sk-proj_secret_value_here",
      nested: {
        bearerToken: "bearer super-secret-token-value",
        endpoint: "https://example.com/path?token=abc#frag",
      },
    });

    assert.strictEqual(
      sanitized,
      JSON.stringify({
        apiKey: "[redacted]",
        nested: {
          bearerToken: "[redacted]",
          endpoint: "https://example.com/path",
        },
      }),
    );
  });

  it("summarizes commands after stripping env wrappers and absolute paths", () => {
    assert.strictEqual(
      sanitizeBomPropertyValue(
        "cdx:mcp:command",
        "OPENAI_API_KEY=sk-test /usr/bin/env python /tmp/run.py",
      ),
      "python",
    );
  });

  it("sanitizes urls without keeping credentials or tokens", () => {
    assert.strictEqual(
      sanitizeBomUrl("https://example.com/path?token=abc#frag"),
      "https://example.com/path",
    );
  });

  it("strips user-info, query and fragment from URLs the parser rejects", () => {
    assert.strictEqual(
      sanitizeBomUrl("https://svc:pw-Secret1@db.example:PORT/v1?sig=abc#f"),
      "https://db.example:PORT/v1",
    );
    assert.strictEqual(
      sanitizeBomPropertyValue(
        "description",
        "Connect to https://svc:pw-Secret1@db.example:PORT/v1 first",
      ),
      "Connect to https://db.example:PORT/v1 first",
    );
    assert.strictEqual(
      sanitizeBomUrl("https://{host}/path?k=abc"),
      "https://{host}/path",
    );
    assert.strictEqual(
      sanitizeBomUrl("git+ssh://git@github.com:org/repo.git"),
      "git+ssh://git@github.com:org/repo.git",
    );
    assert.strictEqual(sanitizeBomUrl("not a url"), "not a url");
  });

  it("ends endpoint URL paths before a segment holding a credential", () => {
    assert.strictEqual(
      sanitizeBomEndpointUrl(
        "https://bot@mcp.example.com/mcp/ghp_abcdefghijklmnopqrstuvwxyz0123456789/sse?x=1#f",
      ),
      "https://mcp.example.com/mcp",
    );
    assert.strictEqual(
      sanitizeBomEndpointUrl(
        "https://mcp.example.com/v1;session=abc/mcp;token=sk_live_abcdefgh12345678/sse",
      ),
      "https://mcp.example.com/v1/mcp/sse",
    );
    assert.strictEqual(
      sanitizeBomEndpointUrl(
        "https://mcp.example.com/mcp/%73k_live_abcdefgh12345678/sse",
      ),
      "https://mcp.example.com/mcp",
    );
    assert.strictEqual(
      sanitizeBomEndpointUrl("https://example.com/mcp/sse"),
      "https://example.com/mcp/sse",
    );
    assert.strictEqual(sanitizeBomEndpointUrl("not a url"), "not a url");
    assert.strictEqual(sanitizeBomEndpointUrl("mailto:a@b"), "mailto:a@b");
  });

  it("percent-encodes route templates and URLs into URI references", () => {
    const cases = [
      // route templates from OpenAPI, kosi, scalasem, dosai and golem
      ["/users/{id}", "/users/%7Bid%7D"],
      ["api/[controller]/{id}", "api/%5Bcontroller%5D/%7Bid%7D"],
      ["/orders/{}", "/orders/%7B%7D"],
      ["/files/my file", "/files/my%20file"],
      ["/a<b>|c^d", "/a%3Cb%3E%7Cc%5Ed"],
      ["/café", "/caf%C3%A9"],
      ["/a%zz/%", "/a%25zz/%25"],
      // what an RFC 3986 path holds as it is stays as it is
      ["/time/09:30", "/time/09:30"],
      ["/static/*", "/static/*"],
      ["/fiber/+", "/fiber/+"],
      ["/users/%7Bid%7D", "/users/%7Bid%7D"],
      // the authority of a URL is kept, the query and fragment stay apart
      [
        "http://[::1]:9000/m{x}?q=a b&c={d}#f#g",
        "http://[::1]:9000/m%7Bx%7D?q=a%20b&c=%7Bd%7D#f%23g",
      ],
      ["https://api.example.com/v1/x", "https://api.example.com/v1/x"],
      ["/a#b?c", "/a#b?c"],
      ["kafka:order-events", "kafka:order-events"],
      [
        "jdbc:postgresql://db.internal:5432/reports",
        "jdbc:postgresql://db.internal:5432/reports",
      ],
    ];
    for (const [value, expected] of cases) {
      assert.strictEqual(encodeUriReference(value), expected, value);
      // Encoding twice changes nothing.
      assert.strictEqual(encodeUriReference(expected), expected, expected);
    }
    // A lone surrogate becomes U+FFFD rather than throwing.
    assert.strictEqual(encodeUriReference("/x\ud800y"), "/x%EF%BF%BDy");
    assert.strictEqual(encodeUriReference(undefined), "");
  });

  it("detects inline credentials the sanitizer would redact", () => {
    assert.strictEqual(
      hasInlineCredential("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
      true,
    );
    // The patterns are global; a second call must not resume mid-string.
    assert.strictEqual(
      hasInlineCredential("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
      true,
    );
    assert.strictEqual(hasInlineCredential("AKIAABCDEFGHIJKLMNOP"), true);
    assert.strictEqual(hasInlineCredential("repos"), false);
    assert.strictEqual(hasInlineCredential(undefined), false);
  });
});

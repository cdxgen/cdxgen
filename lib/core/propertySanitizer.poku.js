import { assert, describe, it } from "poku";

import {
  encodeUriReference,
  hasInlineCredential,
  redactCommandCredentials,
  sanitizeBomEndpointUrl,
  sanitizeBomPropertyValue,
  sanitizeBomReferenceUrl,
  sanitizeBomText,
  sanitizeBomUrl,
  stripUrlCredentials,
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
      "git+ssh://github.com:org/repo.git",
    );
    assert.strictEqual(sanitizeBomUrl("not a url"), "not a url");
  });

  it("strips a URL value that is a network-path reference", () => {
    assert.strictEqual(
      sanitizeBomUrl("//user:pw@host/path?token=abc#f"),
      "//host/path",
    );
    assert.strictEqual(sanitizeBomUrl("//ghtoken@host/x"), "//host/x");
    assert.strictEqual(
      sanitizeBomReferenceUrl("//ci:pw@git.example.com/repo.git?x=1#v1.0.0"),
      "//git.example.com/repo.git#v1.0.0",
    );
    assert.strictEqual(
      sanitizeBomReferenceUrl("//git@git.example.com/repo.git"),
      "//git@git.example.com/repo.git",
    );
    assert.strictEqual(
      sanitizeBomPropertyValue(
        "cdx:github:step:command",
        "npm publish --registry=//deploy:s3cr3t@pkgs.internal/npm/",
      ),
      "npm publish --registry=//pkgs.internal/npm/",
    );
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
    assert.strictEqual(hasInlineCredential("glpat-abcdefghij0123456789"), true);
    assert.strictEqual(hasInlineCredential("repos"), false);
    assert.strictEqual(hasInlineCredential(undefined), false);
  });
});

describe("stripUrlCredentials()", () => {
  it("removes a userinfo that holds list separators and quotes", () => {
    for (const password of [
      "Zx9;Qw7",
      "Lm4,Rt8",
      "Hd3'Yk5",
      'Qa1"Ws2',
      "Pl0|Ok9",
    ]) {
      assert.strictEqual(
        stripUrlCredentials(`https://deploy:${password}@repo.example.com/a/`),
        "https://repo.example.com/a/",
        password,
      );
    }
  });

  it("removes a whole query, path parameters and all", () => {
    assert.strictEqual(
      stripUrlCredentials("https://a.example/x;v=1?sv=1;sig=abc123 tail"),
      "https://a.example/x;v=1 tail",
    );
    assert.strictEqual(
      stripUrlCredentials("https://h/p?next=https://u:p@x/y z"),
      "https://h/p z",
    );
  });

  it("handles every scheme", () => {
    assert.strictEqual(
      stripUrlCredentials("sparse+https://ci:pw@registry.example.com/index/"),
      "sparse+https://registry.example.com/index/",
    );
    assert.strictEqual(
      stripUrlCredentials("jdbc:postgresql://db:5432/app?user=a&password=b"),
      "jdbc:postgresql://db:5432/app",
    );
  });

  it("keeps the items of a list and the quotes around a URL", () => {
    assert.strictEqual(
      stripUrlCredentials(
        "file:///opt/gradle,https://ci:pw@dl.example.com/g.zip?x=1",
      ),
      "file:///opt/gradle,https://dl.example.com/g.zip",
    );
    assert.strictEqual(
      stripUrlCredentials(
        "https://a.example.com,https://ci:pw@b.example.com/x",
      ),
      "https://a.example.com,https://b.example.com/x",
    );
    assert.strictEqual(
      stripUrlCredentials("https://a/x?y=1,file:///opt/z"),
      "https://a/x,file:///opt/z",
    );
    assert.strictEqual(
      stripUrlCredentials('-Du="https://u:p@h/x?y=1" -Dfoo'),
      '-Du="https://h/x" -Dfoo',
    );
    assert.strictEqual(
      stripUrlCredentials("ne(variables['feed'], 'https://ci:pw@h/npm/')"),
      "ne(variables['feed'], 'https://h/npm/')",
    );
  });

  it("leaves text without URLs alone", () => {
    assert.strictEqual(
      stripUrlCredentials("user@example.com"),
      "user@example.com",
    );
    assert.strictEqual(stripUrlCredentials(undefined), "");
  });

  it("handles many URLs in one value", () => {
    stripUrlCredentials(`${"a://".repeat(50000)}x`);
    stripUrlCredentials(`https://h/p?${"q://".repeat(50000)}`);
    stripUrlCredentials(`https://${",".repeat(200000)}a://b`);
    assert.strictEqual(
      stripUrlCredentials(`${"https://a/x ".repeat(50000)}//u:p@h/x`).endsWith(
        " //h/x",
      ),
      true,
    );
    stripUrlCredentials(" //a".repeat(200000));
    stripUrlCredentials(`=//${"a:".repeat(100000)}`);
  });

  it("removes the credentials of a network-path reference", () => {
    for (const [input, expected] of [
      ["//user:pw@host/path", "//host/path"],
      ["//user:pw@host/path?token=abc#f", "//host/path"],
      [
        "npm publish --registry=//deploy:s3cr3t@pkgs.internal/npm/",
        "npm publish --registry=//pkgs.internal/npm/",
      ],
      [
        "pip install --index-url //u:pw@pypi.internal/simple pkg",
        "pip install --index-url //pypi.internal/simple pkg",
      ],
      ['url: "//u:pw@h"', 'url: "//h"'],
      [
        "ne(variables['feed'], '//ci:pw@h/npm/')",
        "ne(variables['feed'], '//h/npm/')",
      ],
      ["curl //u:pw@h/x\nthen //v:pw@h2/y", "curl //h/x\nthen //h2/y"],
      ["https://u:pw@a/x and //v:pw@b/y?z=1", "https://a/x and //b/y"],
      ["//u:pw@[::1]:8080/x", "//[::1]:8080/x"],
    ]) {
      assert.strictEqual(stripUrlCredentials(input), expected, input);
    }
  });

  it("leaves two slashes that do not start a URL with a credential alone", () => {
    for (const input of [
      "src//lib/x.js",
      "//host/path?x=1",
      "// see user@example.com for details",
      "// TODO: ping @ops before release",
      "echo done //todo@me",
      "grep -E '//[a-z]+@[a-z]+' file",
      "//deploy@host/path",
      "a//u:pw@host/x",
      "//u:pw@/x",
    ]) {
      assert.strictEqual(stripUrlCredentials(input), input, input);
    }
  });

  it("sanitizes a URL with a separator in its password in BOM text", () => {
    assert.strictEqual(
      sanitizeBomPropertyValue(
        "cdx:example",
        "publish to https://ci:hun,ter2@Pkgs.example.com/npm/?sig=Zm9vYmFy",
      ),
      "publish to https://pkgs.example.com/npm/",
    );
    // The port is out of range, so URL() rejects the value.
    assert.strictEqual(
      sanitizeBomUrl("http://u:p@h:99999/x?y#z"),
      "http://h:99999/x",
    );
  });

  it("redacts credential arguments in command lines and keeps the rest", () => {
    const cases = [
      [
        'curl -u deploy:hunter2 -H "Authorization: Bearer abc.def" https://x/y',
        'curl -u [redacted] -H "Authorization: [redacted]" https://x/y',
      ],
      ["curl -udeploy:hunter2 https://x", "curl -u[redacted] https://x"],
      [
        'curl -H "Authorization: Bearer $TOKEN" https://x',
        'curl -H "Authorization: Bearer $TOKEN" https://x',
      ],
      [
        "docker login -u ci -p s3cr3t registry.example.com",
        "docker login -u ci -p [redacted] registry.example.com",
      ],
      ["docker run -p 8080:80 nginx", "docker run -p 8080:80 nginx"],
      [
        "echo $PW | docker login --password-stdin -u ci reg",
        "echo $PW | docker login --password-stdin -u ci reg",
      ],
      ["mysql -uroot -phunter2 db", "mysql -uroot -p[redacted] db"],
      [
        "npm publish --token abc123 --access public",
        "npm publish --token [redacted] --access public",
      ],
      [
        "wget --user=bob:pw --password=hunter2 https://x",
        "wget --user=[redacted] --password=[redacted] https://x",
      ],
      ["NPM_TOKEN=abc123 npm publish", "NPM_TOKEN=[redacted] npm publish"],
      [
        "export GITHUB_TOKEN=ghx; ./gradlew publish -Dorg.gradle.project.nexusPwd=Ht5 -Pfoo=bar",
        "export GITHUB_TOKEN=[redacted]; ./gradlew publish -Dorg.gradle.project.nexusPwd=[redacted] -Pfoo=bar",
      ],
      [
        "twine upload -u __token__ -p pypi-abc dist/*",
        "twine upload -u __token__ -p [redacted] dist/*",
      ],
      ["deploy --token $DEPLOY_TOKEN", "deploy --token $DEPLOY_TOKEN"],
      ["sort -u file", "sort -u file"],
      [
        'git commit --author="A B <a@b>" -m msg',
        'git commit --author="A B <a@b>" -m msg',
      ],
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(redactCommandCredentials(input), expected, input);
    }
  });

  it("finds JSON Web Tokens", () => {
    // 512 KB of `-eyJ`, the input that makes a backtracking pattern retry
    // from every position, holds no token.
    const adversarial = "-eyJ".repeat(131072);
    assert.strictEqual(hasInlineCredential(adversarial), false);
    sanitizeBomText(adversarial);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl";
    assert.strictEqual(
      sanitizeBomText(`Bearer-less ${jwt}. next`),
      "Bearer-less [redacted]. next",
    );
    assert.strictEqual(sanitizeBomText(`x-${jwt}-`), "x-[redacted]-");
    assert.strictEqual(sanitizeBomText("eyJabc.def"), "eyJabc.def");
    assert.strictEqual(sanitizeBomText("noeyJabc.def.ghi"), "noeyJabc.def.ghi");
    assert.ok(hasInlineCredential(jwt));
  });

  it("keeps URL templates and strips credentials from any scheme", () => {
    assert.strictEqual(
      sanitizeBomText(
        "GET https://{user}:{password}@api.example.com/{id}?token={t} now",
      ),
      "GET https://api.example.com/{id} now",
    );
    assert.strictEqual(
      sanitizeBomText("see [docs](https://h.example/x?s=(1))."),
      "see [docs](https://h.example/x).",
    );
    assert.strictEqual(
      sanitizeBomText('{"url":"https://a:b@h.example/x?y=1"}'),
      '{"url":"https://h.example/x"}',
    );
    assert.strictEqual(
      sanitizeBomText("connect postgres://admin:hunter2@db:5432/app"),
      "connect postgres://db:5432/app",
    );
    assert.strictEqual(
      sanitizeBomUrl("jdbc:mysql://admin:hunter2@db/app"),
      "jdbc:mysql://db/app",
    );
  });
});

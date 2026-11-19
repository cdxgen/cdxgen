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
  sanitizeUrlProperties,
  sanitizeUrlQuery,
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

  it("redacts hyphen-delimited provider keys in plain text", () => {
    for (const key of [
      "sk_live_StripeStyleKey0123456789",
      "sk-proj_UnderscoreStyleKey0123456789",
      "sk-proj-OpenAiProjectKey0123456789abcdefghijklmnopqrstuvwxyzABCD",
      "sk-ant-api03-AnthropicKey0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFAA",
      "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef",
      "sk-LegacyOpenAiKey0123456789abcdefghijklmnopqrstuv",
    ]) {
      assert.strictEqual(
        sanitizeBomPropertyValue(
          "cdx:agent:description",
          `Run \`KEY=${key} python evals.py\` first.`,
        ),
        "Run `KEY=[redacted] python evals.py` first.",
      );
    }
    assert.strictEqual(
      sanitizeBomPropertyValue("cdx:langgraph:envFile", {
        OPENAI_KEY: "sk-proj-OpenAiProjectKey0123456789abcdefghij",
      }),
      JSON.stringify({ OPENAI_KEY: "[redacted]" }),
    );
  });

  it("reduces a command line to its executable whatever the path holds", () => {
    for (const [command, expected] of [
      ["/usr/lib/jvm/java-21/bin/java -Dk=SECRET -jar tickets.jar", "java"],
      [
        "/opt/homebrew/opt/openjdk@21/bin/java -Dk=SECRET -jar tickets.jar",
        "java",
      ],
      [
        "/opt/homebrew/opt/openjdk@21/bin/java -Dk=SECRET -jar /srv/app.jar",
        "java",
      ],
      ["/opt/tool@2/bin/run --key-file=keys/hunter2.bin", "run"],
      [
        "/opt/homebrew/opt/python@3.12/bin/python3 --key SECRET app.py",
        "python3",
      ],
      ["C:\\jdk-21\\bin\\java -Dk=SECRET -jar tickets-mcp.jar", "java"],
      ["C:\\Program Files\\nodejs\\node.exe --inspect", "node.exe"],
      ["C:\\Program Files\\nodejs\\node.exe", "node.exe"],
    ]) {
      assert.strictEqual(
        sanitizeBomPropertyValue("cdx:mcp:command", command),
        expected,
        command,
      );
    }
  });

  it("redacts common secret key names", () => {
    const secretKeys = [
      "registry_pass",
      "dbPass",
      "db_pwd",
      "private_key",
      "privateKeyPem",
      "signing_key",
      "ssh_keys",
      "aws_access_key",
      "aws_access_key_id",
      "Set-Cookie",
      "passphrase",
      "registry_creds",
    ];
    const sanitized = JSON.parse(
      sanitizeBomPropertyValue("cdx:skill:metadata", {
        owner: "platform-team",
        passthrough: "enabled",
        keyboard: "us",
        ...Object.fromEntries(secretKeys.map((key) => [key, `value-${key}`])),
      }),
    );
    assert.deepStrictEqual(sanitized, {
      owner: "platform-team",
      passthrough: "enabled",
      keyboard: "us",
      ...Object.fromEntries(secretKeys.map((key) => [key, "[redacted]"])),
    });
  });

  it("sanitizes object keys like values", () => {
    const sanitized = sanitizeBomPropertyValue("cdx:agent:permission", {
      bash: {
        "git push https://deploy:ghp_abcdefghijklmnopqrstuvwxyz012345@git.example.com/acme/app.git *":
          "allow",
        "gh api -H ghp_abcdefghijklmnopqrstuvwxyz012345 *": "deny",
        "*": "ask",
      },
      ["__proto__"]: "dropped",
    });
    assert.strictEqual(
      sanitized,
      JSON.stringify({
        bash: {
          "git push https://git.example.com/acme/app.git *": "allow",
          "gh api -H [redacted] *": "deny",
          "*": "ask",
        },
      }),
    );
  });

  it("redacts bearer tokens in base64 and percent-encoded form whole", () => {
    for (const [token, expected] of [
      ["UrlSafeTokenUrlSafeToken_0123-4567.89", "[redacted]"],
      ["Short0Head+WholeTokenSurvives/0123456789abcdefghij==", "[redacted]"],
      [
        "LongEnoughHeadIsRedacted01+TailOfTheTokenSurvives/0123456789==",
        "[redacted]",
      ],
      ["tilde~token~0123456789abcdef", "[redacted]"],
      [
        "AAAAAAAAAAAAAAAAAAAAAMLheAAAAAAA0%2BuSeid%2BULvsea4JtiGRiSDSJSI%3DEUifiRBkKG5E",
        "[redacted]",
      ],
    ]) {
      assert.strictEqual(
        sanitizeBomPropertyValue(
          "cdx:agent:description",
          `Authorization: Bearer ${token} sent`,
        ),
        `Authorization: ${expected} sent`,
      );
    }
    assert.strictEqual(
      sanitizeBomPropertyValue("cdx:agent:description", "Bearer $API_TOKEN"),
      "Bearer $API_TOKEN",
    );
  });

  it("keeps short hyphenated words that only share a key prefix", () => {
    const text =
      "Use the sk-learn wrapper, pk-column and task-runner-for-long-jobs.";
    assert.strictEqual(
      sanitizeBomPropertyValue("cdx:agent:description", text),
      text,
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

  it("removes credentials from URL-valued component properties", () => {
    const properties = [
      {
        name: "cdx:gem:remote",
        value: "https://ci-bot:PLANTED@git.example.com/acme/auth.git",
      },
      {
        name: "cdx:cargo:sourceUrl",
        value:
          "git+https://ci-bot:PLANTED@git.example.com/acme/core.git?x=1#abc",
      },
      { name: "cdx:pub:registry", value: "https://pub.dev" },
      { name: "cdx:npm:note", value: "plain text" },
      { name: "cdx:json", value: '{"url":"https://u:p@h/x"}' },
      {
        name: "cdx:list",
        value: "https://u:p@a.example.com/x, https://b.example.com/y",
      },
      { name: "cdx:number", value: 3 },
    ];
    const result = sanitizeUrlProperties(properties);
    assert.deepStrictEqual(
      result.map((property) => property.value),
      [
        "https://git.example.com/acme/auth.git",
        "git+https://git.example.com/acme/core.git#abc",
        "https://pub.dev",
        "plain text",
        '{"url":"https://u:p@h/x"}',
        "https://a.example.com/x, https://b.example.com/y",
        3,
      ],
    );
    assert.strictEqual(result[2], properties[2]);
    assert.strictEqual(sanitizeUrlProperties(undefined), undefined);
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

describe("URL query parameters", () => {
  // Per ecosystem: a URL as it appears in a manifest, lock file or package
  // metadata, and the URL a BOM keeps. A parameter that names what the URL
  // points at stays; one that signs or authenticates it, or that is not known
  // to be harmless, goes.
  const cases = [
    {
      ecosystem: "NuGet v3 feed (Azure Artifacts)",
      input:
        "https://pkgs.dev.azure.com/org/proj/_packaging/feed/nuget/v3/index.json?api-version=7.1-preview.1",
      kept: "https://pkgs.dev.azure.com/org/proj/_packaging/feed/nuget/v3/index.json?api-version=7.1-preview.1",
    },
    {
      ecosystem: "NuGet gallery package page",
      input:
        "https://www.nuget.org/packages/Newtonsoft.Json/13.0.3?_src=template",
      kept: "https://www.nuget.org/packages/Newtonsoft.Json/13.0.3?_src=template",
    },
    {
      ecosystem: "NuGet license link (nuspec licenseUrl)",
      input: "https://go.microsoft.com/fwlink/?LinkId=329770",
      kept: "https://go.microsoft.com/fwlink/?LinkId=329770",
    },
    {
      ecosystem: "NuGet search service",
      input:
        "https://azuresearch-usnc.nuget.org/query?q=Foo&prerelease=true&semVerLevel=2.0.0&take=20&skip=0&packageType=dotnettool&ApiKey=Qm7secretKey",
      kept: "https://azuresearch-usnc.nuget.org/query",
    },
    {
      ecosystem: "NuGet registration with a token beside a kept parameter",
      input:
        "https://api.nuget.org/v3/registration5-gz-semver2/foo/index.json?semVerLevel=2.0.0&token=Zq7tokenRw2",
      kept: "https://api.nuget.org/v3/registration5-gz-semver2/foo/index.json",
    },
    {
      ecosystem: "NuGet package on an Azure Artifacts feed with credentials",
      input:
        "https://build:Vb8nexusQz41mX@pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/flatcontainer/foo/1.0.0/foo.1.0.0.nupkg?api-version=7.1",
      kept: "https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/flatcontainer/foo/1.0.0/foo.1.0.0.nupkg?api-version=7.1",
    },
    {
      ecosystem: "Go module proxy and vanity import path",
      input: "https://golang.example.org/x/tools?go-get=1",
      kept: "https://golang.example.org/x/tools?go-get=1",
    },
    {
      ecosystem: "uv or Terraform git source",
      input:
        "git+https://github.com/acme/lib.git?rev=0a1b2c3d&subdirectory=pkg",
      kept: "git+https://github.com/acme/lib.git?rev=0a1b2c3d&subdirectory=pkg",
    },
    {
      ecosystem: "Terraform git source with an SSH key parameter",
      input: "git::https://github.com/acme/mod.git?ref=v1.2.0&sshkey=Zm9vYmFy",
      kept: "git::https://github.com/acme/mod.git",
    },
    {
      ecosystem: "pip VCS requirement",
      input: "git+https://github.com/acme/lib.git#egg=lib&subdirectory=src",
      kept: "git+https://github.com/acme/lib.git#egg=lib&subdirectory=src",
    },
    {
      ecosystem: "PyPI file with a digest",
      input:
        "https://files.pythonhosted.org/packages/x/lib-1.0.whl#sha256=0a1b2c3d4e5f",
      kept: "https://files.pythonhosted.org/packages/x/lib-1.0.whl#sha256=0a1b2c3d4e5f",
    },
    {
      ecosystem: "Visual Studio Marketplace item",
      input: "https://marketplace.visualstudio.com/items?itemName=acme.tool",
      kept: "https://marketplace.visualstudio.com/items?itemName=acme.tool",
    },
    {
      ecosystem: "Azure DevOps repository path",
      input:
        "https://dev.azure.com/org/proj/_git/repo?path=%2Fsrc&version=GBmain&_a=contents",
      kept: "https://dev.azure.com/org/proj/_git/repo?path=%2Fsrc&version=GBmain&_a=contents",
    },
    {
      ecosystem: "Maven repository with an unknown parameter",
      input: "https://repo.example.com/maven2/?mirror=eu&version=1",
      kept: "https://repo.example.com/maven2/?version=1",
    },
    {
      ecosystem: "Docker or OCI registry with a token",
      input:
        "https://registry.example.com/v2/acme/app/manifests/1.0?ns=docker.io&access_token=Hn4tokenBx9",
      kept: "https://registry.example.com/v2/acme/app/manifests/1.0",
    },
  ];

  for (const { ecosystem, input, kept } of cases) {
    it(`keeps what names the target for ${ecosystem}`, () => {
      assert.strictEqual(sanitizeBomReferenceUrl(input), kept);
      assert.strictEqual(sanitizeBomUrl(input), kept.split("#")[0]);
      assert.strictEqual(
        sanitizeBomText(`see ${input}.`),
        `see ${kept.split("#")[0]}.`,
      );
      assert.deepStrictEqual(
        sanitizeUrlProperties([{ name: "cdx:test:url", value: input }]),
        [{ name: "cdx:test:url", value: kept }],
      );
    });
  }

  const signed = [
    {
      kind: "S3 presigned URL",
      input:
        "https://bucket.s3.amazonaws.com/pkg/lib-1.0.tgz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260101T000000Z&X-Amz-Expires=300&X-Amz-Signature=0a1b2c3d&api-version=1",
    },
    {
      kind: "GCS signed URL",
      input:
        "https://storage.googleapis.com/bucket/lib.tgz?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=0a1b2c3d&ref=main",
    },
    {
      kind: "GCS V2 signed URL",
      input:
        "https://storage.googleapis.com/bucket/lib.tgz?GoogleAccessId=svc%40proj.iam&Expires=1767225600&Signature=Qm7sig%2B&version=1",
    },
    {
      kind: "Azure SAS URL",
      input:
        "https://acct.blob.core.windows.net/pkgs/foo.1.0.nupkg?sv=2022-11-02&ss=b&srt=o&sp=r&se=2026-12-31T00%3A00%3A00Z&sig=Ht5portalLw93cN%3D&api-version=2022-11-02",
    },
    {
      kind: "Azure SAS URL with only the key fields",
      input:
        "https://acct.blob.core.windows.net/pkgs/foo.nupkg?sv=2022-11-02&se=2026-12-31&sp=r&sr=b",
    },
    {
      kind: "CloudFront signed URL",
      input:
        "https://d111.cloudfront.net/lib.tgz?Policy=eyJTdGF0ZW1lbnQ&Signature=Qm7sig&Key-Pair-Id=APKAEXAMPLE&ref=main",
    },
    {
      kind: "Alibaba OSS signed URL",
      input:
        "https://b.oss-cn-hangzhou.aliyuncs.com/lib.tgz?OSSAccessKeyId=LTAIEXAMPLE&Expires=1767225600&Signature=Qm7sig",
    },
    {
      kind: "URL with an API key and a password",
      input:
        "https://feed.example.com/index.json?api-version=1&apikey=Qm7secret",
    },
    {
      kind: "URL with a JWT in a kept parameter",
      input:
        "https://feed.example.com/index.json?ref=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rwW0",
    },
  ];

  for (const { kind, input } of signed) {
    it(`removes the whole query of a ${kind}`, () => {
      const pathOnly = input.split("?")[0];
      assert.strictEqual(sanitizeBomReferenceUrl(input), pathOnly);
      assert.strictEqual(sanitizeBomUrl(input), pathOnly);
      assert.strictEqual(sanitizeBomText(input), pathOnly);
      assert.strictEqual(
        sanitizeUrlProperties([{ name: "cdx:test:url", value: input }])[0]
          .value,
        pathOnly,
      );
    });
  }

  it("sanitizeUrlQuery() keeps the order and spelling of what stays", () => {
    assert.strictEqual(
      sanitizeUrlQuery("take=5&mirror=1&Q=a%20b&skip=0"),
      "take=5&Q=a%20b&skip=0",
    );
    assert.strictEqual(sanitizeUrlQuery(""), "");
    assert.strictEqual(sanitizeUrlQuery("ref"), "");
    assert.strictEqual(sanitizeUrlQuery("ref=a;b"), "");
    assert.strictEqual(sanitizeUrlQuery("ref=a b"), "");
    assert.strictEqual(sanitizeUrlQuery(`ref=${"a".repeat(300)}`), "");
    assert.strictEqual(sanitizeUrlQuery("%73ig=x&ref=main"), "");
  });

  it("drops a query that holds a token shape under a kept name", () => {
    assert.strictEqual(
      sanitizeBomReferenceUrl(
        "https://git.example.com/acme/lib.git?ref=ghp_abcdefghijklmnopqrstuvwxyz0123",
      ),
      "https://git.example.com/acme/lib.git",
    );
  });

  it("still removes user-info next to a kept query", () => {
    assert.strictEqual(
      sanitizeBomUrl("https://u:p@host.example/feed?api-version=1"),
      "https://host.example/feed?api-version=1",
    );
    assert.strictEqual(
      sanitizeBomText("jdbc:postgresql://u:p@db/app?ref=main&password=x"),
      "jdbc:postgresql://db/app",
    );
  });
});

describe("structured value key names", () => {
  const redactedKeys = (names) =>
    sanitizeBomPropertyValue(
      "cdx:skill:metadata",
      Object.fromEntries(names.map((name) => [name, "value-1234"])),
    );

  it("redacts credential names that end in key", () => {
    const names = [
      "key",
      "keys",
      "api_key",
      "apiKey",
      "APIKey",
      "accessKey",
      "private-key",
      "signing.key",
      "AWS_SECRET_ACCESS_KEY",
      "ssh_keys",
      "deployKey",
      "licensekey",
    ];
    const parsed = JSON.parse(redactedKeys(names));
    for (const name of names) {
      assert.strictEqual(parsed[name], "[redacted]", name);
    }
  });

  it("keeps names that only contain the word key", () => {
    const names = [
      "sort_key",
      "primary_key",
      "cache_key",
      "projectKey",
      "sonar.projectKey",
      "monkey",
      "keyboard",
    ];
    const parsed = JSON.parse(redactedKeys(names));
    for (const name of names) {
      assert.strictEqual(parsed[name], "value-1234", name);
    }
  });

  it("keeps redacting the other credential endings", () => {
    const names = [
      "db_creds",
      "bypass",
      "password",
      "client_secret",
      "authToken",
    ];
    const parsed = JSON.parse(redactedKeys(names));
    for (const name of names) {
      assert.strictEqual(parsed[name], "[redacted]", name);
    }
  });
});

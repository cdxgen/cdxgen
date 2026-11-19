import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strict as assert, describe, test } from "poku";

import {
  defaultCaCertificates,
  isBlockedNpmrcKey,
  npmOperatorConfigEnv,
  npmrcKeyCandidates,
  operatorNpmrcKeys,
  parseNpmrc,
  parseNpmrcFromEnv,
} from "./npmrc.js";

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: Test data
const VALID_NPMRC_CASES = [
  {
    name: "basic key=value",
    input: "registry = https://registry.npmjs.org/",
    expected: { registry: "https://registry.npmjs.org/" },
  },
  {
    name: "key=value without spaces",
    input: "cache=/tmp/npm-cache",
    expected: { cache: "/tmp/npm-cache" },
  },
  {
    name: "value containing equals sign",
    input: "init-author-name=John=Doe",
    expected: { "init-author-name": "John=Doe" },
  },
  {
    name: "hash comment",
    input: "# this is a comment\nregistry=https://example.com",
    expected: { registry: "https://example.com" },
  },
  {
    name: "semicolon comment",
    input: "; another comment\nproxy=http://proxy.local",
    expected: { proxy: "http://proxy.local" },
  },
  {
    name: "inline comment (treated as value)",
    input: "registry=https://example.com # comment",
    expected: { registry: "https://example.com # comment" },
  },
  {
    name: "double-quoted value",
    input: 'description = "A package with spaces"',
    expected: { description: "A package with spaces" },
  },
  {
    name: "single-quoted value",
    input: "description = 'Single quoted'",
    expected: { description: "Single quoted" },
  },
  {
    name: "quoted value with inner quotes",
    input: 'note = "He said \\"hello\\""',
    expected: { note: 'He said \\"hello\\"' },
  },
  {
    name: "array values with []",
    input: "proxy[] = http://proxy1.local\nproxy[] = http://proxy2.local",
    expected: { proxy: ["http://proxy1.local", "http://proxy2.local"] },
  },
  {
    name: "single array value",
    input: "registry[] = https://registry.example.com",
    expected: { registry: ["https://registry.example.com"] },
  },
  {
    name: "scoped registry",
    input: "@myscope:registry = https://custom.example.com",
    expected: { "@myscope:registry": "https://custom.example.com" },
  },
  {
    name: "URI-fragment auth config",
    input: "//registry.npmjs.org/:_authToken = abc123xyz",
    expected: { "//registry.npmjs.org/:_authToken": "abc123xyz" },
  },
  {
    name: "scoped auth with quoted token",
    input: '//registry.example.com/:_authToken = "secret-token"',
    expected: { "//registry.example.com/:_authToken": "secret-token" },
  },
  {
    name: "extra whitespace around =",
    input: "  key   =   value  ",
    expected: { key: "value" },
  },
  {
    name: "empty lines and mixed whitespace",
    input: "\n\nregistry=https://example.com\n\n  \nproxy=http://local\n",
    expected: {
      registry: "https://example.com",
      proxy: "http://local",
    },
  },
  {
    name: "env var substitution syntax",
    input: "cache = ${HOME}/.npm-cache",
    expected: { cache: "${HOME}/.npm-cache" },
  },
  {
    name: "env var with default",
    input: 'prefix = "${NPM_PREFIX:-/usr/local}"',
    expected: { prefix: "${NPM_PREFIX:-/usr/local}" },
  },
  {
    name: "unicode in value",
    input: "description = 日本語パッケージ",
    expected: { description: "日本語パッケージ" },
  },
  {
    name: "emoji in value",
    input: 'note = "Test 🚀 emoji"',
    expected: { note: "Test 🚀 emoji" },
  },
  {
    name: "unicode key (unusual but valid)",
    input: "キー = 値",
    expected: { キー: "値" },
  },
  {
    name: "mixed unicode and ascii",
    input: "registry = https://例え.jp/npm",
    expected: { registry: "https://例え.jp/npm" },
  },
  {
    name: "path with special chars",
    input: "prefix = /usr/local/bin:$HOME/bin",
    expected: { prefix: "/usr/local/bin:$HOME/bin" },
  },
  {
    name: "url with query params",
    input: "registry = https://example.com/npm?token=abc&scope=private",
    expected: { registry: "https://example.com/npm?token=abc&scope=private" },
  },
];

const MALICIOUS_NPMRC_CASES = [
  {
    name: "command injection via git config",
    input: "git = ./pwn.sh\nregistry=https://registry.npmjs.org/",
    expected: { git: "./pwn.sh", registry: "https://registry.npmjs.org/" },
    note: "Parser returns raw value; filtering happens elsewhere",
  },
  {
    name: "script-shell injection",
    input: "script-shell = /bin/bash -c 'malicious'",
    expected: { "script-shell": "/bin/bash -c 'malicious'" },
  },
  {
    name: "path traversal in value",
    input: "cache = ../../../etc/passwd",
    expected: { cache: "../../../etc/passwd" },
  },
  {
    name: "null byte injection attempt",
    input: "key = value\u0000injection",
    expected: { key: "value\u0000injection" },
  },
  {
    name: "newline injection in value",
    input: "key = value\ninjected = true",
    expected: { key: "value", injected: "true" },
  },
  {
    name: "very long value (potential DoS)",
    input: `longkey = ${"a".repeat(100000)}`,
    expected: { longkey: "a".repeat(100000) },
  },
  {
    name: "many repeated keys",
    input: Array(1000).fill("duplicate = value").join("\n"),
    expected: { duplicate: "value" },
  },
  {
    name: "proxy with credentials",
    input: "proxy = http://user:pass@evil.com:8080",
    expected: { proxy: "http://user:pass@evil.com:8080" },
  },
  {
    name: "cafile pointing to malicious cert",
    input: "cafile = /tmp/evil-cert.pem",
    expected: { cafile: "/tmp/evil-cert.pem" },
  },
  {
    name: "node-options with code execution flags",
    input: 'node-options = "--eval "require("child_process").execSync("id")""',
    expected: {
      "node-options": '--eval "require("child_process").execSync("id")"',
    },
  },
];

const EDGE_CASE_NPMRC = [
  {
    name: "empty input",
    input: "",
    expected: {},
  },
  {
    name: "only comments",
    input: "# comment\n; another\n  \n",
    expected: {},
  },
  {
    name: "line without equals sign",
    input: "invalid-line\nregistry=https://example.com",
    expected: { registry: "https://example.com" },
  },
  {
    name: "key without value",
    input: "emptykey =\nvalid = value",
    expected: { emptykey: "", valid: "value" },
  },
  {
    name: "value without key (should skip)",
    input: "=novalue\nregistry=https://example.com",
    expected: { registry: "https://example.com" },
  },
  {
    name: "multiple equals in line",
    input: "a=b=c=d",
    expected: { a: "b=c=d" },
  },
  {
    name: "tabs as whitespace",
    input: "key\t=\tvalue",
    expected: { key: "value" },
  },
  {
    name: "mixed line endings",
    input: "win=1\r\nunix=2\rmac=3",
    expected: { win: "1", unix: "2", mac: "3" },
  },
  {
    name: "unmatched quotes (treated as literal)",
    input: 'broken = "unclosed quote',
    expected: { broken: '"unclosed quote' },
  },
  {
    name: "array with mixed quoted/unquoted",
    input: 'items[] = "quoted"\nitems[] = unquoted',
    expected: { items: ["quoted", "unquoted"] },
  },
];

const REDOS_RESILIENCE_TESTS = [
  {
    name: "very long key name",
    input: `${"a".repeat(50000)} = value`,
  },
  {
    name: "many array entries",
    input: Array(10000).fill("list[] = item").join("\n"),
  },
  {
    name: "repeated = characters",
    input: `key = ${"=".repeat(50000)}`,
  },
  {
    name: "deeply nested looking scoped key",
    input: `${"/".repeat(1000)}registry.example.com${"/".repeat(1000)}:token = abc`,
  },
  {
    name: "alternating comment/value lines",
    input: Array(5000).fill("# comment\nkey=value").join("\n"),
  },
];

describe("operator proxy and TLS keys", () => {
  const OPERATOR = ["proxy", "https-proxy", "cafile", "ca", "strict-ssl"];
  const SPELLINGS = (name) => [
    name,
    `"${name}"`,
    `'${name}'`,
    `${name} ;x`,
    `${name} #x`,
    name.replace("-", "\\-"),
    `${name.slice(0, 1)}\${CDXGEN_UNSET_NPMRC_TEST_VAR?}${name.slice(1)}`,
  ];

  test("operatorNpmrcKeys() names the setting under every spelling", () => {
    for (const name of OPERATOR) {
      for (const spelling of SPELLINGS(name)) {
        assert.deepStrictEqual(operatorNpmrcKeys(spelling), [name], spelling);
      }
    }
    assert.deepStrictEqual(operatorNpmrcKeys("registry"), []);
    assert.deepStrictEqual(operatorNpmrcKeys("script-shell"), []);
  });

  test("isBlockedNpmrcKey() blocks them unless the caller replaces them", () => {
    for (const name of OPERATOR) {
      for (const spelling of SPELLINGS(name)) {
        assert.strictEqual(isBlockedNpmrcKey(spelling), true, spelling);
        assert.strictEqual(
          isBlockedNpmrcKey(spelling, { operatorKeysReplaced: true }),
          false,
          spelling,
        );
      }
      for (const prefixed of [`//host.example/:${name}`, `@scope:${name}`]) {
        assert.strictEqual(
          isBlockedNpmrcKey(prefixed, { operatorKeysReplaced: true }),
          true,
          prefixed,
        );
      }
    }
    for (const name of ["script-shell", "global", "prefix", "node-options"]) {
      assert.strictEqual(
        isBlockedNpmrcKey(name, { operatorKeysReplaced: true }),
        true,
        name,
      );
    }
  });

  test("npmOperatorConfigEnv() falls back to the npm defaults", () => {
    const env = npmOperatorConfigEnv(OPERATOR, {
      env: {},
      nullDevice: "NULLDEV",
      defaultCaFile: () => "DEFAULTCA",
    });
    assert.deepStrictEqual(env, {
      npm_config_proxy: "null",
      npm_config_https_proxy: "null",
      npm_config_strict_ssl: "true",
      npm_config_cafile: "DEFAULTCA",
    });
  });

  test("npmOperatorConfigEnv() only touches the settings the project names", () => {
    assert.deepStrictEqual(
      npmOperatorConfigEnv(["proxy"], { env: {}, nullDevice: "NULLDEV" }),
      { npm_config_proxy: "null" },
    );
    assert.deepStrictEqual(npmOperatorConfigEnv([], { env: {} }), {});
  });

  test("npmOperatorConfigEnv() uses the user .npmrc of the operator", () => {
    const env = npmOperatorConfigEnv(OPERATOR, {
      env: {},
      userConfig: {
        proxy: "http://corp-proxy.example:3128",
        "strict-ssl": "false",
        cafile: "/etc/corp/ca.pem",
        ca: ["A", "B"],
      },
      nullDevice: "NULLDEV",
      defaultCaFile: () => "DEFAULTCA",
    });
    assert.deepStrictEqual(env, {
      npm_config_proxy: "http://corp-proxy.example:3128",
      npm_config_https_proxy: "null",
      npm_config_strict_ssl: "false",
      npm_config_ca: "A\n\nB",
      npm_config_cafile: "/etc/corp/ca.pem",
    });
  });

  test("npmOperatorConfigEnv() keeps variables the operator exports", () => {
    const env = npmOperatorConfigEnv(OPERATOR, {
      env: {
        NPM_CONFIG_PROXY: "http://env-proxy.example",
        npm_config_https_proxy: "http://env-proxy.example",
        npm_config_strict_ssl: "false",
        npm_config_cafile: "/env/ca.pem",
      },
      userConfig: { proxy: "http://user.example" },
      nullDevice: "NULLDEV",
      defaultCaFile: () => "DEFAULTCA",
    });
    assert.deepStrictEqual(env, {});
  });

  test("npmOperatorConfigEnv() lets an operator ca win over a project cafile", () => {
    const env = npmOperatorConfigEnv(["cafile"], {
      env: { npm_config_ca: "CA" },
      nullDevice: "NULLDEV",
      defaultCaFile: () => "DEFAULTCA",
    });
    assert.deepStrictEqual(env, { npm_config_cafile: "NULLDEV" });
  });

  test("npmOperatorConfigEnv() ignores an empty operator variable", () => {
    const env = npmOperatorConfigEnv(["proxy"], {
      env: { npm_config_proxy: "" },
    });
    assert.deepStrictEqual(env, { npm_config_proxy: "null" });
  });
});

describe("defaultCaCertificates()", () => {
  test("uses the default store, and the system store when enabled", () => {
    const calls = [];
    const tlsModule = {
      getCACertificates: (type) => {
        calls.push(type);
        return type === "system" ? ["SYS", "A"] : ["A", "EXTRA"];
      },
    };
    assert.deepStrictEqual(defaultCaCertificates({ env: {}, tlsModule }), [
      "A",
      "EXTRA",
    ]);
    assert.deepStrictEqual(calls, ["default"]);
    for (const env of [
      { NODE_OPTIONS: "--max-old-space-size=1 --use-system-ca" },
      { NODE_USE_SYSTEM_CA: "1" },
    ]) {
      assert.deepStrictEqual(defaultCaCertificates({ env, tlsModule }), [
        "A",
        "EXTRA",
        "SYS",
      ]);
    }
  });

  test("falls back to the bundled roots and NODE_EXTRA_CA_CERTS", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-extra-ca-"));
    try {
      const file = join(dir, "extra.pem");
      writeFileSync(
        file,
        "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n",
      );
      const certificates = defaultCaCertificates({
        env: { NODE_EXTRA_CA_CERTS: file },
        tlsModule: { rootCertificates: ["ROOT"] },
      });
      assert.strictEqual(certificates[0], "ROOT");
      assert.ok(certificates[1].includes("QUJD"));
      assert.strictEqual(certificates.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: Test data

describe("npmrc Parser - Valid Cases", () => {
  for (const tc of VALID_NPMRC_CASES) {
    test(`should parse: ${tc.name}`, () => {
      const result = parseNpmrc(tc.input);
      assert.deepStrictEqual(result, tc.expected, `Failed for: ${tc.name}`);
    });
  }
});

describe("npmrc Parser - Malicious Inputs", () => {
  for (const tc of MALICIOUS_NPMRC_CASES) {
    test(`should safely parse (no crash): ${tc.name}`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = parseNpmrc(tc.input);
      }, `Parser threw on: ${tc.name}`);
      assert.deepStrictEqual(
        result,
        tc.expected,
        `Output mismatch for: ${tc.name}`,
      );
    });
  }
});

describe("npmrc Parser - Edge Cases", () => {
  for (const tc of EDGE_CASE_NPMRC) {
    test(`should handle: ${tc.name}`, () => {
      const result = parseNpmrc(tc.input);
      assert.deepStrictEqual(result, tc.expected, `Failed for: ${tc.name}`);
    });
  }
});

describe("npmrc Parser - ReDoS Resilience", () => {
  for (const tc of REDOS_RESILIENCE_TESTS) {
    test(`should handle quickly: ${tc.name}`, () => {
      const start = Date.now();
      let result;
      assert.doesNotThrow(() => {
        result = parseNpmrc(tc.input);
      });
      const duration = Date.now() - start;
      assert.ok(
        duration < 100,
        `Parsing took too long (${duration}ms): ${tc.name}`,
      );
      assert.ok(
        typeof result === "object" && result !== null,
        `Should return object for: ${tc.name}`,
      );
    });
  }
});

describe("npmrc Parser - Unicode Handling", () => {
  test("should preserve unicode characters", () => {
    const input = "desc = 测试🔐\nregistry = https://例え.日本/";
    const result = parseNpmrc(input);
    assert.strictEqual(result.desc, "测试🔐");
    assert.strictEqual(result.registry, "https://例え.日本/");
  });

  test("should handle unicode in keys", () => {
    const input = "キー🔑 = 値🔐";
    const result = parseNpmrc(input);
    assert.strictEqual(result["キー🔑"], "値🔐");
  });
});

describe("npmrc Parser - Security Separation", () => {
  test("parser does not filter - that's caller's responsibility", () => {
    const malicious = "git = ./pwn.sh\nregistry = https://safe.com";
    const result = parseNpmrc(malicious);
    assert.strictEqual(result.git, "./pwn.sh");
    assert.strictEqual(result.registry, "https://safe.com");
    const DANGEROUS = new Set(["git", "script-shell"]);
    const safe = Object.fromEntries(
      Object.entries(result).filter(([key]) => !DANGEROUS.has(key)),
    );
    assert.strictEqual(safe.git, undefined);
    assert.strictEqual(safe.registry, "https://safe.com");
  });
});

const VALID_ENV_CASES = [
  {
    name: "basic npm_config_ prefix",
    env: { npm_config_registry: "https://example.com" },
    expected: { registry: "https://example.com" },
  },
  {
    name: "case-insensitive prefix",
    env: { NPM_CONFIG_PROXY: "http://proxy.local" },
    expected: { proxy: "http://proxy.local" },
  },
  {
    name: "dash-to-underscore conversion (user provides underscore)",
    env: { npm_config_allow_same_version: "true" },
    expected: { allow_same_version: "true" },
  },
  {
    name: "scoped registry auth preserves URL case",
    env: { "npm_config_//registry.example.com/:_authToken": "secret123" },
    expected: { "//registry.example.com/:_authToken": "secret123" },
  },
  {
    name: "scoped package registry preserves scope case",
    env: { "NPM_CONFIG_@MyScope:registry": "https://custom.example.com" },
    expected: { "@MyScope:registry": "https://custom.example.com" },
  },
  {
    name: "simple keys are lowercased regardless of env var case",
    env: { NPM_CONFIG_REGISTRY: "https://example.com" },
    expected: { registry: "https://example.com" },
  },
  {
    name: "mixed: simple + scoped keys",
    env: {
      NPM_CONFIG_REGISTRY: "https://public.com",
      "npm_config_//private.example.com/:_authToken": "token123",
    },
    expected: {
      registry: "https://public.com",
      "//private.example.com/:_authToken": "token123",
    },
  },
  {
    name: "boolean flag with empty value → true",
    env: { npm_config_foo: "" },
    expected: { foo: "true" },
  },
  {
    name: "boolean flag with undefined value → true",
    env: { npm_config_bar: undefined },
    expected: { bar: "true" },
  },
  {
    name: "multiple config vars",
    env: {
      npm_config_registry: "https://a.com",
      npm_config_proxy: "http://b.com",
      npm_config_cache: "/tmp/cache",
    },
    expected: {
      registry: "https://a.com",
      proxy: "http://b.com",
      cache: "/tmp/cache",
    },
  },
  {
    name: "unicode values preserved",
    env: { npm_config_description: "测试🔐" },
    expected: { description: "测试🔐" },
  },
  {
    name: "basic pnpm_config_ prefix",
    env: { pnpm_config_registry: "https://pnpm-registry.example.com" },
    expected: { registry: "https://pnpm-registry.example.com" },
  },
  {
    name: "case-insensitive PNPM_CONFIG_ prefix",
    env: { PNPM_CONFIG_PROXY: "http://proxy.local" },
    expected: { proxy: "http://proxy.local" },
  },
  {
    name: "pnpm_config_ simple key lowercased",
    env: { PNPM_CONFIG_STORE_DIR: "/custom/store" },
    expected: { store_dir: "/custom/store" },
  },
  {
    name: "pnpm_config_ boolean flag with empty value → true",
    env: { pnpm_config_shamefully_hoist: "" },
    expected: { shamefully_hoist: "true" },
  },
  {
    name: "pnpm_config_ overrides npm_config_ for same key",
    env: {
      npm_config_registry: "https://npm-registry.com",
      pnpm_config_registry: "https://pnpm-registry.com",
    },
    expected: { registry: "https://pnpm-registry.com" },
  },
  {
    name: "pnpm_config_ and npm_config_ for different keys are both included",
    env: {
      npm_config_cache: "/npm-cache",
      pnpm_config_store_dir: "/pnpm-store",
    },
    expected: { cache: "/npm-cache", store_dir: "/pnpm-store" },
  },
  {
    name: "empty config key after pnpm_config_ prefix ignored",
    env: { pnpm_config_: "value" },
    expected: {},
  },
];

const EDGE_ENV_CASES = [
  {
    name: "empty env object",
    env: {},
    expected: {},
  },
  {
    name: "non-npm env vars ignored",
    env: { PATH: "/usr/bin", HOME: "/home/user", npm_config_foo: "bar" },
    expected: { foo: "bar" },
  },
  {
    name: "prefix substring not matched",
    env: { my_npm_config_foo: "bar" },
    expected: {},
  },
  {
    name: "empty config key after prefix",
    env: { npm_config_: "value" },
    expected: {},
  },
  {
    name: "value with special chars preserved",
    env: { npm_config_prefix: "/path:with:colons$VAR" },
    expected: { prefix: "/path:with:colons$VAR" },
  },
];

describe("parseNpmrcFromEnv - Valid Cases", () => {
  for (const tc of VALID_ENV_CASES) {
    test(`should parse: ${tc.name}`, () => {
      const result = parseNpmrcFromEnv(tc.env);
      assert.deepStrictEqual(result, tc.expected, `Failed for: ${tc.name}`);
    });
  }
});

describe("parseNpmrcFromEnv - Edge Cases", () => {
  for (const tc of EDGE_ENV_CASES) {
    test(`should handle: ${tc.name}`, () => {
      const result = parseNpmrcFromEnv(tc.env);
      assert.deepStrictEqual(result, tc.expected, `Failed for: ${tc.name}`);
    });
  }
});

describe("parseNpmrcFromEnv - Security", () => {
  test("parser returns raw values - filtering is caller's responsibility", () => {
    const maliciousEnv = {
      npm_config_git: "./pwn.sh",
      npm_config_registry: "https://safe.com",
    };
    const result = parseNpmrcFromEnv(maliciousEnv);
    assert.strictEqual(result.git, "./pwn.sh");
    assert.strictEqual(result.registry, "https://safe.com");
    const DANGEROUS = new Set(["git", "script-shell", "shell"]);
    const safe = Object.fromEntries(
      Object.entries(result).filter(([key]) => !DANGEROUS.has(key)),
    );
    assert.strictEqual(safe.git, undefined);
    assert.strictEqual(safe.registry, "https://safe.com");
  });
});

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: Test data
describe("isBlockedNpmrcKey()", () => {
  test("blocks the keys npm applies under every spelling it accepts", () => {
    const spellings = [
      "node-options",
      '"node-options"',
      "'node-options'",
      '"node-\\u006fptions"',
      "node-options ;x",
      "node-options #x",
      "node-opt${CDXGEN_UNSET_NPMRC_TEST_VAR?}ions",
      "node\\-options",
      "@scope:node-options",
      "global",
      "prefix",
      "https-proxy",
      "strict-ssl",
      "cafile",
    ];
    for (const spelling of spellings) {
      assert.strictEqual(isBlockedNpmrcKey(spelling), true, spelling);
    }
  });

  test("keeps ordinary keys, including ones that expand variables", () => {
    for (const key of [
      "registry",
      "//${NPM_HOST}/:_authToken",
      "@scope:registry",
      "fund",
      '"always-auth"',
    ]) {
      assert.strictEqual(isBlockedNpmrcKey(key), false, key);
    }
  });

  test("expands a variable from the given environment", () => {
    assert.ok(
      npmrcKeyCandidates("node-${PART}", { PART: "options" }).includes(
        "node-options",
      ),
    );
  });
});

describe("operator proxy and TLS keys", () => {
  const OPERATOR = ["proxy", "https-proxy", "cafile", "ca", "strict-ssl"];
  const SPELLINGS = (name) => [
    name,
    `"${name}"`,
    `'${name}'`,
    `${name} ;x`,
    `${name} #x`,
    name.replace("-", "\\-"),
    `${name.slice(0, 1)}\${CDXGEN_UNSET_NPMRC_TEST_VAR?}${name.slice(1)}`,
  ];

  test("operatorNpmrcKeys() names the setting under every spelling", () => {
    for (const name of OPERATOR) {
      for (const spelling of SPELLINGS(name)) {
        assert.deepStrictEqual(operatorNpmrcKeys(spelling), [name], spelling);
      }
    }
    assert.deepStrictEqual(operatorNpmrcKeys("registry"), []);
    assert.deepStrictEqual(operatorNpmrcKeys("script-shell"), []);
  });

  test("isBlockedNpmrcKey() blocks them unless the caller replaces them", () => {
    for (const name of OPERATOR) {
      for (const spelling of SPELLINGS(name)) {
        assert.strictEqual(isBlockedNpmrcKey(spelling), true, spelling);
        assert.strictEqual(
          isBlockedNpmrcKey(spelling, { operatorKeysReplaced: true }),
          false,
          spelling,
        );
      }
      for (const prefixed of [`//host.example/:${name}`, `@scope:${name}`]) {
        assert.strictEqual(
          isBlockedNpmrcKey(prefixed, { operatorKeysReplaced: true }),
          true,
          prefixed,
        );
      }
    }
    for (const name of ["script-shell", "global", "prefix", "node-options"]) {
      assert.strictEqual(
        isBlockedNpmrcKey(name, { operatorKeysReplaced: true }),
        true,
        name,
      );
    }
  });

  test("npmOperatorConfigEnv() falls back to the npm defaults", () => {
    const env = npmOperatorConfigEnv(OPERATOR, {
      env: {},
      nullDevice: "NULLDEV",
      defaultCaFile: () => "DEFAULTCA",
    });
    assert.deepStrictEqual(env, {
      npm_config_proxy: "null",
      npm_config_https_proxy: "null",
      npm_config_strict_ssl: "true",
      npm_config_cafile: "DEFAULTCA",
    });
  });

  test("npmOperatorConfigEnv() only touches the settings the project names", () => {
    assert.deepStrictEqual(
      npmOperatorConfigEnv(["proxy"], { env: {}, nullDevice: "NULLDEV" }),
      { npm_config_proxy: "null" },
    );
    assert.deepStrictEqual(npmOperatorConfigEnv([], { env: {} }), {});
  });

  test("npmOperatorConfigEnv() uses the user .npmrc of the operator", () => {
    const env = npmOperatorConfigEnv(OPERATOR, {
      env: {},
      userConfig: {
        proxy: "http://corp-proxy.example:3128",
        "strict-ssl": "false",
        cafile: "/etc/corp/ca.pem",
        ca: ["A", "B"],
      },
      nullDevice: "NULLDEV",
      defaultCaFile: () => "DEFAULTCA",
    });
    assert.deepStrictEqual(env, {
      npm_config_proxy: "http://corp-proxy.example:3128",
      npm_config_https_proxy: "null",
      npm_config_strict_ssl: "false",
      npm_config_ca: "A\n\nB",
      npm_config_cafile: "/etc/corp/ca.pem",
    });
  });

  test("npmOperatorConfigEnv() keeps variables the operator exports", () => {
    const env = npmOperatorConfigEnv(OPERATOR, {
      env: {
        NPM_CONFIG_PROXY: "http://env-proxy.example",
        npm_config_https_proxy: "http://env-proxy.example",
        npm_config_strict_ssl: "false",
        npm_config_cafile: "/env/ca.pem",
      },
      userConfig: { proxy: "http://user.example" },
      nullDevice: "NULLDEV",
      defaultCaFile: () => "DEFAULTCA",
    });
    assert.deepStrictEqual(env, {});
  });

  test("npmOperatorConfigEnv() lets an operator ca win over a project cafile", () => {
    const env = npmOperatorConfigEnv(["cafile"], {
      env: { npm_config_ca: "CA" },
      nullDevice: "NULLDEV",
      defaultCaFile: () => "DEFAULTCA",
    });
    assert.deepStrictEqual(env, { npm_config_cafile: "NULLDEV" });
  });

  test("npmOperatorConfigEnv() ignores an empty operator variable", () => {
    const env = npmOperatorConfigEnv(["proxy"], {
      env: { npm_config_proxy: "" },
    });
    assert.deepStrictEqual(env, { npm_config_proxy: "null" });
  });
});

describe("defaultCaCertificates()", () => {
  test("uses the default store, and the system store when enabled", () => {
    const calls = [];
    const tlsModule = {
      getCACertificates: (type) => {
        calls.push(type);
        return type === "system" ? ["SYS", "A"] : ["A", "EXTRA"];
      },
    };
    assert.deepStrictEqual(defaultCaCertificates({ env: {}, tlsModule }), [
      "A",
      "EXTRA",
    ]);
    assert.deepStrictEqual(calls, ["default"]);
    for (const env of [
      { NODE_OPTIONS: "--max-old-space-size=1 --use-system-ca" },
      { NODE_USE_SYSTEM_CA: "1" },
    ]) {
      assert.deepStrictEqual(defaultCaCertificates({ env, tlsModule }), [
        "A",
        "EXTRA",
        "SYS",
      ]);
    }
  });

  test("falls back to the bundled roots and NODE_EXTRA_CA_CERTS", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-extra-ca-"));
    try {
      const file = join(dir, "extra.pem");
      writeFileSync(
        file,
        "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n",
      );
      const certificates = defaultCaCertificates({
        env: { NODE_EXTRA_CA_CERTS: file },
        tlsModule: { rootCertificates: ["ROOT"] },
      });
      assert.strictEqual(certificates[0], "ROOT");
      assert.ok(certificates[1].includes("QUJD"));
      assert.strictEqual(certificates.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: Test data

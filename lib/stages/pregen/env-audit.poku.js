import { strict as assert } from "node:assert";

import { describe, test } from "poku";

import { auditEnvironment } from "./env-audit.js";

const NODE_OPTIONS_ATTACK_VECTORS = [
  {
    name: "--require flag",
    value: "--require ./evil.js",
    expectedMatch: true,
  },
  {
    name: "--require with uppercase",
    value: "--REQUIRE ./evil.js",
    expectedMatch: true,
  },
  {
    // -r alone is ambiguous and not matched to avoid false-positives from legitimate short opts
    name: "-r short flag (not matched)",
    value: "-r ./evil.js",
    expectedMatch: false,
  },
  {
    name: "--eval flag",
    value: "--eval \"console.log('pwned')\"",
    expectedMatch: true,
  },
  {
    name: "--eval with complex payload",
    value: "--eval \"require('child_process').execSync('id')\"",
    expectedMatch: true,
  },
  {
    // -e alone is not matched to avoid false-positives
    name: "-e short flag (not matched)",
    value: "-e \"console.log('test')\"",
    expectedMatch: false,
  },
  {
    name: "--import flag (Node 18+)",
    value: "--import ./malicious.mjs",
    expectedMatch: true,
  },
  {
    name: "--loader flag",
    value: "--loader ./hook-loader.js",
    expectedMatch: true,
  },
  {
    name: "--inspect flag",
    value: "--inspect=0.0.0.0:9229",
    expectedMatch: true,
  },
  {
    name: "--inspect-brk flag",
    value: "--inspect-brk=9229",
    expectedMatch: true,
  },
  {
    name: "--inspect with host",
    value: "--inspect 127.0.0.1:9229",
    expectedMatch: true,
  },
  {
    // --test runs the built-in test runner and is not an exploit vector
    name: "--test flag (safe, not matched)",
    value: "--test",
    expectedMatch: false,
  },
  {
    name: "safe memory flag",
    value: "--max-old-space-size=4096",
    expectedMatch: false,
  },
  {
    name: "safe GC flag",
    value: "--expose-gc",
    expectedMatch: false,
  },
  {
    name: "safe trace flag",
    value: "--trace-warnings",
    expectedMatch: false,
  },
  {
    name: "multiple flags with one malicious",
    value: "--max-old-space-size=4096 --require ./evil.js",
    expectedMatch: true,
  },
  {
    name: "empty string",
    value: "",
    expectedMatch: false,
  },
  {
    name: "whitespace only",
    value: "   ",
    expectedMatch: false,
  },
];

const DANGEROUS_ENV_VAR_CASES = [
  {
    name: "NODE_NO_WARNINGS set",
    env: { NODE_NO_WARNINGS: "1" },
    expectedWarnings: 1,
    expectedVar: "NODE_NO_WARNINGS",
  },
  {
    name: "NODE_PENDING_DEPRECATION set",
    env: { NODE_PENDING_DEPRECATION: "1" },
    expectedWarnings: 1,
    expectedVar: "NODE_PENDING_DEPRECATION",
  },
  {
    name: "UV_THREADPOOL_SIZE set",
    env: { UV_THREADPOOL_SIZE: "128" },
    expectedWarnings: 1,
    expectedVar: "UV_THREADPOOL_SIZE",
  },
  {
    name: "all dangerous vars set",
    env: {
      NODE_NO_WARNINGS: "1",
      NODE_PENDING_DEPRECATION: "1",
      UV_THREADPOOL_SIZE: "128",
    },
    expectedWarnings: 3,
    expectedVar: null,
  },
  {
    name: "no dangerous vars",
    env: { PATH: "/usr/bin", HOME: "/home/user" },
    expectedWarnings: 0,
    expectedVar: null,
  },
  {
    name: "dangerous var with empty value (falsy)",
    env: { NODE_NO_WARNINGS: "" },
    expectedWarnings: 0,
    expectedVar: null,
  },
];

const COMBINED_ATTACK_CASES = [
  {
    name: "NODE_OPTIONS attack + dangerous vars",
    env: {
      NODE_OPTIONS: "--require ./evil.js",
      NODE_NO_WARNINGS: "1",
      UV_THREADPOOL_SIZE: "128",
    },
    minWarnings: 3,
  },
  {
    name: "multiple NODE_OPTIONS patterns",
    env: {
      NODE_OPTIONS: '--require ./a.js --eval "code" --inspect',
    },
    minWarnings: 3,
  },
  {
    name: "clean environment",
    env: {},
    minWarnings: 0,
  },
];

describe("auditEnvironment - NODE_OPTIONS Detection", () => {
  for (const tc of NODE_OPTIONS_ATTACK_VECTORS) {
    test(`should detect ${tc.name}`, () => {
      const env = { NODE_OPTIONS: tc.value };
      const warnings = auditEnvironment(env);

      const hasSuspiciousWarning = warnings.some((w) =>
        w.message.includes("NODE_OPTIONS contains a code-execution flag"),
      );

      if (tc.expectedMatch) {
        assert.ok(
          hasSuspiciousWarning,
          `Expected warning for ${tc.name} but got: ${warnings.join(", ")}`,
        );
      } else {
        assert.ok(
          !hasSuspiciousWarning,
          `Unexpected warning for ${tc.name}: ${warnings.join(", ")}`,
        );
      }
    });
  }
});

describe("auditEnvironment - Dangerous Env Vars", () => {
  for (const tc of DANGEROUS_ENV_VAR_CASES) {
    test(`should handle ${tc.name}`, () => {
      const warnings = auditEnvironment(tc.env);

      assert.strictEqual(
        warnings.length,
        tc.expectedWarnings,
        `Expected ${tc.expectedWarnings} warnings, got ${warnings.length}: ${warnings.join(", ")}`,
      );

      if (tc.expectedVar) {
        assert.ok(
          warnings.some((w) => w.message.includes(tc.expectedVar)),
          `Expected warning about ${tc.expectedVar} but got: ${warnings.join(", ")}`,
        );
      }
    });
  }
});

describe("auditEnvironment - Combined Attacks", () => {
  for (const tc of COMBINED_ATTACK_CASES) {
    test(`should handle ${tc.name}`, () => {
      const warnings = auditEnvironment(tc.env);

      assert.ok(
        warnings.length >= tc.minWarnings,
        `Expected at least ${tc.minWarnings} warnings, got ${warnings.length}: ${warnings.join(", ")}`,
      );
    });
  }
});

describe("auditEnvironment - Edge Cases", () => {
  test("should handle undefined NODE_OPTIONS", () => {
    const warnings = auditEnvironment({});
    const hasSuspiciousWarning = warnings.some((w) =>
      w.message.includes("NODE_OPTIONS contains a code-execution flag"),
    );
    assert.ok(!hasSuspiciousWarning);
  });

  test("should handle null env (uses process.env)", () => {
    const warnings = auditEnvironment();
    assert.ok(Array.isArray(warnings));
  });

  test("should return empty array for completely clean env", () => {
    const warnings = auditEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "en_US.UTF-8",
    });
    assert.deepStrictEqual(warnings, []);
  });

  test("should detect all dangerous vars individually", () => {
    const warnings1 = auditEnvironment({ NODE_NO_WARNINGS: "1" });
    const warnings2 = auditEnvironment({ NODE_PENDING_DEPRECATION: "1" });
    const warnings3 = auditEnvironment({ UV_THREADPOOL_SIZE: "128" });

    assert.strictEqual(warnings1.length, 1);
    assert.strictEqual(warnings2.length, 1);
    assert.strictEqual(warnings3.length, 1);

    assert.ok(warnings1[0].message.includes("NODE_NO_WARNINGS"));
    assert.ok(warnings2[0].message.includes("NODE_PENDING_DEPRECATION"));
    assert.ok(warnings3[0].message.includes("UV_THREADPOOL_SIZE"));
  });

  test("should be case-sensitive for env var names", () => {
    const warnings = auditEnvironment({
      node_no_warnings: "1",
      Node_Options: "--require ./evil.js",
    });
    assert.strictEqual(warnings.length, 0);
  });
});

describe("auditEnvironment - Warning Message Format", () => {
  test("dangerous var warning should mention unsetting", () => {
    const warnings = auditEnvironment({ NODE_NO_WARNINGS: "1" });
    assert.ok(warnings[0].mitigation.includes("Unset"));
    assert.ok(warnings[0].mitigation.includes("NODE_NO_WARNINGS"));
  });

  test("NODE_OPTIONS warning should mention the pattern", () => {
    const warnings = auditEnvironment({ NODE_OPTIONS: "--require ./evil.js" });
    assert.ok(warnings[0].message.includes("NODE_OPTIONS"));
  });

  test("warnings should be human-readable strings", () => {
    const warnings = auditEnvironment({
      NODE_OPTIONS: "--eval test",
      NODE_NO_WARNINGS: "1",
    });
    for (const w of warnings) {
      assert.strictEqual(typeof w.message, "string");
      assert.ok(w.message.length > 0);
    }
  });
});

describe("auditEnvironment - NODE_TLS_REJECT_UNAUTHORIZED", () => {
  test("should flag when set to '0' (TLS disabled)", () => {
    const warnings = auditEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].severity, "critical");
    assert.ok(
      warnings[0].message.includes("TLS certificate verification is disabled"),
    );
  });

  test("should not flag when set to '1' (TLS enabled)", () => {
    const warnings = auditEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "1" });
    assert.strictEqual(warnings.length, 0);
  });

  test("should not flag when unset", () => {
    const warnings = auditEnvironment({});
    const hasTlsWarning = warnings.some(
      (w) => w.variable === "NODE_TLS_REJECT_UNAUTHORIZED",
    );
    assert.ok(!hasTlsWarning);
  });
});

describe("auditEnvironment - JVM Code Execution", () => {
  test("should flag -javaagent in JAVA_TOOL_OPTIONS", () => {
    const warnings = auditEnvironment({
      JAVA_TOOL_OPTIONS: "-javaagent:/evil/agent.jar",
    });
    assert.ok(warnings.some((w) => w.variable === "JAVA_TOOL_OPTIONS"));
    assert.ok(warnings.some((w) => w.type === "code-execution"));
  });

  test("should flag -javaagent in JDK_JAVA_OPTIONS", () => {
    const warnings = auditEnvironment({
      JDK_JAVA_OPTIONS: "-javaagent:/evil/agent.jar",
    });
    assert.ok(warnings.some((w) => w.variable === "JDK_JAVA_OPTIONS"));
    assert.ok(warnings.some((w) => w.type === "code-execution"));
  });

  test("should flag --add-opens in JAVA_TOOL_OPTIONS", () => {
    const warnings = auditEnvironment({
      JAVA_TOOL_OPTIONS: "--add-opens java.base/java.lang=ALL-UNNAMED",
    });
    assert.ok(warnings.some((w) => w.type === "code-execution"));
  });

  test("should not flag safe JVM options", () => {
    const warnings = auditEnvironment({
      JAVA_TOOL_OPTIONS: "-Xmx4g -Xms512m",
    });
    assert.ok(!warnings.some((w) => w.variable === "JAVA_TOOL_OPTIONS"));
  });

  test("should not flag empty JAVA_TOOL_OPTIONS", () => {
    const warnings = auditEnvironment({ JAVA_TOOL_OPTIONS: "" });
    assert.ok(!warnings.some((w) => w.variable === "JAVA_TOOL_OPTIONS"));
  });
});

describe("auditEnvironment - Proxy Interception", () => {
  test("should flag HTTP_PROXY when set", () => {
    const warnings = auditEnvironment({ HTTP_PROXY: "http://proxy:3128" });
    assert.ok(warnings.some((w) => w.type === "network-interception"));
    assert.ok(warnings.some((w) => w.variable === "HTTP_PROXY"));
  });

  test("should flag https_proxy (lowercase) when set", () => {
    const warnings = auditEnvironment({ https_proxy: "http://proxy:3128" });
    assert.ok(warnings.some((w) => w.type === "network-interception"));
  });

  test("should produce only one network-interception finding even if multiple proxy vars are set", () => {
    const warnings = auditEnvironment({
      HTTP_PROXY: "http://proxy:3128",
      HTTPS_PROXY: "http://proxy:3128",
    });
    assert.strictEqual(
      warnings.filter((w) => w.type === "network-interception").length,
      1,
    );
  });

  test("should not flag proxy vars when unset", () => {
    const warnings = auditEnvironment({ PATH: "/usr/bin" });
    assert.ok(!warnings.some((w) => w.type === "network-interception"));
  });
});

describe("auditEnvironment - Credential Exposure", () => {
  test("should flag GITHUB_TOKEN when set", () => {
    const warnings = auditEnvironment({ GITHUB_TOKEN: "ghp_test1234" });
    assert.ok(warnings.some((w) => w.variable === "GITHUB_TOKEN"));
    assert.ok(warnings.some((w) => w.type === "credential-exposure"));
  });

  test("should flag NPM_TOKEN when set", () => {
    const warnings = auditEnvironment({ NPM_TOKEN: "npm_secret" });
    assert.ok(warnings.some((w) => w.variable === "NPM_TOKEN"));
  });

  test("should not flag credential vars when unset", () => {
    const warnings = auditEnvironment({ PATH: "/usr/bin" });
    assert.ok(!warnings.some((w) => w.type === "credential-exposure"));
  });

  test("should not flag credential vars with empty value", () => {
    const warnings = auditEnvironment({ GITHUB_TOKEN: "" });
    assert.ok(!warnings.some((w) => w.variable === "GITHUB_TOKEN"));
  });
});

describe("auditEnvironment - Debug Mode Exposure", () => {
  test("should flag CDXGEN_DEBUG_MODE=verbose", () => {
    const warnings = auditEnvironment({ CDXGEN_DEBUG_MODE: "verbose" });
    assert.ok(warnings.some((w) => w.type === "debug-exposure"));
    assert.strictEqual(
      warnings.find((w) => w.type === "debug-exposure")?.severity,
      "low",
    );
  });

  test("should flag CDXGEN_DEBUG_MODE=debug", () => {
    const warnings = auditEnvironment({ CDXGEN_DEBUG_MODE: "debug" });
    assert.ok(warnings.some((w) => w.type === "debug-exposure"));
  });

  test("should flag SCAN_DEBUG_MODE=debug", () => {
    const warnings = auditEnvironment({ SCAN_DEBUG_MODE: "debug" });
    assert.ok(warnings.some((w) => w.type === "debug-exposure"));
  });

  test("should not flag when CDXGEN_DEBUG_MODE is not set", () => {
    const warnings = auditEnvironment({ PATH: "/usr/bin" });
    assert.ok(!warnings.some((w) => w.type === "debug-exposure"));
  });

  test("should not flag when CDXGEN_DEBUG_MODE is an unrecognised value", () => {
    const warnings = auditEnvironment({ CDXGEN_DEBUG_MODE: "info" });
    assert.ok(!warnings.some((w) => w.type === "debug-exposure"));
  });
});

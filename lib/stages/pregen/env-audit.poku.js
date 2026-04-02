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
    name: "-r short flag",
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
    name: "-e short flag",
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
        w.includes("NODE_OPTIONS contains code execution flag"),
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
          warnings.some((w) => w.includes(tc.expectedVar)),
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
      w.includes("NODE_OPTIONS contains code execution flag"),
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

    assert.ok(warnings1[0].includes("NODE_NO_WARNINGS"));
    assert.ok(warnings2[0].includes("NODE_PENDING_DEPRECATION"));
    assert.ok(warnings3[0].includes("UV_THREADPOOL_SIZE"));
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
    assert.ok(warnings[0].includes("Unset"));
    assert.ok(warnings[0].includes("NODE_NO_WARNINGS"));
  });

  test("NODE_OPTIONS warning should mention the pattern", () => {
    const warnings = auditEnvironment({ NODE_OPTIONS: "--require ./evil.js" });
    assert.ok(warnings[0].includes("NODE_OPTIONS"));
    assert.ok(warnings[0].includes("code execution flag"));
  });

  test("warnings should be human-readable strings", () => {
    const warnings = auditEnvironment({
      NODE_OPTIONS: "--eval test",
      NODE_NO_WARNINGS: "1",
    });
    for (const w of warnings) {
      assert.strictEqual(typeof w, "string");
      assert.ok(w.length > 0);
    }
  });
});

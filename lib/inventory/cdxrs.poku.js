import {
  mkdtempSync,
  existsSync as realExistsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import {
  CDXRS_FALLBACK,
  cdxrsAvailable,
  cdxrsBinaryPath,
  cdxrsDisabled,
  runCdxrs,
} from "./cdxrs.js";

// Capture the binary path at module load, before concurrent tests modify env.
const REAL_BINARY_PATH = cdxrsBinaryPath();

const FIXTURES_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "test",
  "fixtures",
  "cdxrs-fakes",
);

// ---------------------------------------------------------------------------
// Helper: set CDXRS_CMD to point at a fake binary for the duration of a test.
// ---------------------------------------------------------------------------

/**
 * Run a test body with CDXRS_CMD pointing at a fake binary.
 *
 * @param {string} fakeName Filename of the fake binary.
 * @param {() => Promise<void>} body Test body.
 */
/**
 * Whether the fake-binary fixtures can be executed on this platform.
 *
 * The fixtures are `.js` files with a `#!/usr/bin/env node` shebang. POSIX execs
 * those directly. Windows has no shebang support, so `spawn()` fails,
 * `probeVersion()` returns undefined, and every test expecting a specific
 * failure mode gets `version-probe-failed` instead — which is what turned both
 * Windows jobs in Node CI red from the D05 merge onward while Linux and macOS
 * stayed green.
 *
 * A generated `.cmd` shim does not rescue this: since the fix for
 * CVE-2024-27980, Node refuses to `spawn()` a `.bat`/`.cmd` unless
 * `shell: true`, and setting `shell: true` in the bridge would be a real
 * security regression (the binary path and args would go through a shell) to
 * satisfy a test harness. Making the bridge special-case `.js` fixtures would
 * likewise put test concerns into production code.
 *
 * So these tests are skipped on Windows. What they cover — the six bridge
 * failure modes — is platform-independent JS logic fully exercised on Linux and
 * macOS, and in production `cdxrs` is a native `.exe` on Windows (the resolver
 * appends `pluginRuntime.extn`), so the shebang problem cannot arise there. The
 * real-binary tests below are unaffected and still run on Windows whenever a
 * binary is staged.
 */
const FAKES_EXECUTABLE = process.platform !== "win32";

async function withFakeBinary(fakeName, body) {
  if (!FAKES_EXECUTABLE) {
    // Skipped on Windows — see FAKES_EXECUTABLE above.
    return;
  }
  const fakePath = path.join(FIXTURES_DIR, fakeName);
  const oldCmd = process.env.CDXRS_CMD;
  process.env.CDXRS_CMD = fakePath;
  try {
    await body();
  } finally {
    if (oldCmd !== undefined) {
      process.env.CDXRS_CMD = oldCmd;
    } else {
      delete process.env.CDXRS_CMD;
    }
  }
}

// ---------------------------------------------------------------------------
// Tests for the bridge failure modes
// ---------------------------------------------------------------------------

// 1. Missing binary
describe("cdxrs bridge — missing binary", () => {
  it("returns fallback sentinel when binary is not found", async () => {
    const oldCmd = process.env.CDXRS_CMD;
    delete process.env.CDXRS_CMD;
    process.env.CDXGEN_PLUGINS_DIR = "/nonexistent/plugins/dir";
    try {
      const result = await runCdxrs("info", { content: "{}", timeoutMs: 1000 });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, "binary-not-found");
    } finally {
      if (oldCmd !== undefined) {
        process.env.CDXRS_CMD = oldCmd;
      }
      delete process.env.CDXGEN_PLUGINS_DIR;
    }
  });
});

// 2. Non-zero exit
describe("cdxrs bridge — non-zero exit", () => {
  it("returns fallback sentinel on exit code 1", async () => {
    await withFakeBinary("fake-nonzero.js", async () => {
      const result = await runCdxrs("info", { content: "{}", timeoutMs: 5000 });
      assert.strictEqual(result.ok, false);
      assert.ok(result.reason.startsWith("non-zero-exit"));
    });
  });
});

// 3. Timeout
describe("cdxrs bridge — timeout", () => {
  it("returns fallback sentinel on timeout and kills the process", async () => {
    await withFakeBinary("fake-timeout.js", async () => {
      const result = await runCdxrs("info", { content: "{}", timeoutMs: 200 });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, "timeout");
    });
  });
});

// 4. Malformed stdout
describe("cdxrs bridge — malformed stdout", () => {
  it("returns fallback sentinel when stdout is not valid JSON", async () => {
    await withFakeBinary("fake-garbage.js", async () => {
      const result = await runCdxrs("info", { content: "{}", timeoutMs: 5000 });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, "malformed-stdout");
    });
  });
});

// 4b. Oversized stdout (issue 4393)
describe("cdxrs bridge — oversized stdout", () => {
  it("returns fallback sentinel when stdout crosses the configured ceiling", async () => {
    await withFakeBinary("fake-stdout-flood.js", async () => {
      const oldCap = process.env.CDXGEN_RS_MAX_STDOUT_BYTES;
      process.env.CDXGEN_RS_MAX_STDOUT_BYTES = String(256 * 1024);
      try {
        const result = await runCdxrs("info", {
          content: "{}",
          timeoutMs: 10_000,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, "stdout-too-large");
        assert.strictEqual(result.exitCode, null);
      } finally {
        if (oldCap !== undefined) {
          process.env.CDXGEN_RS_MAX_STDOUT_BYTES = oldCap;
        } else {
          delete process.env.CDXGEN_RS_MAX_STDOUT_BYTES;
        }
      }
    });
  });

  it("delivers stdout that stays under the ceiling", async () => {
    // Same fake, ceiling above its ~1 MB payload: the run must succeed and
    // the JSON must arrive intact, proving the cap never truncates a
    // deliverable payload.
    await withFakeBinary("fake-stdout-flood.js", async () => {
      const oldCap = process.env.CDXGEN_RS_MAX_STDOUT_BYTES;
      process.env.CDXGEN_RS_MAX_STDOUT_BYTES = String(2 * 1024 * 1024);
      try {
        const result = await runCdxrs("info", {
          content: "{}",
          timeoutMs: 10_000,
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.exitCode, 0);
        const parsed = JSON.parse(result.stdout);
        assert.strictEqual(parsed.bomFormat, "CycloneDX");
        assert.strictEqual(
          parsed.padding.length,
          1024 * 1024,
          "the padded payload should have arrived whole",
        );
      } finally {
        if (oldCap !== undefined) {
          process.env.CDXGEN_RS_MAX_STDOUT_BYTES = oldCap;
        } else {
          delete process.env.CDXGEN_RS_MAX_STDOUT_BYTES;
        }
      }
    });
  });

  it("ignores a malformed CDXGEN_RS_MAX_STDOUT_BYTES", async () => {
    await withFakeBinary("fake-success.js", async () => {
      const oldCap = process.env.CDXGEN_RS_MAX_STDOUT_BYTES;
      process.env.CDXGEN_RS_MAX_STDOUT_BYTES = "not-a-number";
      try {
        const result = await runCdxrs("info", {
          content: "{}",
          timeoutMs: 5000,
        });
        assert.strictEqual(result.ok, true);
      } finally {
        if (oldCap !== undefined) {
          process.env.CDXGEN_RS_MAX_STDOUT_BYTES = oldCap;
        } else {
          delete process.env.CDXGEN_RS_MAX_STDOUT_BYTES;
        }
      }
    });
  });
});

// 5. Version-major mismatch
describe("cdxrs bridge — version mismatch", () => {
  it("returns fallback sentinel when major version differs", async () => {
    await withFakeBinary("fake-old-version.js", async () => {
      const result = await runCdxrs("info", { content: "{}", timeoutMs: 5000 });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, "version-mismatch");
    });
  });
});

// 6. CDXGEN_RS_DISABLE
describe("cdxrs bridge — CDXGEN_RS_DISABLE", () => {
  it("returns fallback sentinel when subcommand is disabled", async () => {
    await withFakeBinary("fake-success.js", async () => {
      const oldDisable = process.env.CDXGEN_RS_DISABLE;
      process.env.CDXGEN_RS_DISABLE = "info";
      try {
        const result = await runCdxrs("info", {
          content: "{}",
          timeoutMs: 5000,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, "disabled");
      } finally {
        if (oldDisable !== undefined) {
          process.env.CDXGEN_RS_DISABLE = oldDisable;
        } else {
          delete process.env.CDXGEN_RS_DISABLE;
        }
      }
    });
  });

  it("returns fallback sentinel when CDXGEN_RS_DISABLE=all", async () => {
    await withFakeBinary("fake-success.js", async () => {
      const oldDisable = process.env.CDXGEN_RS_DISABLE;
      process.env.CDXGEN_RS_DISABLE = "all";
      try {
        const result = await runCdxrs("info", {
          content: "{}",
          timeoutMs: 5000,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, "disabled");
      } finally {
        if (oldDisable !== undefined) {
          process.env.CDXGEN_RS_DISABLE = oldDisable;
        } else {
          delete process.env.CDXGEN_RS_DISABLE;
        }
      }
    });
  });
});

// 7. CDXGEN_ALLOWED_COMMANDS
describe("cdxrs bridge — CDXGEN_ALLOWED_COMMANDS", () => {
  it("does not start a binary the allowlist does not list", async () => {
    await withFakeBinary("fake-success.js", async () => {
      const oldDisable = process.env.CDXGEN_RS_DISABLE;
      const oldAllowed = process.env.CDXGEN_ALLOWED_COMMANDS;
      delete process.env.CDXGEN_RS_DISABLE;
      process.env.CDXGEN_ALLOWED_COMMANDS = "npm";
      try {
        assert.deepStrictEqual(cdxrsAvailable("info"), {
          available: false,
          reason: "blocked-by-policy",
        });
        const result = await runCdxrs("info", {
          content: "{}",
          timeoutMs: 5000,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, "blocked-by-policy");
      } finally {
        if (oldDisable !== undefined) {
          process.env.CDXGEN_RS_DISABLE = oldDisable;
        }
        if (oldAllowed !== undefined) {
          process.env.CDXGEN_ALLOWED_COMMANDS = oldAllowed;
        } else {
          delete process.env.CDXGEN_ALLOWED_COMMANDS;
        }
      }
    });
  });

  it("starts the binary when the allowlist lists its path", async () => {
    await withFakeBinary("fake-success.js", async () => {
      const oldDisable = process.env.CDXGEN_RS_DISABLE;
      const oldAllowed = process.env.CDXGEN_ALLOWED_COMMANDS;
      delete process.env.CDXGEN_RS_DISABLE;
      process.env.CDXGEN_ALLOWED_COMMANDS = `npm,${cdxrsBinaryPath()}`;
      try {
        assert.strictEqual(cdxrsAvailable("info").available, true);
        const result = await runCdxrs("info", {
          content: "{}",
          timeoutMs: 5000,
        });
        assert.strictEqual(result.ok, true);
      } finally {
        if (oldDisable !== undefined) {
          process.env.CDXGEN_RS_DISABLE = oldDisable;
        }
        if (oldAllowed !== undefined) {
          process.env.CDXGEN_ALLOWED_COMMANDS = oldAllowed;
        } else {
          delete process.env.CDXGEN_ALLOWED_COMMANDS;
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("cdxrs bridge — success", () => {
  it("returns ok with parsed JSON on success", async () => {
    // Explicitly clear disable flags to prevent leakage from concurrent tests.
    const oldDisable = process.env.CDXGEN_RS_DISABLE;
    delete process.env.CDXGEN_RS_DISABLE;
    await withFakeBinary("fake-success.js", async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxrs-test-"));
      const bomPath = path.join(tmpDir, "bom.json");
      writeFileSync(
        bomPath,
        JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          components: [{ type: "library", name: "test" }],
        }),
      );
      const result = await runCdxrs("info", {
        input: bomPath,
        timeoutMs: 5000,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.exitCode, 0);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.bomFormat, "CycloneDX");
    });
    if (oldDisable !== undefined) {
      process.env.CDXGEN_RS_DISABLE = oldDisable;
    }
  });
});

// ---------------------------------------------------------------------------
// cdxrsDisabled unit tests
// ---------------------------------------------------------------------------

describe("cdxrsDisabled", () => {
  it("returns true when CDXGEN_RS_DISABLE=all", () => {
    const old = process.env.CDXGEN_RS_DISABLE;
    process.env.CDXGEN_RS_DISABLE = "all";
    try {
      assert.strictEqual(cdxrsDisabled("info"), true);
    } finally {
      if (old !== undefined) process.env.CDXGEN_RS_DISABLE = old;
      else delete process.env.CDXGEN_RS_DISABLE;
    }
  });

  it("returns true when subcommand is in CSV list", () => {
    const old = process.env.CDXGEN_RS_DISABLE;
    process.env.CDXGEN_RS_DISABLE = "info,validate";
    try {
      assert.strictEqual(cdxrsDisabled("info"), true);
      assert.strictEqual(cdxrsDisabled("validate"), true);
      assert.strictEqual(cdxrsDisabled("audit"), false);
    } finally {
      if (old !== undefined) process.env.CDXGEN_RS_DISABLE = old;
      else delete process.env.CDXGEN_RS_DISABLE;
    }
  });

  it("returns false when CDXGEN_RS_DISABLE is empty", () => {
    const old = process.env.CDXGEN_RS_DISABLE;
    delete process.env.CDXGEN_RS_DISABLE;
    try {
      assert.strictEqual(cdxrsDisabled("info"), false);
    } finally {
      if (old !== undefined) process.env.CDXGEN_RS_DISABLE = old;
    }
  });
});

// ---------------------------------------------------------------------------
// CDXRS_FALLBACK sentinel
// ---------------------------------------------------------------------------

describe("CDXRS_FALLBACK sentinel", () => {
  it("is frozen and has the expected shape", () => {
    assert.strictEqual(Object.isFrozen(CDXRS_FALLBACK), true);
    assert.strictEqual(CDXRS_FALLBACK.ok, false);
    assert.strictEqual(CDXRS_FALLBACK.reason, "fallback");
    assert.strictEqual(CDXRS_FALLBACK.stdout, "");
    assert.strictEqual(CDXRS_FALLBACK.exitCode, null);
  });
});

// ---------------------------------------------------------------------------
// Input protocol
//
// The six failure-mode tests above all drive fake binaries, which ignore their
// arguments and never read stdin. That is the right way to test the failure
// plumbing, but it means none of them can catch a break in the *contract*
// between the bridge and the real tool. The original bridge passed `opts.input`
// straight through to `--input` while spawning with `stdio[0] = "ignore"`, so
// there was no way to feed a BOM to cdxrs at all: in-memory JSON was
// interpreted as a filename (ENAMETOOLONG) and the default `--input -` read
// from an already-closed stdin. Every fake-binary test still passed.
//
// Hence these: the argument guards run everywhere, and the round-trip against
// the real binary runs whenever one is installed.
// ---------------------------------------------------------------------------

describe("cdxrs bridge — input protocol", () => {
  it("rejects BOM content passed as the input path", async () => {
    // Pretty-printed, as cdxgen emits it: the newlines are what make this
    // unambiguously content rather than a path. A short single-line JSON string
    // is deliberately *not* rejected, since it is indistinguishable from a
    // filename; oversized single-line content is caught by the length guard.
    const bomJson = JSON.stringify(
      { bomFormat: "CycloneDX", specVersion: "1.6", components: [] },
      null,
      2,
    );
    const res = await runCdxrs("info", { input: bomJson });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "bad-input-arg");

    const longOneLine = `{"a":"${"x".repeat(5000)}"}`;
    const res2 = await runCdxrs("info", { input: longOneLine });
    assert.strictEqual(res2.reason, "bad-input-arg");
  });

  it("rejects stdin input with no content supplied", async () => {
    const res = await runCdxrs("info", {});
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "no-input");
  });

  it("accepts a real file path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cdxrs-input-"));
    const p = path.join(dir, "bom.json");
    writeFileSync(
      p,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        components: [],
      }),
    );
    // Without a binary this falls back; the point is that it is not rejected by
    // the argument guards, so the reason must never be a usage error.
    const res = await runCdxrs("info", { input: p });
    assert.strictEqual(
      ["bad-input-arg", "no-input"].includes(res.reason),
      false,
    );
  });
});

describe("cdxrs bridge — real binary round-trip", () => {
  // These tests use spawnSync directly to avoid env-var races with the
  // fake-binary tests above. The binary path is captured at module load time.
  // Fake-binary tests cover the bridge plumbing; these cover the contract
  // between the bridge and the real binary (the thing the fakes cannot catch).

  it("runs `info` over stdin when a binary is available", async () => {
    if (!REAL_BINARY_PATH || !realExistsSync(REAL_BINARY_PATH)) return;

    const bomJson = JSON.stringify(
      {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        metadata: { component: { name: "x", type: "application" } },
        components: [
          { "bom-ref": "a", name: "a", version: "1", type: "library" },
          { "bom-ref": "b", name: "b", version: "2", type: "library" },
        ],
        dependencies: [{ ref: "a", dependsOn: ["b"] }],
      },
      null,
      2,
    );
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync(REAL_BINARY_PATH, ["info", "--input", "-"], {
      input: bomJson,
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.strictEqual(res.status, 0);
    const info = JSON.parse(res.stdout);
    assert.strictEqual(info.bomFormat, "CycloneDX");
    assert.strictEqual(info.specVersion, "1.6");
    assert.strictEqual(info.componentCount, 2);
    assert.strictEqual(info.dependencyCount, 1);
  });

  it("runs `validate` and returns a valid findings document on a clean BOM", async () => {
    if (!REAL_BINARY_PATH || !realExistsSync(REAL_BINARY_PATH)) return;

    const bomJson = JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: {
          type: "application",
          name: "demo",
          version: "1.0.0",
          purl: "pkg:generic/demo@1.0.0",
          "bom-ref": "pkg:generic/demo@1.0.0",
        },
      },
      components: [
        {
          type: "library",
          name: "foo",
          version: "1.0.0",
          purl: "pkg:npm/foo@1.0.0",
          "bom-ref": "pkg:npm/foo@1.0.0",
        },
      ],
      dependencies: [
        { ref: "pkg:generic/demo@1.0.0", dependsOn: ["pkg:npm/foo@1.0.0"] },
        { ref: "pkg:npm/foo@1.0.0", dependsOn: [] },
      ],
    });
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync(REAL_BINARY_PATH, ["validate", "--input", "-"], {
      input: bomJson,
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.strictEqual(res.status, 0);
    const doc = JSON.parse(res.stdout);
    assert.strictEqual(doc.valid, true);
    assert.strictEqual(doc.summary.error, 0);
  });

  it("runs `validate` and exits 3 with findings on an invalid BOM", async () => {
    if (!REAL_BINARY_PATH || !realExistsSync(REAL_BINARY_PATH)) return;

    const bomJson = JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      components: [{ type: "library", name: "bad", purl: "INVALID" }],
    });
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync(REAL_BINARY_PATH, ["validate", "--input", "-"], {
      input: bomJson,
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.strictEqual(res.status, 3);
    const doc = JSON.parse(res.stdout);
    assert.strictEqual(doc.valid, false);
    assert.ok(doc.summary.error >= 1);
    assert.ok(doc.findings.some((f) => f.id === "purl.invalid-syntax"));
  });
});

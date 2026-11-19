/**
 * Tests for the project-tooling gate shared by every layer (issue #4527).
 *
 * `isSecureMode` is a snapshot taken when activity.js loads, which is false
 * in this test process. The gate also reads CDXGEN_SECURE_MODE when it is
 * called, which is what the `cdxgen-secure` command relies on and what makes
 * secure mode testable in-process here. Every test sets and restores the
 * variables it touches, because poku hooks are not scoped to describe blocks.
 */
import process from "node:process";

import { assert, describe, it } from "poku";
import sinon from "sinon";

import { isSecureMode } from "./activity.js";
import { getLedgerEvents, resetLedgerEvents } from "./buildLedger.js";
import {
  isDependencyInstallAllowed,
  isProjectToolingAllowed,
  isSecureModeActive,
  reportProjectToolingSkipped,
} from "./projectTooling.js";

/**
 * Run `body` with the given environment variables set (or removed when the
 * value is undefined), restoring the previous values afterwards.
 *
 * @param {Object} vars Variable name to value, undefined to unset
 * @param {Function} body Code to run
 * @returns {*} What body returns
 */
function withEnv(vars, body) {
  const saved = {};
  for (const [name, value] of Object.entries(vars)) {
    saved[name] = process.env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

describe("isSecureModeActive()", () => {
  it("turns on when CDXGEN_SECURE_MODE is true or 1 at call time", () => {
    for (const value of ["true", "1"]) {
      withEnv({ CDXGEN_SECURE_MODE: value }, () => {
        assert.strictEqual(isSecureModeActive(), true, `value ${value}`);
      });
    }
  });

  it("stays off for other values when the import-time snapshot is off", () => {
    if (isSecureMode) {
      // The process itself runs in secure mode; nothing to contrast.
      return;
    }
    for (const value of [undefined, "", "false", "0"]) {
      withEnv({ CDXGEN_SECURE_MODE: value }, () => {
        assert.strictEqual(
          isSecureModeActive(),
          false,
          `value ${JSON.stringify(value)}`,
        );
      });
    }
  });
});

describe("isDependencyInstallAllowed()", () => {
  it("follows installDeps and defaults to on outside secure mode", () => {
    if (isSecureMode) {
      return;
    }
    withEnv({ CDXGEN_SECURE_MODE: undefined }, () => {
      assert.strictEqual(isDependencyInstallAllowed(undefined), true);
      assert.strictEqual(isDependencyInstallAllowed({}), true);
      assert.strictEqual(
        isDependencyInstallAllowed({ installDeps: true }),
        true,
      );
      assert.strictEqual(
        isDependencyInstallAllowed({ installDeps: false }),
        false,
      );
    });
  });

  it("defaults to off in secure mode when a caller leaves installDeps unset", () => {
    withEnv({ CDXGEN_SECURE_MODE: "true" }, () => {
      assert.strictEqual(isDependencyInstallAllowed(undefined), false);
      assert.strictEqual(isDependencyInstallAllowed({}), false);
      assert.strictEqual(
        isDependencyInstallAllowed({ installDeps: false }),
        false,
      );
      // An explicit --install-deps is still honoured
      assert.strictEqual(
        isDependencyInstallAllowed({ installDeps: true }),
        true,
      );
    });
  });

  it("is not turned back on by introspection", () => {
    withEnv({ CDXGEN_SECURE_MODE: undefined }, () => {
      assert.strictEqual(
        isDependencyInstallAllowed({ installDeps: false, introspect: true }),
        false,
      );
    });
  });
});

describe("isProjectToolingAllowed()", () => {
  it("allows tooling outside secure mode when installs are not disabled", () => {
    if (isSecureMode) {
      return;
    }
    withEnv({ CDXGEN_SECURE_MODE: undefined }, () => {
      assert.strictEqual(isProjectToolingAllowed(undefined), true);
      assert.strictEqual(isProjectToolingAllowed(null), true);
      assert.strictEqual(isProjectToolingAllowed({}), true);
      assert.strictEqual(isProjectToolingAllowed({ installDeps: true }), true);
    });
  });

  it("refuses tooling when installs are disabled", () => {
    withEnv({ CDXGEN_SECURE_MODE: undefined }, () => {
      assert.strictEqual(
        isProjectToolingAllowed({ installDeps: false }),
        false,
      );
    });
  });

  it("lets operator introspection keep tooling on outside secure mode", () => {
    if (isSecureMode) {
      return;
    }
    withEnv({ CDXGEN_SECURE_MODE: undefined }, () => {
      assert.strictEqual(
        isProjectToolingAllowed({ installDeps: false, introspect: true }),
        true,
      );
    });
  });

  it("ignores introspection that came from the scanned project's config file", () => {
    withEnv({ CDXGEN_SECURE_MODE: undefined }, () => {
      assert.strictEqual(
        isProjectToolingAllowed({
          installDeps: false,
          introspect: true,
          introspectFromConfigFile: true,
        }),
        false,
      );
    });
  });

  it("reads secure mode at call time: installs default off and introspection cannot re-enable tooling", () => {
    withEnv({ CDXGEN_SECURE_MODE: "true" }, () => {
      // installDeps defaults to off in secure mode when a caller leaves it unset
      assert.strictEqual(isProjectToolingAllowed({}), false);
      assert.strictEqual(isProjectToolingAllowed(undefined), false);
      // An explicit --install-deps is still honoured
      assert.strictEqual(isProjectToolingAllowed({ installDeps: true }), true);
      // Secure mode wins over introspection
      assert.strictEqual(
        isProjectToolingAllowed({ installDeps: false, introspect: true }),
        false,
      );
    });
    withEnv({ CDXGEN_SECURE_MODE: "1" }, () => {
      assert.strictEqual(isProjectToolingAllowed({}), false);
    });
  });
});

describe("reportProjectToolingSkipped()", () => {
  const ledgerEnv = {
    CDXGEN_INTROSPECT: "true",
    // No sidecar: the events stay in this process's memory only
    CDXGEN_INTROSPECT_LEDGER: undefined,
  };
  const fields = {
    ecosystem: "java",
    tool: "maven",
    impact: "transitive-deps",
    detail: "Maven was not run in this test.",
  };

  it("prints once per options object and remediation id, and records one degradation", () => {
    const logStub = sinon.stub(console, "log");
    try {
      withEnv(ledgerEnv, () => {
        resetLedgerEvents();
        const options = {};
        const message = "test: skipping maven (first)";
        reportProjectToolingSkipped(
          options,
          "jvm.maven.tooling-disabled",
          message,
          fields,
        );
        reportProjectToolingSkipped(
          options,
          "jvm.maven.tooling-disabled",
          message,
          fields,
        );
        // Same id, different wording: still the same skip for this scan
        reportProjectToolingSkipped(
          options,
          "jvm.maven.tooling-disabled",
          "test: skipping maven (reworded)",
          fields,
        );
        assert.strictEqual(logStub.callCount, 1);
        assert.strictEqual(logStub.firstCall.args[0], message);
        const events = getLedgerEvents().filter(
          (event) => event.remediationId === "jvm.maven.tooling-disabled",
        );
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].ecosystem, "java");
        assert.strictEqual(events[0].tool, "maven");
        assert.strictEqual(events[0].impact, "transitive-deps");
      });
    } finally {
      logStub.restore();
      resetLedgerEvents();
    }
  });

  it("only shows a skip without a remediation id, deduplicating by message", () => {
    const logStub = sinon.stub(console, "log");
    try {
      withEnv(ledgerEnv, () => {
        resetLedgerEvents();
        const options = {};
        reportProjectToolingSkipped(options, null, "test: evidence skip A");
        reportProjectToolingSkipped(options, null, "test: evidence skip A");
        reportProjectToolingSkipped(options, null, "test: evidence skip B");
        assert.deepStrictEqual(
          logStub.getCalls().map((call) => call.args[0]),
          ["test: evidence skip A", "test: evidence skip B"],
        );
        assert.strictEqual(getLedgerEvents().length, 0);
      });
    } finally {
      logStub.restore();
      resetLedgerEvents();
    }
  });

  it("reports again for a fresh options object (a new scan)", () => {
    const logStub = sinon.stub(console, "log");
    try {
      withEnv(ledgerEnv, () => {
        resetLedgerEvents();
        const message = "test: skipping msbuild";
        for (const options of [{}, {}]) {
          reportProjectToolingSkipped(
            options,
            "dotnet.msbuild.tooling-disabled",
            message,
            { ecosystem: "dotnet", tool: "msbuild", impact: "versions" },
          );
          reportProjectToolingSkipped(
            options,
            "dotnet.msbuild.tooling-disabled",
            message,
            { ecosystem: "dotnet", tool: "msbuild", impact: "versions" },
          );
        }
        assert.strictEqual(logStub.callCount, 2);
        assert.strictEqual(
          getLedgerEvents().filter(
            (event) =>
              event.remediationId === "dotnet.msbuild.tooling-disabled",
          ).length,
          2,
        );
      });
    } finally {
      logStub.restore();
      resetLedgerEvents();
    }
  });

  it("shares one report key between callers without options", () => {
    const logStub = sinon.stub(console, "log");
    try {
      withEnv(ledgerEnv, () => {
        resetLedgerEvents();
        const message = "test: skip without options";
        reportProjectToolingSkipped(undefined, null, message);
        reportProjectToolingSkipped(null, null, message);
        reportProjectToolingSkipped("not an object", null, message);
        assert.strictEqual(logStub.callCount, 1);
      });
    } finally {
      logStub.restore();
      resetLedgerEvents();
    }
  });

  it("still prints but records nothing while the ledger is off", () => {
    const logStub = sinon.stub(console, "log");
    try {
      withEnv(
        { CDXGEN_INTROSPECT: undefined, CDXGEN_INTROSPECT_LEDGER: undefined },
        () => {
          resetLedgerEvents();
          reportProjectToolingSkipped(
            {},
            "jvm.maven.tooling-disabled",
            "test: ledger off",
            fields,
          );
          assert.strictEqual(logStub.callCount, 1);
          assert.strictEqual(getLedgerEvents().length, 0);
        },
      );
    } finally {
      logStub.restore();
      resetLedgerEvents();
    }
  });
});

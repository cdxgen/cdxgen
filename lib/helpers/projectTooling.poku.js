import { assert, describe, it } from "poku";

import {
  isDependencyInstallAllowed,
  isSecureModeActive,
} from "./projectTooling.js";
import { isSecureMode } from "./utils.js";

function withSecureModeEnv(value, fn) {
  const saved = process.env.CDXGEN_SECURE_MODE;
  if (value === undefined) {
    delete process.env.CDXGEN_SECURE_MODE;
  } else {
    process.env.CDXGEN_SECURE_MODE = value;
  }
  try {
    return fn();
  } finally {
    if (saved === undefined) {
      delete process.env.CDXGEN_SECURE_MODE;
    } else {
      process.env.CDXGEN_SECURE_MODE = saved;
    }
  }
}

describe("isSecureModeActive()", () => {
  it("reads CDXGEN_SECURE_MODE at call time", () => {
    withSecureModeEnv("true", () => {
      assert.strictEqual(isSecureModeActive(), true);
    });
    if (!isSecureMode) {
      withSecureModeEnv(undefined, () => {
        assert.strictEqual(isSecureModeActive(), false);
      });
    }
  });
});

describe("isDependencyInstallAllowed()", () => {
  it("follows installDeps and defaults to on outside secure mode", () => {
    if (isSecureMode) {
      return;
    }
    withSecureModeEnv(undefined, () => {
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
    withSecureModeEnv("true", () => {
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
});

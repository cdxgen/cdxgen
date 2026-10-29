import { createRequire } from "node:module";
import path from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";

// This file runs in its own poku process on purpose: it captures
// console.warn globally to assert the one-warning-per-lockfile reporting of
// lockfile paths outside the project (issue #3816), which cannot be done
// safely in a file whose other tests run interleaved.

const require = createRequire(import.meta.url);

const MALICIOUS_LOCK = path.join(
  "test",
  "data",
  "package-json",
  "malicious-path",
  "package-lock.json",
);

const captureOutsidePathWarnings = async (secure) => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args.map((arg) => `${arg}`).join(" "));
  };
  try {
    const { parsePkgLock } = await esmock("./parsers-js.js", {
      "../core/activity.js": { isSecureMode: secure },
      "../core/buildLedger.js": { recordDegradation: () => {} },
    });
    await parsePkgLock(MALICIOUS_LOCK);
  } finally {
    console.warn = originalWarn;
  }
  return warnings.filter((text) => text.includes("outside the project root"));
};

describe("npm lockfile outside-path reporting", () => {
  // One test on purpose: both modes capture console.warn, so they must not
  // run interleaved.
  it("warns once per lockfile, keeping entries by default and omitting them in secure mode", async () => {
    const defaultWarnings = await captureOutsidePathWarnings(false);
    assert.deepStrictEqual(defaultWarnings.length, 1);
    assert.ok(defaultWarnings[0].includes(MALICIOUS_LOCK), defaultWarnings[0]);
    assert.ok(defaultWarnings[0].includes("evil-pkg"), defaultWarnings[0]);
    assert.ok(defaultWarnings[0].includes("They are kept"), defaultWarnings[0]);

    const secureWarnings = await captureOutsidePathWarnings(true);
    assert.deepStrictEqual(secureWarnings.length, 1);
    assert.ok(
      secureWarnings[0].startsWith("WARNING: Omitted"),
      secureWarnings[0],
    );
    assert.ok(secureWarnings[0].includes(MALICIOUS_LOCK), secureWarnings[0]);
  });

  it("records the js.lockfile-unsafe-path remediation in the catalog", () => {
    const remediations = require("../../data/remediations.json");
    const entry = remediations["js.lockfile-unsafe-path"];
    assert.ok(entry, "catalog entry missing");
    assert.strictEqual(entry.ecosystem, "npm");
  });
});

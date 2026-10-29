import { createRequire } from "node:module";

import esmock from "esmock";
import { assert, describe, it } from "poku";

// This file runs in its own poku process on purpose: it captures
// console.warn globally to assert the one-warning-per-lockfile reporting of
// the lockfile path validation (issue #3816), which cannot be done safely in
// a file whose other tests run interleaved.

const require = createRequire(import.meta.url);

describe("npm lockfile path validation reporting", () => {
  it("warns once per lockfile naming the lockfile and the first entry", async () => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => {
      warnings.push(args.map((arg) => `${arg}`).join(" "));
    };
    const degradationEvents = [];
    try {
      const { parsePkgLock } = await esmock("./parsers-js.js", {
        "../core/buildLedger.js": {
          recordDegradation: (...args) => {
            degradationEvents.push(args);
          },
        },
      });
      const parsedList = await parsePkgLock(
        "./test/data/package-json/malicious-path/package-lock.json",
      );
      // The crafted entries are omitted from the SBOM, including the link
      // that mirrors its target's traversal version.
      assert.ok(!parsedList.pkgList.some((dep) => dep.name === "evil-pkg"));
      assert.ok(
        !parsedList.pkgList.some((dep) => dep.name === "malicious-pkg"),
      );
      assert.deepStrictEqual(parsedList.pkgList.length, 1);

      const rejectionWarnings = warnings.filter((text) =>
        text.includes("outside the project root"),
      );
      assert.deepStrictEqual(rejectionWarnings.length, 1);
      assert.ok(
        rejectionWarnings[0].includes("malicious-path/package-lock.json"),
        `warning does not name the lockfile: ${rejectionWarnings[0]}`,
      );
      assert.ok(rejectionWarnings[0].includes("evil-pkg"));
      // One degradation event for the scan of this lockfile.
      assert.deepStrictEqual(degradationEvents.length, 1);
      assert.deepStrictEqual(
        degradationEvents[0][0],
        "js.lockfile-unsafe-path",
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("records the js.lockfile-unsafe-path remediation in the catalog", async () => {
    const remediations = require("../../data/remediations.json");
    const entry = remediations["js.lockfile-unsafe-path"];
    assert.ok(entry, "catalog entry missing");
    assert.strictEqual(entry.ecosystem, "npm");
  });
});

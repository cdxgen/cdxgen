import { assert, describe, it } from "poku";

import {
  createOsQueryFallbackBomRef,
  createOsQueryPurl,
  deriveOsQueryDescription,
  deriveOsQueryName,
  deriveOsQueryPublisher,
  deriveOsQueryVersion,
  sanitizeOsQueryBomRefValue,
  sanitizeOsQueryIdentity,
  shouldCreateOsQueryPurl,
} from "./osqueryTransform.js";

describe("osqueryTransform helpers", () => {
  it("derives version, name, publisher, and description from osquery rows", () => {
    const row = {
      pid: "1024",
      provider: "null",
      summary: "sample description",
    };
    assert.strictEqual(deriveOsQueryVersion(row), "1024");
    assert.strictEqual(deriveOsQueryName(row, false), "1024");
    assert.strictEqual(deriveOsQueryPublisher(row), "");
    assert.strictEqual(deriveOsQueryDescription(row), "sample description");
  });

  it("falls back to query name for single-row synthetic entries", () => {
    const row = {};
    assert.strictEqual(deriveOsQueryName(row, true, "os-image"), "os-image");
  });

  it("sanitizes osquery identity strings used in purl fields", () => {
    assert.strictEqual(
      sanitizeOsQueryIdentity("{My App:%Name}"),
      "My+App--Name",
    );
  });

  it("creates valid purl strings for osquery-derived components", () => {
    const purl = createOsQueryPurl(
      "swid",
      "microsoft",
      "windows+11",
      "22H2",
      undefined,
      "windows",
    );
    assert.ok(purl.startsWith("pkg:swid/microsoft/"));
    assert.ok(purl.includes("@22H2"));
  });

  it("creates readable fallback bom-ref strings for non-package osquery rows", () => {
    const bomRef = createOsQueryFallbackBomRef(
      "authorized_keys_snapshot",
      "data",
      "root",
      "ssh-ed25519",
      "key_file",
      "/root/.ssh/authorized_keys",
    );
    assert.strictEqual(
      bomRef,
      "osquery:authorized_keys_snapshot:data:root@ssh-ed25519[key_file=/root/.ssh/authorized_keys]",
    );
  });

  it("omits the bracketed suffix when no extra identity field exists", () => {
    const bomRef = createOsQueryFallbackBomRef(
      "windows_run_keys",
      "data",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Updater",
      undefined,
    );
    assert.strictEqual(
      bomRef,
      "osquery:windows_run_keys:data:HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Updater@unknown",
    );
  });

  it("sanitizes fallback bom-ref fragments without percent-encoding them", () => {
    assert.strictEqual(
      sanitizeOsQueryBomRefValue(" launchd: updater@[user]=#1\n"),
      "launchd- updater--user---1",
    );
  });

  it("limits purl generation to package-like osquery component types", () => {
    assert.strictEqual(shouldCreateOsQueryPurl(undefined), true);
    assert.strictEqual(shouldCreateOsQueryPurl("application"), true);
    assert.strictEqual(shouldCreateOsQueryPurl("operating-system"), true);
    assert.strictEqual(shouldCreateOsQueryPurl("data"), false);
    assert.strictEqual(shouldCreateOsQueryPurl("device"), false);
    assert.strictEqual(shouldCreateOsQueryPurl("cryptographic-asset"), false);
  });
});

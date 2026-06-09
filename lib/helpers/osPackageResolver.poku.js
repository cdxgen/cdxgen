import { assert, describe, it } from "poku";

import {
  _resetOsInfoCache,
  resolvePackageForFile,
} from "./osPackageResolver.js";

describe("osPackageResolver", () => {
  it("resolves undefined for empty path", () => {
    _resetOsInfoCache();
    const result = resolvePackageForFile("");
    assert.strictEqual(result, undefined);
  });

  it("returns undefined for null/undefined filePath", () => {
    _resetOsInfoCache();
    assert.strictEqual(resolvePackageForFile(null), undefined);
    assert.strictEqual(resolvePackageForFile(undefined), undefined);
  });

  it("returns undefined for a path that is not owned by any package", () => {
    _resetOsInfoCache();
    // A path that definitely does not exist
    const result = resolvePackageForFile(
      "/tmp/cdxgen-test-nonexistent-file-xyz123.so",
    );
    assert.ok(
      result === undefined,
      "should return undefined for unknown paths",
    );
  });

  it("caches repeated calls to avoid duplicate subprocess invocations", () => {
    _resetOsInfoCache();
    const path = "/tmp/cdxgen-test-cache-check.so";
    const first = resolvePackageForFile(path);
    const second = resolvePackageForFile(path);
    assert.deepStrictEqual(
      first,
      second,
      "cached result should equal first lookup",
    );
  });
});

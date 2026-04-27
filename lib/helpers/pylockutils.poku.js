import { assert, describe, it } from "poku";

import {
  collectPyLockTopLevelProperties,
  getPyLockPackages,
  isPyLockFile,
  isPyLockObject,
} from "./pylockutils.js";

describe("pylockutils", () => {
  it("detects valid pylock file names", () => {
    assert.ok(isPyLockFile("/tmp/pylock.toml"));
    assert.ok(isPyLockFile("/tmp/pylock.api.toml"));
    assert.ok(!isPyLockFile("/tmp/poetry.lock"));
  });

  it("detects pylock object shape and packages", () => {
    const pylockData = {
      "lock-version": "1.0",
      packages: [{ name: "attrs", version: "1.0.0" }],
    };
    assert.ok(isPyLockObject(pylockData));
    assert.deepStrictEqual(getPyLockPackages(pylockData).length, 1);
  });

  it("collects pylock top-level custom properties", () => {
    const properties = collectPyLockTopLevelProperties({
      "lock-version": "1.0",
      "requires-python": ">=3.11",
      "created-by": "uv",
    });
    assert.ok(
      properties.some(
        (p) => p.name === "cdx:pylock:lock_version" && p.value === "1.0",
      ),
    );
    assert.ok(
      properties.some(
        (p) => p.name === "cdx:pylock:requires_python" && p.value === ">=3.11",
      ),
    );
    assert.ok(
      properties.some(
        (p) => p.name === "cdx:pylock:created_by" && p.value === "uv",
      ),
    );
  });
});

import { assert, describe, it } from "poku";

import {
  collectPyLockDependencyRelationships,
  collectPyLockFileComponents,
  collectPyLockTopLevelProperties,
  getPyLockPackages,
  isDefaultPypiRegistry,
  isPyLockFile,
  isPyLockObject,
  normalizePyLockRegistry,
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

  it("normalizes registry URLs and semantic dependency relationships", () => {
    assert.strictEqual(
      normalizePyLockRegistry("https://pypi.org/simple/?token=secret#frag"),
      "https://pypi.org/simple",
    );
    assert.strictEqual(
      isDefaultPypiRegistry("https://pypi.org/simple/?token=secret"),
      true,
    );
    assert.deepStrictEqual(
      collectPyLockDependencyRelationships({
        dependencies: ["httpx>=0.27.0"],
        extras: { cli: ["rich>=13.0"] },
        "dependency-groups": { dev: ["pytest>=8.0"] },
      }),
      [
        { name: "pytest", scope: "dependency-group" },
        { name: "rich", scope: "optional-extra" },
        { name: "httpx", scope: "required" },
      ],
    );
  });

  it("creates artifact components with normalized distribution metadata", () => {
    const components = collectPyLockFileComponents(
      {
        name: "demo",
        wheels: [
          {
            url: "https://files.pythonhosted.org/packages/demo.whl?token=secret",
            hashes: {
              sha256: "abc",
              sha256_digest: "abc",
              blake2b_256: "def",
            },
            index: "https://custom.example/simple/",
          },
        ],
      },
      "/tmp/pylock.toml",
    );
    assert.strictEqual(components.length, 1);
    assert.strictEqual(
      components[0].externalReferences?.[0]?.url,
      "https://files.pythonhosted.org/packages/demo.whl",
    );
    assert.deepStrictEqual(components[0].hashes, [
      { alg: "BLAKE2B-256", content: "def" },
      { alg: "SHA-256", content: "abc" },
      { alg: "SHA-256_DIGEST", content: "abc" },
    ]);
  });
});

import { createHash } from "node:crypto";

import { assert, describe, it } from "poku";

import {
  collectPyLockDependencyRelationships,
  collectPyLockFileComponents,
  collectPyLockPackageProperties,
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

  it("keeps credentials and tokens from pylock tables out of properties", () => {
    const [toolProp] = collectPyLockTopLevelProperties({
      tool: {
        locker: { "index-url": "https://bot:idx-pass@pkgs.example.com/simple" },
      },
    });
    assert.strictEqual(toolProp.name, "cdx:pylock:tool");
    assert.strictEqual(
      toolProp.value,
      '{"locker":{"index-url":"https://pkgs.example.com/simple"}}',
    );
    const packageProps = collectPyLockPackageProperties({
      index: "https://pkgs.example.com/simple/?token=qry-token",
      tool: { locker: { "upload-token": "upl-secret" } },
      vcs: { type: "git", url: "https://x:git-pass@git.example.com/a.git" },
      wheels: [
        {
          name: "a-1.0-py3-none-any.whl",
          url: "https://bot:whl-pass@files.example.com/a.whl?X-Amz-Signature=sig",
        },
      ],
    });
    const byName = Object.fromEntries(
      packageProps.map((p) => [p.name, p.value]),
    );
    assert.strictEqual(
      byName["cdx:pylock:index"],
      "https://pkgs.example.com/simple/",
    );
    assert.strictEqual(
      byName["cdx:pylock:tool"],
      '{"locker":{"upload-token":"[redacted]"}}',
    );
    assert.strictEqual(
      byName["cdx:pylock:vcs"],
      '{"type":"git","url":"https://git.example.com/a.git"}',
    );
    assert.strictEqual(
      byName["cdx:pylock:wheels"],
      '[{"name":"a-1.0-py3-none-any.whl","url":"https://files.example.com/a.whl"}]',
    );
    const serialized = JSON.stringify(packageProps);
    for (const secret of [
      "qry-token",
      "upl-secret",
      "git-pass",
      "whl-pass",
      "sig",
    ]) {
      assert.ok(!serialized.includes(secret), secret);
    }
    assert.strictEqual(
      normalizePyLockRegistry("https://bot:idx-pass@pkgs.example.com/simple/"),
      "https://pkgs.example.com/simple",
    );
    const [sdistComp] = collectPyLockFileComponents(
      {
        name: "a",
        sdist: { url: "https://bot:sdist-pass@files.example.com/a.tar.gz" },
      },
      "pylock.toml",
    );
    assert.strictEqual(
      sdistComp.externalReferences[0].url,
      "https://files.example.com/a.tar.gz",
    );
    assert.ok(
      sdistComp.properties.some(
        (p) =>
          p.name === "cdx:pylock:file:url" &&
          p.value === "https://files.example.com/a.tar.gz",
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

  it("bounds the package name repeated in every artifact component", () => {
    const longName = "a".repeat(10000);
    const refName = `${"a".repeat(128)}-${createHash("sha256").update(longName).digest("hex").slice(0, 12)}`;
    const components = collectPyLockFileComponents(
      {
        name: longName,
        wheels: [{ name: "w0" }, {}],
      },
      "pylock.toml",
    );
    assert.strictEqual(components.length, 2);
    assert.strictEqual(
      components[0]["bom-ref"],
      `urn:file:pylock:${refName}:wheel:w0`,
    );
    assert.strictEqual(components[0].name, "w0");
    assert.strictEqual(components[1].name, `${refName}-wheel`);
    assert.strictEqual(
      components[1]["bom-ref"],
      `urn:file:pylock:${refName}:wheel:${refName}-wheel`,
    );
    // Two long names that share their first 128 characters stay apart.
    const [other] = collectPyLockFileComponents(
      { name: `${longName}b`, wheels: [{ name: "w0" }] },
      "pylock.toml",
    );
    assert.notStrictEqual(other["bom-ref"], components[0]["bom-ref"]);
    // A name within the bound is used as it is.
    const [short] = collectPyLockFileComponents(
      { name: "six", wheels: [{ name: "w0" }] },
      "pylock.toml",
    );
    assert.strictEqual(short["bom-ref"], "urn:file:pylock:six:wheel:w0");
  });
});

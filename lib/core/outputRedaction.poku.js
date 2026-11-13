import process from "node:process";

import { assert, describe, it } from "poku";

import { redactPackageManagerOutput } from "./outputRedaction.js";

function withEnv(variables, callback) {
  const saved = Object.fromEntries(
    Object.keys(variables).map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, variables);
    return callback();
  } finally {
    for (const [name, original] of Object.entries(saved)) {
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  }
}

describe("redactPackageManagerOutput()", () => {
  it("removes token-like segments from index URL paths", () => {
    const output = [
      "Looking in indexes: http://pypi.example.com:8080/aB3dE5fG7hJ9kL1mN2pQ/simple/",
      "Downloading https://files.example.com/packages/internal_sdk-2.4.0-py3-none-any.whl#sha256=abc",
      "GET https://registry.example.com/npm/ghp_R7mQ2xV9bT4nL8cW3zD6hJ1fS5gY0aE2uK7p/pkg",
    ].join("\n");
    const redacted = redactPackageManagerOutput(output);
    assert.ok(redacted.includes("http://pypi.example.com:8080/***/simple/"));
    assert.ok(
      redacted.includes(
        "https://files.example.com/packages/internal_sdk-2.4.0-py3-none-any.whl#sha256=abc",
      ),
    );
    assert.ok(redacted.includes("https://registry.example.com/npm/***/pkg"));
    assert.ok(!redacted.includes("aB3dE5fG7hJ9kL1mN2pQ"));
    assert.ok(!redacted.includes("ghp_"));
  });

  it("replaces the values of credential-like environment variables", () => {
    withEnv(
      {
        PIP_EXTRA_INDEX_URL: "https://pypi.internal.example/Zq7tokenRw2/",
        CDXGEN_TEST_DEPLOY_TOKEN: "Vb8nexusQz41mX",
        CDXGEN_TEST_REPO_PSW: "Ht5portalLw93cN",
        CDXGEN_TEST_SHORT_TOKEN: "abc",
      },
      () => {
        const redacted = redactPackageManagerOutput(
          "ERROR: https://pypi.internal.example/Zq7tokenRw2/ refused Vb8nexusQz41mX; Ht5portalLw93cN abc",
        );
        assert.strictEqual(redacted, "ERROR: *** refused ***; *** abc");
      },
    );
  });

  it("redacts the message of an Error without its spawn arguments", () => {
    const error = Object.assign(
      new Error("spawnSync pip ENOENT https://u:pw@host/simple?token=x"),
      { spawnargs: ["--index-url", "https://u:pw@host/simple"] },
    );
    assert.strictEqual(
      redactPackageManagerOutput(error),
      "Error: spawnSync pip ENOENT https://***:***@host/simple?***",
    );
  });

  it("stays linear on long input", () => {
    const started = performance.now();
    redactPackageManagerOutput(`${"://".repeat(50000)}${"a".repeat(50000)}`);
    assert.ok(performance.now() - started < 2000);
  });
});

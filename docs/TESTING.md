# Testing Guide

cdxgen uses [poku](https://poku.io/) as its test runner. Tests are written as `*.poku.js` files co-located next to the module they test. This page explains how to write, run, and structure those tests.

## Running tests

```bash
# run the full test suite
pnpm test

# run tests in watch mode (re-runs on file change)
pnpm run watch

# run a single test file directly
node lib/helpers/utils.poku.js
```

Configuration is in `.pokurc.jsonc`. By default poku discovers every file ending in `.poku.js` under `lib/`.

## File naming and location

| Source file | Test file |
|---|---|
| `lib/helpers/utils.js` | `lib/helpers/utils.poku.js` |
| `lib/cli/index.js` | `lib/cli/index.poku.js` |
| `lib/stages/pregen/pregen.js` | `lib/stages/pregen/pregen.poku.js` |

## Basic test anatomy

```js
import { assert, describe, it } from "poku";

import { myFunction } from "./my-module.js";

describe("myFunction()", () => {
  it("returns the expected value", () => {
    const result = myFunction("input");
    assert.strictEqual(result, "expected");
  });

  it("handles an empty string", () => {
    assert.strictEqual(myFunction(""), "");
  });
});
```

`describe`, `it`, and `assert` are re-exported from poku. `assert` is Node's built-in assert module, so all the usual methods (`strictEqual`, `deepStrictEqual`, `ok`, `throws`, etc.) are available.

For async tests, use `async`/`await`:

```js
it("fetches metadata", async () => {
  const meta = await fetchMetadata("lodash");
  assert.ok(meta.version, "version should be present");
});
```

## Using fixture files

Fixture files live in `test/` and are checked into the repository. They are the primary inputs for parser tests. Reference them with a relative path from the test file or use `import.meta.url` to build an absolute path:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "../../test/my-fixture.lock");
```

Parser functions are expected to return an empty array (not throw) when passed a path to a file that does not exist. Always add a test for the missing-file case.

## Mocking ES module dependencies with esmock

Because cdxgen is pure ESM, standard CommonJS mocking tools do not work. Use [esmock](https://github.com/iambumblehead/esmock) to replace module dependencies during a specific test.

```js
import esmock from "esmock";
import sinon from "sinon";

describe("createJavaBom() with a mocked spawn", () => {
  it("returns an empty list when spawn fails", async () => {
    const spawnStub = sinon.stub().returns({ stdout: "", stderr: "error", status: 1 });

    const { createJavaBom } = await esmock("../cli/index.js", {
      "../helpers/utils.js": {
        safeSpawnSync: spawnStub,
      },
    });

    const result = await createJavaBom("/some/path", {});
    assert.ok(result, "should still return a result");
  });
});
```

Key points when using esmock:

- Import the module under test inside `esmock()` on every test that needs it; do not share the import across tests with different stubs.
- Stub the function at the path used by the module under test, not at the path where it is defined.
- Use `sinon.stub()` for functions and `sinon.spy()` when you only need to observe calls without replacing behaviour.

## Using sinon for stubs and spies

```js
import sinon from "sinon";

// replace a function entirely
const stub = sinon.stub().returns({ stdout: "1.2.3\n", status: 0 });

// spy on a real function
const spy = sinon.spy(myModule, "parseLockFile");

// assert on calls
assert.ok(stub.calledOnce, "spawn was called once");
assert.strictEqual(stub.firstCall.args[0], "mvn");

// clean up after each test
sinon.restore();
```

Call `sinon.restore()` in an `afterEach` hook or at the end of a describe block to avoid stub leakage across tests.

## What to test

A typical parser test should cover:

- A realistic fixture file with multiple packages
- An empty or minimal fixture
- A file that does not exist (expect empty array, no throw)
- Any edge cases specific to the format (workspaces, monorepo roots, version aliases)

For `create<Language>Bom` integration tests, mock `safeSpawnSync` to return canned output rather than actually invoking the package manager. This keeps tests fast and dependency-free.

## Cross-platform assertions

Tests run on Linux, macOS, and Windows in CI. When asserting on file paths, use `path.join` or `path.normalize` rather than hardcoded `/` separators. When asserting on command strings, check the executable name only rather than the full path.

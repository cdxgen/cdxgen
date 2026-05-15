# Adding Support for a New Language or Ecosystem

This guide walks through the full process of adding cdxgen support for a new programming language or package ecosystem. It follows the same pattern used by every existing language (Go, Ruby, Dart, Haskell, etc.) and is the authoritative reference for contributors adding a new type.

## Before you start

Check `lib/helpers/utils.js` for `PROJECT_TYPE_ALIASES` to confirm the ecosystem is not already supported under a different alias. For example, `flutter` is an alias for `dart`.

## Step 1: Add project type aliases

Open `lib/helpers/utils.js` and find `PROJECT_TYPE_ALIASES`. Add a new entry for your ecosystem. The key is the canonical type name used internally; the array holds all the user-facing aliases that `--type` accepts.

```js
// lib/helpers/utils.js
export const PROJECT_TYPE_ALIASES = {
  // ... existing entries ...
  mylang: ["mylang", "mypkgmanager", "myalias"],
};
```

If your ecosystem uses a dedicated package manager that deserves its own alias, also add it to `PACKAGE_MANAGER_ALIASES` just below.

## Step 2: Write parser functions in utils.js

Most parsing logic lives in `lib/helpers/utils.js`. Add one or more functions that read your lock file or manifest and return an array of component objects.

A minimal component object looks like this:

```js
{
  name: "my-package",
  version: "1.2.3",
  purl: new PackageURL("generic", undefined, "my-package", "1.2.3", null, null).toString(),
  "bom-ref": `pkg:generic/my-package@1.2.3`,
  type: "library",
  scope: "required",
}
```

Use the `PackageURL` class from `packageurl-js` to construct purls. Never concatenate purl strings by hand.

Use `safeExistsSync`, `safeMkdirSync`, and `safeSpawnSync` instead of their raw Node.js equivalents. Guard file-system calls with `isSecureMode` checks where the operation would be unsafe.

## Step 3: Create a create&lt;Language&gt;Bom function in lib/cli/index.js

Add an async function named `create<YourLang>Bom` following the exact signature used by all other language functions:

```js
export async function createMylangBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  let parentComponent = {};

  // locate manifest or lock files
  // call your parser function(s) from utils.js
  // optionally invoke the package manager via safeSpawnSync
  // optionally fetch registry metadata

  return buildBomNSData(options, pkgList, "mylang", {
    src: path,
    dependencies,
    parentComponent,
  });
}
```

The return value of `buildBomNSData` is the standard BOM result object. Always delegate final assembly to `buildBomNSData` rather than constructing `bomJson` manually.

## Step 4: Register the function in the dispatch switch

Inside `createXBom()` in `lib/cli/index.js`, find the large `switch` or `if/else` block that dispatches to per-language functions. Add a case for your canonical type:

```js
case "mylang":
  bomData = await createMylangBom(path, options);
  break;
```

There are two dispatch blocks: one inside `createXBom` and one inside `createMultiXBom`. Make sure both handle your type so that `-t mylang` works both alone and combined with other types.

## Step 5: Add fixture files to test/

Commit at least one real-world lock file or manifest for your ecosystem to the `test/` directory. The file name should follow the convention used by other ecosystems, for example `test/Gemfile.lock` for Ruby.

These fixture files are the inputs for your unit tests.

## Step 6: Write a poku test file

Create a test file named after the module you are testing, for example `lib/helpers/mylang.poku.js` or add cases to `lib/helpers/utils.poku.js`. Follow the pattern from existing test files:

```js
import { assert, describe, it } from "poku";

import { parseMylangLock } from "./utils.js";

describe("parseMylangLock()", () => {
  it("returns components from a valid lock file", () => {
    const pkgs = parseMylangLock("test/my-fixture.lock");
    assert.ok(pkgs.length > 0, "should find at least one package");
    assert.strictEqual(pkgs[0].name, "expected-package");
  });

  it("returns an empty array for a missing file", () => {
    const pkgs = parseMylangLock("test/does-not-exist.lock");
    assert.deepStrictEqual(pkgs, []);
  });
});
```

Run `pnpm test` to check your tests pass.

## Step 7: Update PROJECT_TYPES.md

Open `docs/PROJECT_TYPES.md` and add a row for your ecosystem in the appropriate table. Include the canonical type name, all supported aliases, and the manifest or lock files that trigger automatic detection.

## Step 8: Consider a container image

If your ecosystem requires a build tool that is not present in the default cdxgen container image, raise an issue or pull request against the `ci/` directory to add a dedicated image. Follow the naming convention of existing images such as `cdxgen-debian-php84`.

## Step 9: Consider repotests coverage

If there is a well-known public repository that uses your ecosystem, add an entry to `.github/workflows/repotests.yml` to scan it in CI. This prevents regressions as other parts of cdxgen change.

## Quick checklist

- [ ] Added type aliases to `PROJECT_TYPE_ALIASES` in `lib/helpers/utils.js`
- [ ] Added parser function(s) in `lib/helpers/utils.js` (or a new helper module)
- [ ] Added `create<YourLang>Bom()` in `lib/cli/index.js`
- [ ] Registered the function in both dispatch blocks in `createXBom` / `createMultiXBom`
- [ ] Added fixture files to `test/`
- [ ] Added poku tests and confirmed they pass with `pnpm test`
- [ ] Updated `docs/PROJECT_TYPES.md`
- [ ] Considered a container image if a special SDK is required
- [ ] Considered a repotest entry

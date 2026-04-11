# GitHub Copilot instructions for cdxgen

## Project context

cdxgen is a universal polyglot CycloneDX SBOM/BOM generator written in **pure ESM JavaScript** targeting Node.js ≥ 20 (with optional Bun/Deno support). It produces CycloneDX JSON documents for dozens of language ecosystems.

---

## Module system

The project uses **ES modules only** (`"type": "module"`). Never generate `require()` calls or `module.exports`. The single CJS file (`index.cjs`) is auto-generated — do not edit it.

---

## Import style

Always use the `node:` protocol prefix for Node.js built-ins:
```js
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
```

Biome enforces this import order (with a blank line between each group):
1. `node:*` built-ins
2. npm packages
3. Local `./` or `../` imports

---

## Code style

- Formatter and linter: **Biome** (not ESLint/Prettier). Run `pnpm run lint` to auto-fix.
- Indentation: **2 spaces**.
- One binding per `const`/`let` declaration (`useSingleVarDeclarator`).
- Default parameters must be **last** in the parameter list.
- `noParameterAssign` is **off** — reassigning parameters is acceptable.
- `noForEach` is **off** — `.forEach()` is acceptable alongside `for...of`.
- Suppress individual Biome rules with `// biome-ignore <rule>: <reason>` comments.

---

## Key patterns

### `options` object threading
All public functions accept a single `options` plain object passed from the CLI. Never read `process.argv` inside library code — always use `options`:
```js
export async function createJavaBom(path, options) {
  if (options.deep) { … }
}
```

### Safe wrappers — always prefer these
```js
import { safeExistsSync, safeMkdirSync, safeSpawnSync } from "../helpers/utils.js";
// NOT: existsSync, mkdirSync, spawnSync directly
```

### PackageURL — never concatenate purl strings by hand
```js
import { PackageURL } from "packageurl-js";
const purl = new PackageURL(type, namespace, name, version, qualifiers, subpath);
const s = purl.toString();
const obj = PackageURL.fromString(purlString);
```

### HTTP requests — use `cdxgenAgent`, not raw `got`
```js
import { cdxgenAgent } from "../helpers/utils.js";
const response = await cdxgenAgent(url, { responseType: "json" });
```

### Logging
```js
import { thoughtLog, traceLog } from "../helpers/logger.js";
import { DEBUG_MODE } from "../helpers/utils.js";

thoughtLog("Resolving transitive dependencies for", pkg.name); // debug thinking
traceLog("spawn", { command: cmd, cwd: dir });                  // structured trace
if (DEBUG_MODE) console.log("verbose detail", detail);
```

### Security / secure mode
```js
import { isSecureMode } from "../helpers/utils.js";
if (isSecureMode) return; // skip operations unsafe under --permission
```

---

## File locations

| What | Where |
|---|---|
| Core BOM generation per language | `lib/cli/index.js` (`create<Language>Bom` functions) |
| Lockfile / manifest parsers | `lib/helpers/utils.js` (`parse*` functions) |
| Shared utilities, constants, env vars | `lib/helpers/utils.js` |
| Logging | `lib/helpers/logger.js` |
| Pre-generation env setup | `lib/stages/pregen/pregen.js` |
| Post-generation filtering | `lib/stages/postgen/postgen.js` |
| HTTP server | `lib/server/server.js` |

---

## Tests

Tests are co-located as **`<module>.poku.js`** files (e.g., `lib/helpers/utils.poku.js`). Use **poku** + **esmock** + **sinon**:

```js
import { assert, describe, it } from "poku";
import esmock from "esmock";
import sinon from "sinon";

describe("myFunction()", () => {
  it("returns expected value", async () => {
    const { myFunction } = await esmock("./my-module.js", {
      "../helpers/utils.js": { safeSpawnSync: sinon.stub().returns({ stdout: "" }) },
    });
    assert.strictEqual(myFunction("input"), "expected");
  });
});
```

Run tests: `pnpm test`

---

## What NOT to generate

- `require()` or `module.exports`
- `import fs from "fs"` (missing `node:` prefix)
- Direct `spawnSync` / `execSync` / `existsSync` / `mkdirSync` calls in library code
- Hand-concatenated purl strings
- Direct `import got from "got"` in library modules
- Modifications to files under `types/` (auto-generated)
- Hardcoded secrets, tokens, or credentials

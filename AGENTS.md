# AGENTS.md — cdxgen contributor guide for AI agents

This document helps AI coding agents (GitHub Copilot, Claude, Cursor, etc.) understand the cdxgen codebase conventions, architecture, and contribution rules so they can produce code that fits naturally with the existing style.

---

## Project overview

**cdxgen** is a universal, polyglot CycloneDX Bill-of-Materials (BOM) generator. It produces SBOM, CBOM, OBOM, SaaSBOM, CDXA, and VDR documents in CycloneDX JSON format. It is distributed as an npm package (`@cyclonedx/cdxgen`), a container image, and a Deno/Bun-compatible script.

Primary entry points:

- **CLI** — `bin/cdxgen.js` (calls into `lib/cli/index.js`)
- **Audit CLI** — `bin/audit.js` (`cdx-audit` predictive supply-chain audit with `console`, `json`, and `sarif` reporters)
- **Conversion CLI** — `bin/convert.js` (`cdx-convert` CycloneDX → SPDX export)
- **Library** — `lib/cli/index.js` exports `createBom`, `submitBom`
- **HTTP server** — `lib/server/server.js` (started via `bin/repl.js` or `cdxgen --server`)
- **REPL** — `bin/repl.js`

---

## Module system and runtime

- The package is **pure ESM** (`"type": "module"` in `package.json`). There is no CommonJS source except the generated `index.cjs` shim.
- The project targets **Node.js ≥ 20** with optional support for Bun and Deno (see `devEngines` in `package.json`).
- Detect the runtime with the helpers exported from `lib/helpers/utils.js`:
  ```js
  export const isNode = globalThis.process?.versions?.node !== undefined;
  export const isBun = globalThis.Bun?.version !== undefined;
  export const isDeno = globalThis.Deno?.version?.deno !== undefined;
  ```

---

## Import conventions

### Always use the `node:` protocol for built-ins

```js
// correct
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// wrong — missing node: prefix
import { readFileSync } from "fs";
```

### Import ordering (enforced by Biome)

Biome (`biome.json`) enforces this exact three-group order, with a blank line between each group:

```
1. Node built-ins   (node:*)
<blank line>
2. npm packages     (packageurl-js, semver, got, …)
<blank line>
3. Local modules    (../../helpers/utils.js, …)
```

---

## Code style (Biome)

The linter and formatter is **Biome** (not ESLint/Prettier).

| Setting   | Value                                                                                   |
| --------- | --------------------------------------------------------------------------------------- |
| Indent    | 2 spaces                                                                                |
| Formatter | enabled for `lib/**` and root JS/JSON (excludes `test/`, `data/`, `contrib/`, `types/`) |
| Linter    | enabled for the same scope                                                              |

Run locally:

```bash
pnpm run lint        # check + auto-fix
pnpm run lint:check  # check only (used in CI)
pnpm run lint:errors # errors only
```

Key rules to be aware of (see `biome.json`):

- `noUndeclaredVariables` — error. Don't leave variables undeclared.
- `noConstAssign` — error.
- `useDefaultParameterLast` — error (default params must come last).
- `useSingleVarDeclarator` — error (one binding per `const`/`let`).
- `noUnusedVariables` — warn (use `_prefix` for intentionally unused vars).
- `noParameterAssign` — **off** (reassigning parameters is allowed).
- `noForEach` — **off** (`.forEach()` is acceptable).
- `noDelete` — **off** (`delete obj.prop` is acceptable).
- `noAssignInExpressions` — **off**.
- Comments starting with `// biome-ignore` are the escape hatch for individual rule suppressions.

---

## Repository layout

```
bin/             CLI entry points (audit.js, cdxgen.js, convert.js, evinse.js, repl.js, verify.js, sign.js, validate.js)
lib/
  audit/         Predictive supply-chain audit engine, scoring, progress, and reporters for `cdx-audit`
  cli/           Core BOM generation logic (index.js ~9 000 lines)
  evinser/       Evinse / SaaSBOM evidence generation
  helpers/
    analyzer.js         JS/TS import/export analysis
    caxa.js             Caxa (self-extracting) executable parsing
    cbomutils.js        Cryptography BOM helpers
    db.js               SQLite / atom DB helpers
    depsUtils.js        mergeDependencies + trimComponents (shared BOM dependency utilities)
    display.js          Terminal output tables and summaries
    dotnetutils.js      .NET assembly / NuGet utilities
    envcontext.js       Git, env info, tool availability checks
    formulationParsers.js  CycloneDX formulation section builder; addFormulationSection()
    logger.js           thoughtLog / traceLog / THINK_MODE / TRACE_MODE
    protobom.js         Protobuf-based BOM utilities
    pythonutils.js      Python venv / conda helpers
    utils.js            ~18 000-line utility module; most parsing functions live here
    bomValidator.js        CycloneDX JSON schema validation
  managers/
    docker.js           Docker daemon / OCI operations
    oci.js              OCI image layer extraction
    piptree.js          pip dependency tree
  parsers/
    iri.js              IRI reference validator
    npmrc.js            .npmrc parser
  server/
    server.js           connect-based HTTP server
  stages/
    postgen/            Post-processing (annotator.js, postgen.js)
    pregen/             Pre-generation env setup (pregen.js, envAudit.js)
  third-party/
    arborist/           Forked npm arborist for workspace support
data/            Static data files (license SPDX list, frameworks list, …)
test/            Sample lockfiles, manifests, and fixtures used by poku tests
types/           Auto-generated TypeScript `.d.ts` declarations (do not edit)
docs/            Documentation (Markdown)
plugins/         cdxgen plugin entry point stubs
contrib/         Community scripts (not linted)
ci/              Dockerfiles for CI images
tools_config/    Tool configuration files
```

---

## Key abstractions

### `options` object

Every public function accepts a single `options` plain object. It is created by the CLI argument parser in `bin/cdxgen.js` and threaded through the entire call chain without mutation. When adding new CLI flags, add them to the yargs builder in `bin/cdxgen.js` **and** pass them through `options` — never read `process.argv` directly inside library code.

### `createBom(path, options)` — `lib/cli/index.js`

The top-level export. Dispatches to per-language `create*Bom` functions based on `options.projectType`. Returns `{ bomJson, dependencies, parentComponent, … }`.

### `postProcess(bomNSData, options)` — `lib/stages/postgen/postgen.js`

Runs after BOM generation: filtering, standards application, metadata enrichment, formulation population, and annotations. It is called **exactly once** per BOM generation cycle — by `bin/cdxgen.js` and `lib/server/server.js` — after `createBom` returns.

**Any logic that must execute exactly once across all language types must live here**, not inside `buildBomNSData` (which is invoked once per language type and therefore runs multiple times for multi-type projects).

### `prepareEnv(filePath, options)` — `lib/stages/pregen/pregen.js`

Runs before BOM generation to install missing build tools via sdkman, nvm, rbenv, etc.

### PackageURL

---

## BOM generation pipeline

Understanding the call chain is critical to placing new logic in the right spot.

```
bin/cdxgen.js (or server.js)
  └── createBom(path, options)                     lib/cli/index.js
        ├── createXBom(path, options)              — single project type
        │     └── create<Language>Bom(path, options)
        │           └── buildBomNSData(options, pkgList, ptype, context)
        │                 — called ONCE PER LANGUAGE TYPE
        │                 — returns { bomJson, nsMapping, dependencies, parentComponent, formulationList? }
        │
        └── createMultiXBom(pathList, options)     — multiple types or container
              ├── createXBom() × N  (one per type/path)
              └── dedupeBom()  →  merges all per-type results
  └── postProcess(bomNSData, options)              lib/stages/postgen/postgen.js
        — called EXACTLY ONCE after createBom returns
        — correct place for: formulation, annotations, filtering, metadata enrichment
```

### Key implication: multi-invocation of `buildBomNSData`

`buildBomNSData` is called once **per language type**. A command like
`cdxgen -t js,java,python` triggers three separate calls. Any side-effect
placed inside `buildBomNSData` will run three times.

**Rule:** Logic that must execute once per BOM (e.g. formulation, final
annotations, global deduplication) belongs in `postProcess`, not in
`buildBomNSData` or `createMultiXBom`.

### Forwarding per-language data to `postProcess`

When a per-language step produces data that `postProcess` needs (e.g. Pixi
lock formulation components), attach it to `bomNSData` before returning:

```js
// inside buildBomNSData:
if (context?.formulationList?.length) {
  bomNSData.formulationList = context.formulationList;
}
```

`postProcess` can then read `bomNSData.formulationList` and incorporate it
into the single formulation section it builds.

---

## Module layering rules

The dependency graph between source layers is strictly one-directional:

```
lib/helpers/*          (no imports from cli/ or stages/)
      ↓
lib/cli/index.js       (imports from helpers/*)
      ↓
lib/stages/postgen/    (imports from helpers/*, NOT from cli/index.js)
bin/cdxgen.js          (imports from cli/ and stages/)
lib/server/server.js   (imports from cli/ and stages/)
```

**Never import `lib/cli/index.js` from inside `lib/helpers/` or `lib/stages/`.**
Shared utilities used by both layers must live in a helper module:

| Utility                 | Location                            |
| ----------------------- | ----------------------------------- |
| `mergeDependencies`     | `lib/helpers/depsUtils.js`          |
| `trimComponents`        | `lib/helpers/depsUtils.js`          |
| `addFormulationSection` | `lib/helpers/formulationParsers.js` |

If you find yourself writing `import { … } from "../../cli/index.js"` inside
a helper or stage module, **stop and extract the function to `lib/helpers/`
first**.

---

### PackageURL

```js
import { PackageURL } from "packageurl-js";

// construct
const purl = new PackageURL(
  type,
  namespace,
  name,
  version,
  qualifiers,
  subpath,
);
// parse
const purlObj = PackageURL.fromString(purlString);
// serialise
const s = purl.toString();
```

Never construct purl strings by hand-concatenation.

### HTTP requests

All outbound HTTP is done through `cdxgenAgent` (a `got` instance with retries, timeout, and proxy support), exported from `lib/helpers/utils.js`. Never import `got` directly in new code — use `cdxgenAgent` or pass it through the `options` object.

---

## Logging conventions

| Function                                              | Purpose                             | Activation                                              |
| ----------------------------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| `console.log` / `console.warn` / `console.error`      | Operational messages                | Always                                                  |
| `thoughtLog(msg, args?)` from `lib/helpers/logger.js` | Internal reasoning / debug thinking | `CDXGEN_THINK_MODE=true` or `CDXGEN_DEBUG_MODE=verbose` |
| `traceLog(type, args)` from `lib/helpers/logger.js`   | Structured trace of commands & HTTP | `CDXGEN_TRACE_MODE=true` or `CDXGEN_DEBUG_MODE=verbose` |
| `DEBUG_MODE` constant from `lib/helpers/utils.js`     | Guards verbose `console.log` calls  | `CDXGEN_DEBUG_MODE=debug` or `debug`                    |

Prefer `thoughtLog` over ad-hoc `console.log` for introspective messages inside core logic so they can be silenced in production.

---

## Security conventions

cdxgen has a _secure mode_ (`CDXGEN_SECURE_MODE=true` or running under Node.js `--permission`). Guards:

```js
import { isSecureMode } from "../helpers/utils.js";
if (isSecureMode) {
  /* skip risky operation */
}
```

Always use the safe wrappers rather than the raw Node.js equivalents:
| Safe wrapper | Replaces |
|---|---|
| `safeExistsSync(path)` | `existsSync(path)` |
| `safeMkdirSync(path, opts)` | `mkdirSync(path, opts)` |
| `safeSpawnSync(cmd, args, opts)` | `spawnSync(cmd, args, opts)` |

`safeSpawnSync` also validates `cmd` against `CDXGEN_ALLOWED_COMMANDS` and records every invocation in `commandsExecuted`.

For user-supplied strings that will be used in file paths or URLs, check `hasDangerousUnicode(str)` and `isValidDriveRoot(root)` (Windows) before use.

Environment variables from `auditEnvironment` (`lib/stages/pregen/envAudit.js`) are checked at startup to detect dangerous `NODE_OPTIONS` values.

When adding or modifying **external-facing features** (SCM/network integrations like release notes, git metadata, repository lookups), treat all input values as untrusted by default:

- Validate git refs/tags/branches with `isSafeGitRefName()` before using them in git revision/range arguments.
- Prefer parsing helpers that normalize and filter unsafe refs before selection.
- Never pass user/remote-derived refs directly into `git log`/`git` revision arguments without validation.
- Use `hardenedGitCommand()` (or `safeSpawnSync` wrappers where applicable) instead of raw process execution.
- Use `cdxgenAgent` for outbound HTTP and source tokens from `options`/environment without logging credentials.

### BOM property-value hygiene

When emitting CycloneDX `properties`, annotations, evidence objects, or service/component metadata, treat **every value** as potentially secret-bearing unless it is already a small, enumerated, non-sensitive token.

- Never emit raw secrets or likely secret carriers into BOM fields, including:
  - bearer tokens, API keys, passwords, client secrets, cookies, session IDs, private keys, signed URLs, or authorization headers
  - raw environment variable values, command-line arguments, header values, or config blobs that may contain credentials
  - free-form copied text from user/config-controlled sources when it could embed secrets
- Prefer **booleans, counts, categories, and field names** over raw values. For example:
  - `credentialExposure=true`
  - `credentialIndicatorCount=3`
  - `credentialExposureFieldCount=2`
  - `credentialReferenceCount=1`
  - `header:Authorization` as a field label is acceptable; the header value is not
- Treat URLs and URIs as untrusted. Before emitting them, remove or avoid:
  - query strings and fragments
  - `userinfo` (`https://user:pass@host/...`)
  - signed-token parameters such as `token`, `sig`, `signature`, `X-Amz-Signature`, `X-Goog-Signature`, `access_token`, `id_token`, `client_secret`, `api_key`, and similar aliases
- Treat command strings as untrusted. Do not emit full commands when arguments may contain credentials; prefer the executable name, transport type, or a redacted/summarized form instead.
- Treat free-text mirrored metadata as untrusted. Fields such as `cdx:agent:description`, `cdx:skill:metadata`, `cdx:agent:permission`, `cdx:crewai:*`, `cdx:mcp:description`, `cdx:mcp:resourceUri`, `cdx:mcp:configuredEndpoints`, `cdx:mcp:command`, and future `cdx:mcp:auth:*` values must be reviewed for secret-bearing content before being added.
- If a value is useful for analysis but may contain credentials, emit a safe derivative instead (count, host, scheme, basename, allowlisted enum, or `"redacted"` marker).
- Add or update tests whenever new emitted properties are introduced to assert that secrets are not copied into BOM output.

---

## Environment variables

All cdxgen-specific variables use the `CDXGEN_` prefix (or well-known tool-specific names like `JAVA_HOME`, `PYTHON_CMD`, etc.). Environment variables are declared as module-level constants in `lib/helpers/utils.js`:

```js
export const DEBUG_MODE =
  ["debug", "verbose"].includes(process.env.CDXGEN_DEBUG_MODE) ||
  process.env.SCAN_DEBUG_MODE === "debug";
```

Do not read `process.env.CDXGEN_*` inside deep library functions — export the derived constant from `utils.js` and import it instead. See `docs/ENV.md` for the full list of supported variables.

---

## Adding support for a new language/ecosystem

1. Add a `create<Language>Bom(path, options)` function in `lib/cli/index.js`, following the same signature and return shape as the existing functions.
2. Add parser functions in `lib/helpers/utils.js` (for lock file / manifest parsing) or a new helper module under `lib/helpers/`.
3. Register the new project type in `PROJECT_TYPE_ALIASES` and `PACKAGE_MANAGER_ALIASES` in `lib/helpers/utils.js`.
4. Add a dispatch branch in `createXBom` / `createBom` in `lib/cli/index.js`.
5. Update `docs/PROJECT_TYPES.md`.
6. Add fixture files to `test/` and cover with a `*.poku.js` test.
7. If updating OSQuery table metadata in `data/queries*.json` (for example `purlType` or `componentType`), review all platform variants (`queries.json`, `queries-win.json`, and `queries-darwin.json`) and keep shared table entries aligned.
8. Always consider adding/expanding `repotests.yml` coverage with a representative public repository for the ecosystem change; if a stable public repo is not practical, add fixture-backed repo tests under `test/data/` and exercise them from `repotests.yml`.

---

## Testing

### Framework: poku

Tests are co-located with the source as **`<module>.poku.js`** files. The test runner is [poku](https://poku.io/).

```
lib/helpers/utils.poku.js         ← tests for utils.js
lib/helpers/pythonutils.poku.js   ← tests for pythonutils.js
lib/cli/index.poku.js             ← tests for index.js
lib/stages/pregen/envAudit.poku.js
…
```

Configuration is in `.pokurc.jsonc`:

```jsonc
{
  "include": ["lib"],
  "filter": ".poku.js",
  "reporter": "verbose",
}
```

Run all tests:

```bash
pnpm test
```

Watch mode:

```bash
pnpm run watch
```

### Cross-platform test expectations

- Treat every unit/integration test as cross-platform unless a test is explicitly platform-scoped.
- Always check string/path assertions against Windows and POSIX path separator differences (`\` vs `/`).
- Prefer `node:path` helpers, normalization, or separator-agnostic assertions over hard-coded path literals in tests.
- When adding or changing tests that inspect file paths, temp directories, command arguments, or serialized activity/log output, verify they still pass on Windows runners and do not assume `/tmp`-style paths.

### Review feedback handling

- Before finalizing work, review feedback from automated code review or validation tools.
- If a review comment is valid, fix it in the same change rather than leaving it behind.
- If a review comment is not valid, document why it was not applied in the final summary.
- Thoroughness is preferred over speed when resolving valid review feedback.

### Test anatomy

```js
import { strict as assert } from "node:assert"; // or:
import { assert, describe, it, test } from "poku";

import { myFunction } from "./my-module.js";

describe("myFunction()", () => {
  it("does X when Y", () => {
    const result = myFunction(input);
    assert.strictEqual(result, expected);
  });
});
```

- Use `assert` and `describe`/`it`/`test` from `poku` (they re-export Node's assert plus test grouping).
- For async tests, return the promise or use `async`/`await` inside `it`/`test`.
- For tests that need to mock ES-module dependencies, use **esmock** + **sinon**:

```js
import esmock from "esmock";
import sinon from "sinon";

const gotStub = sinon.stub().returns({ json: sinon.stub().resolves({}) });
gotStub.extend = sinon.stub().returns(gotStub);

const { submitBom } = await esmock("./index.js", { got: { default: gotStub } });
```

- Test files are **excluded from the Biome linter** (`"!test/**"` in `biome.json`), so slightly looser style is acceptable there, but still follow the same import conventions.
- TypeScript generation (`pnpm run gen-types`) excludes `*.poku.js` files via `tsconfig.json`.

---

## TypeScript types

Types are generated — do not write or edit files under `types/` manually. Source JSDoc is the source of truth:

```js
/**
 * Parses a Cargo.lock file and returns a list of component objects.
 *
 * @param {string} cargoLockFile Path to Cargo.lock
 * @param {Object} options CLI options
 * @returns {Object[]} Array of component objects
 */
export function parseCargoData(cargoLockFile, options) { … }
```

Regenerate after adding/changing public function signatures:

```bash
pnpm run gen-types
```

---

## CI overview

| Workflow             | Trigger             | What it does                                        |
| -------------------- | ------------------- | --------------------------------------------------- |
| `nodejs.yml`         | PR / push to master | Unit tests (poku) on a matrix of Node versions × OS |
| `lint.yml`           | PR / push to master | `pnpm run lint:check` (Biome)                       |
| `repotests.yml`      | PR / push to master | Integration tests against real projects             |
| `snapshot-tests.yml` | PR / push           | Snapshot comparisons of generated BOMs              |
| `codeql.yml`         | Push / schedule     | CodeQL security analysis                            |
| `build-image.yml`    | PR / push           | Docker image builds                                 |

Node versions to test against are read from `.versions/node_*` files (not hardcoded). OS matrix: Ubuntu 22.04, Ubuntu 24.04, Windows, macOS (both x64 and ARM).

All GitHub Actions workflows pin action SHA digests and have `permissions: {}` at the job level (least-privilege).

---

## Dependency management

- Package manager: **pnpm ≥ 10** (`packageManager` field in `package.json`).
- Install: `pnpm install --config.strict-dep-builds=true --frozen-lockfile --package-import-method copy`
- Do not use `npm` or `yarn`.
- Runtime dependencies are in `dependencies`; test/dev tools in `devDependencies`; optional heavy packages (atom, protobuf, server middleware) in `optionalDependencies`.
- Dependency updates are managed by Renovate (see `renovate.json`). Do not bump dependency versions in PRs unless directly required.

---

## What to avoid

- **Do not** import `got` directly in new library code — use `cdxgenAgent` from `lib/helpers/utils.js`.
- **Do not** use `spawnSync` / `execSync` directly — use `safeSpawnSync`.
- **Do not** use `existsSync` / `mkdirSync` directly — use `safeExistsSync` / `safeMkdirSync`.
- **Do not** construct PURL strings by concatenation — use `new PackageURL(…).toString()`.
- **Do not** read `process.argv` inside library modules — accept options via the `options` object.
- **Do not** commit secrets, tokens, or credentials.
- **Do not** copy raw secret-bearing values into emitted BOM properties, annotations, evidence, endpoints, or service metadata; aggregate, classify, or redact them instead.
- **Do not** modify generated files under `types/` directly.
- **Do not** add `console.log` debug statements to production code without gating them on `DEBUG_MODE` or replacing them with `thoughtLog`.
- **Do not** add or update `pnpm-lock.yaml` unless changing `package.json` dependencies.
- **Do not** import from `lib/cli/index.js` inside `lib/helpers/*` or `lib/stages/*` — this creates a circular-like cross-layer dependency. Extract the shared function to `lib/helpers/` instead.
- **Do not** add logic that must execute once-per-BOM inside `buildBomNSData` — it is called once per language type. Use `postProcess` in `lib/stages/postgen/postgen.js` instead.

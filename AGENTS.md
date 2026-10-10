# AGENTS.md — cdxgen contributor guide for AI agents

This document helps AI coding agents (GitHub Copilot, Claude, Cursor, etc.) understand the cdxgen codebase conventions, architecture, and contribution rules so they can produce code that fits naturally with the existing style.

---

## Project overview

**cdxgen** is a universal, polyglot CycloneDX Bill-of-Materials (BOM) generator. It produces SBOM, CBOM, OBOM, SaaSBOM, CDXA, and VDR documents in CycloneDX JSON format. It is distributed as an npm package (`@cdxgen/cdxgen`), a container image, and a Deno/Bun-compatible script.

Primary entry points:

- **CLI** — `bin/cdxgen.js` (calls into `lib/cli/index.js`)
- **Audit CLI** — `bin/audit.js` (`cdx-audit` predictive supply-chain audit with `console`, `json`, and `sarif` reporters)
- **Conversion CLI** — `bin/convert.js` (`cdx-convert` CycloneDX → SPDX export)
- **Library** — `lib/cli/index.js` exports `createBom`, `submitBom`
- **HTTP server** — `lib/server/server.js` (started via `bin/repl.js` or `cdxgen --server`)
- **REPL** — `bin/repl.js`

Companion binaries:

- cdxgen opportunistically uses the optional companion package/repo **`cdxgen-plugins-bin`** for heavyweight native helpers such as **Trivy**, **osquery**, **SourceKitten**, **dosai**, and **golem**.
- Dynamic SBOM generation via **tracebom** depends only on `@cdxgen/safer-exec` + `@cdxgen/cdx-proto` from optional deps. No atom, no plugins-bin, no hbom.
- Container/rootfs inventory flows through `lib/managers/binary.js` and may combine native parsing with plugin-enriched Trivy output.
- Live-OS OBOM flows use the bundled osquery binary plus the query packs under `data/queries*.json`. Linux query packs also include hardening-focused snapshots such as `sysctl_hardening` and `mount_hardening`.
- When the optional `trustinspector` helper is present, host-path trust enrichment should be treated as batched rather than artificially capped. Keep Authenticode, WDAC, code-signing, and notarization properties intact across large inventories.
- GTFOBins enrichment is expected on Linux live-runtime osquery components in the same way LOLBAS enrichment is expected on Windows runtime components.
- Go Evinse flows use the bundled `golem` helper when available. Keep `cdx:golem:*` metadata and component properties safe, compact, and policy-friendly: counts, categories, scopes, source locations, data-flow rule IDs, taint-kind labels, crypto algorithm names/OIDs, and module facts are acceptable, but do not emit raw generator commands, environment values, HTTP parameter values, raw key material, embedded file contents, generated source contents, or secrets.

---

## Module system and runtime

- The package is **pure ESM** (`"type": "module"` in `package.json`). There is no CommonJS source except the generated `index.cjs` shim.
- The project targets **Node.js ≥ 24** with optional support for Bun and Deno (see `devEngines` in `package.json`).
- Detect the runtime with the helpers exported from `lib/ecosystems/utils.js`:
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
2. npm packages     (@cdxgen/cdx-purl, semver, undici, …)
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
pnpm run lint:check  # check only (only for CI)
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

### Prefer deterministic parsing over monolithic regexes

- For filenames, URLs, refs, manifests, and other untrusted or user-controlled text, prefer `split()`, `startsWith()`, `endsWith()`, `indexOf()`, and small anchored validators over a single large parsing regex.
- Avoid regexes with nested quantifiers, overlapping alternations, or ambiguous greedy groups (for example `(...*)*`, broad `.*`/`[\s\S]*` capture chains, or long optional hyphen-separated groups) because they are harder to review and can trigger CodeQL inefficient-regular-expression findings.
- If regex is still the clearest tool, keep it linear-time, anchored, and narrowly scoped to one token at a time.

---

## Repository layout

```
.agents/         Agent-facing skills and workspace configuration (see .agents/README.md)
bin/             CLI entry points (audit.js, cdxgen.js, convert.js, evinse.js, repl.js, verify.js, sign.js, validate.js)
lib/
  audit/         Predictive supply-chain audit engine, scoring, progress, and reporters for `cdx-audit`
  cli/           Core BOM generation logic (index.js ~9 000 lines)
  evinser/       Evinse / SaaSBOM evidence generation
  helpers/
    analyzer.js         JS/TS import/export analysis, MCP inventory, and crypto-aware AST extraction
    asarutils.js        Electron ASAR parsing, file inventory, hashes, and embedded manifest extraction
    caxa.js             Caxa (self-extracting) executable parsing
    cbomutils.js        Cryptography BOM helpers, OID lookup, and source-derived algorithm inventory
    db.js               SQLite / atom DB helpers
    depsUtils.js        mergeDependencies + trimComponents (shared BOM dependency utilities)
    display.js          Terminal output tables and summaries
    dotnetutils.js      .NET assembly / NuGet utilities
    dynamic.js          Dynamic process tracing SBOM generator
    envcontext.js       Git, env info, tool availability checks
    formulationParsers.js  CycloneDX formulation section builder; addFormulationSection()
    golem.js            Go Evinse helper integration, Golem invocation, and cdx:golem evidence mapping
    inventoryStats.js   Shared filters and counters for unpackaged native files and source-derived crypto pivots
    logger.js           thoughtLog / traceLog / THINK_MODE / TRACE_MODE
    osPackageResolver.js  Map dynamic libraries to operating system packages
    protobom.js         Protobuf-based BOM utilities
    pythonutils.js      Python venv / conda helpers
    traceRunner.js      Execute commands under safer-exec tracing and collect loaded library paths
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

### Go Evinse with Golem

`evinse -l go` calls `lib/ecosystems/golem.js`, which resolves the optional `golem` plugin binary, runs `golem analyze --format json`, and maps the report into CycloneDX evidence. Occurrences and call-stack frames are attached to matching Go module purls. Data-flow traces are mapped to occurrence and call-stack evidence when `--deep`, `--with-data-flow`, `--profile research`, or explicit `--golem-dataflow` options are used. Metadata-level `cdx:golem:*` properties are appended to `bom.metadata.component`; component-level `cdx:golem:*` properties are appended to matching dependency components; crypto evidence can add schema-valid `cryptographic-asset` components without purls.

Keep this path layered as `bin/evinse.js` → `lib/evinser/evinser.js` → `lib/ecosystems/golem.js`. Do not import CLI modules from helpers. When adding Golem evidence, update `docs/GO_EVINSE_GOLEM.md`, `docs/CUSTOM_PROPERTIES.md`, `docs/EVINSE.md`, `docs/GO_EVINSE_GOLEM_THREAT_MODEL.md`, `docs/BOM_AUDIT.md`, `docs/LESSON14.md`, repo-test assertions in `.github/workflows/repotests.yml`, and the REPL commands in `bin/repl.js` if the new property creates a useful analyst pivot.

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

Every directory under `lib/` belongs to a numbered layer, and an import may only
reach a strictly lower layer. `contrib/check-boundaries.js` owns the table and
enforces it: `node contrib/check-boundaries.js --strict` must report zero cycles
and zero violations.

| Layer | Directories                                               |
| ----- | --------------------------------------------------------- |
| 0     | `lib/core`                                                |
| 1     | `lib/parsers`                                             |
| 2     | `lib/inventory`, `lib/helpers`                            |
| 3     | `lib/ecosystems`                                          |
| 4     | `lib/managers`, `lib/stages/pregen`, `lib/stages/postgen` |
| 5     | `lib/cli`, `lib/evinser`, `lib/validator`                 |
| 6     | `lib/server`, `lib/audit`                                 |

`lib/third-party` is vendored and opts out of the rule.

**Never import `lib/cli/index.js` from a lower layer.** A utility both layers
need belongs in a layer both can reach:

| Utility                 | Location                              |
| ----------------------- | ------------------------------------- |
| `mergeDependencies`     | `lib/inventory/depsUtils.js`          |
| `trimComponents`        | `lib/inventory/depsUtils.js`          |
| `addFormulationSection` | `lib/inventory/formulationParsers.js` |

Go Evinse/Golem evidence mapping belongs in `lib/ecosystems/golem.js`; the
enriched BOM write-back belongs in `lib/evinser/evinser.js`. Do not move that
logic into post-processing — Evinse is a separate enrichment command over an
existing BOM.

If you find yourself writing `import { … } from "../../cli/index.js"` in a lower
layer, **stop and extract the function downward first**.

---

### Package URLs

Purls are built with `@cdxgen/cdx-purl` through the helpers in
`lib/inventory/purl.js`, which apply the registered per-type rules (namespace
requirements, permitted qualifiers, normalisation):

```js
import { applyPurl, tryBuildPurl } from "../inventory/purl.js";

const purl = tryBuildPurl({
  type: "npm",
  namespace: "@scope",
  name: "pkg",
  version: "1.0.0",
});
// null when the coordinates cannot form a valid purl — drop the purl rather
// than emitting an invalid one.
applyPurl(component, purl, `library:${name}:${version}`);
```

Never build a purl by string concatenation: it skips encoding and qualifier
validation, which is how `pkg:generic/name#/abs/path` and `pkg:npm/test@` once
reached CI. Never invent a purl `type` that cdx-purl has no rules for — use
`pkg:generic` with a `cdx:purl:proposedType` property instead.

### Hashes

An integrity string belongs in `hashes[]`, never in a property. Set
`_integrity` on the package (`sha512-<base64>` for npm/ssri, `sha256-<base64>`
for Go sums) and `processHashes` converts it into a CycloneDX `hashes[]` entry
with the digest hex-encoded, so the same artefact hashes identically whichever
collector found it.

### Custom properties

Every `cdx:` property must be described in `docs/CUSTOM_PROPERTIES.md`.
`lib/customProperties.poku.js` fails the build when a new namespace appears
without documentation.

### Cryptographic assets and OS trust material

- **Do not assign a purl to `type: "cryptographic-asset"` components.** cdxgen intentionally suppresses purls for cryptographic assets.
- Use schema-valid `cryptoProperties.assetType` values only:
  - `certificate` for certificates such as `secureboot_certificates`
  - `related-crypto-material` for trusted key files, kernel keys, and similar key material
- Source-derived `assetType: "algorithm"` components must carry a known `cryptoProperties.oid`. If a detected algorithm cannot be mapped to an OID, skip it rather than emitting a validator-breaking component.
- Current OS/container trust-material conventions:
  - repository sources (`apt`, `ppa`, `yum`) → `type: "data"` with `cdx:os:repo:*` properties
  - trusted key files → `type: "cryptographic-asset"` with `cryptoProperties.relatedCryptoMaterialProperties.type = "public-key"`
  - repo-to-key trust relationships should be represented in `dependencies` when the source file explicitly references a key (`signed-by`, `gpgkey`, etc.)
- If you add new osquery- or rootfs-derived crypto inventory, validate it against `lib/validator/bomValidator.js` expectations and the CycloneDX schema files under `data/`.

### Go Evinse and Golem property hygiene

- Preserve `cdx:golem:*` as small strings: counts, booleans, enums, source locations, module paths, and comma-separated scope/category lists.
- Preserve data-flow and crypto-flow evidence as categories, rule IDs, confidence/severity labels, taint kinds, source locations, and call-stack frames. Do not emit raw source values, key material, plaintext, ciphertext, HTTP parameter values, environment values, generated source contents, or full command lines.
- Do not emit raw `go:generate` command strings, raw environment values, embedded file contents, generated source contents, or full command lines.
- Prefer scope-aware policy signals. `cdx:golem:usageScopes=runtime` is a stronger release signal than test-only usage; `cdx:golem:testOnly=true` is useful triage context but should not be treated as proof of no risk.
- Prefer bounded defaults for data-flow in CI: `--deep` or `--with-data-flow --golem-dataflow crypto` with capped workers, capped `--golem-max-procs`, slice/trace limits, generated-file skipping, and tests skipped unless `--golem-tests` is required.
- Keep BOM audit rules in `data/rules/golem-go.yaml` aligned with emitted property names and document new rules in `docs/BOM_AUDIT.md`.
- Keep `cdxi` pivots aligned with the analyst flow: `.golemsummary` for run context, `.golemhotspots` for risk review, and `.golemcoverage` for evidence coverage.

### HTTP requests

All outbound HTTP is done through `cdxgenAgent`, exported from `lib/ecosystems/utils.js`. It is a small [undici](https://github.com/nodejs/undici)-backed, `got`-compatible client created by `createHttpClient()` in `lib/core/httpClient.js` — it supports `.get`/`.post`/`.put`/`.head`, `.extend()`, `responseType`, `throwHttpErrors`, `followRedirect`, timeouts, and `beforeRequest`/`afterResponse`/`beforeError` hooks (which power dry-run enforcement, host allow-listing, network-activity recording, and HTTP trace logging). It also keeps an in-memory GET response cache for the run; `CDXGEN_NO_CACHE` and `--no-cache` turn off only the on-disk caches. The cache keys on the URL, the response type and a digest of the request headers, so responses fetched with different credentials never mix; pass `cache: false` for anything short-lived, such as a token exchange. A `beforeNetwork` hook runs only when a request misses the cache, which is how `withHostRateLimit(url, issue, { deferGate: true })` in `lib/inventory/fetchBatch.js` keeps cached reads from waiting for a rate-limit slot. Read Maven POMs, jars and hashes through `lib/inventory/jvmLocalRepos.js` before going to a remote repository. Never talk to the network directly (raw `undici`, `fetch`, `http`, etc.) in new code — use `cdxgenAgent`, or pass it through the `options` object. The one exception is Docker/Podman daemon communication, which uses the unix-socket/TLS connection helper in `lib/managers/dockerConnection.js`.

---

## Logging conventions

| Function                                             | Purpose                             | Activation                                              |
| ---------------------------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| `console.log` / `console.warn` / `console.error`     | Operational messages                | Always                                                  |
| `thoughtLog(msg, args?)` from `lib/core/logger.js`   | Internal reasoning / debug thinking | `CDXGEN_THINK_MODE=true` or `CDXGEN_DEBUG_MODE=verbose` |
| `traceLog(type, args)` from `lib/core/logger.js`     | Structured trace of commands & HTTP | `CDXGEN_TRACE_MODE=true` or `CDXGEN_DEBUG_MODE=verbose` |
| `DEBUG_MODE` constant from `lib/ecosystems/utils.js` | Guards verbose `console.log` calls  | `CDXGEN_DEBUG_MODE=debug` or `debug`                    |

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

| Safe wrapper                     | Replaces                     |
| -------------------------------- | ---------------------------- |
| `safeExistsSync(path)`           | `existsSync(path)`           |
| `safeMkdirSync(path, opts)`      | `mkdirSync(path, opts)`      |
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

All cdxgen-specific variables use the `CDXGEN_` prefix (or a well-known
tool-specific name such as `JAVA_HOME` or `PYTHON_CMD`). `docs/ENV.md` lists
every supported variable.

Read them with `readEnvironmentVariable` from `lib/core/activity.js`, never
`process.env` directly — the helper records the read so dry-run mode can report
which variables a scan consulted:

```js
import { readEnvironmentVariable } from "../core/activity.js";

const target = readEnvironmentVariable("BAZEL_TARGET") || "//...";
```

Variables that gate behaviour globally are derived once into a module-level
constant and imported, rather than re-read deep in a call stack:

```js
export const DEBUG_MODE =
  ["debug", "verbose"].includes(readEnvironmentVariable("CDXGEN_DEBUG_MODE")) ||
  readEnvironmentVariable("SCAN_DEBUG_MODE") === "debug";
```

---

## Adding support for a new language/ecosystem

1. Add a `create<Language>Bom(path, options)` function in `lib/cli/index.js`, following the same signature and return shape as the existing functions.
2. Add parser functions in `lib/ecosystems/utils.js` (for lock file / manifest parsing) or a new helper module under `lib/helpers/`.
3. Register the new project type in `PROJECT_TYPE_ALIASES` and `PACKAGE_MANAGER_ALIASES` in `lib/ecosystems/utils.js`.
4. Add a dispatch branch in `createXBom` / `createBom` in `lib/cli/index.js`.
5. Update `docs/PROJECT_TYPES.md`.
6. Add fixture files to `test/` and cover with a `*.poku.js` test.
7. If updating OSQuery table metadata in `data/queries*.json` (for example `purlType` or `componentType`), review all platform variants (`queries.json`, `queries-win.json`, and `queries-darwin.json`) and keep shared table entries aligned.
8. Always consider adding/expanding `repotests.yml` coverage with a representative public repository for the ecosystem change; if a stable public repo is not practical, add fixture-backed repo tests under `test/data/` and exercise them from `repotests.yml`.
9. For container/rootfs or OBOM feature work, also review the companion integration surfaces that usually need to stay aligned: `lib/managers/binary.js`, `lib/managers/binary.poku.js`, `lib/managers/binary.e2e.poku.js`, `lib/stages/postgen/auditBom.poku.js`, `ci/dockertests.sh`, `ci/assertions.sh`, `data/component-tags.json`, `bin/repl.js`, and any relevant docs/rules.
10. For CBOM source-analysis work, keep `lib/inventory/analyzer.js`, `lib/inventory/analyzer.poku.js`, `lib/inventory/cbomutils.js`, and the `createCryptoCertsBom()` path in `lib/cli/index.js` aligned. The analyzer is intentionally lightweight, so prefer conservative constant propagation over broad speculative inference.

---

## Testing

### Framework: poku

Tests are co-located with the source as **`<module>.poku.js`** files. The test runner is [poku](https://poku.io/).

```
lib/ecosystems/utils.poku.js         ← tests for utils.js
lib/ecosystems/pythonutils.poku.js   ← tests for pythonutils.js
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

### Container / OBOM regression coverage

- **Unit coverage:** use `lib/managers/binary.poku.js` for rootfs/container parsing logic, repository-source parsing, trusted-key modeling, and osquery invocation behavior.
- **Rule coverage:** use `lib/stages/postgen/auditBom.poku.js` when changing `data/rules/*.yaml`, `lib/inventory/auditCategories.js`, or hardening-related query packs.
- **Analyzer coverage:** use `lib/inventory/analyzer.poku.js`, `lib/inventory/cbomutils.poku.js`, and `lib/ecosystems/utils.poku.js` when changing crypto-aware AST extraction, GTFOBins/LOLBAS enrichment, or osquery-to-component transforms.
- **Binary E2E coverage:** use `lib/managers/binary.e2e.poku.js` for real Trivy/rootfs integration when the local environment has the companion repo and container runtime available.
- **Docker-script parity checks:** use `ci/dockertests.sh` plus `ci/assertions.sh` for archive vs reconstructed-rootfs parity, tool identity evidence, container-risk audit coverage, unpackaged native-file count assertions, and OS repo/trusted-key crypto assertions. The `nerdctl` lane must keep working even when Docker itself is absent.
- For macOS OBOM changes, validate the real bundled osquery behavior and keep `docs/OBOM_MACOS_TROUBLESHOOTING.md` in sync when execution mode or permissions expectations change.

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
- Tests run with `CDXGEN_NO_CACHE=true`, loaded from `test/poku.env`, so a stubbed registry answer never reaches this machine's on-disk metadata cache and no test is answered from it. A test of that cache unsets the variable and points `CDXGEN_CACHE_DIR` at a temporary directory.
- For async tests, return the promise or use `async`/`await` inside `it`/`test`.
- For tests that need to mock ES-module dependencies, use **esmock** + **sinon**:

```js
import esmock from "esmock";
import sinon from "sinon";

// cdxgenAgent is built by createHttpClient(); mock that seam to inject a fake
// client, or stub cdxgenAgent.get/.post directly for simpler cases.
const agentStub = sinon.stub().returns({ json: sinon.stub().resolves({}) });
agentStub.get = sinon.stub().resolves({ statusCode: 200, body: {} });

const { submitBom } = await esmock("./index.js", {
  "../helpers/httpClient.js": {
    createHttpClient: sinon.stub().returns(agentStub),
  },
});
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

`gen-types` is a maintainer step, run by hand before a release. Do not run it
as part of ordinary changes and never wire it into a test or a golden: the test
suite is decoupled from the freshness of `types/`, so adding a source file does
not require regenerating declarations first. To check the generated tree after
running it:

```bash
pnpm run gen-types
CDXGEN_VERIFY_TYPES=1 pnpm test
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

- **Do not** talk to the network directly (raw `undici`, `fetch`, `http`/`https`) in new library code — use `cdxgenAgent` from `lib/ecosystems/utils.js` (or `lib/managers/dockerConnection.js` for the container daemon).
- **Do not** use `spawnSync` / `execSync` directly — use `safeSpawnSync`.
- **Do not** use `existsSync` / `mkdirSync` directly — use `safeExistsSync` / `safeMkdirSync`.
- **Do not** shell out to the Electron `asar` CLI or add a runtime dependency for ASAR parsing — use the native reader in `lib/ecosystems/asarutils.js`.
- **Do not** construct PURL strings by concatenation — use `new PackageURL(…).toString()`.
- **Do not** read `process.argv` inside library modules — accept options via the `options` object.
- **Do not** commit secrets, tokens, or credentials.
- **Do not** copy raw secret-bearing values into emitted BOM properties, annotations, evidence, endpoints, or service metadata; aggregate, classify, or redact them instead.
- **Do not** modify generated files under `types/` directly.
- **Do not** add `console.log` debug statements to production code without gating them on `DEBUG_MODE` or replacing them with `thoughtLog`.
- **Do not** add or update `pnpm-lock.yaml` unless changing `package.json` dependencies.
- **Do not** import from `lib/cli/index.js` inside `lib/helpers/*` or `lib/stages/*` — this creates a circular-like cross-layer dependency. Extract the shared function to `lib/helpers/` instead.
- **Do not** add logic that must execute once-per-BOM inside `buildBomNSData` — it is called once per language type. Use `postProcess` in `lib/stages/postgen/postgen.js` instead.
- **Do not** add any generic functions to `lib/cli/index.js` and `lib/ecosystems/utils.js`.
- **Do not** add complex all-in-one regex parsers for filenames or other externally sourced strings when tokenization plus small validators will do; that pattern is difficult to maintain and may fail CodeQL inefficient-regex checks.

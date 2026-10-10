# cdxrs — Rust-native CycloneDX tooling for cdxgen

This document specifies the protocol, exit codes, environment variables, and
extension points for the `cdxrs` Rust binary. Every Track B/C/D deliverable
that ports JS logic to Rust must follow this specification.

## Overview

`cdxrs` lives in the `cdxgen-plugins-bin` repository at
`thirdparty/cdxrs/`. It is a single crate with a single binary, following the
same shape as `thirdparty/cdxui/` (not the `rusi` workspace).

The JS bridge is at `lib/inventory/cdxrs.js` in the cdxgen repository. It is the
**only** module that spawns the `cdxrs` binary.

## Architecture

```
cdxgen (JS)
  └── lib/inventory/cdxrs.js     ← bridge: spawns binary, handles failure modes
        └── cdxrs binary       ← Rust crate in cdxgen-plugins-bin
              ├── src/main.rs   ← clap parsing + dispatch ONLY
              ├── src/lib.rs    ← library: all logic
              ├── src/cli.rs    ← clap derive structs
              ├── src/io.rs     ← input/output resolution
              ├── src/log.rs    ← NDJSON logging to stderr
              ├── src/error.rs  ← thiserror types + exit-code mapping
              ├── src/bom/      ← CycloneDX model, read, write, refs
              └── src/cmd/      ← subcommand implementations
```

### Library/binary split (mandatory)

All logic lives in `src/lib.rs` modules. `src/main.rs` is argument parsing
plus thin dispatch — it contains no business logic and has no `std::process::exit`
calls outside of the dispatch return. This is what makes the eventual napi-rs
move cheap.

## Binary resolution

The bridge reuses `lib/inventory/plugins.js` conventions:

- `CDXRS_CMD` environment variable overrides the binary path.
- Otherwise, the binary is resolved from the platform-specific plugins-bin
  package: `plugins/cdxrs/cdxrs-<platform>-<arch>[.exe]`.
- Platform/arch detection uses `getPluginsBinTarget()` from plugins.js.

## Protocol

### Invocation

```
cdxrs <subcommand> [--input <file|->] [--output <file|->] [--max-input-bytes N]
```

- `--input -` reads stdin; `--input <path>` reads a file. Default: `-`.
  `--input` is always a **path**; BOM content is never passed as an argument.
  The bridge writes content to stdin, spilling to a temp file above 32 MB.
- `--output -` or omitted writes stdout; `--output <path>` writes a file.
- `--max-input-bytes` guards against hostile input (default: 2 GB).
- Inputs over 32 MB should go through a file path, not a pipe (enforced by the
  bridge).

### I/O channels

| Channel | Content                                                     |
| ------- | ----------------------------------------------------------- |
| stdin   | JSON BOM data (when `--input -`)                            |
| stdout  | JSON output (command results, BOM data)                     |
| stderr  | NDJSON log records ONLY (never interleave logs into stdout) |

### Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Success                                                                    |
| 1    | Operational failure (I/O error, parse error, size limit)                   |
| 2    | Bad usage (invalid arguments)                                              |
| 3    | Validation failure with findings on stdout (findings are data, not errors) |

### NDJSON log records (stderr)

Every log record is a single-line JSON object:

```json
{ "level": "info", "msg": "reading BOM" }
```

Levels: `debug`, `info`, `warn`, `error`. The bridge forwards these to
cdxgen's logger at the corresponding levels.

## Subcommands

### `cdxrs info`

Reads a BOM and prints summary statistics as a JSON object:

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.6",
  "componentCount": 42,
  "dependencyCount": 35,
  "serviceCount": 0,
  "vulnerabilityCount": 0,
  "hasEvidence": true,
  "cdxrsVersion": "3.0.0"
}
```

### `cdxrs --version`

Prints `cdxrs <version>` (e.g., `cdxrs 3.0.0`).

### `cdxrs schema-version`

Prints supported spec versions as JSON:

```json
{ "supportedSpecVersions": ["1.6", "1.7"] }
```

## Adding a new subcommand

1. **Create `src/cmd/<name>.rs`** with a `pub fn run(...) -> Result<(), CdxrsError>`
   function. All logic goes here.

2. **Add to `src/cmd/mod.rs`:**

   ```rust
   pub mod <name>;
   ```

3. **Add to the clap enum in `src/cli.rs`:**

   ```rust
   pub enum Command {
       Info,
       SchemaVersion,
       /// Description for --help.
       <Name>,
   }
   ```

4. **Add dispatch in `src/main.rs`:**

   ```rust
   Some(Command::<Name>) => cdxrs::cmd::<name>::run(&cli.input, &cli.output, cli.max_input_bytes),
   ```

5. **Register in the JS bridge** (`lib/inventory/cdxrs.js`):
   Add the subcommand name to `KNOWN_SUBCOMMANDS`.

6. **Add the subcommand to `cdxrsDisabled` coverage** if it should be
   individually disableable via `CDXGEN_RS_DISABLE`.

7. **Write tests** — unit tests in the `.rs` file, and a bridge test with a
   fake binary fixture covering at least success and one failure mode.

## Testing against a locally-built binary

Until plugins-bin is published, use `contrib/link-local-plugins.sh`:

```bash
make -C ../cdxgen-plugins-bin/thirdparty/cdxrs darwin   # or: linux
./contrib/link-local-plugins.sh                          # stages cdxrs
export CDXGEN_PLUGINS_DIR=/tmp/cdxgen-local-plugins      # path it prints
node bin/cdxgen.js --version --verbose                   # => cdxrs 3.0.0 (available)
```

Two notes, because the obvious approaches do not work:

- **`pnpm link` does not help.** Binary discovery is purely path-based —
  `<pluginsDir>/<tool>/<tool>-<platform>-<arch>` — and the version pinned in
  `package.json` is only used to construct npx/global-store paths, so aligning it
  does nothing for local testing. The platform packages' `plugins/` directories
  are also empty in git (binaries are build artifacts), so linking one yields an
  empty plugins dir.
- **Prefer this over a bare `CDXRS_CMD`.** `CDXRS_CMD` short-circuits
  `resolvePluginBinary`, so it never exercises the filename convention or the
  plugins-dir layout — the two things most likely to be wrong. The script stages
  a composite directory (symlinks to your installed plugins, local builds
  layered on top), so everything else keeps resolving.

Run the bridge tests with a binary present as well as without; they cover both:

```bash
CDXGEN_PLUGINS_DIR=/tmp/cdxgen-local-plugins npx poku lib/inventory/cdxrs.poku.js
```

## Environment variables

| Variable                | Purpose                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CDXGEN_PLUGINS_DIR`    | Override the plugins directory (see above)                                                                                                                                                                |
| `CDXRS_CMD`             | Override the cdxrs binary path                                                                                                                                                                            |
| `CDXGEN_RS_DISABLE`     | Disable Rust paths: `all` or comma-separated subcommand names                                                                                                                                             |
| `CDXGEN_NO_RUST`        | Set to `true` to disable all Rust paths (same as `CDXGEN_RS_DISABLE=all`)                                                                                                                                 |
| `--no-rust`             | CLI flag alias for `CDXGEN_NO_RUST=true`                                                                                                                                                                  |
| `CDXGEN_CACHE_DIR`      | Override the metadata cache directory. Default: platform cache dir (`~/.cache/cdxgen` on Linux, `~/Library/Caches/cdxgen` on macOS, `%LOCALAPPDATA%\cdxgen\cache` on Windows).                            |
| `CDXGEN_NO_CACHE`       | Set to `true` or `1` to bypass the on-disk metadata cache for this run.                                                                                                                                   |
| `CDXGEN_CACHE_TTL`      | Override the cache TTL in seconds. `0` means never expire. Default: 86400 (24h).                                                                                                                          |
| `CDXGEN_CACHE_LOOPBACK` | Set to `1` to allow caching loopback hosts (`127.0.0.1`, `::1`, `localhost`). Loopback is excluded by default because test-double entries are keyed by ephemeral ports. Used by `contrib/bench-fetch.js`. |
| `--no-cache`            | CLI flag alias for `CDXGEN_NO_CACHE=true`                                                                                                                                                                 |
| `--cache-ttl <secs>`    | CLI flag alias for `CDXGEN_CACHE_TTL=<secs>`                                                                                                                                                              |

## Batch transport selection

`prefetchJson` in `lib/inventory/fetchBatch.js` dispatches a batch to one of two
transports, and callers do not choose between them:

| Batch contains                                          | Transport                |
| ------------------------------------------------------- | ------------------------ |
| Plain JSON requests only, binary available              | `cdxrs fetch` subprocess |
| Any request with `responseType: "text"` or `"buffer"`   | JS pool (`cdxgenAgent`)  |
| Any request carrying its own `headers`                  | JS pool                  |
| No binary, or `CDXGEN_RS_DISABLE=fetch`, or `--no-rust` | JS pool                  |

The protocol carries a URL, an `accept` value and an opaque `authRealm`, and
types a result body as JSON. Two kinds of request therefore have no faithful
representation in it:

- a non-JSON `responseType`, because the envelope has nowhere to put HTML.
  Rather than parse HTML as JSON and record a failure, the batch goes to the
  pool, which passes `responseType` straight to the agent. Maven POMs, the
  pkg.go.dev pages behind `getGoPkgLicense`/`getGoPkgVCSUrl`, and CocoaPods
  podspecs rely on this;
- request-specific `headers`, because cdxrs derives its own `Authorization`
  from `GITHUB_TOKEN` and would silently drop any other credential, turning an
  authenticated lookup into an anonymous one. `forgeEnricher` relies on this to
  carry `--forge-token` and `GITLAB_TOKEN`.

The pool applies the same global and per-host concurrency and rate policy, so
the batching win is unchanged; only the on-disk cache below is skipped.

Within the pool, a credential the caller attached to a request wins over the
ambient `GITHUB_TOKEN`. The ambient token is a fallback, never an override.

A batch routed to `cdxrs fetch` is sent in runs of at most 250 URLs, one run
at a time so each host still sees a single rate gate. The envelope has to
become one JavaScript string, and a large pnpm workspace fetching full npm
packuments in a single run produced more than V8's string limit allows (issue
4393). If a run still fails with `stdout-too-large`, the bridge splits it in
half and retries, which is cheap because the first attempt filled the disk
cache below; only a single URL that is too large on its own goes to the JS
pool. A run that fails for any other reason falls back to the JS pool without
affecting the other runs. `lastBatchStats()` reports the whole batch: counts
and elapsed time add up across runs, and peak concurrency is the widest run.

## Metadata cache

`cdxrs fetch` writes an on-disk conditional cache under
`<cacheDir>/cdxrs-fetch/<host>/<hash>.json`. The cache is bounded by both a
TTL (default 24h, opportunistic sweep per host directory) and an LRU byte
ceiling (default 256 MB).

Enforcing the ceiling means walking the whole cache, so it is not done on every
write: a run may add an eighth of the ceiling (at least 8 MB) before a pass is
due. A cache can therefore sit that much over the ceiling between passes, and
one left oversized by a run that exited early is reclaimed by the next run that
writes enough, or immediately by `cdxgen cache clear`.

Entries are not fsynced. Every byte in the cache is re-derivable from the
network and atomicity comes from `rename`, so a torn entry left by a crash is
simply discarded on read and refetched.

Inspect or purge the cache:

```bash
cdxgen cache info    # resolved directory, entry count, total bytes, per-host breakdown
cdxgen cache clear   # purge all entries
```

The cache directory is resolved by JS and passed to Rust via `--cache-dir` on
every invocation, so both sides agree on the location. When `CDXGEN_CACHE_DIR`
is unset, the platform cache directory is used. If no home directory can be
resolved, the cache is disabled — it never falls back to the working directory.

## JS bridge API

```js
import {
  cdxrsAvailable,
  runCdxrs,
  cdxrsDisabled,
  CDXRS_FALLBACK,
} from "./cdxrs.js";

// Check if the binary is present and version-compatible
const { available, version, reason } = cdxrsAvailable("info");

// Run a subcommand (async). Normal case: pass in-memory BOM data as `content`,
// which is written to the child's stdin with `--input -`.
const result = await runCdxrs("info", {
  content: bomJsonString, // fed over stdin
  args: [], // extra CLI args
  timeoutMs: 30_000, // default 30s
});

// Alternative, when the BOM is already a file on disk:
const result2 = await runCdxrs("info", { input: "/path/to/bom.json" });

// result: { ok: true, stdout, stderr, exitCode } on success
// result: { ok: false, reason, stdout: "", exitCode: null } on failure

// Check if a subcommand is disabled
if (cdxrsDisabled("info")) {
  /* take JS path */
}
```

### Failure modes (all non-fatal)

Every failure mode logs once at `warn` and returns the `CDXRS_FALLBACK`
sentinel (`{ ok: false, reason: "..." }`). The caller takes the JS path.

| Failure                | `reason` field          |
| ---------------------- | ----------------------- |
| Binary not found       | `binary-not-found`      |
| Non-zero exit          | `non-zero-exit:<code>`  |
| Timeout                | `timeout`               |
| Oversized stdout       | `stdout-too-large`      |
| Malformed stdout       | `malformed-stdout`      |
| Stdout not collectable | `stdout-collect-failed` |
| Version-major mismatch | `version-mismatch`      |
| CDXGEN_RS_DISABLE      | `disabled`              |
| Spawn error            | `spawn-error`           |
| Unknown subcommand     | `unknown-subcommand`    |

The bridge kills the **process group** on timeout (`process.kill(-pid,
"SIGKILL")`) so a hung child cannot outlive the parent. It also kills the
group once collected stdout passes `CDXGEN_RS_MAX_STDOUT_BYTES` (default:
V8's maximum string length, 0x1fffffe8): stdout must become a single JS
string, so an oversized payload can never be delivered, and waiting for the
child to finish would only end in `ERR_STRING_TOO_LONG` crashing the process
(issue 4393). For `fetch`, the caller answers `stdout-too-large` by splitting
the run (see [Batch transport selection](#batch-transport-selection)).

## BOM model and round-trip fidelity

### Model decision: hand-written

The CycloneDX serde model in `src/bom/model.rs` is hand-written, not
generated. typify was evaluated but rejected because:

1. The official JSON schemas declare `additionalProperties: false`, conflicting
   with the mandatory unknown-field-preservation requirement.
2. The 91 interlinked definitions with complex oneOf/anyOf produce unwieldy
   enums.
3. Every generated struct would need manual `#[serde(flatten)]` additions.

### Unknown-field preservation

Every object that can carry vendor extensions has:

```rust
#[serde(flatten)]
pub extra: BTreeMap<String, Value>,
```

### Round-trip strategy

The I/O path (`bom::read`/`bom::write`) uses `serde_json::Value` rather than the
typed structs, because `Value` cannot drop a field it has no struct member for.
Output is 2-space indented with a trailing newline, matching
`JSON.stringify(bom, null, 2) + "\n"`.

`serde_json` **must** be built with the `preserve_order` feature:

```toml
serde_json = { version = "1", features = ["preserve_order"] }
```

### Field-order fidelity

This is the subtlest requirement in the crate, so it is worth stating plainly.

`preserve_order` backs `Value`'s maps with `IndexMap`, so keys are written in the
order they were read. Without it, `Value` uses a `BTreeMap` and writes every
object's keys **alphabetically**.

That difference is invisible if you only test against golden files: cdxgen's
normalizer (`contrib/sbom-normalize.js`) already sorts keys recursively, so a
`BTreeMap` round-trips them unchanged. But real cdxgen output is
insertion-ordered — `bomFormat, specVersion, serialNumber, version, metadata,
components, dependencies` at the root, and similarly nested — so a `BTreeMap`
backend silently reorders every object in any live BOM.

The regression guard is `thirdparty/cdxrs/testdata/real-unsorted-npm.json`, a
genuine unnormalized cdxgen BOM, together with two tests in `tests/roundtrip.rs`:
`test_roundtrip_preserves_non_alphabetical_field_order` and
`test_unsorted_fixture_is_actually_unsorted` (the latter fails if the fixture is
ever normalized, which would quietly retire the former).

**When vendoring new fixtures, do not normalize them.** A corpus of exclusively
normalized goldens cannot detect a field-order regression.

## Build and release

### Release profile

```toml
[profile.release]
opt-level = "z"
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true
```

### Cross-build

The Makefile mirrors `thirdparty/cdxui/Makefile`:

- `make darwin` — darwin-amd64, darwin-arm64 (native macOS)
- `make linux` — 5 Linux GNU targets (requires Linux host + cargo-zigbuild)
- `make linuxmusl` — 2 musl targets
- `make windows` — 2 Windows GNU targets
- `make all` — all targets for the current host OS + SBOM generation

Each binary gets a `.sha256` sidecar.

### Size budget

`scripts/check-package-size.sh` enforces 250 MB packed per platform package.
cdxrs release binaries are ~440 KB (unstripped ~480 KB), well within budget.

## Testing

| Test                                     | What it verifies                                               |
| ---------------------------------------- | -------------------------------------------------------------- |
| `cargo test` (9 tests)                   | `info`, round-trip incl. unsorted BOM, typed-model, fuzz guard |
| `cargo clippy -- -D warnings`            | No lint warnings                                               |
| `cargo fmt --check`                      | Code formatting                                                |
| `lib/inventory/cdxrs.poku.js` (11 tests) | Six bridge failure modes + success + cdxrsDisabled + sentinel  |
| `contrib/rs-disable-golden-test.js`      | Default and `CDXGEN_RS_DISABLE=all` runs are byte-identical    |

### CI integration

Runs as a separate CI job:

```bash
pnpm run test:rs-disable
```

This is a **permanent safety net** that must stay green for the entire v13
cycle. If it fails, a Rust path is changing output — fix the Rust path, do not
weaken the test.

Two properties of this job are load-bearing, and both are easy to lose in a
well-meant simplification:

1. **It runs every scenario twice** — once with Rust enabled, once with
   `CDXGEN_RS_DISABLE=all` — and compares the two runs _against each other_.
   Running the golden corpus with `CDXGEN_RS_DISABLE=all` and checking it still
   matches the committed goldens is **not** equivalent and cannot detect a Rust
   path that ignores the flag, because that is exactly the run in which the Rust
   path is switched off.
2. **It compares serialized bytes, not `diffBoms`.** `contrib/sbom-diff.js`
   compares components, dependencies and `metadata.component` only; it returns
   `isEqual: true` for BOMs that differ in other top-level fields, `specVersion`
   included. Correct for its own purpose, far too loose for this one.

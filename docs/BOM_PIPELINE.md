# BOM Generation Pipeline

This page walks through what cdxgen does from the moment you press Enter to the moment an output file is written. Understanding the pipeline helps you diagnose errors, tune performance, and know which phase produced a given piece of output.

## Overview

Every `cdxgen` run moves through four broad phases.

1. Environment preparation
2. Language detection and manifest discovery
3. Per-language BOM assembly
4. Post-processing and output

## Phase 1: Environment preparation

`prepareEnv()` in `lib/stages/pregen/pregen.js` runs first. It checks whether the required build tools for each detected language are present and installs missing ones using sdkman, nvm, rbenv, or similar managers. If you pass `--no-install-deps`, this phase skips installation and proceeds with whatever is already on the system.

If a required SDK is completely absent and auto-install is also disabled, cdxgen continues but will likely produce an incomplete BOM with a warning.

## Phase 2: Language detection and manifest discovery

`createBom()` in `lib/cli/index.js` examines the target directory (or the purl/URL you provided) and determines which project types are present. Detection works by looking for known manifest files such as `package.json`, `pom.xml`, `Cargo.toml`, and so on.

You can override detection with `-t <type>` or combine types with `-t js -t java`. Use `--exclude-type` to skip a type that cdxgen would otherwise pick up automatically.

For each detected type, cdxgen creates a list of relevant manifest and lock files respecting `--include-regex`, `--exclude`, and `--exclude-type` filters. This is also where purl-based input is resolved: cdxgen contacts the relevant registry to find the repository URL before cloning.

## Phase 3: Per-language BOM assembly

For a single project type, `createXBom()` calls the matching `create<Language>Bom()` function, for example `createJavaBom()` or createRubyBom()`. For multiple types or container images, `createMultiXBom()` calls `createXBom()` once per type and then merges the results.

Inside each `create<Language>Bom()` function:

- Manifest and lock files are read and parsed into an intermediate component list.
- Where needed, the package manager (Maven, pip, go mod, etc.) is invoked to resolve transitive dependencies.
- Registry metadata is optionally fetched to fill in missing fields like description and license.
- `buildBomNSData()` is called to assemble the final CycloneDX JSON structure for that language type.

`buildBomNSData()` is called once per language type. A multi-type scan like `-t js,java,python` calls it three times. Side-effects such as writing files must not live here.

## Phase 4: Post-processing and output

`postProcess()` in `lib/stages/postgen/postgen.js` runs exactly once after `createBom()` returns, regardless of how many language types were scanned. This phase handles:

- Component deduplication and filtering (`--required-only`, `--filter`, `--only`, `--min-confidence`)
- Standards and attestation metadata
- Formulation section population (build tools, git metadata)
- Annotations
- BOM profile adjustments

After post-processing, `bin/cdxgen.js` serialises the result to JSON, writes the output file, and optionally prints a summary table.

## Where errors come from

| Symptom | Likely phase | What to check |
|---|---|---|
| "SDK not found" or build tool missing | Phase 1 | Install the SDK manually or use a container image that bundles it |
| BOM has no components | Phase 2 | Check that manifest files exist; try `-t <explicit-type>` |
| Dependency tree is shallow | Phase 3 | The package manager may have failed; run with `CDXGEN_DEBUG_MODE=debug` to see the exact commands |
| Components missing from output | Phase 4 | A filter may have removed them; check `--required-only`, `--filter`, and `--min-confidence` |

See [Troubleshooting](TROUBLESHOOTING.md) for a more complete list of common issues.

## Timing notes

- Phase 1 is skipped entirely when `--no-install-deps` is passed.
- Phases 2 and 3 run in parallel for independent language types inside `createMultiXBom()`.
- Registry metadata fetching in Phase 3 is the most common cause of slow runs. Set `CDXGEN_TIMEOUT_MS` to limit how long each request waits.
- Phase 4 is fast unless the BOM is very large or evidence mode is active.

## Server mode

When cdxgen runs as an HTTP server (`cdxgen --server` or `bin/repl.js`), the same pipeline runs per request. Phase 1 is skipped for server requests by default. The output is returned in the HTTP response instead of being written to a file.

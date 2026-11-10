# Migrating to cdxgen v13

This guide covers user-visible breaking changes introduced by cdxgen v13.
Additional sections will be appended as later deliverables land.

## Package rename: `@cyclonedx/cdxgen` → `@cdxgen/cdxgen`

The npm package has moved from the `@cyclonedx` scope to the `@cdxgen` scope,
where it joins `@cdxgen/cdx-purl`, `@cdxgen/cdx-hbom`, `@cdxgen/cdx-proto`, and
`@cdxgen/safer-exec`.

**The `cdxgen` command name is unchanged.** All 15 bin entries (`cdxgen`,
`cbom`, `obom`, `evinse`, `cdx-audit`, `cdx-convert`, `cdx-validate`,
`tracebom`, etc.) install the same command names as before. Only the package
specifier changes.

### Install

```shell
# Before (v12)
npm install -g @cyclonedx/cdxgen

# After (v13)
npm install -g @cdxgen/cdxgen
```

### Programmatic imports

```js
// Before (v12)
import { createBom, submitBom } from "@cyclonedx/cdxgen";

// After (v13)
import { createBom, submitBom } from "@cdxgen/cdxgen";
```

Deep imports change **both scope and path**. For example:

```js
// Before (v12)
import { parsePkgLock } from "@cyclonedx/cdxgen/helpers/parsers-js";

// After (v13)
import { parsePkgLock } from "@cdxgen/cdxgen/helpers/parsers-js";
```

Some modules moved package as well as scope. The foundational modules now live
under `core/`, and the HuggingFace manifest readers under `parsers/`:

| v12 path                      | v13 path                      |
| ----------------------------- | ----------------------------- |
| `helpers/logger`              | `core/logger`                 |
| `helpers/propertySanitizer`   | `core/propertySanitizer`      |
| `helpers/paths`               | `core/paths`                  |
| `helpers/state`               | `core/state`                  |
| `helpers/core-activity`       | `core/activity`               |
| `helpers/core-fs`             | `core/fs`                     |
| `helpers/core-env`            | `core/env`                    |
| `helpers/httpClient`          | `core/httpClient`             |
| `helpers/huggingfaceManifest` | `parsers/huggingfaceManifest` |
| `helpers/huggingfaceUtils`    | `parsers/huggingfaceUtils`    |

Most of what used to be `helpers/` is now split across `ecosystems/` and
`inventory/`. The ecosystem-specific parsers, registry metadata, and
per-ecosystem logic live in `ecosystems/`; the general-purpose BOM-construction
utilities (purl, SPDX, evidence, deps, display, analyzers, AI/MCP/HBOM,
formulation parsers, CI parsers, crypto, OS/osquery, source resolution) live in
`inventory/`. The barrel `ecosystems/utils` re-exports across both packages for
backward compatibility. `helpers/` retains only the output-side modules
(`bomSigner`, `exportUtils`, `annotationFormatter`, `versutils`, `vsixutils`,
`remote/`). If a v12 `helpers/x` import is not in the table below, try
`inventory/x` first, then `ecosystems/x`.

Selected moves:

| v12 path                 | v13 path                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| `helpers/parsers-js`     | `ecosystems/parsers-js`                                                  |
| `helpers/parsers-misc`   | `ecosystems/parsers-misc`                                                |
| `helpers/parsers-python` | `ecosystems/parsers-python`                                              |
| `helpers/parsers-rust`   | `ecosystems/parsers-rust`                                                |
| `helpers/parsers-dotnet` | `ecosystems/parsers-dotnet`                                              |
| `helpers/parsers-jvm`    | `ecosystems/parsers-jvm`                                                 |
| `helpers/parsers-go`     | `ecosystems/parsers-go`                                                  |
| `helpers/ecosystems`     | `ecosystems/ecosystems`                                                  |
| `helpers/purl`           | `inventory/purl`                                                         |
| `helpers/spdx`           | `inventory/spdx`                                                         |
| `helpers/npmutils`       | `ecosystems/npmutils`                                                    |
| `helpers/deps`           | `inventory/deps`                                                         |
| `helpers/utils` (barrel) | `ecosystems/utils` (re-exports from both `ecosystems/` and `inventory/`) |

Several exports from the retired `core-misc-a.js` and `core-misc-b.js` moved to
new homes:

| v12 export                                                                                                          | v13 module                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `isFeatureEnabled`, `hasAnyProjectType`, `shouldRunPredictiveBomAudit`, `isPackageManagerAllowed`, `extractPathEnv` | `core/env`                     |
| `isValidDriveRoot`, `toCamel`                                                                                       | `core/paths`                   |
| `isValidIriReference`                                                                                               | `parsers/iri`                  |
| `getDefaultBomAuditCategories`                                                                                      | `ecosystems/auditCategories`   |
| `getRuntimeInformation`, `retrieveCdxgenVersion`, `retrieveCdxgenPluginVersion`                                     | `ecosystems/envcontext`        |
| `extractToolRefs`, `attachIdentityTools`, `addEvidenceForDotnet`, `convertOSQueryResults`                           | `inventory/evidenceUtils`      |
| `addEvidenceForImports`                                                                                             | `ecosystems/jsEvidence`        |
| `getCppModules`                                                                                                     | `ecosystems/cppEvidence`       |
| `parseCaxaMetadata`                                                                                                 | `ecosystems/caxa`              |
| `analyzeDosaiCrypto`, `runDosaiCommand`                                                                             | `inventory/dosai`              |
| `isPartialTree`, `recomputeScope`                                                                                   | `ecosystems/depsUtils`         |
| `getOSPackageForFile`, `collectExecutables`, `collectSharedLibs`                                                    | `ecosystems/osPackageResolver` |
| `getPyModules`, `createUVLock`, `getPipFrozenTree`, `getPipTreeForPackages`                                         | `ecosystems/pythonutils`       |
| `parsePodfileLock`, `parsePodfileTargets`, `parseCocoaDependency`, `executePodCommand`, `buildObjectForCocoaPod`    | `ecosystems/parsers-misc`      |
| `getMavenCommand`, `getMillCommand`                                                                                 | `ecosystems/gradleutils`       |
| `getAtomCommand`, `executeAtom`, `findAppModules`                                                                   | `ecosystems/atomUtils`         |

### JSR

```ts
// Before (v12)
export { createBom } from "jsr:@cyclonedx/cdxgen";

// After (v13)
export { createBom } from "jsr:@cdxgen/cdxgen";
```

### `metadata.tools` change — action required for dep-scan and similar consumers

cdxgen records itself in `metadata.tools.components[].purl`. After the rename:

| Field     | Before (v12)                       | After (v13)                     |
| --------- | ---------------------------------- | ------------------------------- |
| `purl`    | `pkg:npm/%40cyclonedx/cdxgen@12.x` | `pkg:npm/%40cdxgen/cdxgen@13.x` |
| `bom-ref` | `pkg:npm/@cyclonedx/cdxgen@12.x`   | `pkg:npm/@cdxgen/cdxgen@13.x`   |
| `group`   | `@cyclonedx`                       | `@cdxgen`                       |

**dep-scan and other tools that identify the generating tool by purl or
`bom-ref`** will see the new strings. To handle the transition:

1. **Match on `name`/`group` instead of purl.** The `name` is always `"cdxgen"`;
   match on that plus `group` to identify cdxgen-generated BOMs regardless of
   package scope.
2. **Or accept both purls.** Treat `pkg:npm/%40cyclonedx/cdxgen@*` and
   `pkg:npm/%40cdxgen/cdxgen@*` as equivalent during the transition.

This is the same class of consumer-side break as the PyPI name canonicalization
(see [Package URL canonicalization](#package-url-purl-canonicalization) above) —
both land in v13 as one story.

### Container images move too

Container images follow the repository, because GitHub Container Registry
namespaces are tied to the owning GitHub organization and cdxgen now lives at
`github.com/cdxgen/cdxgen`. Every image moves from `ghcr.io/cyclonedx/*` to
`ghcr.io/cdxgen/*`:

| v12                                        | v13                                     |
| ------------------------------------------ | --------------------------------------- |
| `ghcr.io/cyclonedx/cdxgen:v12`             | `ghcr.io/cdxgen/cdxgen:v13`             |
| `ghcr.io/cyclonedx/cdxgen-secure:v12`      | `ghcr.io/cdxgen/cdxgen-secure:v13`      |
| `ghcr.io/cyclonedx/cdxgen-deno:v12`        | `ghcr.io/cdxgen/cdxgen-deno:v13`        |
| `ghcr.io/cyclonedx/cdxgen-bun:v12`         | `ghcr.io/cdxgen/cdxgen-bun:v13`         |
| `ghcr.io/cyclonedx/cdxgen-<lang><ver>:v12` | `ghcr.io/cdxgen/cdxgen-<lang><ver>:v13` |

The v12 images stay where they are and keep working; they are simply not
updated past v12. Pipelines pinned to `ghcr.io/cyclonedx/cdxgen:v12` continue
to run, but a pipeline tracking `:latest` or `:master` under the old namespace
stops receiving updates and must be repointed.

The full image catalogue is in [ci/images/README.md](ci/images/README.md).

## Node requirement

cdxgen v13 requires **Node.js >= 24.0.0**.

Previous versions supported Node 20 and 22. If you are running an older Node,
upgrade to Node 24 (current LTS) or Node 26 before installing v13.

| cdxgen | Minimum Node | Notes                             |
| ------ | ------------ | --------------------------------- |
| v12    | 20           | End of maintenance once v13 ships |
| v13    | 24           | Active development target         |

## CycloneDX spec version changes

The `--spec-version` flag now accepts **1.6**, **1.7**, and **2.0** as
generation targets. The default remains **1.7**.

**Removed generation targets:** `1.4` and `1.5`.

If you previously used `--spec-version 1.4` or `--spec-version 1.5`, you will
now receive an error message explaining the change.

Note that generating with `--spec-version 1.6` produces a **1.6** document — it
does not emit 1.4 or 1.5. The 1.4/1.5 output-downgrade logic in
`lib/stages/postgen/postgen.js` is retained and is still reachable by library
callers that pass `specVersion: 1.4`/`1.5` to `createBom()`; only the CLI
generation target is restricted. To obtain a 1.4 or 1.5 document from the CLI,
generate 1.6 and convert it with an external tool, for example:

```shell
cdxgen -o bom.json --spec-version 1.6 .
cyclonedx-cli convert --input-file bom.json --output-version v1_5 --output-file bom-1.5.json
```

The validation command (`cdx-validate`) continues to accept existing 1.4 and
1.5 BOMs as input, and the bundled 1.4/1.5 JSON schemas in `data/` are retained
for that purpose.

The spec floor is enforced on the `cdxgen` CLI, the `tracebom` CLI, and the
`/sbom` HTTP server endpoint (which returns HTTP 400 for a rejected value).

## Removed CLI flags and env vars

| Flag                         | CLI                  | Status          | Reason                                                                             |
| ---------------------------- | -------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `--db-path`                  | `evinse`             | Removed         | Hidden flag whose own help text read "Unused". It was never read by any code path. |
| `--spec-version 1.4` / `1.5` | `cdxgen`, `tracebom` | Values rejected | Below the v13 spec floor. See above.                                               |

No environment variables were formally deprecated in v12, so none are removed.

## `lib/helpers/utils.js` barrel deprecation

`lib/helpers/utils.js` has been decomposed into focused leaf modules. The file
has moved to `lib/ecosystems/utils.js` and remains as a re-export barrel that
preserves all **261** public export names for one major version, so existing
`import { X } from "@cdxgen/cdxgen/ecosystems/utils"` imports keep working
unchanged. (The old `helpers/utils` path no longer resolves.)

The barrel is **deprecated as of v13**. Consumers should import from the
specific leaf module instead:

| New module                  | Theme                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `inventory/purl`            | purl build/parse, version compare, conan/nix purl helpers                                               |
| `inventory/spdx`            | license-id normalisation, SPDX expressions, license data lookup                                         |
| `core/state`                | eval-time data constants (frameworks, version, module tables)                                           |
| `core/paths`                | path/OS detection helpers, `isValidDriveRoot`, `toCamel`                                                |
| `core/activity`             | activity/dry-run/host-allowlist, `cdxgenAgent`, feature flags                                           |
| `core/fs`                   | safe wrappers, `safeSpawnSync`, file discovery, checksums                                               |
| `core/env`                  | runtime detection, env flags, command resolution, alias tables, `isFeatureEnabled`, `hasAnyProjectType` |
| `inventory/deps`            | dependency-tree assembly, component merge/dedupe, JAR namespace collection                              |
| `ecosystems/ecosystems`     | the `get*Metadata` family + registry fetch helpers                                                      |
| `ecosystems/parsers-go`     | Go ecosystem parsers (`parseGoMod*`, `parseGosum*`, etc.)                                               |
| `ecosystems/parsers-dotnet` | .NET ecosystem parsers (`parseCsProj*`, `parseNuspec*`, etc.)                                           |
| `ecosystems/parsers-rust`   | Rust/cargo parsers (`parseCargo*`, cargo workspace internals)                                           |
| `ecosystems/parsers-jvm`    | JVM parsers (`parsePom`, `parseMavenTree*`, `parseBazel*`, etc.)                                        |
| `ecosystems/parsers-python` | Python parsers (`parsePy*`, `parseReq*`, `parsePixi*`, etc.)                                            |
| `ecosystems/parsers-js`     | JS/npm parsers (`parsePkgJson`, `parsePkgLock`, `parsePnpm*`, etc.)                                     |
| `ecosystems/parsers-misc`   | All other parsers (`parseComposer*`, `parseConan*`, `parseSwift*`, etc.)                                |

## Removed container images

The Node.js 20 images are removed, since cdxgen itself now requires Node.js >= 24:

| Removed                               | Replacement                           |
| ------------------------------------- | ------------------------------------- |
| `ghcr.io/cdxgen/cdxgen-node20`        | `ghcr.io/cdxgen/cdxgen-alpine-node24` |
| `ghcr.io/cdxgen/cdxgen-alpine-node20` | `ghcr.io/cdxgen/cdxgen-alpine-node24` |

The rolling `ghcr.io/cdxgen/cdxgen-node` alias previously pointed at the
Node.js 20 image and now points at `cdxgen-alpine-node24`. Note that this
changes its base image from SUSE BCI to Alpine.

The `-t node20` **install-version project type** is unaffected and remains the
supported way to build a target application that requires an older Node.js:

```shell
docker run --rm -v $(pwd):/app:rw -t ghcr.io/cdxgen/cdxgen:latest -t node20 -r /app -o /app/bom.json
```

## Install and package size changes

`@cdxgen/cdxgen-plugins-bin` and its per-platform binary packages (e.g.
`@cdxgen/cdxgen-plugins-bin-darwin-arm64`) are **optional dependencies**, as
they were in v12, and are selected automatically based on your runtime
platform.

**What this means for you:**

- `npm install @cdxgen/cdxgen --omit=optional` (or `--no-optional`) is a
  supported install. cdxgen falls back to its JavaScript implementations for
  every plugin-backed feature, and v13's JavaScript paths are faster than the
  v12 ones they replaced.
- A missing plugins directory is no longer reported as an install problem. Run
  with `CDXGEN_DEBUG_MODE=debug` to see which implementation was selected.
- Set `CDXGEN_PLUGINS_DIR` to point cdxgen at a plugins directory you manage
  yourself.

Skipping the optional dependencies keeps roughly 570 MB of platform binaries
out of `node_modules`.

## Rust-backed stages

> **Placeholder** — later v13 deliverables will document the `cdxrs` binary
> here, including how to disable individual Rust-backed steps via
> `CDXGEN_RS_DISABLE=<subcommand>[,...]` and the JS fallback guarantee.

## Package URL (purl) canonicalization

cdxgen v13 replaces the `packageurl-js` library with `@cdxgen/cdx-purl`, a
strict, canonicalizing implementation that enforces the purl-spec ABNF and
per-type policies. This section documents the user-visible purl changes.

### PyPI name normalization

PyPI package names containing `.` or `_` are now normalized to `-` per
[PEP 503](https://peps.python.org/pep-0503/), as required by the purl-spec.
**Both the `purl` string and the derived `bom-ref` change.**

| Before (v12)                      | After (v13)                       |
| --------------------------------- | --------------------------------- |
| `pkg:pypi/jaraco.classes@3.4.0`   | `pkg:pypi/jaraco-classes@3.4.0`   |
| `pkg:pypi/jaraco.context@6.1.1`   | `pkg:pypi/jaraco-context@6.1.1`   |
| `pkg:pypi/jaraco.functools@4.4.0` | `pkg:pypi/jaraco-functools@4.4.0` |

The component `name` field is **not** changed — only the `purl` and `bom-ref`.

### Golang namespace case normalization

Golang namespaces are lowercased per the purl-spec (golang paths are
case-insensitive). For example:

| Before (v12)                                                   | After (v13)                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `pkg:golang/github.com/ShiftLeftSecurity/atlassian-connect-go` | `pkg:golang/github.com/shiftleftsecurity/atlassian-connect-go` |

The component `name` preserves its original case; only the `purl`/`bom-ref`
are lowercased.

### Components without a valid purl

Some components legitimately lack enough metadata to construct a valid purl
under strict rules. These now receive a **name-based `bom-ref`** and no `purl`
field:

- **Maven** artifacts without a `groupId` (some Mill/Gradle modules)
- **Swift** local application packages (no remote URL / namespace)
- **vscode-extension** packages without a publisher
- **Golang** modules with no path separator (e.g. `go4.org`)

Previously these received a non-canonical or invalid purl like
`pkg:swift/swift-smoke@undefined`.

### Reserved characters in versions and names

The purl grammar allows only letters, digits, `.`, `-`, `_`, `~` and `:` to
appear literally in a component. Everything else is percent-encoded, once, in
the `purl`; the `bom-ref` and the `dependencies` refs carry the decoded form,
and the component `version` and `name` keep the string the manifest or lockfile
recorded. `@cdxgen/cdx-purl` rejects a purl that leaves such a character
unescaped (`E_INVALID_CHARACTER`), so cdxgen escapes every one of them:

| Ecosystem            | Recorded version or name          | `purl`                                                         |
| -------------------- | --------------------------------- | -------------------------------------------------------------- |
| npm, pnpm, yarn, bun | `1.0.0+build.5` (semver build)    | `pkg:npm/app@1.0.0%2Bbuild.5`                                  |
| Go                   | `v3.2.0+incompatible`             | `pkg:golang/github.com/dgrijalva/jwt-go@v3.2.0%2Bincompatible` |
| Cargo                | `0.11.0+wasi-snapshot-preview1`   | `pkg:cargo/wasi@0.11.0%2Bwasi-snapshot-preview1`               |
| PyPI                 | `2.1.0+cpu`, `1!0.2.0` (epoch)    | `pkg:pypi/torch@2.1.0%2Bcpu`, `pkg:pypi/pkg@1%210.2.0`         |
| Swift                | `1.0.0+build.7`                   | `pkg:swift/github.com/example/meta@1.0.0%2Bbuild.7`            |
| deb                  | `libstdc++6`, `12.2.0-14+deb12u1` | `pkg:deb/debian/libstdc%2B%2B6@12.2.0-14%2Bdeb12u1`            |
| Composer             | `dev-feature/x` (branch)          | `pkg:composer/acme/branch@dev-feature%2Fx`                     |

A purl typed by hand as a scan source (`cdxgen pkg:cargo/wasi@0.11.0+wasi-snapshot-preview1`)
or read from a third-party BOM is accepted with the characters unescaped: cdxgen
splits it on its separators and rebuilds it before validating it.

`npm publish` records `semver.clean()` of a version, so a project, workspace
member or git/file dependency whose `package.json` says `1.0.0+build.5` is
known to the npm registry as `1.0.0`. npm components whose version would be
cleaned carry that form in the `cdx:npm:cleanedVersion` property, whichever
package manager's lockfile the component came from.

### Guidance for downstream consumers

**dep-scan and other tools that match on purl strings** must handle the new
canonical forms. An unmigrated consumer that looks up
`pkg:pypi/jaraco.classes@3.4.0` will silently miss advisories stored under
`pkg:pypi/jaraco-classes@3.4.0`.

**What to do:**

1. **Normalize incoming purls the same way** before lookup. For PyPI, apply
   PEP 503 normalization: lowercase the name and replace runs of `-`, `_`,
   and `.` with a single `-`. The `@cdxgen/cdx-purl` library does this
   automatically — use `Purl.parse(purlString).toString()` to canonicalize.

2. **Treat old and new spellings as equivalent during a transition period.**
   When an exact purl match fails, retry with the canonicalized form. This
   covers SBOMs generated by v12 that are consumed by v13-era tooling.

3. **Match on `bom-ref` cautiously.** Since `bom-ref` is derived from `purl`
   in cdxgen, it changes alongside the purl. Dependency relationships
   (`dependencies[].ref`, `dependencies[].dependsOn[]`) reference `bom-ref`
   values, so they also change.

4. **Components without a purl** now use a name-based `bom-ref`. Consumers
   that assumed every component has a `pkg:`-prefixed `bom-ref` should handle
   non-purl refs gracefully.

### Nix flake purls use `generic`

**Affected:** anyone consuming cdxgen Nix flake (`flake.lock`) BOMs.

| Before (v12)              | After (v13)                                                            |
| ------------------------- | ---------------------------------------------------------------------- |
| `pkg:nix/nixpkgs@bd645e8` | `pkg:generic/nixpkgs@bd645e8?vcs_url=https://github.com/NixOS/nixpkgs` |

`nix` is not a registered purl type, so a `pkg:nix/...` purl identified a
package in a namespace no vulnerability database or advisory feed recognises.
Flake inputs are now `pkg:generic` with a `vcs_url` qualifier built from the
locked node's forge (`type`, `owner`, `repo`) and a `cdx:purl:proposedType=nix`
property recording the intent, so a future upstream registration is a
mechanical switch.

To adapt: match `pkg:generic/` components carrying
`cdx:purl:proposedType=nix` instead of matching on `pkg:nix/`. The full
revision remains in `cdx:nix:revision`, the NAR hash in `cdx:nix:nar_hash`,
and the forge download URL in `cdx:nix:download_url`.

The root dependency edge also changes. It previously referenced
`pkg:nix/flake@latest`, which matched no component in the BOM — a dangling
`dependencies[].ref`. It now points at the real parent component
(`application:<project>:latest`), so the graph is well-formed.

## New ecosystems

v13 adds Zig, Gleam and Mojo, plus bzlmod dependency extraction for Bazel.
None of them squats an unregistered purl type:

- **Zig** (`build.zig.zon`) — `pkg:generic/...` with a `download_url`
  qualifier and `cdx:purl:proposedType=zig`. Multihash `1220…` digests are
  emitted as SHA-256 `hashes[]` entries; any other hash encoding is kept as a
  `cdx:zig:hash` property rather than guessing an algorithm.
- **Gleam** (`gleam.toml`, `manifest.toml`) — `pkg:hex/...`. Gleam resolves
  through Hex, and a Gleam package on Hex _is_ a Hex package, so no new type is
  needed.
- **Mojo** (`mojoproject.toml`) — Mojo's own packages are `pkg:generic/...`
  with `cdx:purl:proposedType=mojo`. Conda and PyPI packages pulled in through
  `pixi.lock` keep their existing `pkg:conda` and `pkg:pypi` types.
- **Bazel bzlmod** (`MODULE.bazel`, `MODULE.bazel.lock`) — dependencies
  resolved through bzlmod map to their true ecosystem purl (`pkg:maven` and so
  on) so advisories match. Only Bazel Central Registry modules use
  `pkg:bazel/...`, which is the registered `bazel` type's intended use: its
  rules prohibit a namespace and default `repository_url` to
  `https://bcr.bazel.build`.

## Legacy properties moved under `internal:`

**Affected:** anyone matching cdxgen's unnamespaced component properties.

Properties that predate the `cdx:*` convention are now prefixed with
`internal:`, marking them as implementation detail rather than a modelled part
of the property surface:

| Before (v12)           | After (v13)                     |
| ---------------------- | ------------------------------- |
| `SrcFile`              | `internal:SrcFile`              |
| `Namespaces`           | `internal:Namespaces`           |
| `ImportedModules`      | `internal:ImportedModules`      |
| `LocalNodeModulesPath` | `internal:LocalNodeModulesPath` |

The same applies to `CalledMethods`, `ExportedModules`, `GIT_BRANCH`,
`GradleModule`, `GradleProfileName`, `ImportedSymbols`, `ModuleGoVersion`,
`PackageFiles`, `PackageMaintainer`, `PackageVendor`, `PkgProvides`,
`ResolvedUrl`, `ServiceName`, `SrcGoMod`, `SrcPath`, `localScanPath` and the
three `privado*` keys. `docs/CUSTOM_PROPERTIES.md` carries the full list.

Container image properties keep their `oci:` namespace and `java:modules` keeps
its own — both were already namespaced.

For source evidence, prefer `evidence.occurrences[].location` and
`evidence.identity[].methods[].value` over matching `internal:SrcFile`; those
are modelled CycloneDX fields and will stay stable.

## atom 3 (native binaries)

cdxgen v13 has upgraded the bundled [atom](https://github.com/AppThreat/atom)
from 2.5.6 to 3.x. atom 3 is repackaged: `@appthreat/atom` is now a ~30 KB
dispatcher with eight per-platform `optionalDependencies` that carry the actual
payload. `@appthreat/atom-parsetools` (the `astgen`, `rbastgen`, `phpastgen`,
`scalasem`, and `php-parse` frontends) is still required for JS/TS, Python,
Ruby, PHP, and Scala analysis.

### JDK no longer required on five native platforms

The five native sub-packages embed a GraalVM native image and need **no JDK**:

- linux-amd64 (glibc)
- linux-arm64 (glibc)
- linux-amd64-musl
- darwin-arm64
- windows-amd64

The three jar-kind triples still require **Java 23+** (atom 3's jars are class-file version 67):

- darwin-amd64
- windows-arm64
- linux-arm64-musl

cdxgen now gates the "Atom requires Java 23" advice on the jar-kind provider,
so users on native platforms are no longer told to install a JDK for unrelated
failures. The standalone `cbom` and `saasbom` release binaries embed the
matching native (or jar) payload for their target triple.

### Reachables results are stricter

atom 3's reachables slicer uses a new Flux data-flow engine and additionally
drops sanitised flows, profile-neutralised flows, `<metaClassAdapter>`
duplicates, and flows terminating in benign builtins. **Reachables counts will
fall and purl coverage will rise** — this is the intended upstream improvement,
not a regression. Re-baseline any reachables-based assertions accordingly.

### `@appthreat/atom-parsetools` is now mandatory for evinse

The native atom binaries ship `bin/atom` alone; `astgen`, `rbastgen`,
`phpastgen`, and `scalasem` come from `@appthreat/atom-parsetools`, which cdxgen
already declares and places on `PATH`. Plain `npm i -g @cdxgen/cdxgen` installs
it automatically. If you previously relied on the old jar distribution bundling
these frontends, ensure `@appthreat/atom-parsetools` is installed.

From atom-parsetools 2.0.0, `astgen` writes the JavaScript and TypeScript type
maps with its `parsa` binary by default. The binary type checks with TypeScript
7's checker and is about four times faster than the TypeScript 6 path it
replaces. It ships as one of six `@appthreat/parsa-<os>-<cpu>` platform packages
listed as optional dependencies, so a plain install brings the one matching the
host, and an install with `--omit=optional` (or pnpm's `--no-optional`) keeps
the TypeScript 6 fallback. Whatever engine ran, astgen records it in
`astgen_manifest.jsonl` beside its output. astgen's own settings, including
`ASTGEN_TYPES`, `ASTGEN_NATIVE_BIN`, and `ASTGEN_NATIVE_MEMORY_MB`, are
documented in [atom-parsetools' ASTGEN.md](https://github.com/AppThreat/atom-parsetools/blob/main/docs/ASTGEN.md);
cdxgen neither reads nor sets them.

### PHP `php-parse` handling

The atom 3 dispatcher clobbers `PHP_PARSER_BIN` with a path that does not exist
on native platforms. cdxgen works around this by resolving the real `php-parse`
from `@appthreat/atom-parsetools` (or the `PHP_PARSER_BIN` env var) and spawning
the native binary directly for PHP. No operator action is required; container
images that set `PHP_PARSER_BIN` are honoured explicitly.

### Container memory

The native images size their heap from the cgroup limit, not host RAM, so atom
does not OOM in a memory-capped container and needs no `-XX:` override.
It does degrade sharply instead: measured on a 60-file JavaScript corpus,
`--memory=4g` ran in 11 s at 34% GC load, while `--memory=256m` ran the same
analysis in 116 s at 90% GC load. Give containers running evinse a few GB if
you care about wall time.

### New environment variables

See [`docs/ENV.md`](docs/ENV.md) for the Atom/Evinse env-var table
(`ATOM_CMD`, `ATOM_HOME`, `ATOM_JAVA_HOME`, `ATOM_DEBUG`, `PHP_PARSER_BIN`,
`ATOM_JVM_ARGS`, `ATOM_SLICE_DEPTH`).

## New CLI flags

| Flag                                                                                                                                             | Purpose                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--tlp-classification`                                                                                                                           | Record a Traffic Light Protocol classification under `metadata.distributionConstraints.tlp` (CycloneDX 1.7+). Present in v12 but hidden; now documented. A weak classification (`CLEAR`, `GREEN`, `AMBER`) also redacts known sensitive property values.                                                  |
| `--tea-fetch <tei>`                                                                                                                              | Retrieve a supplier's SBOM over the Transparency Exchange API and merge it. See [Lesson 20](docs/LESSON20.md).                                                                                                                                                                                            |
| `--tea-publish <url>`                                                                                                                            | Publish the generated BOM as a TEA Artifact. Targets the **draft** publisher API and will change.                                                                                                                                                                                                         |
| `--tea-leaf-identifier`, `--tea-collection-name`, `--tea-reason`, `--tea-author-name`, `--tea-author-email`, `--tea-artifact-url`, `--tea-token` | Supporting options for `--tea-publish`.                                                                                                                                                                                                                                                                   |
| `--experimental-mcp-pinning`                                                                                                                     | Record an explicit pinning state for MCP server components. Off by default; property names carry no stability promise.                                                                                                                                                                                    |
| `--introspect`                                                                                                                                   | Build introspection: grade how completely the environment allowed the BOM to be generated and write `<output>.introspection.md` / `.introspection.json` reports. Off by default; also enabled by `--profile introspect` or `CDXGEN_INTROSPECT=true`. See [Lesson 30](docs/LESSON30.md) and `docs/CLI.md`. |
| `--introspect-report`, `--introspect-json`                                                                                                       | Destinations for the introspection reports. Default next to the BOM output; `-` writes the markdown report to stderr.                                                                                                                                                                                     |
| `--introspect-fail-below <n>`                                                                                                                    | CI gate: exit with status **4** after the BOM is written when the overall introspection score is below `n`. Distinct from the generic failure status 1, so CI can tell a generation failure from a not-good-enough SBOM.                                                                                  |
| `--introspect-annotate`                                                                                                                          | Carry the verdict inside the BOM as `cdx:introspection:*` metadata properties and annotations. On whenever introspection runs; pass `--no-introspect-annotate` to keep the BOM untouched.                                                                                                                 |

`--tea-publish` uses exit status **3** for a publish failure, distinct from
other errors. The BOM is written to disk before the publish is attempted, so a
failure never costs you the SBOM — gate CI on `3` as "generated but not
distributed" rather than as a build failure. `--introspect-fail-below` uses
exit status **4** the same way: the BOM and the reports are written first, and
the gate means "generated but not good enough", which needs a different
response from a generation failure. An introspected run with
`--fail-on-error` uses exit status **5** when a build tool failed and the
failure was deferred so the BOM and the reports could still be written; the
extractor took no incomplete-result fallback, so the BOM holds exactly what
was collected before the failure.

## What appears in a BOM that did not before

These change component counts or add fields, so they are the ones most likely
to surprise a diff after upgrading.

- **CycloneDX 1.7 `citations`** — a root-level array recording that cdxgen
  collected the inventory, plus audit findings when `--bom-audit` ran. Stripped
  automatically at `--spec-version 1.6` and below. See
  [Lesson 19](docs/LESSON19.md).
- **PEP 770 embedded SBOMs** — components a Python distribution declares in its
  own `.dist-info/sboms/` directory now appear, as dependencies _of_ that
  distribution. On the project's own test fixture this took the component count
  from 1 to 2.
- **`algorithmFamily` and `ellipticCurve`** on cryptographic assets, with the
  deprecated free-text `curve` retained when a curve cannot be mapped to the
  1.7 enum.
- **New ecosystems** — Zig, Gleam, Mojo and bzlmod, listed above.

## Performance

Small projects are roughly 45% faster than v12 and use less memory; the packed
tarball grew ~0.4 MB. Numbers, methodology and what is still unmeasured are in
[docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Deprecations

The Rust fallback paths are **not** scheduled for removal, reversing the
original v13 plan — measurement did not justify making the binary mandatory.
See [docs/DEPRECATIONS.md](docs/DEPRECATIONS.md) for the full schedule and the
criteria that would have to hold before anything is removed.

## npm dependency tree reader updated

cdxgen reads npm dependency trees with a trimmed, vendored copy of
`@npmcli/arborist`, now based on upstream 10.0.2. SBOM content for npm projects
is unchanged. Two behaviours differ:

- **`packageExtensions` in a project's `package.json` are applied.** This is an
  upstream 10.x feature for repairing third-party manifests declaratively. Where
  an extension adds a dependency, that dependency now appears in the SBOM. No
  flag is needed. The BOM records the repair with `cdx:npm:packageExtensionsHash`
  on the root component and `cdx:npm:packageExtensionsApplied` on each affected
  dependency. Pass `--no-package-extensions` with `--deep` to produce a BOM that
  reflects manifests as published.
- **`.npm-extension.{mjs,cjs}` files are detected and declared, never executed.**
  npm loads and executes these while reading a tree; cdxgen does not run
  project-supplied code to build an SBOM. When a root `.npm-extension` file is
  present, cdxgen hashes it with npm's own algorithm and emits
  `cdx:npm:extensionHash`, `cdx:npm:extensionFormat`, and
  `cdx:npm:extensionApplied` on the root component.

  The repairs such a file makes are recorded in the lockfile, so cdxgen takes
  them from there rather than executing anything. When the on-disk hash matches
  the lockfile's `npmExtensionHash`, the SBOM reflects the repaired dependencies
  (`cdx:npm:extensionApplied: true`), and on `--deep` the affected packages also
  carry `cdx:npm:extensionFieldsApplied`. When the file has changed since the
  lockfile was written the hashes differ and the graph is reported as
  `unverified`; when the lockfile records no extension at all it is reported as
  `false`, meaning repairs may be missing.

## Diagnostic output moved from stdout to stderr

**Affected:** any caller that read cdxgen's stdout to get progress messages,
banners, the environment-audit table, or other diagnostics.

cdxgen v13 enforces a strict stream contract:

- **stdout** carries the payload only — the BOM document, and only when you ask
  for it on stdout with `-o -`.
- **stderr** carries every human-readable diagnostic: progress, banners,
  warnings, the environment audit, audit findings, and the debug, thought, and
  trace logs (`CDXGEN_DEBUG_MODE`, `CDXGEN_THINK_MODE`, `CDXGEN_TRACE_MODE`).

In v12 all of this went to stdout, so `CDXGEN_TRACE_MODE=true` interleaved JSON
trace records with `--print` table output and there was no way to get a clean
machine-readable stream.

If you parsed stdout for diagnostics, read stderr instead. To restore the v12
behaviour during a staged migration:

```shell
export CDXGEN_LOG_STREAM=stdout
```

This is a compatibility escape hatch and will be removed in a future release.

## `-o -` writes the BOM to stdout

`-o -` (or `--output -`) emits the BOM document on stdout with all diagnostics
on stderr:

```shell
cdxgen -t js -o - . > bom.json
cdxgen -t js -o - . | jq '.components | length'
```

In v12 this silently created a file named `-` in the current directory.

When several output formats are requested, `-o -` emits one document: the SPDX
document if `--format spdx` was requested, otherwise the CycloneDX one. Write to
files if you need both.

## Verbosity, progress, and log format flags

| Flag                          | Purpose                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `-q`, `--quiet`               | Errors only. (Env: `CDXGEN_LOG_LEVEL=silent`)                                                               |
| `--verbose`                   | Countable. Once for per-file detail, twice for debug output. (Env: `CDXGEN_LOG_LEVEL`, `CDXGEN_DEBUG_MODE`) |
| `--no-progress`               | Force static output instead of the live progress region. (Env: `CDXGEN_NO_PROGRESS`)                        |
| `--color=auto\|always\|never` | When to colorize. (Env: `CDXGEN_COLOR`, `NO_COLOR`, `FORCE_COLOR`)                                          |
| `--log-format=text\|json`     | `json` emits NDJSON records on stderr and disables the live region. (Env: `CDXGEN_LOG_FORMAT`)              |

`-v` still means `--version`, unchanged from v12. `--verbose` has no short form
because of it; repeat the long flag (`--verbose --verbose`) or set
`CDXGEN_LOG_LEVEL=debug`.

Existing env vars (`CDXGEN_DEBUG_MODE`, `SCAN_DEBUG_MODE`, `CI`, `NO_COLOR`,
`FORCE_COLOR`, `CDXGEN_TABLE_BORDER`) keep working and take precedence when both
a flag and an env var are set.

The live progress region is used only when stderr is an interactive terminal. It
is disabled automatically for pipes and redirects, under `CI=true`, when `TERM`
is `dumb` or `unknown`, in server mode, and inside worker threads — in all of
those cases each phase prints one plain line when it finishes, and no ANSI
escape byte is written.

### Containers: `docker run -t` opts into the live region

`docker run -t` allocates a pseudo-terminal, which makes stderr interactive
inside the container. Docker does **not** propagate the host's environment, so a
`CI=true` set by your build system is not visible to cdxgen in the container and
cannot suppress the region for you. A CI job that copies one of the documented
`-t` examples therefore collects cursor-movement escapes in its logs.

Pick whichever fits the job:

```shell
# Drop -t: nothing needs a TTY when the output is captured
docker run --rm -v /tmp:/tmp -v $(pwd):/app:rw ghcr.io/cdxgen/cdxgen -t js -o /app/bom.json /app

# Or keep -t and turn the region off explicitly
docker run --rm -t -e CDXGEN_NO_PROGRESS=true ... ghcr.io/cdxgen/cdxgen ...

# Or forward the CI signal the image cannot see
docker run --rm -t -e CI=true ... ghcr.io/cdxgen/cdxgen ...
```

This is not specific to containers — any `-t`-style pseudo-terminal has the same
effect — but containers are where it surprises people, because the host's `CI`
is silently absent.

## Trace records changed shape, and now carry phases

**Affected:** anything consuming `CDXGEN_TRACE_LOG` / `CDXGEN_TRACE_MODE`
output, including the `--tui` terminal interface (cdxui).

The trace stream is NDJSON: one JSON object per line, each with a `timestamp`
and a `type`. v13 renames the fields that v12 emitted and adds two record
types.

| Type       | v12 fields | v13 fields                                                          |
| ---------- | ---------- | ------------------------------------------------------------------- |
| `spawn`    | `cmd`      | `command`, `cwd`                                                    |
| `http`     | `url`      | `protocol`, `host`, `path`, `pathname`                              |
| `activity` | —          | `identifier`, `kind`, `status`, `target`, `reason`, `networkIntent` |
| `phase`    | —          | `phase`, `state`, `detail`, `note`, `done`, `total`, `elapsedMs`    |

A consumer that read `cmd` or `url` gets nothing in v13. Rebuild the URL from
its parts:

```js
const url = `${protocol.replace(/:$/, "")}://${host}${pathname ?? ""}`;
```

`phase` records mirror the live progress region, so a program driving cdxgen
through a pipe can render progress without scraping formatted lines. `state` is
one of `started`, `progress`, `succeeded`, `failed`, or `skipped`; `progress`
records are throttled to the frame interval, and `done`/`total` appear only for
phases with a determinate total:

```json
{"timestamp":"...","type":"phase","phase":"Generating BOM","state":"started","elapsedMs":0}
{"timestamp":"...","type":"phase","phase":"Generating BOM","state":"succeeded","note":"5770 components","elapsedMs":3013}
```

Two related fixes land with this:

- The thought and trace logs are written synchronously and opened in append
  mode. In v12 the tail of a log was lost when the process exited, so
  `CDXGEN_THOUGHT_LOG` files ended mid-sentence with no closing `</think>`, and
  worker threads punched holes through each other's records.
- `--tui` now reports an error when the cdxui plugin binary is missing instead
  of silently continuing without the interface, and passes arguments to cdxui
  separated by `\x1f` rather than by spaces, so a scan path containing a space
  survives. Set `CDXUI_CMD` to point at a specific cdxui binary.

Using `--tui` requires a cdxui build from cdxgen-plugins-bin new enough to
understand these records; an older cdxui shows an empty progress panel.

## Unidentifiable Java archives are reported instead of dropped

**Affected:** BOMs for `.jar`, `.war`, and `.hpi` archives, and container images
containing them. Component counts go up.

In v12, an archive whose Maven coordinates could not be read produced a warning
and was left out of the SBOM entirely:

```
Unable to extract component information from /opt/java/lib/jrt-fs.jar.
The SBOM won't include this artifact.
```

Silently omitting a shipped artifact is the worst outcome for an SBOM: the file
is on disk and reachable, but nothing downstream knows it exists. v13 records it
as a `file` component instead, with:

- MD5, SHA-1, and SHA-256 hashes, so it can be matched by content against a
  binary-authority service even without coordinates.
- `evidence.identity` at **confidence `0`** with technique `filename`, stating
  plainly that only the file name is known.
- A `pkg:generic/<name>` purl. The location is carried by `internal:SrcFile`
  and the evidence `concludedValue`, both rewritten to scan-relative paths;
  nested archives are identified by their entry path, as
  `outer.war!/WEB-INF/lib/inner.jar`. The purl holds no path, so it stays
  identical between runs over the same input.

This is the same treatment unpackaged executables and shared libraries already
get in container BOMs. The warning is gone; the archive is not.

Test jars (`-tests.jar`, `-test-sources.jar`) are still skipped, and unreadable
files are still skipped.

To find them in a generated BOM, select `file` components whose purl identity
was concluded at zero confidence from a `.jar`, `.war`, or `.hpi` name:

```shell
jq '[.components[]
     | select(.type=="file")
     | select(.name | test("\\.(jar|war|hpi)$"))
     | select(any(.evidence.identity[]?;
                  .field=="purl" and .confidence==0))]
    | length' bom.json
```

### Purls set by a collector are no longer discarded

`file`, `data`, and `cryptographic-asset` components get no purl _derived_ from
the ecosystem being scanned, since they are not packages of that ecosystem.
Previously this also discarded a purl the collector had already resolved. A
`pkg:generic/...` purl set by a collector is now preserved, which is what makes
these components joinable across BOMs.

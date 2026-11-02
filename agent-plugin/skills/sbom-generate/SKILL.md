---
name: sbom-generate
description: Generates a CycloneDX SBOM from source code with OWASP cdxgen, covering project-type selection across 30+ ecosystems, monorepo recursion, lifecycle phases, generation profiles, component filtering, and spec-version targeting. Use when asked to create an SBOM or BOM for a repository or directory, produce a dependency inventory, resolve licenses, or export SPDX from source.
---

# Generate an SBOM from source

Use this skill for the common case: a user wants a CycloneDX SBOM for a
repository or directory. For containers and binaries use `container-sbom`; for
live hosts use `os-hardware-inventory`; to improve an SBOM that came back thin
use `sbom-fidelity-loop`.

Read [reference/safety.md](../../reference/safety.md) before running anything.
The dry-run-first rule and the absolute-path rule are not optional.

## Core syntax

```bash
cdxgen [path] [options]
```

`path` defaults to `.`. Every boolean flag accepts a `--no-` prefix to invert it.

## Step 1: preview

```bash
cdxgen /absolute/path/to/project --dry-run --activity-report json
```

Summarize what the run would read, write, execute, and fetch. Ask before the
real run. Pay particular attention to whether the preview shows package-manager
installs; if it does, offer `--no-install-deps` or `--lifecycle pre-build`.

## Step 2: generate

```bash
cdxgen /absolute/path/to/project -o /absolute/path/to/bom.json
```

Auto-detection handles most projects. Reach for flags when it does not.

## Choosing a project type

Omit `-t` and let cdxgen detect. Pass it when detection is wrong, when you want
to constrain a large monorepo, or when the target is not source code.

```bash
# Restrict a polyglot repo to two ecosystems
cdxgen -t java -t python -o /absolute/path/to/bom.json /absolute/path/to/project

# Exclude one ecosystem instead of listing the rest
cdxgen --exclude-type mcp -o /absolute/path/to/bom.json /absolute/path/to/project
```

Common aliases (the full matrix is at
<https://cdxgen.github.io/cdxgen/#/PROJECT_TYPES>):

| Ecosystem  | Types                                                                 |
| ---------- | --------------------------------------------------------------------- |
| Node.js    | `npm`, `pnpm`, `yarn`, `bun`, `deno`, `js`, `ts`, `nodejs`, `rush`    |
| JVM        | `java`, `kotlin`, `scala`, `groovy`, `gradle`, `maven`, `sbt`, `mill` |
| Python     | `python`, `uv`, `poetry`, `pdm`, `hatch`, `pixi`, `rye`, `conda`      |
| Go         | `go`, `golang`, `gomod`                                               |
| Rust       | `rust`, `cargo`, `rs`                                                 |
| .NET       | `csharp`, `dotnet`, `vbnet`, `fsharp`                                 |
| Ruby       | `ruby`, `bundler`, `gems`                                             |
| PHP        | `php`, `composer`, `wordpress`                                        |
| C/C++      | `c`, `cpp`, `conan`, `collider`                                       |
| Others     | `dart`, `elixir`, `haskell`, `clojure`, `nix`, `zig`, `gleam`, `mojo` |
| CI/config  | `github`, `actions`, `helm`                                           |

Pinned toolchains are supported as types too: `java21`, `python312`,
`maven3.9.9`, `gradle8.14`, `ruby3.4.0`. cdxgen installs the pinned tool with
sdkman and uses it instead of the project's wrapper. This is the fix when a
project's wrapper is broken or targets an unsupported JDK.

## Monorepos

`--recurse` defaults to `true`. For large repos this is often the wrong default:

```bash
# Single project at the root only
cdxgen --no-recurse -t java -o /absolute/path/to/bom.json /absolute/path/to/project
```

Combine `--no-recurse` with explicit `-t` values, or use `--exclude` to skip
directories. See <https://cdxgen.github.io/cdxgen/#/MONOREPO>.

## Lifecycle phases

| Phase        | Behavior                                                        |
| ------------ | --------------------------------------------------------------- |
| `pre-build`  | No package installations. Manifests and lockfiles only.         |
| `build`      | Default. May invoke the package manager.                        |
| `post-build` | Binaries and containers rather than source.                     |

```bash
cdxgen --lifecycle pre-build -o /absolute/path/to/bom.json /absolute/path/to/project
```

`pre-build` is the right choice for CI, containers, air-gapped hosts, and any
run where modifying the project is unacceptable.

## Generation profiles

`--profile` presets a bundle of flags for an intended audience.

| Profile              | Intent                                                  |
| -------------------- | ------------------------------------------------------- |
| `generic`            | Default                                                 |
| `appsec`             | Application-security review                             |
| `research`           | Deep security research, maximum evidence                |
| `operational`        | Operations and runtime inventory                        |
| `threat-modeling`    | Threat-model inputs                                     |
| `license-compliance` | License resolution and compliance                       |
| `ml` / `ml-deep` / `ml-tiny` | Machine-learning inventory at three depths      |
| `introspect`         | Grade the scan's own fidelity and rank remediations     |

```bash
cdxgen --profile license-compliance -o /absolute/path/to/bom.json /absolute/path/to/project
cdxgen --profile research --evidence -o /absolute/path/to/bom.json /absolute/path/to/project
```

Use `--profile introspect` when the user's real question is "why is my SBOM
incomplete?" — then follow `sbom-fidelity-loop`.

## Filtering the component set

| Flag                | Effect                                                            |
| ------------------- | ----------------------------------------------------------------- |
| `--required-only`   | Production/non-dev dependencies only                              |
| `--filter <text>`   | Exclude components matching the text in purl or property values   |
| `--only <text>`     | Include only components matching the text in the purl             |
| `--exclude <glob>`  | Skip paths                                                        |
| `--exclude-type <t>`| Drop an ecosystem or overlay from the result                       |

```bash
cdxgen --required-only -o /absolute/path/to/bom.json /absolute/path/to/project
```

## Spec version and output format

`--spec-version` defaults to `1.7`. Accepted generation targets are `1.6`,
`1.7`, and `2.0`. **`1.4` and `1.5` are rejected as generation targets** — if a
consumer needs a legacy document, generate at a supported version and downgrade
the serialized output with `cdx-convert` (see `bom-convert-validate`).

```bash
# SPDX 3.0.1 JSON-LD directly
cdxgen --format spdx -o /absolute/path/to/bom.spdx.json /absolute/path/to/project

# Protobuf export alongside JSON
cdxgen --export-proto --proto-bin-file /absolute/path/to/bom.cdx -o /absolute/path/to/bom.json /absolute/path/to/project
```

Other output controls: `-p` / `--print` for a human-readable table or tree,
`--json-pretty`, `--tui` for the interactive terminal view, `--quiet`.

## Enrichment worth knowing about

| Flag                     | Adds                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| `--evidence`             | Occurrence and callstack evidence; produces a SaaSBOM                 |
| `--include-crypto`       | Cryptographic assets and certificates (see `crypto-bom`)              |
| `--include-formulation`  | Git metadata and build-tool versions                                  |
| `--include-release-notes`| Release notes for resolved components                                 |
| `--resolve-class`        | Class-to-namespace mapping; writes `<output>.map`                     |
| `--deep`                 | Deep parsing for C/C++, OS, OCI, and live systems                     |
| `--bom-audit`            | Embed supply-chain findings during generation (see `bom-audit`)        |
| `--tlp-classification`   | `CLEAR`, `GREEN`, `AMBER`, `AMBER_AND_STRICT`, `RED`                  |
| `--license-policy`       | Evaluate against a license policy file                                |

`--validate` is on by default; the BOM is schema-checked before cdxgen exits.

## When a run goes wrong

| Symptom                    | First thing to check                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| Hangs or exits with a thin BOM | Atom availability. Native-binary platforms need no JDK; on jar-based triples (darwin-amd64, windows-arm64, linux-arm64-musl) check `java -version` — Java >= 23 is required and fails silently below that. |
| Registry or network timeouts | Set `HTTP_PROXY` / `HTTPS_PROXY`; cdxgen's HTTP client honors them automatically. Do not auto-retry without asking. |
| Only direct dependencies   | The build tool could not resolve transitives. Run `--profile introspect` and follow `sbom-fidelity-loop`. |
| Fails in CI or a container | `--install-deps` defaulted on. Use `--no-install-deps` or `--lifecycle pre-build`.   |
| Missing build toolchain    | Suggest the container image, or a pinned type such as `-t java21`.                   |
| Permission errors          | Check whether `CDXGEN_SECURE_MODE` is set; see [reference/safety.md](../../reference/safety.md). |

More at <https://cdxgen.github.io/cdxgen/#/TROUBLESHOOTING>.

## After generating

Offer the natural next step rather than stopping at the file:

- Explore it interactively — `bom-explore`
- Audit supply-chain exposure — `bom-audit`
- Sign it for distribution — `bom-signing`
- Convert to SPDX or another spec version — `bom-convert-validate`
- Add usage and callstack evidence — `bom-evidence`
- Improve its accuracy — `sbom-fidelity-loop`
- Upload to Dependency-Track — `dependency-track-upload`

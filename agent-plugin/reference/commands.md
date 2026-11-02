# cdxgen command surface

`@cdxgen/cdxgen` publishes 16 commands. Pick the right entry point before
reaching for flags.

## Generation

| Command         | Equivalent                                                                       | Use for                                            |
| --------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| `cdxgen`        | —                                                                                | The universal generator for source, containers, OS |
| `obom`          | `cdxgen -t os`                                                                   | Live operating-system inventory                    |
| `hbom`          | dedicated command (library path: `cdxgen -t hbom`)                               | Live host hardware inventory                       |
| `cbom`          | `cdxgen --include-crypto --evidence --deep`                                      | Cryptographic BOM                                  |
| `aibom`         | `cdxgen -t ai`                                                                   | AI/ML model and service inventory                  |
| `saasbom`       | `cdxgen --evidence --deep`                                                        | Service and endpoint inventory with evidence       |
| `spdxgen`       | `cdxgen --format spdx`                                                           | Direct SPDX 3.0.1 JSON-LD output                   |
| `cdxgen-secure` | `cdxgen` under `CDXGEN_SECURE_MODE`                                              | Permission-restricted generation                   |
| `tracebom`      | dedicated command                                                                | Dynamic runtime-trace BOM from a running process   |

## Post-processing and analysis

| Command        | Use for                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `evinse`       | Add occurrence, callstack, data-flow, and crypto-flow evidence to a BOM      |
| `cdx-audit`    | Predictive supply-chain audit of existing BOMs; console/JSON/SARIF reporters |
| `cdx-validate` | Schema plus standards and signature validation of an existing BOM           |
| `cdx-convert`  | CycloneDX to SPDX 3.0.1 JSON-LD, or cross-convert between CycloneDX versions |
| `cdx-sign`     | Sign a BOM with JSF (replace, multi-signer, or chain modes)                  |
| `cdx-verify`   | Verify JSF signatures on a BOM                                              |
| `cdxi`         | Interactive REPL for exploring a generated BOM                              |

## Installation

| Requirement | Detail                                                                        |
| ----------- | ----------------------------------------------------------------------------- |
| Runtime     | Node.js >= 24                                                                  |
| Java        | Only on jar-based atom triples (darwin-amd64, windows-arm64, linux-arm64-musl): >= 23 |
| Install     | `npm i -g @cdxgen/cdxgen`, or run ad hoc with `pnpm dlx @cdxgen/cdxgen`       |
| Container   | `docker run --rm -v $(pwd):/app:rw -t ghcr.io/cdxgen/cdxgen:master /app`       |

Prefer the container image when the host is a jar-based atom triple without
Java 23, lacks the project's build toolchain, or when the user wants isolation
from `--install-deps`.

## Optional companion packages

| Package                      | Adds                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `@cdxgen/cdxgen-plugins-bin` | Trivy and osquery helpers, `golem` for Go Evinse evidence, `trustinspector` for host trust posture |
| `@cdxgen/cdx-hbom`           | Hardware collection on `darwin/arm64`, `linux/amd64`, `linux/arm64`, `windows/amd64`, `windows/arm64` |

These are optional. When absent, cdxgen still produces a valid BOM with less
enrichment; say so rather than reporting a failure.

## Reference links

- Docs home: <https://cdxgen.github.io/cdxgen>
- CLI reference: <https://cdxgen.github.io/cdxgen/#/CLI>
- Project types: <https://cdxgen.github.io/cdxgen/#/PROJECT_TYPES>
- Environment variables: <https://cdxgen.github.io/cdxgen/#/ENV>
- Secure mode: <https://cdxgen.github.io/cdxgen/#/PERMISSIONS>
- BOM audit rules: <https://cdxgen.github.io/cdxgen/#/BOM_AUDIT>
- Custom properties: <https://cdxgen.github.io/cdxgen/#/CUSTOM_PROPERTIES>
- Troubleshooting: <https://cdxgen.github.io/cdxgen/#/TROUBLESHOOTING>

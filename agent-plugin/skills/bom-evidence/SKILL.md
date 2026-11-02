---
name: bom-evidence
description: Enriches an existing CycloneDX BOM with occurrence, callstack, reachability, data-flow, and crypto-flow evidence using cdxgen evinse, including Go analysis via Golem and Rust analysis via Rusi, and produces SaaSBOM service and endpoint inventory. Use when asked which dependencies are actually used or reachable, for callstack or usage evidence, a SaaSBOM, API endpoint inventory, data-flow or taint analysis, or to distinguish real from declared dependency usage.
---

# Add evidence to a BOM

`evinse` answers a question a plain SBOM cannot: which declared dependencies
the code actually uses, where, and along what data paths. Run it on a BOM that
already exists.

Read [reference/safety.md](../../reference/safety.md) first. The rule about
never surfacing raw Golem values is a hard constraint, restated below.

## Basic flow

```bash
# 1. generate
cdxgen -t go -o /absolute/path/to/bom.json /absolute/path/to/project

# 2. enrich
evinse -i /absolute/path/to/bom.json -o /absolute/path/to/bom.evinse.json \
  -l go /absolute/path/to/project
```

`-l` / `--language` defaults to `java`. Supported: `java`, `jar`, `js`, `ts`,
`javascript`, `nodejs`, `py`, `python`, `android`, `go`, `golang`, `rust`, `rs`,
`csharp`, `cs`, `c`, `cpp`, `dotnet`, `php`, `swift`, `ios`, `ruby`, `scala`,
`vb`.

## Evidence dimensions

| Flag                 | Adds                                                            |
| -------------------- | --------------------------------------------------------------- |
| `--with-reachables`  | Reachability slices                                             |
| `--with-data-flow`   | Data-flow evidence                                              |
| `--deep`             | Deeper analysis across dimensions                               |
| `--annotate`         | Record findings as BOM annotations                              |
| `--print, -p`        | Human-readable summary                                          |
| `--openapi-spec-file`| Correlate discovered endpoints against an OpenAPI spec          |
| `--force`            | Re-run even when cached slices exist                            |

Slice outputs can be written or reused via `--usages-slices-file`,
`--reachables-slices-file`, `--data-flow-slices-file`, `--semantics-slices-file`,
and `--deps-slices-file`. Pass these when the user will iterate — regenerating
slices is the expensive part.

`--with-deep-jar-collector` and `--skip-maven-collector` tune JVM collection.

## SaaSBOM: services and endpoints

```bash
saasbom /absolute/path/to/project -o /absolute/path/to/saasbom.json
```

`saasbom` sets `--evidence` and `--deep`, and defaults the spec version to
`1.7`. Equivalent from source:

```bash
cdxgen --evidence --deep -o /absolute/path/to/bom.json /absolute/path/to/project
```

**Be candid about SaaSBOM's success rate.** Service and endpoint collection
depends on `atom` and `atom-tools`, and outside the cdxgen container image the
chances of a complete collection are low unless the user has set those up
themselves. cdxgen itself warns about this when not running in a container.
Recommend the container image:

```bash
docker run --rm -v $(pwd):/app:rw -t ghcr.io/cdxgen/cdxgen:master /app --evidence -o /app/bom.json
```

Inspect results in `cdxi` with `.services` and `.occurrences`.

## Go: Golem

Golem provides semantic evidence for Go, from the optional
`@cdxgen/cdxgen-plugins-bin` package. When the platform binary is absent,
`evinse` still runs but without Golem evidence — say so rather than reporting
failure.

```bash
evinse -i /absolute/path/to/bom.json -o /absolute/path/to/bom.evinse.json \
  -l go --golem-callgraph static /absolute/path/to/project

cdx-audit --bom /absolute/path/to/bom.evinse.json --direct-bom-audit --categories golem
```

### Call graph modes

`--golem-callgraph`: `none`, `static` (default), `cha`, `rta`, `vta`. Precision
and cost both rise across that list. Start with `static`.

### Data-flow modes

`--golem-dataflow`: `none`, `security`, `crypto`, `all`. Defaults to `all` with
`--with-data-flow`, `--profile research`, or `--deep`; `none` otherwise.

Bounded crypto-flow analysis:

```bash
evinse -i /absolute/path/to/bom.json -o /absolute/path/to/bom.evinse.crypto.json \
  -l go --with-data-flow \
  --golem-dataflow crypto --golem-dataflow-pattern-packs crypto \
  /absolute/path/to/project
```

### Bounding cost

Go data-flow analysis is the most expensive thing in this skill. **Keep it
bounded in CI**: `--golem-dataflow-workers`, `--golem-max-procs`,
`--golem-memory-limit`, `--golem-dataflow-max-slices`,
`--golem-dataflow-max-trace-nodes`, `--golem-dataflow-max-trace-edges`,
`--golem-dataflow-max-function-instructions`,
`--golem-dataflow-large-repo-functions`, `--golem-dataflow-skip-generated`,
`--golem-dataflow-skip-tests`, `--golem-progress`.

Set explicit limits rather than letting an unbounded run consume a CI runner.

### Reviewing Golem output

Start high, then drill down. In `cdxi`: `.golemsummary`, `.golemhotspots`,
`.golemcoverage`, `.golemtips` — then `.occurrences`, `.callstack`, and
`.inspect <component>`.

For crypto flow, prioritize components with `cdx:golem:cryptoDataFlow=true` and
`cdx:golem:cryptoDataFlowCount`, then pivot on the rendered
`cryptographic-asset` algorithms.

Golem also surfaces Go-specific supply-chain facts: local `replace` directives,
vendoring and license evidence, usage scopes, and security-sensitive API signals.

### The Golem disclosure rule

**Never surface raw `go:generate` commands, environment values, HTTP parameter
values, key material, plaintext, ciphertext, embedded file contents, generated
source contents, or secrets.** Review exclusively through the emitted
`cdx:golem:*` counts, categories, rule IDs, taint kinds, scopes, call-stack
frames, crypto algorithm/OID pivots, and module facts.

This is not a style preference. Golem's raw output can contain the secrets it
found, and repeating them into a chat transcript or a BOM shared downstream
spreads them.

Threat model: <https://cdxgen.github.io/cdxgen/#/GO_EVINSE_GOLEM_THREAT_MODEL>.

## Rust: Rusi

```bash
evinse -i /absolute/path/to/bom.json -o /absolute/path/to/bom.evinse.json \
  -l rust --rusi-mode analyze /absolute/path/to/project
```

| Flag              | Choices                                          |
| ----------------- | ------------------------------------------------ |
| `--rusi-mode`     | `analyze` (default), `cryptos`                   |
| `--rusi-backend`  | `stable` (default), `compiler`                   |
| `--rusi-toolchain`| `auto` (default), `nightly`, `stable`            |
| `--rusi-callgraph`, `--rusi-dataflow`, `--rusi-patterns` | analysis tuning       |

Use `--rusi-mode cryptos` when the question is cryptographic usage rather than
general dependency usage.

In `cdxi`: `.cargohotspots` and `.cargoworkflows`.

## Reporting evidence honestly

- Absence of an occurrence is not proof a dependency is unused. Reflection, dynamic dispatch, and generated code defeat static analysis.
- Say which analysis mode you used. `static` call graphs miss what `vta` finds.
- When Golem or Rusi binaries were unavailable, state that the evidence layer did not run rather than presenting a thinner BOM as complete.

## Reference

- Evinse: <https://cdxgen.github.io/cdxgen/#/EVINSE>
- Go Evinse and Golem: <https://cdxgen.github.io/cdxgen/#/GO_EVINSE_GOLEM>
- Golem threat model: <https://cdxgen.github.io/cdxgen/#/GO_EVINSE_GOLEM_THREAT_MODEL>

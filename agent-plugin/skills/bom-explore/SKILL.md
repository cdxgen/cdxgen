---
name: bom-explore
description: Explores and triages a CycloneDX BOM interactively with the cdxi REPL, using built-in commands for dependency trees, licenses, services, cryptographic assets, audit findings, evidence occurrences and callstacks, unpackaged container binaries, HBOM and OBOM categories, and Golem or Cargo hotspots. Use when asked to inspect, query, summarize, or triage an existing BOM, find what is inside an SBOM, or answer ad hoc questions about BOM contents without writing scripts.
---

# Explore a BOM interactively

`cdxi` is a REPL for querying a BOM without writing one-off `jq` pipelines. Use
it for ad hoc investigation and triage.

```bash
cdxi
cdxi /absolute/path/to/bom.json
cdxi /absolute/path/to/bom.evinse.json
```

If `bom.json` exists in the working directory, `cdxi` imports it automatically.

Read [reference/safety.md](../../reference/safety.md) first — the
review-before-sharing rule applies to anything you quote out of a BOM.

## Working non-interactively

`cdxi` is interactive, which makes it awkward to drive from an agent turn. When
you need a single answer rather than a session, prefer `jq` against the BOM
file:

```bash
jq '.components | length' /absolute/path/to/bom.json
jq -r '.components[] | "\(.purl)"' /absolute/path/to/bom.json | sort
jq '.annotations[]' /absolute/path/to/bom.json
```

Recommend `cdxi` to the **user** when their question is genuinely exploratory
and they will want to pivot repeatedly. Use `jq` yourself when you need one
fact.

## Start here

| Command     | Shows                                       |
| ----------- | ------------------------------------------- |
| `.summary`  | Overall BOM shape and counts                |
| `.print`    | Component table                             |
| `.tree`     | Dependency tree                             |
| `.validate` | Validation status                           |
| `.create .` | Generate a BOM for the current directory    |
| `.exit`     | Leave                                       |

Always begin with `.summary`. It tells you which of the specialized command
families are even populated.

## By document type

### Dependencies and licenses

`.print`, `.tree`, `.provides`, `.licenses`, `.tagcloud`, `.dispatchedges`

`.tagcloud` is a quick way to see what a BOM is mostly made of.

### Evidence and usage

`.occurrences`, `.callstack`, `.inspect <component>`

Populated only when the BOM came through `evinse` or `--evidence`. See
`bom-evidence`.

### Services and SaaSBOM

`.services`, `.formulation`

### Cryptography

`.cryptos` (all cryptographic assets), `.sourcecryptos` (JavaScript/TypeScript
source-derived algorithms only), `.trusted` (trusted keys and certificates)

Reach for `.sourcecryptos` when the question is about code-level algorithm
usage rather than shipped certificates. See `crypto-bom`.

### Container and rootfs

`.unpackagedbins`, `.unpackagedlibs`

These isolate executable and shared-library components that sit **outside OS
package ownership** — the files an image ships that no package manager accounts
for. A high count is worth surfacing. See `container-sbom`.

### AI and provenance

`.aibom`, `.provenance`

### Audit findings

`.auditfindings`, `.auditactions`

Use these to triage `--bom-audit` annotations. See `bom-audit`.

### Go / Golem evidence

`.golemsummary`, `.golemhotspots`, `.golemcoverage`, `.golemtips`

Work top-down: summary, then hotspots, then coverage, and only then
`.occurrences`, `.callstack`, or `.inspect <component>`. See `bom-evidence`.

### Rust / Cargo

`.cargohotspots`, `.cargoworkflows`

### Hardware BOM

`.hbomsummary`, `.hbomclasses`, `.hbomevidence`, `.hbomdiagnostics`,
`.hbomfirmware`, `.hbombuses`, `.hbompower`, `.hbomtips`

Start with `.hbomsummary`; use `.hbomdiagnostics` when the HBOM looks sparse.
See `os-hardware-inventory`.

### Operating system BOM

`.osinfocategories`, `.obomtips`, `.instrumented`

Each category `.osinfocategories` lists is also a command of the same name,
for example `.deb_packages`, `.rpm_packages`, `.apk_packages` (Alpine, Wolfi
and Chainguard, read from the apk database), `.homebrew_packages`,
`.npm_packages`, `.python_packages` and `.processes`.

`.instrumented` isolates trace-derived components — see `runtime-trace-bom`.

### Vulnerabilities

`.vulnerabilities`

## Triage patterns

**"What is in this SBOM?"**
`.summary` → `.tagcloud` → `.licenses`

**"Which dependencies are actually used?"**
`.occurrences` → `.callstack` → `.inspect <component>` (needs an evinse BOM)

**"What should I look at first in this container image?"**
`.summary` → `.unpackagedbins` → `.unpackagedlibs` → `.trusted`

**"What did the audit find?"**
`.auditfindings` → `.auditactions`

**"Why is my Go evidence thin?"**
`.golemcoverage` → `.golemtips`

**"Why is my HBOM empty?"**
`.hbomdiagnostics`, then `hbom diagnostics` outside the REPL

## Reference

- REPL guide: <https://cdxgen.github.io/cdxgen/#/REPL>

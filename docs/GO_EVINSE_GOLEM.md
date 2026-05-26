# Go Evinse with Golem

Go Evinse uses the `golem` helper from `@cdxgen/cdxgen-plugins-bin` to enrich a Go SBOM with semantic source evidence. The integration is designed for reviewers who need to connect Go module inventory to actual source usage, call graph edges, build directives, native artifacts, and security-sensitive API signals.

The result is still a normal CycloneDX JSON BOM. Golem-derived facts are written as component evidence and `cdx:golem:*` custom properties so existing CycloneDX tools can store the file while cdxgen, `cdxi`, and BOM audit rules can make the extra context useful.

## Quick start

```bash
cdxgen -t go -o bom.json /absolute/path/to/go/project
evinse -i bom.json -o bom.evinse.json -l go /absolute/path/to/go/project
cdxi bom.evinse.json
```

Inside `cdxi`, start with:

```text
.golemsummary
.golemhotspots
.golemcoverage
.occurrences
.callstack
```

For a focused audit pass:

```bash
cdxgen -t go -o bom.json /absolute/path/to/go/project
evinse -i bom.json -o bom.evinse.json -l go /absolute/path/to/go/project
cdx-audit --bom bom.evinse.json --direct-bom-audit --categories golem
```

## What Golem contributes

Golem reads Go packages through the Go toolchain and emits a JSON report. cdxgen maps that report into CycloneDX as follows:

```
Go source tree
   |
   v
golem analyze --format json --callgraph <mode>
   |
   v
golem.json
   |
   v
evinse -l go
   |
   +--> component.evidence.occurrences
   +--> component.evidence.callstack.frames
   +--> component.properties: cdx:golem:*
   +--> metadata.component.properties: cdx:golem:*
```

The integration keeps source evidence compact. It records file names, line numbers, categories, counts, symbol kinds, scopes, and module identity. It does not copy raw environment values, command output, generated file contents, or embedded secrets into the BOM.

## CLI options

These options are accepted by `evinse` when `--language go` or `--language golang` is used.

| Option              | Default                       | Purpose                                                                      |
| ------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `--golem-command`   | `GOLEM_CMD` or bundled plugin | Use a specific `golem` binary. Useful when testing a local helper build.     |
| `--golem-callgraph` | `static`                      | Call graph mode. Accepted values are `none`, `static`, `rta`, and `pointer`. |
| `--golem-patterns`  | `./...`                       | Comma-separated Go package patterns passed to Golem.                         |
| `--golem-tags`      | none                          | Comma-separated Go build tags.                                               |
| `--golem-tests`     | `false`                       | Include Go test variants in package loading and evidence.                    |

Recommended defaults for CI are `--golem-callgraph static` and the default `./...` patterns. Use `rta` or `pointer` when an investigation needs deeper call graph precision and can tolerate more time and memory.

## Call graph modes

| Mode      | Use when                                                                                           | Trade-off                                                         |
| --------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `none`    | You only need imports, usages, build directives, native artifacts, and security signal properties. | Fastest, no call graph frames from edges.                         |
| `static`  | You want a good default for CI and routine AppSec review.                                          | Fast and broad, may include edges that are not runtime-reachable. |
| `rta`     | You want a better approximation from discovered `init` and `main` roots.                           | More precise than static for many applications, more expensive.   |
| `pointer` | You need the deepest call graph attempt for a focused investigation.                               | Most expensive, best reserved for targeted runs.                  |

## Custom property families

Golem emits properties on two levels.

Metadata-level properties summarize the whole Go project and the helper run. Examples include `cdx:golem:toolVersion`, `cdx:golem:callGraphMode`, `cdx:golem:packageCount`, `cdx:golem:fileCount`, `cdx:golem:securitySignalCount`, `cdx:golem:nativeArtifactCount`, `cdx:golem:goDirectiveVersion`, and `cdx:golem:toolchainDirective`.

Component-level properties explain how an individual Go module appears in the analyzed source. Examples include `cdx:golem:modulePath`, `cdx:golem:goVersion`, `cdx:golem:usageScopes`, `cdx:golem:occurrenceEvidenceKinds`, `cdx:golem:securitySignalCategory`, `cdx:golem:securitySignalSeverity`, `cdx:golem:vendored`, `cdx:golem:privateModuleCandidate`, `cdx:golem:licenseFileCount`, and `cdx:golem:localReplacement`.

See [cdx: Custom Properties](CUSTOM_PROPERTIES.md#golem-go-evinse-evidence) for the full inventory.

## BOM audit categories

Go Evinse properties are covered by three built-in BOM audit categories:

| Category            | Focus                                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| `golem-security`    | High-severity semantic security signals and local replacement risk.           |
| `golem-performance` | Expensive analysis choices plus native/generated build surfaces.              |
| `golem-compliance`  | Private module candidates and vendored modules without license-file evidence. |

Run them directly against an enriched BOM:

```bash
cdx-audit --bom bom.evinse.json --direct-bom-audit --categories golem
```

This direct-audit pattern is the expected workflow because `evinse -l go` is the step that adds the Golem properties.

## Threat model summary

Go Evinse with Golem is meant to reduce uncertainty in these review questions:

1. Which Go modules are actually referenced by source code?
2. Which usages are runtime, test, benchmark, fuzz, or example scoped?
3. Which dependencies are touched by security-sensitive APIs?
4. Which builds rely on local replacements, vendored modules, generated code, embedded assets, cgo, or native sidecars?
5. Which private modules need internal provenance and license controls because public registry metadata is not enough?

It does not prove exploitability by itself. Treat the evidence as a prioritization and review layer. Pair it with vulnerability data, test results, code review, and runtime context before making release decisions.

## Practical workflow

```bash
# 1. Generate the base Go SBOM.
cdxgen -t go -o bom.json /absolute/path/to/go/project

# 2. Add semantic evidence.
evinse -i bom.json -o bom.evinse.json -l go --golem-callgraph static /absolute/path/to/go/project

# 3. Audit Golem-derived properties.
cdx-audit --bom bom.evinse.json --direct-bom-audit --categories golem

# 4. Explore interactively.
cdxi bom.evinse.json
```

Use `--golem-tests` when test-only dependency use matters for your decision. Keep it off for production-only triage when you want fewer test-scope signals.

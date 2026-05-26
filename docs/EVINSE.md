# evinse — Add evidence and SaaSBOM context to an SBOM

`evinse` enriches an existing CycloneDX BOM with evidence such as occurrences, call stacks, reachability, and service metadata.

It is the right tool when you already have a BOM and want to answer questions such as:

- Which dependencies are actually used?
- Which packages are reachable from entry points?
- Which services or API surfaces were inferred from the application?
- Which components carry evidence that can support review or verification?

## Who should use this

- **AppSec engineers** — prioritize exploitable or reachable dependencies
- **Developers** — understand which dependencies are exercised by the codebase
- **Platform teams** — generate SaaSBOM-style service evidence from supported projects

## Quick start

```shell
# Start from an existing SBOM
cdxgen -t java -o bom.json .

# Add occurrence evidence
evinse -i bom.json -o bom.evinse.json -l java .

# Add reachability-based evidence
evinse -i bom.json -o bom.evinse.json -l js --with-reachables .

# Add deeper data-flow evidence
evinse -i bom.json -o bom.evinse.json -l java --with-data-flow .
```

## CLI reference

| Flag                        | Default                  | Description                                                                    |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `-i, --input`               | `bom.json`               | Input CycloneDX BOM                                                            |
| `-o, --output`              | `bom.evinse.json`        | Output enriched BOM                                                            |
| `-l, --language`            | `java`                   | Source language                                                                |
| `--golem-command`           | `GOLEM_CMD`              | Use a specific `golem` binary for Go Evinse                                    |
| `--golem-callgraph`         | `static`                 | Go call graph mode: `none`, `static`, `rta`, or `pointer`                      |
| `--golem-patterns`          | `./...`                  | Comma-separated Go package patterns                                            |
| `--golem-tags`              | none                     | Comma-separated Go build tags                                                  |
| `--golem-tests`             | off                      | Include Go test variants in Golem analysis                                     |
| `--force`                   | off                      | Rebuild the evidence database                                                  |
| `--skip-maven-collector`    | off                      | Skip Maven and Gradle cache collection                                         |
| `--with-deep-jar-collector` | off                      | Collect more jars for better Java recall                                       |
| `--annotate`                | off                      | Include atom slice contents as annotations                                     |
| `--with-data-flow`          | off                      | Enable inter-procedural data-flow slicing                                      |
| `--with-reachables`         | off                      | Enable reachability-based slicing                                              |
| `--profile`                 | `generic`                | Use `research` to enable dosai data-flow and crypto analysis for .NET projects |
| `--usages-slices-file`      | `usages.slices.json`     | Reuse an existing usages slice file                                            |
| `--data-flow-slices-file`   | `data-flow.slices.json`  | Reuse an existing data-flow slice file                                         |
| `--reachables-slices-file`  | `reachables.slices.json` | Reuse an existing reachables slice file                                        |
| `--semantics-slices-file`   | `semantics.slices.json`  | Reuse an existing semantics slice file                                         |
| `--openapi-spec-file`       | `openapi.json`           | Reuse an existing OpenAPI spec file                                            |
| `-p, --print`               | off                      | Print evidence tables after generation                                         |

## Supported languages

`evinse` accepts the following language identifiers:

- `java`, `jar`, `android`, `scala`
- `js`, `ts`, `javascript`, `nodejs`
- `py`, `python`
- `go`, `golang`
- `c`, `cpp`
- `csharp`, `cs`, `dotnet`, `vb`, `vbnet`, `visualbasic`, `f#`, `fs`, `fsharp`
- `php`, `ruby`, `swift`, `ios`

## Evidence modes

### Occurrence evidence

The default mode. It records where dependencies appear in the codebase.

### Reachability evidence

Use `--with-reachables` when you need entry-point-to-sink style reachability signals. This is often the best trade-off for AppSec triage.

### Data-flow evidence

Use `--with-data-flow` when you need deeper call-stack evidence and are willing to spend more time and compute.

### Go evidence powered by Golem

For Go projects, `evinse -l go` uses the bundled `golem` helper from `@cdxgen/cdxgen-plugins-bin` when available. Golem maps Go modules to semantic source evidence and emits occurrence, call-stack, usage-scope, build, native-artifact, and security-signal context.

```shell
cdxgen -t go -o bom.json /absolute/path/to/go/project
evinse -i bom.json -o bom.evinse.json -l go --golem-callgraph static /absolute/path/to/go/project
```

The enriched BOM includes:

- `component.evidence.occurrences` for import and symbol usage locations
- `component.evidence.callstack.frames` from usage and call graph evidence when available
- component-level `cdx:golem:*` properties such as usage scopes, occurrence evidence kinds, security signal category/severity, vendoring, private-module hints, license-file counts, and replacement status
- metadata-level `cdx:golem:*` properties such as tool version, call graph mode, package/module/file counts, build directive counts, native artifact counts, and Go toolchain directives

Use `--golem-callgraph static` for routine CI. Use `rta` or `pointer` when an investigation needs more precision and can tolerate more time and memory. Use `--golem-tests` when test-only dependencies are part of the review.

After enrichment, import the BOM into `cdxi` and use `.golemsummary`, `.golemhotspots`, `.golemcoverage`, `.occurrences`, and `.callstack`. For focused policy review, run `cdx-audit --bom bom.evinse.json --direct-bom-audit --categories golem`.

### .NET evidence powered by dosai

For .NET projects, `evinse` uses the bundled `dosai` helper from `@cdxgen/cdxgen-plugins-bin` when available:

- `dosai methods` adds occurrence evidence from package reachability and method-call slices.
- `dosai ApiEndpoints` are converted into CycloneDX `services` for SaaSBOM views.
- `dosai dataflows` adds call-stack evidence when `--with-data-flow` is used.
- `--profile research` enables both data-flow and crypto analysis for .NET projects.

```shell
cdxgen -t dotnet --deep --evidence -o bom.json .
evinse -i bom.json -o bom.evinse.json -l dotnet --profile research .
```

Service endpoints are sanitized before being written to the BOM: URL credentials, query strings, and fragments are removed, and raw authorization policy or role names are summarized as counts rather than copied into properties.

## Practical guidance

- Generate the input BOM with `cdxgen` first.
- For Java and Python, deeper evidence quality usually improves when the input BOM was created with `--deep`.
- Reuse slice files in CI to reduce repeat analysis time.
- Import the enriched BOM into [`cdxi`](REPL.md) and use `.occurrences`, `.callstack`, `.services`, `.formulation`, or the Go-specific `.golemsummary`, `.golemhotspots`, and `.golemcoverage` commands for interactive review.

## Example workflow

```shell
cdxgen -t python --deep -o bom.json .
evinse -i bom.json -o bom.evinse.json -l python --with-reachables .
cdxi bom.evinse.json
```

## Related docs

- [Advanced Usage](ADVANCED.md)
- [Go Evinse with Golem](GO_EVINSE_GOLEM.md)
- [REPL / cdxi](REPL.md)
- [CLI Usage](CLI.md)

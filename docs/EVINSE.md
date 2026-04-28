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

| Flag                        | Default                  | Description                                |
| --------------------------- | ------------------------ | ------------------------------------------ |
| `-i, --input`               | `bom.json`               | Input CycloneDX BOM                        |
| `-o, --output`              | `bom.evinse.json`        | Output enriched BOM                        |
| `-l, --language`            | `java`                   | Source language                            |
| `--force`                   | off                      | Rebuild the evidence database              |
| `--skip-maven-collector`    | off                      | Skip Maven and Gradle cache collection     |
| `--with-deep-jar-collector` | off                      | Collect more jars for better Java recall   |
| `--annotate`                | off                      | Include atom slice contents as annotations |
| `--with-data-flow`          | off                      | Enable inter-procedural data-flow slicing  |
| `--with-reachables`         | off                      | Enable reachability-based slicing          |
| `--usages-slices-file`      | `usages.slices.json`     | Reuse an existing usages slice file        |
| `--data-flow-slices-file`   | `data-flow.slices.json`  | Reuse an existing data-flow slice file     |
| `--reachables-slices-file`  | `reachables.slices.json` | Reuse an existing reachables slice file    |
| `--semantics-slices-file`   | `semantics.slices.json`  | Reuse an existing semantics slice file     |
| `--openapi-spec-file`       | `openapi.json`           | Reuse an existing OpenAPI spec file        |
| `-p, --print`               | off                      | Print evidence tables after generation     |

## Supported languages

`evinse` accepts the following language identifiers:

- `java`, `jar`, `android`, `scala`
- `js`, `ts`, `javascript`, `nodejs`
- `py`, `python`
- `c`, `cpp`
- `php`, `ruby`, `swift`, `ios`

## Evidence modes

### Occurrence evidence

The default mode. It records where dependencies appear in the codebase.

### Reachability evidence

Use `--with-reachables` when you need entry-point-to-sink style reachability signals. This is often the best trade-off for AppSec triage.

### Data-flow evidence

Use `--with-data-flow` when you need deeper call-stack evidence and are willing to spend more time and compute.

## Practical guidance

- Generate the input BOM with `cdxgen` first.
- For Java and Python, deeper evidence quality usually improves when the input BOM was created with `--deep`.
- Reuse slice files in CI to reduce repeat analysis time.
- Import the enriched BOM into [`cdxi`](REPL.md) and use `.occurrences`, `.callstack`, `.services`, or `.formulation` for interactive review.

## Example workflow

```shell
cdxgen -t python --deep -o bom.json .
evinse -i bom.json -o bom.evinse.json -l python --with-reachables .
cdxi bom.evinse.json
```

## Related docs

- [Advanced Usage](ADVANCED.md)
- [REPL / cdxi](REPL.md)
- [CLI Usage](CLI.md)

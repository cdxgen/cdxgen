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

| Flag                             | Default                  | Description                                                                                                       |
| -------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `-i, --input`                    | `bom.json`               | Input CycloneDX BOM                                                                                               |
| `-o, --output`                   | `bom.evinse.json`        | Output enriched BOM                                                                                               |
| `-l, --language`                 | `java`                   | Source language                                                                                                   |
| `--compile-commands`             | autodetected             | C/C++ `compile_commands.json` (or its directory) for atom 4.0+; see [LESSON27.md](LESSON27.md)                    |
| `--golem-command`                | `GOLEM_CMD`              | Use a specific `golem` binary for Go Evinse                                                                       |
| `--golem-callgraph`              | `static` / `none`        | Go call graph mode: `none`, `static`, `cha`, `rta`, or `vta`                                                      |
| `--golem-dataflow`               | `none` / `all`           | Go data-flow mode: `none`, `security`, `crypto`, or `all`                                                         |
| `--golem-dataflow-callgraph`     | `none`                   | Call graph mode for Golem data-flow dynamic summary replay                                                        |
| `--golem-dataflow-pattern-packs` | `all`                    | Data-flow pattern packs such as `crypto`, `process`, `filesystem`, or `all`                                       |
| `--golem-dataflow-max-slices`    | bounded by cdxgen        | Maximum Golem data-flow slices to retain                                                                          |
| `--golem-dataflow-workers`       | capped CPU count         | Worker cap for predictable Go data-flow performance                                                               |
| `--golem-max-procs`              | capped CPU count         | Go scheduler thread cap for Golem                                                                                 |
| `--golem-memory-limit`           | none                     | Optional Golem soft memory limit such as `4GiB`                                                                   |
| `--golem-patterns`               | `./...`                  | Comma-separated Go package patterns                                                                               |
| `--golem-tags`                   | none                     | Comma-separated Go build tags                                                                                     |
| `--golem-tests`                  | off                      | Include Go test variants in Golem analysis                                                                        |
| `--rusi-command`                 | `RUSI_CMD`               | Use a specific `rusi` binary for Rust Evinse                                                                      |
| `--rusi-mode`                    | `analyze`                | Rusi analysis mode. analyze or cryptos                                                                            |
| `--rusi-backend`                 | `stable`                 | Rusi analysis backend. stable or compiler                                                                         |
| `--rusi-toolchain`               | `auto`                   | Rust toolchain for the Rusi compiler backend (e.g., auto, nightly, stable).                                       |
| `--rusi-callgraph`               | `static`                 | Rusi call graph mode.                                                                                             |
| `--rusi-dataflow`                | `none` or `security`     | Rusi data-flow mode. Defaults to security with --with-data-flow, research profile, or --deep, and none otherwise. |
| `--rusi-patterns`                | off                      | Custom Rusi data-flow pattern JSON file.                                                                          |
| `--force`                        | off                      | Rebuild the evidence database                                                                                     |
| `--skip-maven-collector`         | off                      | Skip Maven and Gradle cache collection                                                                            |
| `--with-deep-jar-collector`      | off                      | Collect more jars for better Java recall                                                                          |
| `--annotate`                     | off                      | Include atom slice contents as annotations                                                                        |
| `--with-data-flow`               | off                      | Enable inter-procedural data-flow slicing                                                                         |
| `--with-reachables`              | off                      | Enable reachability-based slicing                                                                                 |
| `--profile`                      | `generic`                | Use `research` to enable dosai data-flow and crypto analysis for .NET projects                                    |
| `--usages-slices-file`           | `usages.slices.json`     | Reuse an existing usages slice file                                                                               |
| `--data-flow-slices-file`        | `data-flow.slices.json`  | Reuse an existing data-flow slice file                                                                            |
| `--reachables-slices-file`       | `reachables.slices.json` | Reuse an existing reachables slice file and its `_1.json`, `_2.json`, ... chunks                                  |
| `--semantics-slices-file`        | `semantics.slices.json`  | Reuse an existing semantics slice file                                                                            |
| `--openapi-spec-file`            | `openapi.json`           | Reuse an existing OpenAPI spec file                                                                               |
| `-p, --print`                    | off                      | Print evidence tables after generation                                                                            |

## Supported languages

`evinse` accepts the following language identifiers:

- `java`, `jar`, `android`, `scala`
- `js`, `ts`, `javascript`, `nodejs`
- `py`, `python`
- `go`, `golang`
- `rust`, `rust-lang`, `rs`
- `c`, `cpp`
- `csharp`, `cs`, `dotnet`, `vb`, `vbnet`, `visualbasic`, `f#`, `fs`, `fsharp`
- `php`, `ruby`, `swift`, `ios`

## Evidence modes

### Occurrence evidence

The default mode. It records where dependencies appear in the codebase.

### Reachability evidence

Use `--with-reachables` when you need entry-point-to-sink style reachability signals. This is often the best trade-off for AppSec triage.

### Data-flow evidence

Use `--with-data-flow` when you need deeper call-stack evidence and are willing to spend more time and compute. For Go, this enables Golem data-flow mode; use `--golem-dataflow crypto` and `--golem-dataflow-pattern-packs crypto` for a focused crypto-flow pass.

### Go evidence powered by Golem

For Go projects, `evinse -l go` uses the bundled `golem` helper from `@cdxgen/cdxgen-plugins-bin` when available. Golem maps Go modules to semantic source evidence and emits occurrence, call-stack, usage-scope, build, native-artifact, security-signal, crypto, and data-flow context.

```shell
cdxgen -t go -o bom.json /absolute/path/to/go/project
evinse -i bom.json -o bom.evinse.json -l go --golem-callgraph static /absolute/path/to/go/project

# Bounded data-flow and crypto-flow evidence. This is the same mode enabled by --deep.
evinse -i bom.json -o bom.evinse.json -l go --with-data-flow --golem-dataflow crypto --golem-dataflow-pattern-packs crypto /absolute/path/to/go/project
```

The enriched BOM includes:

- `component.evidence.occurrences` for import and symbol usage locations
- `component.evidence.callstack.frames` from usage, call graph, and data-flow trace evidence when available
- component-level `cdx:golem:*` properties such as usage scopes, occurrence evidence kinds, security signal category/severity, vendoring, private-module hints, license-file counts, and replacement status
- data-flow properties such as `cdx:golem:dataFlowMode`, `cdx:golem:dataFlowSliceCount`, `cdx:golem:dataFlowCategories`, `cdx:golem:dataFlowTaintKinds`, and `cdx:golem:cryptoDataFlowCount`
- crypto properties and schema-valid `cryptographic-asset` components for algorithms, protocols, certificates, and related crypto material indicators
- metadata-level `cdx:golem:*` properties such as tool version, call graph/data-flow modes, package/module/file counts, build directive counts, native artifact counts, performance counters, and Go toolchain directives

Use `--golem-callgraph static` for routine CI when you do not need data-flow. Use `--deep` or `--with-data-flow` for Golem data-flow; cdxgen applies worker, scheduler, slice, trace, generated-file, and test-file safeguards automatically. Use `rta` or `vta` only when an investigation needs more precision and can tolerate more time and memory. Use `--golem-tests` when test-only dependencies are part of the review.

After enrichment, import the BOM into `cdxi` and use `.golemsummary`, `.golemhotspots`, `.golemcoverage`, `.occurrences`, and `.callstack`. For focused policy review, run `cdx-audit --bom bom.evinse.json --direct-bom-audit --categories golem`.

### Rust evidence powered by rusi

For Rust projects, `evinse -l rust` uses the bundled `rusi` help from `@cdxgen/cdxgen-plugins-bin` when available.

### .NET evidence powered by dosai

For .NET projects, `evinse` uses the bundled `dosai` helper from `@cdxgen/cdxgen-plugins-bin` when available:

- `dosai methods` adds occurrence evidence from package reachability and method-call slices.
- `dosai ApiEndpoints` are converted into CycloneDX `services` for SaaSBOM views.
- `dosai dataflows` adds call-stack evidence when `--with-data-flow` is used.
- `--profile research` enables both data-flow and crypto analysis for .NET projects.
- dosai schema 5.0.0 (.NET 11 / C# 15) outputs are consumed as-is: the schema
  change over 4.x is additive, so occurrence, call-stack, service, and crypto
  evidence keeps working. Post-quantum algorithms (`ML-DSA`, `ML-KEM`,
  `SLH-DSA`) map to CBOM components with their NIST parameter-set OIDs when
  the call-site context names one (e.g. `MLDsaAlgorithm.MLDsa65`); `X25519`
  maps always. Families without a single OID, such as generic AES key wrap,
  stay out of the BOM rather than carrying a wrong OID. Set `DOSAI_CMD` to
  point at a newer dosai build than the bundled one.
- `--exclude` globs are passed to dosai so excluded directories, such as
  vendored build output, are not analysed. They are read the way the atom
  evidence filter reads them: a relative pattern like `BuildOutput/**` or
  `*.Designer.cs` matches at any depth, an absolute path under the scanned
  directory is anchored to it, and excluding a directory excludes everything
  beneath it. Brace groups, numeric ranges, and comma separated lists are
  expanded. Character classes, extglobs, escapes, negated patterns, and
  patterns with shell metacharacters cannot be expressed in dosai and are
  skipped with a warning. Dosai matches case-sensitively on Linux. A dosai build without `--exclude` support runs
  without the patterns.
- When the input BOM was created with `--deep` in the same run, cdxgen reuses
  the dosai methods slice from `deps.slices.json` as the usages slice instead
  of running dosai a second time. `--evidence` implies `--deep`, so this
  covers `cdxgen --evidence` as well. `--deps-slices-file` takes an absolute
  path as given and resolves a relative one against the scanned directory. An
  existing `deps.slices.json` is reused as-is, including one created with
  different `--exclude` patterns or an older cdxgen release, so a stale cache
  can ignore your current excludes; delete the file to force a fresh analysis.
  Pass `--usages-slices-file` to prefer your own slice.
- dosai's package URLs are matched to the BOM by version. When the BOM holds
  a package in several versions (two projects restoring different versions),
  a record whose purl names no version the BOM has is given to the version of
  the project its source file belongs to, and to none when its file is in no
  single project. The same applies to a package `.dll` that several versions
  ship. A library caller of `createBom` that passes no `depsSlicesFile` gets
  the dosai report in a temporary directory of that scan, removed afterwards.
- dosai reports of any size are read. A report larger than one JavaScript
  string can hold (about 512 MB; `dotnet/efcore` produces 1.9 GB) is read in
  bounded runs that keep only what cdxgen uses: the package reachability
  facts, the call-graph nodes and edges they reference, the method calls into
  package assemblies, and the services, endpoints, and AI components. The
  report persisted to `--semantics-slices-file` is then assembled from the
  native dosai files, so it stays complete.

```shell
cdxgen -t dotnet --deep --evidence -o bom.json .
evinse -i bom.json -o bom.evinse.json -l dotnet --profile research .
```

Service endpoints are sanitized before being written to the BOM: URL credentials, query strings, and fragments are removed, and raw authorization policy or role names are summarized as counts rather than copied into properties.

### Swift evidence powered by SourceKitten

For Swift Package Manager projects, `evinse -l swift` (and `cdxgen -t swift --evidence`) uses `sourcekitten`: the bundled helper from `@cdxgen/cdxgen-plugins-bin` on macOS, the build shipped in the cdxgen container images that include Swift, or `SOURCEKITTEN_CMD`. SourceKitten links the Swift runtime of the toolchain that built it, and Linux Swift has no stable ABI, so on Linux outside the images, build it from source with the Swift toolchain you use and set `SOURCEKITTEN_CMD`. Without a working sourcekitten, the evidence is limited to import declarations:

- The project is built once with `swift package clean` and `swift build -c debug --verbose`. Both SwiftPM build engines are supported: llbuild, and Swift Build, the default from Swift 6.4 (Xcode 27). Pass extra build arguments, such as `--build-system native`, with `SWIFT_BUILD_ARGS`.
- Each module's compiler arguments and sources come from llbuild's build description (`.build/<triple>/debug/description.json`) or from the verbose build output (`builtin-SwiftDriver` lines for Swift Build). `.build/workspace-state.json`, and for Swift Build `.build/manifest.pif`, say which package each module belongs to; clang modules are found through their module maps.
- Every non-test source of the root package is indexed with its own module's arguments and source list. The declaring module of each reference is recovered from its USR with `swift demangle`, so an occurrence always points at a line the compiler resolved to a module of that package: `swift-argument-parser` gets the lines using `ArgumentParser`, and members re-exported through another module (`Fluent` re-exports `FluentKit`) are attributed to the package that declares them. Import declarations are recorded as well, which gives C packages such as `swift-cmark` their occurrences and keeps import evidence when part of the build fails.
- SourceKit can only load modules produced by its own compiler version. The toolchain is identified by running `swift -print-target-info` in the project directory, so swiftly's `.swift-version`, `xcrun`, and `SWIFT_CMD` are all honoured, and sourcekitten is pointed at it through `XCODE_DEFAULT_TOOLCHAIN_OVERRIDE` on macOS or `LINUX_SOURCEKIT_LIB_PATH` on Linux. A private module cache is used for every run and removed afterwards.
- Packages that only the root package's test targets, or library targets only tests depend on, use are scoped `optional`, together with the packages reachable only through them. With `--required-only`, they are dropped unless the evidence shows the sources use them. Packages whose manifests predate target-based dependency resolution (tools-version 5.2) can declare test frameworks at package level, and stay required.
- A `--semantics-slices-file` is reused only when it is a semantics slice of the same project directory that is not older than the input SBOM, so reports of other analyzers and slices of other projects under the default `semantics.slices.json` name are never mistaken for it. The same rule applies to Scala slices (see below).
- Projects that need `xcodebuild` are not supported. Sources generated by build plugins are type-checked but not reported, and the tests are not indexed.

```shell
cdxgen -t swift --evidence -o bom.json .
# Narrow the BOM to the packages the shipped code needs
cdxgen -t swift --evidence --required-only -o bom.json .
```

### Scala evidence through scalasem

Scala projects carry their dependencies through the JVM BOM path (`-t sbt`, `-t mill`, `-t scala-cli`, or plain `-t java`), and the evidence step treats every one of those project types the same as `evinse -l scala`. The analyzer is scalasem from `@appthreat/atom-parsetools`; atom is never invoked for Scala. See [SCALA_EVINSE.md](SCALA_EVINSE.md) for the full pipeline.

- Occurrences, crypto assets, services and call stacks come straight from the scalasem report, with source file and line. Components are joined through the dependency classpath the report records, the `internal:Namespaces` properties and the jar namespace map, so the join also works for builds that report no namespaces. Components emitted from sbt, Mill and scala-cli builds name their artifacts the same way: the Scala binary suffix (`_3`, `_2.13`) is stripped and the version it carried is recorded in `cdx:scala:compilerVersion`, which is what vulnerability matching needs.
- A version 1 semantics slice passed with `--semantics-slices-file` is still read: its used types join onto the report evidence instead of replacing it.
- A user-supplied `--openapi-spec-file` produces services even when the report has none.
- An absolute `--semantics-slices-file` is used as given, and a report is reused only when it is a version 2 report of the same project directory that is not older than the input SBOM.
- A failed or degraded run is never silent: the reason is printed once and recorded as `cdx:scalasem:diagnostic` properties, and `--fail-on-error` claims the exit status.

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

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
   +--> cryptographic-asset components for golem.crypto evidence
   +--> crypto data-flow properties and call-stack frames when enabled
```

The integration keeps source evidence compact. It records file names, line numbers, categories, counts, symbol kinds, scopes, and module identity. It does not copy raw environment values, command output, generated file contents, or embedded secrets into the BOM.

## CLI options

These options are accepted by `evinse` when `--language go` or `--language golang` is used.

| Option                                           | Default                       | Purpose                                                                                                                   |
| ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--deep`                                         | `false`                       | Enables Golem data-flow mode with cdxgen's bounded-performance defaults.                                                  |
| `--with-data-flow`                               | `false`                       | Enables Golem data-flow mode without also implying other cdxgen deep-mode behavior.                                       |
| `--profile research`                             | `generic`                     | Enables Golem data-flow mode for research-oriented Go evidence.                                                           |
| `--golem-command`                                | `GOLEM_CMD` or bundled plugin | Use a specific `golem` binary. Useful when testing a local helper build.                                                  |
| `--golem-callgraph`                              | `static` or `none`            | Main call graph mode. Accepted values are `none`, `static`, `cha`, `rta`, and `vta`.                                      |
| `--golem-dataflow`                               | `none` or `all`               | Data-flow mode: `none`, `security`, `crypto`, or `all`. Defaults to `all` with `--deep`, research, or `--with-data-flow`. |
| `--golem-dataflow-callgraph`                     | `none`                        | Call graph mode used for data-flow dynamic summary replay: `none`, `static`, `cha`, `rta`, or `vta`.                      |
| `--golem-dataflow-pattern-packs`                 | `all`                         | Comma-separated data-flow pattern packs. Use `crypto` for a focused crypto-flow pass.                                     |
| `--golem-dataflow-max-slices`                    | bounded by cdxgen             | Maximum data-flow slices emitted into the report.                                                                         |
| `--golem-dataflow-workers` / `--golem-max-procs` | capped CPU count              | Worker and scheduler caps used to avoid noisy CI resource spikes.                                                         |
| `--golem-dataflow-skip-generated`                | `true`                        | Skip generated files during data-flow materialization.                                                                    |
| `--golem-dataflow-skip-tests`                    | `true` unless tests enabled   | Skip test/example/benchmark files during data-flow materialization.                                                       |
| `--golem-memory-limit`                           | none                          | Optional Go soft memory limit such as `4GiB` or `800MiB`.                                                                 |
| `--golem-patterns`                               | `./...`                       | Comma-separated Go package patterns passed to Golem.                                                                      |
| `--golem-tags`                                   | none                          | Comma-separated Go build tags.                                                                                            |
| `--golem-tests`                                  | `false`                       | Include Go test variants in package loading and evidence.                                                                 |

Recommended defaults for CI are `--golem-callgraph static` for ordinary occurrence/call graph evidence and `--deep` or `--with-data-flow --golem-dataflow crypto` for bounded data-flow review. cdxgen automatically lowers the main call graph to `none` when data-flow is enabled unless you request another supported mode, because data-flow already performs its own SSA-backed pass.

## Call graph modes

| Mode     | Use when                                                                                           | Trade-off                                                         |
| -------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `none`   | You only need imports, usages, build directives, native artifacts, and security signal properties. | Fastest, no call graph frames from edges.                         |
| `static` | You want a good default for CI and routine AppSec review.                                          | Fast and broad, may include edges that are not runtime-reachable. |
| `rta`    | You want a better approximation from discovered `init` and `main` roots.                           | More precise than static for many applications, more expensive.   |

## Custom property families

Golem emits properties on two levels.

Metadata-level properties summarize the whole Go project and the helper run. Examples include `cdx:golem:toolVersion`, `cdx:golem:callGraphMode`, `cdx:golem:dataFlowMode`, `cdx:golem:dataFlowCallGraphMode`, `cdx:golem:noRecurse`, `cdx:golem:includeAllFlows`, `cdx:golem:packageCount`, `cdx:golem:fileCount`, `cdx:golem:securitySignalCount`, `cdx:golem:nativeArtifactCount`, `cdx:golem:goDirectiveVersion`, and `cdx:golem:toolchainDirective`.

Component-level properties explain how an individual Go module appears in the analyzed source. Examples include `cdx:golem:modulePath`, `cdx:golem:goVersion`, `cdx:golem:usageScopes`, `cdx:golem:occurrenceEvidenceKinds`, `cdx:golem:securitySignalCategory`, `cdx:golem:securitySignalSeverity`, `cdx:golem:vendored`, `cdx:golem:privateModuleCandidate`, `cdx:golem:licenseFileCount`, and `cdx:golem:localReplacement`.

## Crypto and CBOM evidence

Golem emits a dedicated top-level `crypto` attribute in its JSON report. cdxgen consumes this during `evinse -l go` and renders CycloneDX `type: "cryptographic-asset"` components when the evidence is schema-safe:

- `crypto.assets[]` for algorithms and certificates. Algorithm components are emitted only when an OID is available, either from Golem or cdxgen's `data/crypto-oid.json` catalog.
- `crypto.protocols[]` for protocols such as TLS, rendered with `cryptoProperties.assetType: "protocol"`.
- `crypto.materials[]` for key, token, nonce, salt, password, certificate-key-pair, and related material indicators. Raw values are never emitted.
- `crypto.operations[]` for source operations such as hash, encrypt/decrypt, sign/verify, key generation, key derivation, random generation, and TLS configuration. These are also used to add `dependencies[].provides` relationships from the Go component to rendered crypto assets when possible.
- `crypto.findings[]` for crypto-specific review findings such as weak MD5/SHA-1/DES usage, insecure TLS verification, and literal crypto-material indicators.

Metadata properties summarize this evidence with `cdx:golem:cryptoLibraryCount`, `cdx:golem:cryptoAssetCount`, `cdx:golem:cryptoOperationCount`, `cdx:golem:cryptoMaterialCount`, `cdx:golem:cryptoProtocolCount`, `cdx:golem:cryptoFindingCount`, `cdx:golem:cryptoAlgorithms`, `cdx:golem:cryptoMaterialTypes`, and `cdx:golem:cryptoProtocols`. Components that own crypto operations or findings receive compact properties such as `cdx:golem:cryptoOperationType`, `cdx:golem:cryptoAlgorithm`, `cdx:golem:cryptoFinding`, and `cdx:golem:cryptoFindingSeverity`. Rendered crypto assets carry `cdx:golem:crypto:*` properties for strength, source symbol, usage scope, and source location; they never receive purls.

## Data-flow and crypto-flow evidence

When data-flow is enabled, Golem emits `dataFlow` nodes, edges, slices, trace IDs, taint kinds, source/sink categories, severity, confidence, and performance counters. cdxgen converts this into:

- metadata properties such as `cdx:golem:dataFlowMode`, `cdx:golem:dataFlowSliceCount`, `cdx:golem:dataFlowSourceCount`, `cdx:golem:dataFlowSinkCount`, `cdx:golem:dataFlowNodeCount`, `cdx:golem:dataFlowEdgeCount`, `cdx:golem:dataFlowWorkerCount`, `cdx:golem:dataFlowElapsedMillis`, and truncation/sanitization counters when present;
- component properties such as `cdx:golem:dataFlowCategories`, `cdx:golem:dataFlowRuleId`, `cdx:golem:dataFlowSeverity`, `cdx:golem:dataFlowConfidence`, `cdx:golem:dataFlowTaintKinds`, and `cdx:golem:dataFlowSliceCount`;
- crypto-specific component properties such as `cdx:golem:cryptoDataFlow`, `cdx:golem:cryptoDataFlowCategories`, `cdx:golem:cryptoDataFlowRuleId`, `cdx:golem:cryptoDataFlowTaintKinds`, and `cdx:golem:cryptoDataFlowCount` when the source, sink, rule, or taint kind is crypto-related;
- `component.evidence.occurrences` entries for data-flow source/sink locations; and
- `component.evidence.callstack.frames` generated from ordered data-flow trace nodes.

The default deep-mode data-flow settings are intentionally bounded for CI: worker count and `GOMAXPROCS` are capped, generated files are skipped, tests are skipped unless `--golem-tests` is requested, and slice/trace limits are applied. For a narrow crypto investigation, use:

```bash
evinse -i bom.json -o bom.evinse.json -l go \
  --with-data-flow \
  --golem-dataflow crypto \
  --golem-dataflow-pattern-packs crypto \
  /absolute/path/to/go/project
```

Golem data-flow evidence remains secret-safe. The BOM records categories, rule IDs, taint kinds, source locations, and call-stack frames; it does not copy raw key material, plaintext, environment values, HTTP parameters, generated file contents, or full command strings.

See [cdx: Custom Properties](CUSTOM_PROPERTIES.md#golem-go-evinse-evidence) for the full inventory.

## BOM audit categories

Go Evinse properties are covered by three built-in BOM audit categories:

| Category            | Focus                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `golem-security`    | Runtime security signals, crypto-flow/crypto findings, and local replacement risk.       |
| `golem-performance` | Native boundaries, generated/embedded build inputs, and truncated data-flow coverage.    |
| `golem-compliance`  | Private modules, vendored modules without license-file evidence, and exclude directives. |

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

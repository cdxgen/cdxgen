# Threat model: Go Evinse with Golem

This threat model describes the review boundary for Go Evinse evidence produced by `golem` and embedded in a CycloneDX BOM by cdxgen.

## Assets

The main assets are the Go source tree, the base Go SBOM, the enriched Evinse BOM, and the Golem JSON report generated during enrichment. When data-flow is enabled, the Golem report also contains source/sink categories, node IDs, trace locations, taint kinds, and performance counters. Downstream assets include audit annotations, SARIF or JSON reports, and interactive `cdxi` review output.

The enriched BOM may carry source file paths, line numbers, module paths, symbol categories, build directive summaries, security signal categories, data-flow rule IDs, taint-kind labels, crypto-flow labels, and cryptographic asset metadata such as algorithm OIDs. It should not carry raw secrets, raw environment values, HTTP parameter values, raw key material, plaintext, ciphertext, generated source contents, embedded file contents, or command output.

## Trust boundaries

```
Developer workstation or CI runner
  |
  | local source, go.mod, go.work, vendor tree
  v
Go toolchain and go/packages loader
  |
  | semantic package graph
  v
golem helper
  |
  | JSON evidence report
  v
evinse and cdxgen
  |
  | CycloneDX evidence + custom properties
  v
BOM consumers, cdx-audit, cdxi, policy engines
```

The main boundary is between untrusted project input and trusted review output. A Go repository can contain unusual build tags, generated files, vendored code, replacement directives, cgo files, and embedded asset declarations. Golem reads and classifies those signals but must not execute `go:generate` commands or copy sensitive file contents into the report.

## Threats and controls

| Threat                                                                | How Golem helps                                                                                                 | Remaining reviewer responsibility                                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-hermetic dependency resolution through local `replace` directives | Emits `cdx:golem:localReplacement`, replacement metadata, and module context.                                   | Decide whether the release build may use local source or must use published or vendored dependencies.                                               |
| Hidden or unreviewed private module use                               | Emits `cdx:golem:privateModuleCandidate` and module path context.                                               | Verify internal provenance, source retention, license review, and vulnerability intake.                                                             |
| Runtime use of security-sensitive APIs                                | Emits security signal category and severity properties plus occurrence and call-stack evidence where available. | Confirm reachability, configuration safety, compensating controls, and whether the signal is acceptable.                                            |
| User-controlled values flowing to sensitive sinks                     | Emits `cdx:golem:dataFlow*` properties plus occurrence and call-stack frames when data-flow is enabled.         | Confirm whether the source is truly attacker-controlled, whether sanitizers are sufficient, and whether runtime controls exist.                     |
| Crypto material flowing into algorithms or protocols                  | Emits `cdx:golem:cryptoDataFlow*` properties, crypto asset components, and algorithm/protocol/material pivots.  | Review key management, entropy, algorithm choice, lifecycle controls, and whether raw material is ever logged or stored.                            |
| Native or generated build surface drift                               | Emits native artifact counts, generator kinds, `go:generate`, `go:embed`, and generated-file counts.            | Review generated source ownership, native toolchain policy, cgo side effects, and reproducible build controls.                                      |
| Test-only dependency noise                                            | Emits usage scopes and `cdx:golem:testOnly`.                                                                    | Decide whether the review is production-only, test-supply-chain focused, or both.                                                                   |
| Overly expensive evidence mode in CI                                  | Emits call graph, data-flow, worker, elapsed-time, truncation, and graph-size counters.                         | Use `static` for routine call graphs, use `--golem-dataflow crypto` for focused crypto-flow review, and reserve expensive modes for investigations. |

## Assumptions

The integration assumes the local Go toolchain can load the project packages with the requested patterns and tags. It also assumes the base SBOM was generated for the same source tree or compatible module graph. If the base SBOM and source tree do not match, Golem evidence may not attach to all intended components.

## Out of scope

Golem evidence does not replace vulnerability scanning, exploitability analysis, license classification, or runtime tracing. It does not prove that a signal is exploitable. Data-flow evidence is a static approximation; reflection, dynamic dispatch, build tags, generated code, platform-specific files, cgo boundaries, missing module downloads, or deliberately obfuscated flows can reduce coverage or precision.

## Secure handling notes

Do not publish an enriched BOM before reviewing source paths and internal module names. They are often useful for internal triage but can reveal repository layout or private package naming. Data-flow and crypto-flow properties intentionally use categories, rule IDs, taint kinds, counts, and source locations instead of copied values. If a public artifact is needed, keep the component inventory and audit findings that are safe to share, and remove environment-specific paths according to your disclosure policy.

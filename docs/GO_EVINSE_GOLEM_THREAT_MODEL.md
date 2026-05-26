# Threat model: Go Evinse with Golem

This threat model describes the review boundary for Go Evinse evidence produced by `golem` and embedded in a CycloneDX BOM by cdxgen.

## Assets

The main assets are the Go source tree, the base Go SBOM, the enriched Evinse BOM, and the Golem JSON report generated during enrichment. Downstream assets include audit annotations, SARIF or JSON reports, and interactive `cdxi` review output.

The enriched BOM may carry source file paths, line numbers, module paths, symbol categories, build directive summaries, and security signal categories. It should not carry raw secrets, raw environment values, generated source contents, embedded file contents, or command output.

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

| Threat                                                                | How Golem helps                                                                                                 | Remaining reviewer responsibility                                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Non-hermetic dependency resolution through local `replace` directives | Emits `cdx:golem:localReplacement`, replacement metadata, and module context.                                   | Decide whether the release build may use local source or must use published or vendored dependencies.          |
| Hidden or unreviewed private module use                               | Emits `cdx:golem:privateModuleCandidate` and module path context.                                               | Verify internal provenance, source retention, license review, and vulnerability intake.                        |
| Runtime use of security-sensitive APIs                                | Emits security signal category and severity properties plus occurrence and call-stack evidence where available. | Confirm reachability, configuration safety, compensating controls, and whether the signal is acceptable.       |
| Native or generated build surface drift                               | Emits native artifact counts, generator kinds, `go:generate`, `go:embed`, and generated-file counts.            | Review generated source ownership, native toolchain policy, cgo side effects, and reproducible build controls. |
| Test-only dependency noise                                            | Emits usage scopes and `cdx:golem:testOnly`.                                                                    | Decide whether the review is production-only, test-supply-chain focused, or both.                              |
| Overly expensive evidence mode in CI                                  | Emits call graph mode and node/edge counts.                                                                     | Use `static` or `rta` for routine CI and reserve `pointer` mode for focused investigations.                    |

## Assumptions

The integration assumes the local Go toolchain can load the project packages with the requested patterns and tags. It also assumes the base SBOM was generated for the same source tree or compatible module graph. If the base SBOM and source tree do not match, Golem evidence may not attach to all intended components.

## Out of scope

Golem evidence does not replace vulnerability scanning, exploitability analysis, license classification, or runtime tracing. It does not prove that a signal is exploitable. It also does not guarantee complete code coverage when build tags, generated code, or missing module downloads prevent the Go loader from seeing some packages.

## Secure handling notes

Do not publish an enriched BOM before reviewing source paths and internal module names. They are often useful for internal triage but can reveal repository layout or private package naming. If a public artifact is needed, keep the component inventory and audit findings that are safe to share, and remove environment-specific paths according to your disclosure policy.

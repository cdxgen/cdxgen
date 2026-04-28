# cdx-audit — Predictive supply-chain audit

`cdx-audit` analyzes existing CycloneDX BOMs to estimate which upstream dependencies deserve immediate supply-chain review.

Unlike `cdxgen --bom-audit`, which evaluates the BOM you just generated, `cdx-audit` starts from one or more existing BOMs, resolves supported package URLs back to source repositories, generates child SBOMs for those sources, and scores forward-looking risk using cdxgen's audit rules plus predictive heuristics.

## Who should use this

### AppSec analysts

Use `cdx-audit` to answer:

- Which third-party packages deserve immediate review?
- Which findings are corroborated strongly enough to justify escalation?
- Which upstream workflows, repositories, or provenance signals should I inspect first?

### Maintainers and package owners

Use `cdx-audit` to answer:

- Which dependency should I review before the next release?
- Which downstream workflow file or package behavior triggered the score?
- What is the next concrete action for this dependency?

### Platform, governance, and compliance teams

Use `cdx-audit` to answer:

- Which dependencies need risk triage across a portfolio of BOMs?
- Which results can be exported into SARIF or preserved as CycloneDX annotations?
- Which manual SCVS reviews should be supported with predictive evidence?

## When to use `cdx-audit`

Use `cdx-audit` when you already have one or more BOMs and want to investigate upstream compromise exposure.

Use [`BOM_AUDIT.md`](BOM_AUDIT.md) when you want to embed post-generation findings into the BOM being generated.

Use [`CDX_VALIDATE.md`](CDX_VALIDATE.md) when the primary goal is structural validation, SCVS coverage, or CRA-oriented review.

## Supported scope

`cdx-audit` currently evaluates package URLs for:

- npm (`pkg:npm/...`)
- PyPI (`pkg:pypi/...`)

Other ecosystems are skipped and reported as unsupported.

## What the command does

1. Load one BOM with `--bom` or many BOMs from `--bom-dir`
2. Extract unique npm and PyPI package URLs from `components[]`
3. Skip trusted-publishing-backed packages by default unless you override that behavior
4. Resolve each supported purl to a source repository URL
5. Clone or reuse the source under `--workspace-dir`
6. Generate or reuse a child SBOM for that upstream repository
7. Evaluate built-in audit rules and predictive heuristics against the child SBOM
8. Enrich results with provenance and publishing signals when registries expose them
9. Score each target conservatively so stronger severities require corroboration

## Quick start

```bash
# Audit one BOM
cdx-audit --bom bom.json

# Audit a directory of BOMs and render JSON
cdx-audit --bom-dir ./boms --report json

# Export SARIF for code-scanning style review
cdx-audit --bom bom.json --report sarif --report-file audit.sarif

# Reuse clones and child SBOMs across runs
cdx-audit --bom bom.json --workspace-dir .cache/cdx-audit --reports-dir .reports/cdx-audit

# Focus on required dependencies only
cdx-audit --bom bom.json --scope required

# Override trusted-publishing target selection
cdx-audit --bom bom.json --include-trusted
cdx-audit --bom bom.json --only-trusted
```

## CLI reference

| Option                | Description                                                         |
| --------------------- | ------------------------------------------------------------------- |
| `--bom`               | Path to a single CycloneDX JSON BOM                                 |
| `--bom-dir`           | Directory containing CycloneDX JSON BOMs                            |
| `--workspace-dir`     | Reuse git clones and cached child SBOMs between runs                |
| `--reports-dir`       | Persist generated child SBOMs and per-target findings               |
| `--report`            | Output format: `console`, `json`, or `sarif`                        |
| `--report-file`, `-o` | Write the final report to a file instead of stdout                  |
| `--categories`        | Comma-separated rule categories for child SBOM analysis             |
| `--min-severity`      | Minimum final target severity to include in console or SARIF output |
| `--fail-severity`     | Exit with code `3` when any target reaches this final severity      |
| `--max-targets`       | Safety limit for the number of unique purls analyzed                |
| `--scope`             | Target selection scope: `all` or `required`                         |
| `--include-trusted`   | Include targets already marked with trusted publishing metadata     |
| `--only-trusted`      | Restrict analysis to trusted-publishing-backed targets              |

## Exit behavior

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| `0`  | The run completed and no result met `--fail-severity` |
| `1`  | Configuration or runtime error                        |
| `3`  | At least one result met or exceeded `--fail-severity` |

## Target selection defaults

`cdx-audit` narrows target selection before cloning upstream repositories:

- only npm and PyPI purls are considered
- components with `scope: optional` or `scope: excluded` are skipped when `--scope required` is used
- packages with trusted-publishing metadata such as `cdx:npm:trustedPublishing=true` or `cdx:pypi:trustedPublishing=true` are skipped by default

Use the trusted-publishing switches to override the default:

- `--include-trusted` includes both trusted and non-trusted targets
- `--only-trusted` keeps only trusted-publishing-backed targets

Passing both switches together is invalid.

## What each audience gets back

### Console output

Best for maintainers and triage sessions.

The console report highlights:

- final severity
- affected package or grouped namespace
- why the dependency needs attention
- the next review step
- upstream escalation guidance when the dependency is maintained externally

When nothing crosses the configured threshold, the console output uses the empty state:

`No dependencies require your attention.`

### JSON output

Best for automation and secondary reporting pipelines.

Use `--report json` when you want stable machine-readable results for dashboards, ticket enrichment, or internal triage workflows.

### SARIF output

Best for code scanning platforms and centralized review queues.

`cdx-audit` includes:

- rule metadata and remediation text
- per-result `properties.nextAction`
- `properties.upstreamEscalation` when the right fix lives with an external maintainer
- `relatedLocations` for correlated local workflow receiver files when a sender → receiver dispatch edge was identified

### CycloneDX annotations

When a predictive result is written back into a BOM by downstream workflows, the annotation text preserves:

- `cdx:audit:nextAction`
- `cdx:audit:upstreamGuidance`
- `cdx:audit:dispatch:edge`
- `cdx:audit:dispatch:receiverFiles`
- `cdx:audit:dispatch:receiverNames`

These properties are useful in [`REPL.md`](REPL.md), Dependency-Track, and other annotation-aware tooling.

## Severity model

`cdx-audit` is intentionally conservative:

- isolated findings usually remain `low` or `medium`
- `high` requires corroboration across stronger signals or categories
- `critical` is reserved for rare compound patterns with strong confidence

Two rule families receive additional predictive weight because they encode attacker-relevant, compound behavior rather than generic hygiene issues:

- `CI-019` — explicit fork-context plus sensitive-context plus downstream dispatch
- `INT-009` — obfuscated npm lifecycle execution

This keeps prioritization focused on structurally higher-signal packages while avoiding alert floods from single weak detectors.

## Detection coverage

### GitHub Actions and workflow abuse

`cdx-audit` looks for:

- `workflow_dispatch` and `repository_dispatch` launched from fork-reachable or privileged jobs
- workflows that inspect fork or head-repository context before dispatching downstream automation
- explicit local sender ↔ receiver workflow correlation when the sender target can be matched uniquely inside the same repository
- dispatches triggered via `gh workflow run`, GitHub API endpoints, `actions/github-script`, and common helper actions

Correlated sender → receiver edges are preserved in the console summary, SARIF properties, SARIF related locations, and CycloneDX annotations.

### npm install-time concealment

`cdx-audit` evaluates:

- obfuscated or base64-decoded npm lifecycle hooks
- install-time execution in `preinstall`, `install`, `postinstall`, `prepublish`, and `prepare`
- referenced JS or TS lifecycle files so hidden payloads outside `package.json` are still visible

### PyPI packaging heuristics

`cdx-audit` evaluates:

- suspicious encoded or dynamically executed logic in `setup.py`
- suspicious process or network behavior in package `__init__.py`

The Python coverage is intentionally triage-oriented rather than full static analysis.

### Provenance and publisher context

When registry metadata is available, cdxgen records and uses signals such as:

- trusted publishing
- provenance URLs
- publisher identity
- publish time
- cadence compression
- maintainer or uploader drift

Positive provenance evidence reduces the final score. Missing provenance is treated as weak context, not as proof of compromise.

## Performance and caching

- progress is written to `stderr`, so JSON output on `stdout` remains machine-readable
- `--workspace-dir` stores reusable clones and child SBOM caches
- `--reports-dir` persists intermediate child artifacts and findings for later review
- large target sets emit a preflight note so operators know when the run may take several minutes

## Operational tips

### For AppSec analysts

- start with `--scope required` for the highest-value triage pass
- use `--report sarif` when you want findings in a shared review queue
- treat `CI-019` and `INT-009` as escalation pivots, especially when corroborated

### For maintainers

- start with the console report to get the next concrete action
- inspect sender and receiver workflows together when a dispatch edge is shown
- use `--workspace-dir` during repeated investigations to avoid recloning the same targets

### For platform and compliance teams

- use JSON for portfolio automation
- combine `cdx-validate` manual SCVS reviews with `cdx-audit` evidence when you need workflow, provenance, or publisher context
- preserve SARIF and CycloneDX annotations so the guidance travels with the BOM

## Relationship to custom properties

The predictive audit relies on the custom properties documented in [`CUSTOM_PROPERTIES.md`](CUSTOM_PROPERTIES.md), especially GitHub workflow metadata, provenance properties, and install-time execution indicators.

## Related docs

- [BOM Audit](BOM_AUDIT.md)
- [cdx-validate — Supply-Chain Compliance Validator](CDX_VALIDATE.md)
- [cdx: Custom Properties](CUSTOM_PROPERTIES.md)
- [REPL / cdxi](REPL.md)
- [Tutorials - Scanning Git URLs and purls with BOM Audit](LESSON8.md)

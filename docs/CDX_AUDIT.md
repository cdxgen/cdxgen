# cdx-audit — Upstream supply-chain risk prioritization

`cdx-audit` helps security, engineering, and governance teams prioritize upstream dependency review from existing CycloneDX BOMs. It answers a practical operational question: **which dependencies should we review first, and why?**

It does this by resolving supported package URLs back to source repositories, generating child SBOMs for those sources, and combining cdxgen rules with explainable, high-signal heuristics to surface the dependencies most likely to warrant attention.

Unlike `cdxgen --bom-audit`, which evaluates the BOM you just generated, `cdx-audit` starts from one or more existing BOMs and investigates the upstream repositories behind supported dependencies.

## Product positioning

`cdx-audit` is strongest when it can identify **structural precursors** that have repeatedly shown up in modern supply-chain incidents, for example:

- risky GitHub Actions workflow patterns
- dangerous publish paths or legacy token usage
- install-time execution or concealment signals
- weak or missing provenance signals

`cdx-audit` works best as part of a broader supply-chain assurance program alongside:

- reproducible builds
- registry-side integrity controls
- maintainer identity review
- provenance verification
- runtime behavior analysis
- human review

Use it as an **evidence-backed prioritization layer** that helps teams review faster, focus earlier, and explain why a dependency moved to the front of the queue.

## Who should use this

### AppSec analysts

Use `cdx-audit` to answer:

- Which third-party packages should I inspect before spending time elsewhere?
- Which findings are corroborated strongly enough to justify escalation?
- Which upstream workflows, repositories, or provenance signals should I inspect first?

### Maintainers and package owners

Use `cdx-audit` to answer:

- Which dependency is most likely to deserve review before the next release?
- Which upstream workflow file or package behavior triggered the score?
- What is the next concrete review action for this dependency?

### Platform, governance, and compliance teams

Use `cdx-audit` to answer:

- Which dependencies need risk triage across a portfolio of BOMs?
- Which results can be exported into SARIF or preserved as CycloneDX annotations?
- Which manual SCVS reviews should be supported with heuristic evidence?

## When to use `cdx-audit`

Use `cdx-audit` when you already have one or more BOMs and want to prioritize upstream dependency review based on explainable risk signals.

It is especially useful when “**where should we look first?**” matters as much as “**what evidence can we show for that decision?**”.

Use [`BOM_AUDIT.md`](BOM_AUDIT.md) when you want to embed post-generation findings into the BOM being generated.

Use [`CDX_VALIDATE.md`](CDX_VALIDATE.md) when the primary goal is structural validation, SCVS coverage, or CRA-oriented review.

Use `cdx-audit` to accelerate prioritization and escalation decisions. Final disposition should still account for provenance, internal policy, and analyst review.

## Supported scope

`cdx-audit` currently evaluates package URLs for:

- Cargo / crates.io (`pkg:cargo/...`)
- npm (`pkg:npm/...`)
- PyPI (`pkg:pypi/...`)

Other ecosystems are skipped and reported as unsupported.

Current practical scope limits:

- only supported purls can be analyzed
- source resolution can fail or resolve to incomplete metadata
- clean source does not guarantee clean release artifacts
- some malicious behavior that lives only in runtime, registry, or maintainer infrastructure may be outside the tool's line of sight

## Installing `cdx-audit`

`cdx-audit` ships with the main npm package:

```bash
npm install -g @cyclonedx/cdxgen
cdx-audit --help
```

Without a global install:

```bash
corepack pnpm dlx --package=@cyclonedx/cdxgen cdx-audit --help
```

GitHub Releases also publish standalone binaries such as `cdx-audit-linux-amd64`, `cdx-audit-darwin-arm64`, and `cdx-audit-windows-amd64.exe` together with matching `.sha256` files.

Example with the GitHub CLI in GitHub Actions:

```yaml
permissions:
  contents: read

steps:
  - name: Download cdx-audit binary from GitHub Releases
    env:
      GH_TOKEN: ${{ github.token }}
    run: |
      gh release download v12.3.0 \
        --repo cdxgen/cdxgen \
        --pattern 'cdx-audit-linux-amd64' \
        --pattern 'cdx-audit-linux-amd64.sha256'
      sha256sum -c cdx-audit-linux-amd64.sha256
      chmod +x cdx-audit-linux-amd64
      ./cdx-audit-linux-amd64 --help
```

For Linux, macOS, and Windows download snippets with hash verification, see [`CLI.md`](CLI.md#standalone-release-binaries).

## What the command does

1. Load one BOM with `--bom` or many BOMs from `--bom-dir`
2. Extract unique Cargo, npm, and PyPI package URLs from `components[]`
3. Skip trusted-publishing-backed packages by default unless you override that behavior
4. Resolve each supported purl to a source repository URL
5. Clone or reuse the source under `--workspace-dir`
6. Generate or reuse a child SBOM for that upstream repository
7. Evaluate built-in rules and heuristics against the child SBOM
8. Enrich results with provenance and publishing signals when registries expose them
9. Score each target conservatively so stronger severities require corroboration

The result is a prioritized, explainable **review queue** for upstream investigation.

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

# Limit the queue while keeping the default direct-runtime prioritization
cdx-audit --bom bom.json --scope required --max-targets 25

# Override trusted-publishing target selection
cdx-audit --bom bom.json --include-trusted
cdx-audit --bom bom.json --only-trusted

# Explain risk scoring decisions in think mode
CDXGEN_THINK_MODE=true cdx-audit --bom bom.json --max-targets 10
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
| `--prioritize-direct-runtime` | Keep direct runtime dependencies ahead of less actionable targets (enabled by default) |

## Exit behavior

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| `0`  | The run completed and no result met `--fail-severity` |
| `1`  | Configuration or runtime error                        |
| `3`  | At least one result met or exceeded `--fail-severity` |

## Target selection defaults

`cdx-audit` narrows target selection before cloning upstream repositories:

- only Cargo, npm, and PyPI purls are considered
- components with `scope: optional` or `scope: excluded` are skipped when `--scope required` is used
- packages with trusted-publishing metadata such as `cdx:cargo:trustedPublishing=true`, `cdx:npm:trustedPublishing=true`, or `cdx:pypi:trustedPublishing=true` are skipped by default
- when `--max-targets` trims the queue, direct runtime dependencies are prioritized by default
- explicit `scope=required` is treated as a stronger prioritization indicator than an implicit missing scope
- `evidence.occurrences` lifts packages that are observed in more source locations
- development-only and platform-specific packages remain deprioritized relative to runtime/general packages
- for Cargo targets, runtime-facing crates stay ahead of build-only workspace helper crates when the queue must be trimmed

Use the trusted-publishing switches to override the default:

- `--include-trusted` includes both trusted and non-trusted targets
- `--only-trusted` keeps only trusted-publishing-backed targets

Passing both switches together is invalid.

### Recommended filter combinations

- `cdx-audit --bom bom.json --scope required --max-targets 25` keeps triage focused on required dependencies and caps the review queue
- `cdx-audit --bom bom.json --include-trusted --max-targets 50` includes trusted-publishing-backed packages when you want a broader baseline review
- `cdx-audit --bom bom.json --only-trusted` isolates the subset of packages already backed by trusted publishing metadata

## Prioritization indicators

When `cdx-audit` has to choose which packages to inspect first, it uses a small set of explainable indicators:

1. direct runtime dependency status from the root dependency graph
2. explicit CycloneDX `scope=required`
3. source evidence density from `evidence.occurrences`
4. absence of development-only markers
5. absence of platform-specific constraints
6. for Cargo, runtime-facing member crates before build-only workspace helper crates

These indicators affect queue order, not the final risk severity. Final severity still comes from the findings observed in the generated child SBOM and the conservative scoring model.

## Thought-log diagnostics

If you want a lightweight explanation for why a dependency stayed low risk or was considered risky, run `cdx-audit` with thought logging enabled:

```bash
CDXGEN_THINK_MODE=true cdx-audit --bom bom.json --scope required --max-targets 10
```

The thought log emits one short decision summary per package with:

- the final severity and score
- confidence and confidence label
- the number of findings and corroborating categories
- a short preview of the top reasons behind the decision

## Cargo-specific predictive signals

Cargo support now folds several Cargo-native signals into prioritization and scoring:

- yanked crates and publisher/cadence drift from crates.io metadata
- native build surfaces from `build.rs`, build dependencies, and `-sys` helpers
- workspace-resolved member dependencies so build-only helpers can be deprioritized beneath runtime-facing crates
- exact GitHub Actions/setup/cache/build metadata when child SBOMs include formulation and workflow components

In practice this means `cdx-audit` can now explain not only that a Cargo dependency looks risky, but also whether that risk is:

- runtime-facing versus build-only
- reinforced by Cargo-native build surfaces
- reinforced by mutable Cargo setup actions or workflow steps that exercise native build logic

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

When a `cdx-audit` result is written back into a BOM by downstream workflows, the annotation text preserves:

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

This severity model is designed for operational use:

- lower scores generally indicate weaker or less corroborated signals
- higher scores generally indicate stronger signal convergence and a better candidate for early review
- stronger scores mean “review this sooner with higher confidence”, not “skip analyst validation”

Two rule families receive additional weight because they encode attacker-relevant, compound behavior rather than generic hygiene issues:

- `CI-019` — explicit fork-context plus sensitive-context plus downstream dispatch
- `INT-009` — obfuscated npm lifecycle execution

This keeps prioritization focused on structurally higher-signal packages while avoiding alert floods from single weak detectors.

## Scope and boundaries

`cdx-audit` is intentionally focused. It does not currently aim to:

- cover all ecosystems equally
- detect completely novel attack techniques with no structural precursor
- verify that release artifacts exactly match reviewed source
- see maintainer account takeovers unless they leave source-visible traces
- replace provenance, signatures, reproducibility, or registry protections
- replace manual investigation for high-impact decisions

## Detection coverage

### GitHub Actions and workflow abuse

`cdx-audit` looks for:

- `workflow_dispatch` and `repository_dispatch` launched from fork-reachable or privileged jobs
- workflows that inspect fork or head-repository context before dispatching downstream automation
- explicit local sender ↔ receiver workflow correlation when the sender target can be matched uniquely inside the same repository
- dispatches triggered via `gh workflow run`, GitHub API endpoints, `actions/github-script`, and common helper actions

This is one of the stronger parts of the tool today because many recent supply-chain incidents have left exactly these workflow-level breadcrumbs.

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

## Additional considerations

Like any source- and metadata-driven prioritization system, `cdx-audit` can underrepresent cases such as:

- clean-looking repositories with malicious release artifacts
- attacks that happen entirely through stolen maintainer credentials
- runtime-only payloads or environment-triggered behavior
- malicious infrastructure outside the source tree
- subtle abuse that does not resemble existing incident patterns

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
- treat results as strong prioritization input for human review, not standalone proof

### For maintainers

- start with the console report to get the next concrete action
- inspect sender and receiver workflows together when a dispatch edge is shown
- use `--workspace-dir` during repeated investigations to avoid recloning the same targets
- keep provenance, release controls, and compensating controls in the loop even for lower-scored targets

### For platform and compliance teams

- use JSON for portfolio automation
- combine `cdx-validate` manual SCVS reviews with `cdx-audit` evidence when you need workflow, provenance, or publisher context
- preserve SARIF and CycloneDX annotations so the guidance travels with the BOM

## Relationship to custom properties

The prioritization engine relies on the custom properties documented in [`CUSTOM_PROPERTIES.md`](CUSTOM_PROPERTIES.md), especially GitHub workflow metadata, provenance properties, and install-time execution indicators.

## Related docs

- [BOM Audit](BOM_AUDIT.md)
- [cdx-validate — Supply-Chain Compliance Validator](CDX_VALIDATE.md)
- [cdx: Custom Properties](CUSTOM_PROPERTIES.md)
- [REPL / cdxi](REPL.md)
- [Tutorials - Scanning Git URLs and purls with BOM Audit](LESSON8.md)

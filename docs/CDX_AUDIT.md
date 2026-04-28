# CDX Audit

`cdx-audit` is a predictive supply-chain exposure audit CLI for CycloneDX BOMs.

Unlike `cdxgen --bom-audit`, which evaluates the BOM that was just generated, `cdx-audit` starts from one or more existing BOMs, extracts supported package URLs, resolves their source repositories, generates child SBOMs for those sources, and then reuses the built-in YAML + JSONata audit rules to score forward-looking compromise risk.

## Initial scope

Version 1 focuses only on:

- npm (`pkg:npm/...`)
- PyPI (`pkg:pypi/...`)

Other purl ecosystems are skipped and reported as unsupported.

## How it works

1. Load one BOM with `--bom` or many BOMs from `--bom-dir`
2. Extract unique npm and PyPI package URLs from `components[]`
3. Resolve each purl to a repository URL using the existing source helpers
4. Clone or reuse the repository under `--workspace-dir`
5. Generate a child SBOM for that source repository, or reuse a cached child SBOM from the workspace when one already exists for the same purl target
6. Evaluate built-in audit rules, especially:
   - `ci-permission`
   - `dependency-source`
   - `package-integrity`
7. Enrich npm and PyPI components with registry provenance signals such as trusted publishing, publish time, publisher identity, and provenance URLs when those are exposed by the registry
8. Score each target conservatively so `high` and `critical` require corroborated signals

## Usage

```bash
cdx-audit --bom bom.json
cdx-audit --bom-dir ./boms --report json
cdx-audit --bom bom.json --report sarif --report-file audit.sarif
cdx-audit --bom bom.json --workspace-dir .cache/cdx-audit --reports-dir .reports/cdx-audit
cdx-audit --bom bom.json --report json --report-file audit-report.json
```

## Options

| Option            | Description                                                       |
| ----------------- | ----------------------------------------------------------------- |
| `--bom`           | Path to a single CycloneDX JSON BOM                               |
| `--bom-dir`       | Directory containing CycloneDX JSON BOMs                          |
| `--workspace-dir` | Reuse git clones and cached child SBOMs between runs              |
| `--reports-dir`   | Persist aggregate and per-purl child SBOM reports                 |
| `--report`        | `console`, `json`, or `sarif`                                     |
| `--report-file`   | Write the final rendered report to a file                         |
| `--categories`    | Override the audit rule categories used for child SBOM analysis   |
| `--min-severity`  | Minimum final target severity included in console or SARIF output |
| `--fail-severity` | Exit with code `3` when any target reaches this final severity    |
| `--max-targets`   | Safety limit for the number of unique purls to analyze            |

## Progress UX

When `cdx-audit` is run in an interactive terminal, it shows a dependency-free spinner-style progress line on `stderr` with:

- the current package being analyzed
- the current stage (`resolving repository metadata`, `cloning source`, `generating child SBOM`, `evaluating audit rules`)
- the target index, for example `1/12`

Progress is written to `stderr`, so `--report json` output on `stdout` remains machine-readable.

`--reports-dir` stores intermediate child SBOM artifacts, while `--report-file` controls where the final aggregate report is written.

When `--workspace-dir` is provided, `cdx-audit` also stores per-target child SBOM cache files under `<workspace>/<target>/.cdx-audit/`. A later run can reuse those cached child SBOMs instead of cloning and re-scanning the same source again.

If the workspace is an owned temporary directory under the OS temp root, `cdx-audit` now cleans it up correctly on completion even on platforms where `/tmp` is a symlinked alias.

## Severity model

`cdx-audit` is intentionally conservative:

- isolated findings usually stay `low` or `medium`
- `high` requires corroboration across multiple strong signals and categories
- `critical` is reserved for rare, compound patterns with strong confidence, usually involving GitHub Actions or formulation-derived workflow exposure plus package-level risk signals

This keeps false positives lower while still prioritizing packages that look structurally more likely to be abused in a future supply-chain event.

To reduce alert floods further, `cdx-audit` also consolidates duplicate npm namespace findings when multiple packages under the same namespace surface the same predictive rule pattern. The grouped result is then used for console rendering and fail-threshold evaluation.

Provenance signals are handled conservatively:

- missing trusted publishing is **not** treated as a standalone high-risk signal
- for npm, missing provenance only becomes a detector when the package already has install-time execution risk
- for PyPI, missing provenance is a low-severity contextual detector for default-registry packages without uploader verification
- positive provenance evidence such as `trustedPublishing` or `provenanceUrl` reduces the final predictive score, but does not erase strong multi-signal findings

Recent-release and publisher-change detectors are also conservative:

- they only activate for established packages with enough release history
- recent-release detectors look for very new releases on mature packages, not brand-new projects
- publisher-change detectors use the immediately prior known publisher/uploader as context, then require weak trust posture before surfacing a finding
- publisher drift is a triage signal, not proof of compromise

Maintainer-set drift and cadence anomaly detectors follow the same approach:

- fully disjoint maintainer/uploader sets remain the stronger drift signal
- partial-overlap drift only triggers when some identities are retained and some change across adjacent releases
- release-gap anomalies focus on long dormant gaps on mature packages, not ordinary cadence variation
- compressed-cadence anomalies focus on materially faster-than-usual releases on mature packages with enough history, not normal short-cycle projects
- these signals stay low-severity unless combined with higher-risk package behavior such as install-time execution

## Registry provenance enrichment

When package metadata is available from npmjs or PyPI, cdxgen now records additional provenance-oriented custom properties such as:

- `cdx:npm:trustedPublishing`
- `cdx:npm:provenanceUrl`
- `cdx:npm:publisher`
- `cdx:npm:publishTime`
- `cdx:npm:compressedCadence`
- `cdx:npm:maintainerSetPartialDrift`
- `cdx:pypi:trustedPublishing`
- `cdx:pypi:provenanceUrl`
- `cdx:pypi:publisher`
- `cdx:pypi:uploaderVerified`
- `cdx:pypi:publishTime`
- `cdx:pypi:compressedCadence`
- `cdx:pypi:uploaderSetPartialDrift`

See [`docs/CUSTOM_PROPERTIES.md`](CUSTOM_PROPERTIES.md) for the full inventory and value semantics.

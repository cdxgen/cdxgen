---
name: bom-audit
description: Runs supply-chain risk analysis on CycloneDX BOMs with cdx-audit predictive auditing and cdxgen --bom-audit embedded rules, covering npm and PyPI package compromise posture, CI permission risk, dependency source integrity, license policy violations, and SARIF or JSON reporting for code scanning. Use when asked to audit an SBOM, assess supply-chain or dependency risk, check for compromised or malicious packages, triage which dependencies to review first, or produce SARIF from a BOM.
---

# Audit a BOM for supply-chain risk

Two distinct mechanisms. Choose deliberately.

| Want                                                    | Use                        |
| ------------------------------------------------------- | -------------------------- |
| Findings embedded while the BOM is generated            | `cdxgen --bom-audit`       |
| Analysis of a BOM that already exists                   | `cdx-audit`                |
| Forward-looking review prioritization for npm/PyPI      | `cdx-audit` (predictive)   |
| Rule evaluation against the supplied BOM itself         | `cdx-audit --direct-bom-audit` |

Read [reference/safety.md](../../reference/safety.md) first. Predictive auditing
clones upstream repositories and generates child SBOMs, so it does real network
work — confirm with the user before a large run.

## Predictive audit of an existing BOM

```bash
cdx-audit --bom /absolute/path/to/bom.json
cdx-audit --bom-dir /absolute/path/to/boms --report json --report-file /absolute/path/to/audit.json
cdx-audit --bom /absolute/path/to/bom.json --report sarif --report-file /absolute/path/to/audit.sarif
```

Reporters: `console` (default), `json`, `sarif`. Use SARIF for code-scanning
uploads.

Predictive mode extracts npm and PyPI package URLs from the BOM's components,
generates a child SBOM for each upstream, and evaluates compromise posture.
Cargo/Rust BOMs are also worth auditing this way when the goal is upstream
review prioritization.

**Exit code `3`** means at least one target reached `--fail-severity` (default
`high`) or above. That is a policy signal, not a crash — report it as such.

### Start narrow

For large BOMs or a triage-first workflow:

```bash
cdx-audit --bom /absolute/path/to/bom.json --scope required --max-targets 25
```

| Flag                | Effect                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------- |
| `--scope required`  | Only components with CycloneDX `scope=required`; a missing scope is treated as required |
| `--scope all`       | Default                                                                                 |
| `--max-targets <n>` | Safety limit on unique npm/PyPI purls analyzed                                           |
| `--min-severity`    | Filter console/SARIF output (`low`, `medium`, `high`, `critical`)                        |
| `--fail-severity`   | Severity that triggers exit code 3 (default `high`)                                      |

### Trusted publishing

```bash
# broader baseline, including packages that already carry trusted publishing metadata
cdx-audit --bom /absolute/path/to/bom.json --scope required --include-trusted --max-targets 50

# inspect only that subset
cdx-audit --bom /absolute/path/to/bom.json --only-trusted
```

**Never pass `--include-trusted` together with `--only-trusted`.** Use
`--include-trusted` only when the user explicitly wants the broader baseline.

### Reuse work across runs

```bash
cdx-audit --bom /absolute/path/to/bom.json \
  --workspace-dir /absolute/path/to/workspace \
  --reports-dir /absolute/path/to/reports
```

`--workspace-dir` reuses cloned repositories and cached child SBOMs.
`--reports-dir` persists per-target artifacts plus an aggregate JSON report. Use
both when the user expects iterative analysis.

Other useful flags: `--allowlist-file` (purl prefixes to exclude from target
selection, on top of the built-in allowlist),
`--skip-default-branch-recheck`, `--prioritize-direct-runtime`,
`--rules-dir` for custom rules, and `--introspect` for a per-BOM build-fidelity
verdict inferred from BOM structure alone.

### How the queue is ordered

Queue order is explainable. When trimmed, it prioritizes:

1. direct runtime dependencies
2. explicit CycloneDX `scope=required`
3. stronger source evidence via `evidence.occurrences`
4. non-development ahead of development-only packages
5. non-platform-specific ahead of platform-constrained packages

These affect **which packages are audited first**, not final severity. Final
severity comes from child SBOM findings plus conservative corroboration logic.
Do not present queue position as a risk score.

### Score rationale

```bash
CDXGEN_THINK_MODE=true cdx-audit --bom /absolute/path/to/bom.json --scope required --max-targets 10
```

Prints lightweight score and rationale summaries per package.

## Direct BOM audit

Evaluate rules against the supplied BOM itself rather than generating child
SBOMs:

```bash
cdx-audit --bom /absolute/path/to/bom.json --direct-bom-audit
cdx-audit --bom /absolute/path/to/hbom.json --direct-bom-audit --categories hbom
cdx-audit --bom /absolute/path/to/aibom.json --direct-bom-audit --categories ai-bom
cdx-audit --bom /absolute/path/to/bom.evinse.json --direct-bom-audit --categories golem
```

In direct mode, `--categories` applies to the supplied BOM. Default is
`obom-runtime` for OBOMs and all categories otherwise. In predictive mode it
applies to the generated child SBOMs, defaulting to `ai-agent`,
`ci-permission`, `dependency-source`, `package-integrity`.

## Embedded audit during generation

```bash
cdxgen -o /absolute/path/to/bom.json --bom-audit /absolute/path/to/project
cdxgen -o /absolute/path/to/bom.json --bom-audit --bom-audit-categories ci-permission /absolute/path/to/project
```

Findings land in the BOM's `annotations[]`. Related flags mirror `cdx-audit`:
`--bom-audit-categories`, `--bom-audit-min-severity`,
`--bom-audit-fail-severity`, `--bom-audit-scope`, `--bom-audit-max-targets`,
`--bom-audit-include-trusted`, `--bom-audit-only-trusted`,
`--bom-audit-rules-dir`.

Unknown categories are **rejected**, not ignored. Aliases such as `ai-inventory`
and `hbom` expand to their built-in category sets.

## Rule categories

| Category            | Covers                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `ci-permission`     | GitHub Actions/GitLab CI privilege and supply-chain risk               |
| `dependency-source` | Non-registry, local, or mutable dependency sources                     |
| `package-integrity` | Deprecated, yanked, tampered, or suspicious packages                   |
| `golem-security`    | Go Evinse/Golem evidence findings                                      |
| `asar-archive`      | Electron ASAR archive integrity and contents                           |
| `container-risk`    | Container image risk                                                   |
| `rootfs-hardening`  | Offline host repository trust, privileged helpers, service drift       |
| `obom-runtime`      | Live OS runtime artifacts                                              |
| `hbom-security`     | Hardware security posture                                              |
| `host-topology`     | Merged hardware plus runtime host view                                 |
| `mcp-server`        | MCP server exposure and auth posture                                   |
| `ai-agent`          | AI instruction and skill files                                         |
| `ai-inventory`      | Alias for `ai-agent` + `mcp-server`                                    |
| `ai-bom`            | Umbrella AI-BOM pack                                                   |
| `ai-security`, `ai-governance`, `ai-performance` | AI-specific rule packs                     |
| `ai-provenance`     | Alias enabling `ai-provenance` + `ai-oversight`                        |
| `cbom-security`, `cbom-compliance` | Weak crypto, cipher modes, key sizes, protocol versions |
| `vscode-extension`, `chrome-extension` | IDE and browser extension risk                     |

Aliases worth remembering: `cbom` / `crypto-bom` for both CBOM packs, `hbom` for
the full HBOM pack, `ai-inventory` for AI agent plus MCP.

Full rule tables with IDs and severities:
<https://cdxgen.github.io/cdxgen/#/BOM_AUDIT>.

## License policy

```bash
cdx-audit --bom /absolute/path/to/bom.json --license-policy /absolute/path/to/policy.yaml
```

Evaluates every component license and reports prohibited and warning-level
violations as a separate table. **Error-level (prohibited) violations cause a
non-zero exit**, independent of `--fail-severity`.

`cdxgen --license-policy` applies the same policy at generation time.

## Dry-run-friendly categories

In dry-run mode the formulation-centric categories are the ones that still
produce meaningful output, since they read declared configuration rather than
resolved dependency trees. `ci-permission` is the clearest example.

## Reporting findings to the user

- Lead with what reached `--fail-severity`, not with the total count.
- Name the rule ID (`CI-002`, `PKG-007`) so the user can look it up.
- Say when a clean result reflects conservative analysis rather than proven absence — especially for MCP and AI categories.
- If exit code 3 fired, state which target caused it.

## Exploring findings

In `cdxi` (see `bom-explore`): `.auditfindings` and `.auditactions`.

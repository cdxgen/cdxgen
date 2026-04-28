# BOM Audit

cdxgen includes a built-in, post-generation BOM audit engine that evaluates your CycloneDX SBOM against a set of security and supply-chain rules. The engine uses [JSONata](https://jsonata.org/) expressions to query the BOM structure and [YAML rule files](https://github.com/CycloneDX/cdxgen/tree/master/data/rules) to define what constitutes a finding.

## Quick start

```bash
# Generate an SBOM with audit findings
cdxgen -o bom.json --bom-audit

# Audit with only CI permission rules
cdxgen -o bom.json --bom-audit --bom-audit-categories ci-permission

# Audit with high-severity findings only
cdxgen -o bom.json --bom-audit --bom-audit-min-severity high

# Add your own rules directory
cdxgen -o bom.json --bom-audit --bom-audit-rules-dir ./my-rules

# Predictive audit only required npm/PyPI dependencies
cdxgen -o bom.json --bom-audit --bom-audit-scope required

# Include packages that already have trusted publishing metadata
cdxgen -o bom.json --bom-audit --bom-audit-include-trusted

# Audit only trusted-publishing-backed packages
cdxgen -o bom.json --bom-audit --bom-audit-only-trusted
```

> **Note:** `--bom-audit` automatically enables `--include-formulation` to collect CI/CD workflow data. The formulation section may include sensitive data such as emails and environment details. Always review the generated SBOM before distribution.

## How it works

The audit runs as a post-processing step after BOM generation:

1. **Load rules** — Built-in rules from `data/rules/` are loaded first. If `--bom-audit-rules-dir` is specified, user rules are merged in.
2. **Evaluate** — Each rule's JSONata `condition` expression is evaluated against the full BOM. Matching components or workflows become findings.
3. **Report** — Findings are printed to the console with severity icons and optionally embedded as CycloneDX annotations in the output BOM.
4. **Gate** — In secure mode (`CDXGEN_SECURE_MODE=true`), findings at or above `--bom-audit-fail-severity` cause a non-zero exit code.

```
┌──────────────────────┐
│  createBom(path, opt)│
│   + postProcess()    │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   auditBom(bomJson)  │
│                      │
│  ┌────────────────┐  │
│  │  loadRules()   │  │  ← data/rules/*.yaml + user rules
│  └───────┬────────┘  │
│          │           │
│  ┌───────▼────────┐  │
│  │ evaluateRules() │  │  ← JSONata conditions against BOM
│  └───────┬────────┘  │
│          │           │
│  ┌───────▼────────┐  │
│  │ formatFindings  │  │  ← console output + CycloneDX annotations
│  └────────────────┘  │
└──────────────────────┘
```

## CLI options

| Option                        | Type    | Default | Description                                                                                                              |
| ----------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--bom-audit`                 | boolean | `false` | Enable post-generation security audit                                                                                    |
| `--bom-audit-rules-dir`       | string  | —       | Directory containing additional YAML rule files (merged with built-in rules)                                             |
| `--bom-audit-categories`      | string  | all     | Comma-separated list of rule categories to enable                                                                        |
| `--bom-audit-min-severity`    | string  | `low`   | Minimum severity to report: `low`, `medium`, `high`                                                                      |
| `--bom-audit-fail-severity`   | string  | `high`  | Severity level at or above which findings cause secure mode failure (e.g., `medium` fails on medium, high, and critical) |
| `--bom-audit-scope`           | string  | `all`   | Predictive dependency audit target scope: `all` or `required`                                                            |
| `--bom-audit-max-targets`     | number  | auto    | Predictive dependency audit cap. By default cdxgen scans required targets first and expands to at least 50 targets       |
| `--bom-audit-include-trusted` | boolean | `false` | Include predictive audit targets that already carry trusted publishing metadata                                          |
| `--bom-audit-only-trusted`    | boolean | `false` | Restrict predictive audit targets to trusted-publishing-backed packages only                                             |

## Predictive dependency target selection

When `--bom-audit` is enabled for npm or PyPI-heavy projects, cdxgen now narrows predictive dependency audit targets before cloning upstream repositories:

- packages with trusted publishing metadata (`cdx:npm:trustedPublishing=true` or `cdx:pypi:trustedPublishing=true`) are skipped by default
- `--bom-audit-scope required` keeps only dependencies with CycloneDX `scope=required` (missing scope is treated as required)
- unless you override it, cdxgen caps the predictive dependency audit to `max(50, required-target-count)` and prioritizes required targets first

Use the trusted-publishing switches to override the default:

- `--bom-audit-include-trusted` includes both trusted-publishing-backed and non-trusted packages
- `--bom-audit-only-trusted` scans only trusted-publishing-backed packages

Passing both trusted switches together is invalid and causes cdxgen to exit with an error.

## Built-in rule categories

### `ci-permission` — CI/CD Permission Security

Rules that evaluate GitHub Actions, GitLab CI, and other CI/CD workflow data for privilege and supply-chain risks.

| Rule   | Severity | Description                                                                                  |
| ------ | -------- | -------------------------------------------------------------------------------------------- |
| CI-001 | high     | Unpinned GitHub Action in a workflow with write permissions                                  |
| CI-002 | high     | OIDC token (`id-token: write`) granted to non-official action                                |
| CI-003 | medium   | GitHub Action pinned to a mutable tag instead of SHA                                         |
| CI-004 | medium   | Workflow uses `pull_request_target` trigger                                                  |
| CI-021 | medium   | Heuristic review: high-risk trigger, no explicit permissions block, and sensitive operations |
| CI-018 | high     | Fork-reachable or privileged workflow dispatches downstream workflows/events                 |
| CI-019 | critical | Dispatch chain combines explicit fork context with sensitive credentials                     |
| CI-009 | medium   | Workflow file contains hidden Unicode characters                                             |
| CI-010 | medium   | npm/PyPI publish step uses legacy token-based publishing                                     |

### `dependency-source` — Dependency Source Integrity

Rules that check package manager data for non-registry, local, or mutable dependency sources.

| Rule    | Severity | Description                                                       |
| ------- | -------- | ----------------------------------------------------------------- |
| PKG-001 | high     | npm package with install script from non-registry source          |
| PKG-002 | high     | Go module uses local `replace` directive                          |
| PKG-003 | high     | Swift package uses local checkout path                            |
| PKG-004 | high     | Nix flake missing reproducibility metadata (revision or nar_hash) |
| PKG-005 | medium   | Ruby gem tracks mutable branch without commit pin                 |
| PKG-006 | medium   | Python package from non-default PyPI registry                     |

### `package-integrity` — Package Integrity and Lifecycle

Rules that detect deprecated, yanked, tampered, or suspicious packages.

| Rule    | Severity | Description                                                              |
| ------- | -------- | ------------------------------------------------------------------------ |
| INT-001 | medium   | npm package has install-time execution hooks                             |
| INT-002 | high     | npm package name or version mismatch (possible dependency confusion)     |
| INT-003 | medium   | Deprecated Go module                                                     |
| INT-004 | high     | Yanked Ruby gem                                                          |
| INT-005 | low      | Deprecated npm package                                                   |
| INT-006 | medium   | Dart pub uses non-default registry                                       |
| INT-007 | low      | Maven package contains shaded/relocated classes                          |
| INT-008 | medium   | README file contains hidden Unicode characters                           |
| INT-009 | critical | npm lifecycle hook contains obfuscated or encoded install-time execution |

### Advanced predictive heuristics

Beyond the YAML rule matches above, the current rollout also adds a small number of deliberately high-signal source heuristics for `cdx-audit` scans:

- **GitHub Actions lateral movement:** downstream `workflow_dispatch` / `repository_dispatch` chains launched from fork-reachable or privileged workflows
- **npm install-time concealment:** base64-decoding or otherwise obfuscated lifecycle hooks, including referenced JS files analyzed through the Babel-based source analyzer
- **PyPI packaging surfaces:** shallow heuristics for suspicious logic in `setup.py` and package `__init__.py`

The Python detections are intentionally conservative phase-1 heuristics. They are meant to catch obviously suspicious packaging behavior today while a deeper Python static-analysis path is developed separately.

### `obom-runtime` — Operational Runtime and Host Posture

Rules that evaluate OBOM runtime components from osquery-derived host telemetry for persistence, endpoint control gaps, and suspicious startup/runtime behavior.

| Rule         | Severity | Description                                                          |
| ------------ | -------- | -------------------------------------------------------------------- |
| OBOM-LNX-001 | high     | Linux systemd unit sourced from temporary path                       |
| OBOM-LNX-002 | high     | Linux sudoers broad privilege rule                                   |
| OBOM-LNX-003 | medium   | Root authorized_keys entry without restrictions                      |
| OBOM-LNX-004 | high     | Linux shell history contains suspicious download-execute pattern     |
| OBOM-LNX-005 | critical | Docker API exposed over unauthenticated TCP port                     |
| OBOM-LNX-006 | high     | Privileged Linux listener exposed on a non-local interface           |
| OBOM-LNX-007 | high     | Administrative Linux surface running with elevated privileges        |
| OBOM-LNX-008 | high     | Interactive sudo chain touched sensitive administrative binary       |
| OBOM-LNX-009 | high     | Unexpected Linux privilege transition for non-allowlisted executable |
| OBOM-LNX-010 | critical | Elevated Linux process launched from user-writable or unusual path   |
| OBOM-LNX-011 | medium   | Interactive shell parent spawned privileged Linux execution          |
| OBOM-WIN-001 | high     | Windows drive without BitLocker protection                           |
| OBOM-WIN-002 | high     | Windows Security Center unhealthy state                              |
| OBOM-WIN-003 | critical | Windows Run key references temporary/script execution path           |
| OBOM-WIN-004 | high     | Hidden scheduled task uses suspicious execution path                 |
| OBOM-WIN-005 | critical | Auto-start Windows service points to user-writable path              |
| OBOM-MAC-001 | high     | macOS firewall disabled or stealth mode off                          |
| OBOM-MAC-002 | critical | macOS launchd item from user-writable temporary path                 |
| OBOM-MAC-003 | medium   | macOS firewall exception for binary in untrusted user path           |
| OBOM-MAC-004 | medium   | macOS launchd override disables Apple-managed service                |

### `vscode-extension` — VS Code Extension Security

Rules that evaluate VS Code extension metadata for install-time execution, always-on activation, workspace trust posture, and privileged capabilities.

| Rule    | Severity | Description                                                         |
| ------- | -------- | ------------------------------------------------------------------- |
| VSC-001 | critical | VS Code extension has install-time lifecycle scripts                |
| VSC-002 | high     | Always-on extension (`*` activation) exposes terminal access        |
| VSC-003 | high     | Extension runs in untrusted workspaces with filesystem access       |
| VSC-006 | high     | Extension contributes debugger/authentication provider capabilities |
| VSC-007 | high     | Workspace-context extension executes code                           |

### `chrome-extension` — Chromium Browser Extension Security

Rules that evaluate Chrome/Chromium/Edge/Brave extension metadata for broad site access, request interception, early script injection, autofill, and capability-derived risk posture (file/device/code-injection/fingerprinting).

| Rule    | Severity | Description                                                                           |
| ------- | -------- | ------------------------------------------------------------------------------------- |
| CHE-001 | high     | Extension has broad host access (`<all_urls>` or wildcard host permissions)           |
| CHE-002 | critical | Extension can intercept and block web requests (`webRequest` + `webRequestBlocking`)  |
| CHE-003 | high     | Extension injects content scripts at `document_start` with broad host access          |
| CHE-004 | medium   | Autofill-capable extension has broad host permissions                                 |
| CHE-005 | high     | Extension combines broad host scope with file/device/bluetooth capabilities           |
| CHE-006 | critical | Extension has code-injection capability with broad host scope                         |
| CHE-007 | high     | Extension has fingerprinting capability indicators with broad host scope              |
| CHE-008 | high     | AI-assistant extension has code-injection capability on OpenAI/Claude/Copilot domains |

## Writing custom rules

Rules are YAML files placed in a directory and loaded via `--bom-audit-rules-dir`. Each file can contain a single rule object or a YAML array of rules.

### Rule schema

```yaml
- id: CUSTOM-001 # Required: unique identifier
  name: "Human-readable name" # Optional: display name (defaults to id)
  description: "Long description" # Optional: detailed explanation
  severity: high # Required: critical, high, medium, or low
  category: my-category # Required: grouping for --bom-audit-categories
  condition: | # Required: JSONata expression returning matches
    components[
      $prop($, 'cdx:npm:hasInstallScript') = 'true'
    ]
  location: | # Optional: JSONata expression for finding location
    { "bomRef": $."bom-ref", "purl": purl }
  message: "Template with {{ name }}" # Required: message template with {{ expr }} interpolation
  mitigation: "How to fix this" # Optional: remediation guidance
  attack: # Optional: MITRE ATT&CK metadata propagated to findings / SARIF / annotations
    tactics: [TA0001, TA0004]
    techniques: [T1195.001]
  evidence: | # Optional: JSONata expression for evidence data
    { "key": $prop($, 'cdx:npm:risky_scripts') }
```

### Available JSONata helpers

The rule engine registers custom functions for working with CycloneDX properties:

| Function                      | Description                                                                                                              | Example                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `$prop(obj, name)`            | Extract a property value by name                                                                                         | `$prop($, 'cdx:npm:hasInstallScript')`                                               |
| `$nullSafeProp(obj, name)`    | Extract a property value but return `""` when it is missing; useful for string matching                                  | `$nullSafeProp($, 'cdx:github:workflow:triggers') ~> $contains('pull_request')`      |
| `$hasProp(obj, name)`         | Check if property exists                                                                                                 | `$hasProp($, 'cdx:npm:risky_scripts')`                                               |
| `$hasProp(obj, name, value)`  | Check if property equals value                                                                                           | `$hasProp($, 'cdx:npm:isLink', 'true')`                                              |
| `$p(obj, name)`               | Short alias for `$prop`                                                                                                  | `$p($, 'cdx:go:local_dir')`                                                          |
| `$hasP(obj, name, value)`     | Short alias for `$hasProp`                                                                                               | `$hasP($, 'cdx:gem:yanked', 'true')`                                                 |
| `$propBool(obj, name)`        | Extracts property and normalizes to JS boolean ( true / false / null ). Case-insensitive and null-safe.                  | `$propBool($, 'cdx:github:workflow:hasWritePermissions') = true`                     |
| `$propList(obj, name)`        | Splits comma-separated property strings into a trimmed JSONata array. Returns [] if missing.                             | `$propList($, 'cdx:github:workflow:triggers')`                                       |
| `$listContains(val, target)`  | Safely checks if val (array or string) contains target. Works with both $propList output and raw strings.                | `$listContains($propList($, 'cdx:vscode-extension:contributes'), 'terminal-access')` |
| `$safeStr(val)`               | Guarantees a trimmed string return. Converts null/undefined to "" . Ideal for regex matching and template interpolation. | `$match($safeStr($prop($, 'cdx:npm:versionSpecifiers')), /^\^/)`                     |
| `$startsWith(str, prefix)`    | String prefix check                                                                                                      | `$startsWith(purl, 'pkg:nix/')`                                                      |
| `$endsWith(str, suffix)`      | String suffix check                                                                                                      | `$endsWith(name, '-beta')`                                                           |
| `$arrayContains(arr, value)`  | Check array membership                                                                                                   | `$arrayContains(tags, 'deprecated')`                                                 |
| `$auditComponents(bom)`       | Return a deduplicated array of top-level BOM components plus any `formulation[].components`                              | `$auditComponents($)[$prop($, 'cdx:github:action:isShaPinned') = 'false']`           |
| `$auditWorkflows(bom)`        | Return a deduplicated array of all `formulation[].workflows` entries                                                     | `$auditWorkflows($)[$prop($, 'cdx:github:workflow:hasHighRiskTrigger') = 'true']`    |
| `$formulationComponents(bom)` | Return only `formulation[].components`                                                                                   | `$formulationComponents($)[$prop($, 'cdx:github:step:type') = 'run']`                |

### Message templates

The `message` field supports `{{ expression }}` syntax for dynamic content. The template context includes the matched component/item plus the full BOM:

```yaml
message: "Package '{{ name }}@{{ version }}' from registry {{ $prop($, 'cdx:pypi:registry') }}"
```

### Condition patterns

#### Match components by property value

```yaml
condition: |
  components[
    $prop($, 'cdx:npm:hasInstallScript') = 'true'
  ]
```

#### Match components by property existence

```yaml
condition: |
  components[
    $hasProp($, 'cdx:go:local_dir')
  ]
```

#### Combine multiple conditions

```yaml
condition: |
  $auditComponents($)[
    $prop($, 'cdx:github:action:isShaPinned') = 'false'
    and (
      $prop($, 'cdx:github:workflow:hasWritePermissions') = 'true'
      or $prop($, 'cdx:github:job:hasWritePermissions') = 'true'
    )
  ]
```

#### Match workflow data

```yaml
condition: |
  $auditWorkflows($)[
    $nullSafeProp($, 'cdx:github:workflow:triggers') ~> $contains('pull_request_target')
  ]
```

### ATT&CK metadata in outputs

When a rule defines an `attack:` block, cdxgen carries that metadata through to:

- BOM-audit finding objects as `attackTactics` / `attackTechniques`
- CycloneDX annotations as `cdx:audit:attack:tactics` / `cdx:audit:attack:techniques`
- SARIF rule/result `properties` and SARIF tags like `ATT&CK:TA0004`

This keeps the rule schema lightweight while making ATT&CK-aligned detections available to downstream reporting and triage pipelines.

#### Use purl-based filtering

```yaml
condition: |
  components[
    $startsWith(purl, 'pkg:nix/')
    and $prop($, 'cdx:nix:revision') = null
  ]
```

## Output formats

### Console output

Findings are printed with severity-coded icons:

```
Formulation audit: 3 finding(s)

⛔ [CUSTOM-001] Critical finding message
🔴 [CI-001] Unpinned GitHub Action 'actions/setup-node@v3' in workflow with write permissions
🟡 [CI-003] GitHub Action 'actions/checkout@v3' pinned to mutable tag (not SHA)
🔵 [INT-005] npm package 'leftpad@0.0.1' is deprecated
```

### CycloneDX annotations

When the BOM spec version is ≥ 1.4, findings are embedded as annotations:

```json
{
  "annotations": [
    {
      "subjects": ["urn:uuid:..."],
      "annotator": {
        "component": { "name": "cdxgen", "version": "..." }
      },
      "timestamp": "2025-01-01T00:00:00.000Z",
      "text": "Unpinned GitHub Action 'actions/setup-node@v3' in workflow with write permissions",
      "properties": [
        { "name": "cdx:audit:ruleId", "value": "CI-001" },
        { "name": "cdx:audit:severity", "value": "high" },
        { "name": "cdx:audit:category", "value": "ci-permission" },
        { "name": "cdx:audit:mitigation", "value": "Pin action to full SHA..." }
      ]
    }
  ]
}
```

Audit and validation annotations now render their properties as markdown tables instead of JSON blobs, which improves readability in Dependency-Track, GitHub, and other CycloneDX annotation consumers.

## Environment variables

| Variable                  | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `CDXGEN_DEBUG_MODE=debug` | Show verbose audit logging                              |
| `CDXGEN_SECURE_MODE=true` | Enable secure mode (audit failures cause non-zero exit) |

## Relationship to custom properties

The audit rules are powered by the [cdx: Custom Properties](CUSTOM_PROPERTIES.md) that cdxgen adds to BOM components, workflows, and metadata. See that document for the full inventory of available properties and their value semantics.

## Frequently asked questions

**Q: Does `--bom-audit` slow down BOM generation?**

`--bom-audit` now has two layers:

1. the original in-memory BOM audit, which evaluates JSONata expressions against the generated BOM
2. a predictive dependency audit for npm and PyPI components, which may resolve source repositories and generate child SBOMs

For projects without npm/PyPI dependencies, the overhead is usually minimal. For npm/PyPI-heavy projects, the predictive pass can add noticeable time because it may query registries and inspect upstream source repositories.

To keep large projects responsive, the predictive pass now prints a preflight hint for larger target sets, skips trusted-publishing-backed packages by default, and prioritizes required dependencies before optional ones when a target cap applies.

**Q: Can I disable specific built-in rules?**

Use `--bom-audit-categories` to restrict which categories run. Individual rule disabling is planned for a future release.

**Q: How does provenance affect the predictive audit score?**

Registry-visible provenance such as trusted publishing, provenance URLs, and verified uploaders is treated as a score reducer and confidence input. Missing provenance is only used as a weak contextual detector and is never intended to produce a high-severity finding on its own.

**Q: How do I use this in CI/CD pipelines?**

```yaml
# GitHub Actions example
- name: Generate SBOM with audit
  run: |
    cdxgen -o bom.json --bom-audit --bom-audit-fail-severity high
  env:
    CDXGEN_SECURE_MODE: "true"
```

In secure mode, any finding at or above `--bom-audit-fail-severity` causes a non-zero exit code, failing the pipeline step.

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

| Option                      | Type    | Default | Description                                                                                                              |
| --------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--bom-audit`               | boolean | `false` | Enable post-generation security audit                                                                                    |
| `--bom-audit-rules-dir`     | string  | —       | Directory containing additional YAML rule files (merged with built-in rules)                                             |
| `--bom-audit-categories`    | string  | all     | Comma-separated list of rule categories to enable                                                                        |
| `--bom-audit-min-severity`  | string  | `low`   | Minimum severity to report: `low`, `medium`, `high`                                                                      |
| `--bom-audit-fail-severity` | string  | `high`  | Severity level at or above which findings cause secure mode failure (e.g., `medium` fails on medium, high, and critical) |

## Built-in rule categories

### `ci-permission` — CI/CD Permission Security

Rules that evaluate GitHub Actions, GitLab CI, and other CI/CD workflow data for privilege and supply-chain risks.

| Rule   | Severity | Description                                                   |
| ------ | -------- | ------------------------------------------------------------- |
| CI-001 | high     | Unpinned GitHub Action in a workflow with write permissions   |
| CI-002 | high     | OIDC token (`id-token: write`) granted to non-official action |
| CI-003 | medium   | GitHub Action pinned to a mutable tag instead of SHA          |
| CI-004 | medium   | Workflow uses `pull_request_target` trigger                   |

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

| Rule    | Severity | Description                                                          |
| ------- | -------- | -------------------------------------------------------------------- |
| INT-001 | medium   | npm package has install-time execution hooks                         |
| INT-002 | high     | npm package name or version mismatch (possible dependency confusion) |
| INT-003 | medium   | Deprecated Go module                                                 |
| INT-004 | high     | Yanked Ruby gem                                                      |
| INT-005 | low      | Deprecated npm package                                               |
| INT-006 | medium   | Dart pub uses non-default registry                                   |
| INT-007 | low      | Maven package contains shaded/relocated classes                      |

### `vscode-extension` — VS Code Extension Security

Rules that evaluate VS Code extension metadata for install-time execution, always-on activation, workspace trust posture, and privileged capabilities.

| Rule    | Severity | Description                                                             |
| ------- | -------- | ----------------------------------------------------------------------- |
| VSC-001 | critical | VS Code extension has install-time lifecycle scripts                    |
| VSC-002 | high     | Always-on extension (`*` activation) exposes terminal access            |
| VSC-003 | high     | Extension runs in untrusted workspaces with filesystem access           |
| VSC-006 | high     | Extension contributes debugger/authentication provider capabilities      |
| VSC-007 | high     | Workspace-context extension executes code                               |

### `chrome-extension` — Chromium Browser Extension Security

Rules that evaluate Chrome/Chromium/Edge/Brave extension metadata for broad site access, request interception, early script injection, autofill, and capability-derived risk posture (file/device/code-injection/fingerprinting).

| Rule    | Severity | Description                                                                       |
| ------- | -------- | --------------------------------------------------------------------------------- |
| CHE-001 | high     | Extension has broad host access (`<all_urls>` or wildcard host permissions)      |
| CHE-002 | critical | Extension can intercept and block web requests (`webRequest` + `webRequestBlocking`) |
| CHE-003 | high     | Extension injects content scripts at `document_start` with broad host access     |
| CHE-004 | medium   | Autofill-capable extension has broad host permissions                             |
| CHE-005 | high     | Extension combines broad host scope with file/device/bluetooth capabilities       |
| CHE-006 | critical | Extension has code-injection capability with broad host scope                     |
| CHE-007 | high     | Extension has fingerprinting capability indicators with broad host scope           |
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
  evidence: | # Optional: JSONata expression for evidence data
    { "key": $prop($, 'cdx:npm:risky_scripts') }
```

### Available JSONata helpers

The rule engine registers custom functions for working with CycloneDX properties:

| Function                     | Description                                                                                                              | Example                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `$prop(obj, name)`           | Extract a property value by name                                                                                         | `$prop($, 'cdx:npm:hasInstallScript')`                                               |
| `$hasProp(obj, name)`        | Check if property exists                                                                                                 | `$hasProp($, 'cdx:npm:risky_scripts')`                                               |
| `$hasProp(obj, name, value)` | Check if property equals value                                                                                           | `$hasProp($, 'cdx:npm:isLink', 'true')`                                              |
| `$p(obj, name)`              | Short alias for `$prop`                                                                                                  | `$p($, 'cdx:go:local_dir')`                                                          |
| `$hasP(obj, name, value)`    | Short alias for `$hasProp`                                                                                               | `$hasP($, 'cdx:gem:yanked', 'true')`                                                 |
| `$propBool(obj, name)`       | Extracts property and normalizes to JS boolean ( true / false / null ). Case-insensitive and null-safe.                  | `$propBool($, 'cdx:github:workflow:hasWritePermissions') = true`                     |
| `$propList(obj, name)`       | Splits comma-separated property strings into a trimmed JSONata array. Returns [] if missing.                             | `$propList($, 'cdx:github:workflow:triggers')`                                       |
| `$listContains(val, target)` | Safely checks if val (array or string) contains target. Works with both $propList output and raw strings.                | `$listContains($propList($, 'cdx:vscode-extension:contributes'), 'terminal-access')` |
| `$safeStr(val)`              | Guarantees a trimmed string return. Converts null/undefined to "" . Ideal for regex matching and template interpolation. | `$match($safeStr($prop($, 'cdx:npm:versionSpecifiers')), /^\^/)`                     |
| `$startsWith(str, prefix)`   | String prefix check                                                                                                      | `$startsWith(purl, 'pkg:nix/')`                                                      |
| `$endsWith(str, suffix)`     | String suffix check                                                                                                      | `$endsWith(name, '-beta')`                                                           |
| `$arrayContains(arr, value)` | Check array membership                                                                                                   | `$arrayContains(tags, 'deprecated')`                                                 |

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
  components[
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
  formulation.workflows[
    $nullSafeProp($, 'cdx:github:workflow:triggers') ~> $contains('pull_request_target')
  ]
```

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

## Environment variables

| Variable                  | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `CDXGEN_DEBUG_MODE=debug` | Show verbose audit logging                              |
| `CDXGEN_SECURE_MODE=true` | Enable secure mode (audit failures cause non-zero exit) |

## Relationship to custom properties

The audit rules are powered by the [cdx: Custom Properties](CUSTOM_PROPERTIES.md) that cdxgen adds to BOM components, workflows, and metadata. See that document for the full inventory of available properties and their value semantics.

## Frequently asked questions

**Q: Does `--bom-audit` slow down BOM generation?**

The audit runs after generation and evaluates JSONata expressions against the in-memory BOM. For typical projects, it adds less than a second.

**Q: Can I disable specific built-in rules?**

Use `--bom-audit-categories` to restrict which categories run. Individual rule disabling is planned for a future release.

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

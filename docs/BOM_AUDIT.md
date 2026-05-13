# BOM Audit

cdxgen includes a built-in, post-generation BOM audit engine that evaluates your CycloneDX SBOM against a set of security and supply-chain rules. The engine uses [JSONata](https://jsonata.org/) expressions to query the BOM structure and [YAML rule files](https://github.com/CycloneDX/cdxgen/tree/master/data/rules) to define what constitutes a finding.

## Quick start

```bash
# Generate an SBOM with audit findings
cdxgen -o bom.json --bom-audit

# Audit with only CI permission rules
cdxgen -o bom.json --bom-audit --bom-audit-categories ci-permission

# Audit an Electron ASAR release artifact
cdxgen -t asar -o bom.json --bom-audit --bom-audit-categories asar-archive /absolute/path/to/app.asar

# Audit an offline rootfs for hardening drift
cdxgen /absolute/path/to/rootfs -t rootfs -o bom.json --bom-audit --bom-audit-categories rootfs-hardening

# Generate and audit a host HBOM with the built-in HBOM rule packs
cdxgen -t hbom -o hbom.json --bom-audit .

# Audit only the security-focused HBOM rules
cdxgen -t hbom -o hbom.json --bom-audit --bom-audit-categories hbom-security .

# Audit a previously generated HBOM with the full HBOM alias pack
cdx-audit --bom hbom.json --direct-bom-audit --categories hbom

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

## Dry-run mode

`--bom-audit` works with `--dry-run`, but the two audit layers behave differently:

- **Formulation audit** continues to run normally because it evaluates the already-generated BOM in memory.
- **Predictive dependency audit** switches to planning mode. cdxgen still selects candidate npm/PyPI/Cargo targets, but it does not fetch registry metadata, clone upstream repositories, or generate child SBOMs.

The categories that work best in dry-run mode are the formulation-centric ones:

- `asar-archive`
- `ai-agent`
- `ai-inventory` (alias for `ai-agent,mcp-server`)
- `chrome-extension`
- `ci-permission`
- `container-risk`
- `dependency-source`
- `hbom-security`
- `hbom-performance`
- `hbom-compliance`
- `mcp-server`
- `obom-runtime`
- `vscode-extension`

`package-integrity` is only partially covered in dry-run mode. Rules that can be evaluated from the current BOM still run, but predictive upstream analysis is intentionally skipped. `asar-archive` rules are mostly dry-run friendly because cdxgen can still read ASAR headers and file contents natively, recurse into nested archives, and evaluate Electron header-signing metadata in memory, but embedded npm install-script findings remain partial because temp extraction is still blocked.

Built-in BOM audit rules now declare an explicit `dry-run-support` tag with one of these values:

- `full` — the rule is expected to evaluate normally in dry-run mode
- `partial` — the rule can still match, but dry-run BOM generation may omit some supporting metadata
- `no` — the rule depends on metadata that dry-run intentionally does not collect

When you run `cdxgen --bom-audit --dry-run`, the BOM audit summary reports how many of the active rules are tagged `no` and how many are tagged `partial`.
If the summary reports any `partial` or `no` rules, treat the dry-run result as coverage guidance only and re-run without `--dry-run` before treating a clean result as complete.

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

| Option                        | Type    | Default | Description                                                                                                                                                               |
| ----------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--bom-audit`                 | boolean | `false` | Enable post-generation security audit                                                                                                                                     |
| `--bom-audit-rules-dir`       | string  | —       | Directory containing additional YAML rule files (merged with built-in rules)                                                                                              |
| `--bom-audit-categories`      | string  | all     | Comma-separated list of rule categories to enable. Unknown categories are rejected, and aliases such as `ai-inventory` and `hbom` expand to their built-in category sets. |
| `--bom-audit-min-severity`    | string  | `low`   | Minimum severity to report: `low`, `medium`, `high`                                                                                                                       |
| `--bom-audit-fail-severity`   | string  | `high`  | Severity level at or above which findings cause secure mode failure (e.g., `medium` fails on medium, high, and critical)                                                  |
| `--bom-audit-scope`           | string  | `all`   | Predictive dependency audit target scope: `all` or `required`                                                                                                             |
| `--bom-audit-max-targets`     | number  | auto    | Predictive dependency audit cap. By default cdxgen prioritizes direct runtime and required targets first and expands to at least 50 targets                               |
| `--bom-audit-include-trusted` | boolean | `false` | Include predictive audit targets that already carry trusted publishing metadata                                                                                           |
| `--bom-audit-only-trusted`    | boolean | `false` | Restrict predictive audit targets to trusted-publishing-backed packages only                                                                                              |

## Predictive dependency target selection

When `--bom-audit` is enabled, cdxgen narrows predictive dependency audit targets before cloning upstream repositories:

- packages with trusted publishing metadata (`cdx:cargo:trustedPublishing=true`, `cdx:npm:trustedPublishing=true`, or `cdx:pypi:trustedPublishing=true`) are skipped by default
- `--bom-audit-scope required` keeps only dependencies with CycloneDX `scope=required` (missing scope is treated as required)
- unless you override it, cdxgen caps the predictive dependency audit to `max(50, required-target-count)` and prioritizes direct runtime and required targets first
- explicit `scope=required` and richer `evidence.occurrences` act as prioritization indicators when cdxgen trims the queue
- Cargo runtime-facing crates stay ahead of build-only workspace helper crates when the predictive queue is truncated

Use the trusted-publishing switches to override the default:

- `--bom-audit-include-trusted` includes both trusted-publishing-backed and non-trusted packages
- `--bom-audit-only-trusted` scans only trusted-publishing-backed packages

Passing both trusted switches together is invalid and causes cdxgen to exit with an error.

HBOM-only runs are intentionally different: when `projectType` is `hbom`/`hardware` (or you use the dedicated `hbom` command), cdxgen skips the predictive dependency audit entirely and defaults the audit categories to `hbom-security,hbom-performance,hbom-compliance`.

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
| PKG-007 | high     | Cargo dependency tracks mutable git source without immutable pin  |
| PKG-008 | high     | Cargo dependency uses local path source                           |

### `package-integrity` — Package Integrity and Lifecycle

Rules that detect deprecated, yanked, tampered, or suspicious packages.

| Rule    | Severity | Description                                                               |
| ------- | -------- | ------------------------------------------------------------------------- |
| INT-001 | medium   | npm package has install-time execution hooks                              |
| INT-002 | high     | npm package name or version mismatch (possible dependency confusion)      |
| INT-003 | medium   | Deprecated Go module                                                      |
| INT-004 | high     | Yanked Ruby gem                                                           |
| INT-005 | low      | Deprecated npm package                                                    |
| INT-006 | medium   | Dart pub uses non-default registry                                        |
| INT-007 | low      | Maven package contains shaded/relocated classes                           |
| INT-008 | medium   | README file contains hidden Unicode characters                            |
| INT-009 | critical | npm lifecycle hook contains obfuscated or encoded install-time execution  |
| INT-010 | high     | Cargo crate has been yanked from crates.io                                |
| INT-011 | medium   | Rust project uses Cargo build.rs or native build helpers                  |
| INT-012 | medium   | Rust native build uses mutable Cargo toolchain setup action               |
| INT-013 | medium   | Rust native build is exercised by Cargo workflow build/test/package steps |

### Advanced predictive heuristics

Beyond the YAML rule matches above, the current rollout also adds a small number of deliberately high-signal source heuristics for `cdx-audit` scans:

- **GitHub Actions lateral movement:** downstream `workflow_dispatch` / `repository_dispatch` chains launched from fork-reachable or privileged workflows
- **npm install-time concealment:** base64-decoding or otherwise obfuscated lifecycle hooks, including referenced JS files analyzed through the Babel-based source analyzer
- **PyPI packaging surfaces:** shallow heuristics for suspicious logic in `setup.py` and package `__init__.py`
- **Cargo registry and native build signals:** yanked crates, mutable git/path dependencies, build-only workspace helpers, and Cargo build.rs/native-helper build surfaces
- **Cargo workflow tie-ins:** mutable Cargo setup actions plus Cargo build/test/package/publish workflow steps correlated with native build surfaces

The Python detections are intentionally conservative phase-1 heuristics. They are meant to catch obviously suspicious packaging behavior today while a deeper Python static-analysis path is developed separately.

### `asar-archive` — Electron ASAR release artifact review

Rules that evaluate packaged Electron `.asar` artifacts for dynamic execution, capability overlap, integrity mismatches, nested archive evidence, and Electron signing metadata.

| Rule     | Severity | Description                                                   |
| -------- | -------- | ------------------------------------------------------------- |
| ASAR-001 | high     | Archived JavaScript with eval or dynamic loading              |
| ASAR-002 | high     | Archived JavaScript with network plus file or hardware access |
| ASAR-003 | high     | Declared ASAR integrity mismatch                              |
| ASAR-004 | high     | Embedded npm package with install-time scripts inside ASAR    |
| ASAR-005 | high     | Electron ASAR signing metadata failed verification            |

Notes for reviewers:

- nested archives are surfaced as chained identities such as `outer.asar#/nested/core.asar#/src/main.js`
- archive-internal paths are normalized to forward slashes, even when the outer archive lives on Windows
- `cdx:asar:signingScope=header-only` means Electron signing evidence verifies the ASAR header hash scope, not all packed payload bytes

### `mcp-server` — MCP server exposure and trust posture

Rules that evaluate MCP server inventory emitted from JavaScript/TypeScript source analysis.

| Rule    | Severity | Description                                                             |
| ------- | -------- | ----------------------------------------------------------------------- |
| MCP-001 | critical | Streamable HTTP MCP server exposes tools without authentication         |
| MCP-002 | high     | Streamable HTTP MCP server endpoint is reachable without authentication |
| MCP-003 | medium   | Network-exposed MCP server relies on a non-official SDK or wrapper      |
| MCP-004 | high     | Configured MCP HTTP endpoint lacks any discovered auth posture          |
| MCP-005 | critical | MCP configuration exposes inline credentials                            |
| MCP-006 | high     | MCP configuration suggests confused-deputy risk                         |
| MCP-007 | high     | MCP configuration forwards or passes through bearer-like credentials    |
| MCP-008 | medium   | Build/post-build SBOM includes an MCP configuration file                |

### `ai-agent` — AI agent instruction and MCP governance

Rules that evaluate AI agent instruction files, skill files, and inferred MCP surfaces referenced only from those files.

| Rule    | Severity | Description                                                                    |
| ------- | -------- | ------------------------------------------------------------------------------ |
| AGT-001 | medium   | AI agent instruction or skill file contains hidden Unicode characters          |
| AGT-002 | high     | AI agent instructions reference a public MCP endpoint without auth hints       |
| AGT-003 | medium   | AI agent instructions reference MCP surfaces not otherwise declared in the BOM |
| AGT-004 | high     | AI agent instructions reference tunneled or reverse-proxied MCP exposure       |
| AGT-005 | medium   | AI agent instructions reference non-official MCP wrappers or packages          |
| AGT-006 | critical | AI agent instruction or skill file contains inline credential patterns         |
| AGT-007 | medium   | Build/post-build SBOM includes an AI instruction or skill file                 |

### `ai-inventory` — Umbrella alias for AI inventory review

Use `ai-inventory` with `--bom-audit-categories` when you want one switch that enables both `ai-agent` and `mcp-server` findings for AI instruction files, skill files, MCP configs, and discovered MCP services.

### Standards mapping

The MCP and AI-agent rule sets now carry standards metadata that can be surfaced in audit annotations and downstream compliance workflows. The current mappings focus on:

- **OWASP AI Top 10** for plugin, agency, and supply-chain exposure themes
- **NIST AI RMF** for governance, mapping, and risk-management review flows
- **NIST SSDF** for provenance, interface hardening, and automation/build instruction review

Typical reviewer use:

- **acceptable** — localhost-only, official SDK or config, explicit auth posture, no inline credentials
- **needs review** — public endpoint references, non-official wrappers, tunneled exposure, or undeclared MCP/config references
- **block** — inline credentials, unauthenticated public MCP endpoints, or confused-deputy / token-passthrough indicators

Treat these mappings as reviewer guidance rather than a full certification crosswalk.

### `obom-runtime` — Operational Runtime and Host Posture

Rules that evaluate OBOM runtime components from osquery-derived host telemetry for persistence, endpoint control gaps, suspicious startup/runtime behavior, Linux GTFOBins-enriched activity, hardening drift, and Windows LOLBAS / ATT&CK-aligned abuse patterns.

Recent additions broaden the Linux and trust-aware host coverage:

- live Linux GTFOBins enrichment is applied to osquery runtime rows such as sudo executions, privilege transitions, elevated processes, and privileged listeners
- Linux hardening checks review dedicated `sysctl_hardening` and `mount_hardening` query-pack entries inspired by Lynis and CIS baselines
- trustinspector-backed properties such as `cdx:windows:authenticode:*`, `cdx:windows:wdac:*`, and `cdx:darwin:notarization:*` are used directly in the built-in rules

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
| OBOM-LNX-014 | critical | Linux reverse shell behavior detected in live process telemetry      |
| OBOM-LNX-015 | high     | Linux process uses LD_PRELOAD from writable or temporary path        |
| OBOM-LNX-016 | high     | Linux cron entry fetches remote content or runs from writable path   |
| OBOM-LNX-017 | medium   | Linux sysctl posture diverges from common hardening baseline         |
| OBOM-LNX-018 | high     | Linux temporary mount is missing key hardening flags                 |
| OBOM-LNX-019 | high     | Live Linux runtime artifact matches GTFOBins execution helper        |
| OBOM-WIN-001 | high     | Windows drive without BitLocker protection                           |
| OBOM-WIN-002 | high     | Windows Security Center unhealthy state                              |
| OBOM-WIN-003 | critical | Windows Run key references temporary/script execution path           |
| OBOM-WIN-004 | high     | Hidden scheduled task uses suspicious execution path                 |
| OBOM-WIN-005 | critical | Auto-start Windows service points to user-writable path              |
| OBOM-WIN-006 | high     | Windows persistence surface references LOLBAS execution helper       |
| OBOM-WIN-007 | critical | Windows WMI or AppCompat persistence uses LOLBAS                     |
| OBOM-WIN-008 | high     | Windows startup or process activity uses network-capable LOLBAS      |
| OBOM-WIN-009 | critical | Network-facing Windows listener is a LOLBAS execution helper         |
| OBOM-WIN-010 | critical | Windows persistence artifact uses LOLBAS with UAC-bypass context     |
| OBOM-WIN-011 | high     | Windows Public profile inbound firewall allow rule                   |
| OBOM-WIN-012 | critical | Windows startup or listener binary has invalid Authenticode status   |
| OBOM-WIN-013 | high     | Windows host has no active WDAC policies                             |
| OBOM-MAC-001 | high     | macOS firewall disabled or stealth mode off                          |
| OBOM-MAC-002 | critical | macOS launchd item from user-writable temporary path                 |
| OBOM-MAC-003 | medium   | macOS firewall exception for binary in untrusted user path           |
| OBOM-MAC-004 | medium   | macOS launchd override disables Apple-managed service                |
| OBOM-MAC-005 | high     | macOS Gatekeeper enforcement is disabled or weakened                 |
| OBOM-MAC-006 | medium   | macOS running app launches from Downloads, Desktop, or temp path     |
| OBOM-MAC-007 | high     | macOS startup or application artifact failed notarization assessment |

### `hbom-security`, `hbom-performance`, `hbom-compliance` — Hardware inventory review

Rules that evaluate CycloneDX HBOMs generated by `cdxgen -t hbom` (or the dedicated `hbom` command output when later passed to `cdx-audit`) for hardware security posture, performance degradation signals, and governance completeness.

When you run `cdxgen -t hbom --bom-audit` without specifying categories, cdxgen automatically enables:

- `hbom-security`
- `hbom-performance`
- `hbom-compliance`

You can also use the alias `hbom` with `--bom-audit-categories` to enable the full HBOM review pack in one switch.

#### `hbom-security` — Hardware security posture

| Rule    | Severity | Description                                                    |
| ------- | -------- | -------------------------------------------------------------- |
| HBS-001 | high     | Storage component is explicitly unencrypted                    |
| HBS-002 | high     | Connected wireless adapter uses weak or missing link security  |
| HBS-003 | high     | Removable storage is attached without encryption or lock proof |
| HBS-004 | medium   | HBOM exposes raw hardware identifiers                          |

Typical reviewer actions:

- enable or verify disk / volume encryption before distributing the host
- remove or re-baseline removable media that is attached without lock or encryption assurance
- move wireless links to WPA2/WPA3-class protections and confirm SSID policy
- share redacted HBOMs externally unless raw identifiers are explicitly required

#### `hbom-performance` — Hardware capacity and degradation signals

| Rule    | Severity | Description                                                    |
| ------- | -------- | -------------------------------------------------------------- |
| HBP-001 | medium   | Storage volume has low free capacity headroom                  |
| HBP-002 | high     | Storage health is degraded or wear is near exhaustion          |
| HBP-003 | high     | Thermal zone reports sustained high temperature                |
| HBP-004 | medium   | Battery health is degraded                                     |
| HBP-005 | medium   | Active wired link is operating below expected duplex/bandwidth |
| HBP-006 | high     | Installed memory is only partially online                      |

Typical reviewer actions:

- free storage or relocate logs/caches before patching, indexing, or builds begin to fail
- replace worn SSDs or failing storage before latency-sensitive workloads degrade further
- inspect cooling, dust, fan policy, and workload placement when thermal zones stay hot
- replace batteries or adjust charging policy for mobile devices with poor health
- investigate link negotiation, cabling, switch policy, and memory-online drift before blaming application performance alone

#### `hbom-compliance` — Governance and evidence completeness

| Rule    | Severity | Description                                         |
| ------- | -------- | --------------------------------------------------- |
| HBC-001 | medium   | HBOM inventory lacks firmware or board provenance   |
| HBC-002 | medium   | Managed asset identity is incomplete                |
| HBC-003 | medium   | HBOM collector evidence is incomplete               |
| HBC-004 | medium   | Storage inventory lacks encryption posture evidence |
| HBC-005 | medium   | HBOM uses non-redacted identifier policy            |

These rules are mapped where practical to common governance references such as:

- **NIST SP 800-53** (`CM-8`, `SC-28`, `SI-7`)
- **CIS Controls v8** asset inventory, removable-media, and encryption expectations
- **ISO/IEC 27001** inventory and cryptography controls

Typical reviewer actions:

- confirm that CMDB / asset-management fields can reconcile the HBOM to the physical device
- preserve collector command evidence so the inventory is reproducible during audit or incident review
- capture explicit storage encryption posture for governed devices
- prefer redacted identifier policy for broadly shared BOMs

### `rootfs-hardening` — Offline host and golden-image hardening review

Rules that evaluate reconstructed root filesystems, mounted images, and other offline host snapshots for repository trust, privileged helpers, stale trust anchors, and suspicious service definitions.

Use this category when you want image-baseline checks that do not depend on live osquery collection.

Generated image and rootfs BOMs also carry `cdx:container:unpackagedExecutableCount` and `cdx:container:unpackagedSharedLibraryCount` metadata properties, plus a metadata annotation sentence summarizing the same counts. These counts track executable and shared-library file components discovered from `collectExecutables()` and `collectSharedLibs()` after OS package ownership has been excluded.

| Rule    | Severity | Description                                                     |
| ------- | -------- | --------------------------------------------------------------- |
| RFS-001 | high     | Enabled OS repository uses plaintext HTTP transport             |
| RFS-002 | critical | YUM repository has package signature checks disabled            |
| RFS-003 | high     | Offline trust anchor is marked expired                          |
| RFS-004 | critical | Offline image retains setuid GTFOBins execution helper          |
| RFS-005 | critical | Offline service executes from writable or temporary path        |
| RFS-006 | high     | Offline service pre-start step fetches or shells remote content |

### `container-risk` — Container Escape, Privilege, and Post-Exploit Tooling

Rules that evaluate collected container executables against GTFOBins-derived enrichment plus MITRE ATT&CK for Containers, Peirates/CDK/DEEPCE playbook knowledge, and Docker seccomp guidance to highlight container breakout helpers, privileged execution primitives, offensive toolkits, and seccomp-sensitive escape helpers.

When a finding or count summary needs manual follow-up, import the BOM into `cdxi` and pivot with `.unpackagedbins` or `.unpackagedlibs` to inspect only the native file components that were not matched to OS package ownership.

| Rule    | Severity | Description                                                         |
| ------- | -------- | ------------------------------------------------------------------- |
| CTR-001 | critical | Container image ships setuid/setgid GTFOBins execution primitive    |
| CTR-002 | critical | Container image includes privileged container-escape helper         |
| CTR-003 | high     | Container image includes privileged GTFOBins library-load primitive |
| CTR-004 | high     | Container image retains privileged GTFOBins exfiltration primitive  |
| CTR-005 | medium   | Container image includes mutable-path remote-execution helper       |
| CTR-006 | high     | Container image ships dedicated offensive container toolkit         |
| CTR-007 | medium   | Container image includes seccomp-sensitive namespace escape helper  |

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
| `$auditServices(bom)`         | Return a deduplicated array of top-level BOM services                                                                    | `$auditServices($)[$contains($safeStr($prop($, 'cdx:service:ExecStart')), '/tmp/')]` |
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

**Q: What are the limitations of `--bom-audit --dry-run`?**

Dry-run BOM audit is intentionally conservative:

1. formulation findings are complete only to the extent that the generated BOM captured the relevant metadata
2. predictive dependency audit is limited to candidate-target planning
3. registry metadata enrichment, upstream repository cloning, and child SBOM generation are skipped
4. categories that depend heavily on predictive upstream inspection—especially parts of `package-integrity`—will produce fewer findings than a normal run

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

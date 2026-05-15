# Architecture Under Secure Mode and Dry-Run Mode

This page complements [Architecture Overview](ARCHITECTURE.md) by explaining how cdxgen behaves differently when secure mode or dry-run mode is enabled. The goal is not to repeat the user-facing CLI help, but to show contributors which architectural responsibilities change under those execution constraints.

For operator-focused details such as environment variables, permission flags, and examples, read [Permissions](PERMISSIONS.md) and [CLI Usage](CLI.md).

## Why this matters

The default architecture description assumes cdxgen can read project files, write outputs, create temp directories, and spawn ecosystem tools when needed. Secure mode and dry-run mode change those assumptions in different ways.

| Mode | Primary effect on architecture |
|---|---|
| secure mode | hardens execution and narrows the operations the process should be allowed to perform |
| dry-run mode | turns the run into a read-only planning and inspection pass that records blocked side effects |
| secure mode + dry-run mode | combines hardened execution guidance with a read-only execution model |

## Mental model

```text
normal run
   |
   +--> read inputs
   +--> spawn tools when needed
   +--> create temp files
   +--> write outputs

secure mode
   |
   +--> read inputs with explicit permission boundaries
   +--> reduce or gate risky operations
   +--> require allowlists for sensitive command, path, and host access

dry-run mode
   |
   +--> read inputs
   +--> block writes, clones, and child processes
   +--> record what would have happened
```

## What changes in secure mode

Secure mode is primarily about trust boundaries. Contributors should think of it as an architectural constraint on side effects, not as a different BOM pipeline.

### Practical architecture shifts

| Layer or responsibility | Normal behavior | Secure-mode behavior |
|---|---|---|
| CLI and env setup | derives `options` and runs normally | also guides permission setup through `CDXGEN_SECURE_MODE` and Node permission expectations |
| pre-generation setup | may prepare SDKs or installations | automatic installs are reduced or disabled by policy |
| helper wrappers | may access filesystem, commands, or network through the normal guarded helpers | must also respect allowlists such as `CDXGEN_ALLOWED_COMMANDS`, `CDXGEN_ALLOWED_PATHS`, and `CDXGEN_ALLOWED_HOSTS` where applicable |
| ecosystem execution | can spawn package-manager commands when needed | package-manager execution must fit the active permission model and may be intentionally skipped |
| submission and remote access | allowed when configured | outbound hosts are checked against the secure-mode host policy before submission paths continue |

### Contributor takeaway

When adding a feature that executes commands, reads unusual filesystem locations, or calls remote services, document and design the feature as if secure mode is a first-class execution path.

## What changes in dry-run mode

Dry-run mode changes the architecture more visibly because it blocks side effects while still exercising much of the discovery pipeline.

### Practical architecture shifts

| Layer or responsibility | Normal behavior | Dry-run behavior |
|---|---|---|
| source and manifest discovery | reads project files and continues into generation | still reads files and records the discovery activity |
| temp directories and extraction | can create temp content for archives or helper flows | blocked or reduced to planning-only behavior |
| child-process execution | package-manager and helper commands may run | blocked and reported in the activity summary |
| git / purl source acquisition | may clone or resolve source repositories | blocked after planning the action |
| output and export | may write CycloneDX, SPDX, protobuf, signatures, and submission requests | blocked from persisting outputs or submission side effects |
| BOM audit | can run direct and predictive flows fully | keeps the in-memory formulation audit, but predictive child-SBOM work is reduced to target planning |

### Activity-summary architecture

In dry-run mode, the activity log becomes part of the effective architecture because it explains the decisions and blocked work that a normal run would perform implicitly.

## Secure mode and dry-run mode together

These modes overlap, but they are not the same.

| Question | Secure mode | Dry-run mode |
|---|---|---|
| Is the run read-only? | not necessarily | yes |
| Are child processes blocked by design? | not necessarily, but tightly constrained | yes |
| Do permission and allowlist boundaries matter? | yes | yes, but many side effects are blocked earlier anyway |
| Is the final output meant for persistence? | yes, when the permissions allow it | no, the run is primarily an inspection/planning pass |

One useful contributor rule is this: secure mode asks _"should this operation be allowed?"_ while dry-run mode asks _"what would happen if this operation were allowed?"_

## Design guidance for contributors

1. thread intent through `options` rather than reading CLI state deep in helpers
2. prefer the existing safe wrappers so allowlists and activity recording stay centralized
3. decide explicitly whether a feature should be blocked, degraded, or planned-only in dry-run mode
4. document secure-mode implications when a feature adds command execution, temp files, host access, or writes
5. add or update tests when execution-mode behavior changes

## Where to document future execution-mode changes

| Change type | Best place to document it |
|---|---|
| user-facing flag behavior | `CLI.md` or `PERMISSIONS.md` |
| trust boundary or permission guidance | `PERMISSIONS.md` or `THREAT_MODEL.md` |
| contributor-facing architectural impact | this page and `ARCHITECTURE.md` |
| dry-run audit behavior | `BOM_AUDIT.md` |
| HBOM-specific execution differences | `HBOM.md` and `PERMISSIONS.md` |

## Related pages

- [Architecture Overview](ARCHITECTURE.md)
- [BOM Generation Pipeline](BOM_PIPELINE.md)
- [Permissions](PERMISSIONS.md)
- [CLI Usage](CLI.md)
- [BOM Audit](BOM_AUDIT.md)
- [Threat Model](THREAT_MODEL.md)

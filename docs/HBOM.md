# HBOM Generation

## Overview

`cdxgen` now ships a dedicated `hbom` command for generating a CycloneDX **Hardware Bill of Materials (HBOM)** for the current host.

The command dynamically loads the optional [`@cdxgen/cdx-hbom`](https://www.npmjs.com/package/@cdxgen/cdx-hbom) library only when HBOM generation is requested, so normal SBOM workflows stay unchanged.

## Supported targets

Current hardware collectors come from `@cdxgen/cdx-hbom` and support:

- `darwin/arm64` (Apple Silicon macOS)
- `linux/amd64`
- `linux/arm64`

## Commands

Use the dedicated command when you want a host hardware inventory:

```shell
hbom -o hbom.json
```

You can also access the same integration through the main CLI:

```shell
cdxgen -t hbom -o hbom.json .
```

> `hbom` / `hardware` must **not** be mixed with software project types such as `js`, `java`, `python`, `os`, or `oci` in the same invocation.

If you want a combined hardware + runtime host document, use the dedicated merged-host option instead of mixing project types manually:

```shell
hbom --include-runtime -o host-view.json
```

To focus only on missing native utilities and permission-sensitive enrichments, use the dedicated diagnostics subcommand:

```shell
hbom diagnostics
hbom diagnostics --input hbom.json
```

## Common options

| Option                    | Purpose                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `-o, --output <file>`     | Write the generated HBOM to a file. Default: `hbom.json`                                                                     |
| `-p, --print`             | Print the generated HBOM to stdout instead of writing a file                                                                 |
| `--pretty`                | Pretty-print JSON output                                                                                                     |
| `--validate`              | Validate the generated HBOM using the CycloneDX schema                                                                       |
| `--dry-run`               | Generate a read-only partial HBOM, block collector commands and writes, and report the attempted activity                    |
| `--include-runtime`       | Collect an OBOM runtime inventory alongside the HBOM and emit a merged host view with strict topology links                  |
| `--platform <value>`      | Override platform detection                                                                                                  |
| `--arch <value>`          | Override architecture detection                                                                                              |
| `--sensitive`             | Include raw identifiers instead of redacted defaults                                                                         |
| `--no-command-enrichment` | Disable optional command-based enrichment                                                                                    |
| `--privileged`            | Enable privileged Linux enrichment and allow documented permission-sensitive commands to retry via non-interactive `sudo -n` |
| `--plist-enrichment`      | Enable extra Darwin plist-based enrichment                                                                                   |
| `--strict`                | Fail instead of returning partial results when enrichment fails                                                              |
| `--timeout <ms>`          | Per-command timeout. Increase this on slower hosts such as Raspberry Pi systems                                              |

## Examples

Generate a local HBOM file:

```shell
hbom -o hbom.json
```

Generate a merged host view that keeps HBOM hardware inventory and OBOM runtime evidence in a single CycloneDX document:

```shell
hbom --include-runtime -o host-view.json
```

Use a larger timeout on slower arm64 hosts when command-based collection needs more time:

```shell
hbom --include-runtime --timeout 180000 -o host-view.json
```

Print the generated document to stdout:

```shell
hbom -p
```

Review a read-only partial HBOM and the exact blocked collector commands without writing an output file:

```shell
hbom --dry-run
```

Collect Linux SMBIOS enrichment when you already have the required privileges:

```shell
hbom --platform linux --arch amd64 --privileged -o linux-hbom.json
```

Run a focused diagnostic pass to identify missing Linux utilities and permission-denied enrichments before deciding whether you need `--privileged`:

```shell
hbom diagnostics
```

Review an existing HBOM file and summarize the serialized collector diagnostics without touching the live host again:

```shell
hbom diagnostics --input hbom.json
```

Enable Darwin plist enrichment on Apple Silicon:

```shell
hbom --platform darwin --arch arm64 --plist-enrichment -o mac-hbom.json
```

Generate an HBOM and immediately audit it with the built-in hardware rules:

```shell
cdxgen -t hbom -o hbom.json --bom-audit .
```

Generate a merged host view and include the new topology-aware host audit rules by default:

```shell
cdxgen -t hbom --include-runtime -o host-view.json --bom-audit .
```

Audit only the security-oriented HBOM findings:

```shell
cdxgen -t hbom -o hbom.json --bom-audit --bom-audit-categories hbom-security .
```

## HBOM audit categories

When you run `cdxgen -t hbom --bom-audit` without specifying categories, cdxgen automatically enables the three built-in HBOM review packs:

- `hbom-security` — encryption, removable media, weak wireless security, and raw identifier exposure
- `hbom-performance` — storage headroom, storage wear/health, thermal pressure, battery degradation, wired-link negotiation, and memory-online drift
- `hbom-compliance` — asset identity completeness, firmware/board provenance, collector evidence completeness, storage encryption evidence, and identifier-policy governance
  - including command-diagnostic checks for missing native utilities and permission-denied enrichments that should be rerun with `--privileged` only where policy allows

When you add `--include-runtime`, cdxgen also enables:

- `host-topology` — higher-confidence findings derived from strict HBOM ↔ OBOM topology links such as live runtime addresses attached to weak wireless or degraded wired links, mounted storage devices with degraded health, and explicit Secure Boot trust anchors tied to runtime certificate evidence

You can also use `--bom-audit-categories hbom` as a shorthand alias for the three HBOM-only packs, or `--bom-audit-categories host` for `hbom-security,hbom-performance,hbom-compliance,host-topology`.

## Merged host topology model

`--include-runtime` does **not** guess relationships. Instead, cdxgen only emits cross-domain links when it has explicit evidence such as:

- an HBOM network interface name that exactly matches OBOM `interface_addresses.interface`
- an HBOM NIC driver that exactly matches an OBOM `kernel_modules` entry
- exact identifier-bearing storage fields such as device nodes, volume UUIDs, mount paths, or logical-drive identifiers when both HBOM and OBOM expose the same stable value
- explicit Secure Boot trust identifiers such as certificate fingerprints, subject-key IDs, serials, or paths when HBOM metadata and OBOM `secureboot_certificates` expose the same value

The merged document adds:

- deterministic synthetic `bom-ref` values for HBOM components that previously lacked them
- host/root dependency edges from `metadata.component` to hardware components
- strict hardware → runtime dependency edges when exact matches exist
- strict host → Secure Boot trust dependency edges when HBOM metadata exposes exact Secure Boot identifiers that match runtime certificate evidence
- summary properties such as `cdx:hostview:mode`, `cdx:hostview:topologyLinkCount`, `cdx:hostview:linkedHardwareComponentCount`, and `cdx:hostview:linkedRuntimeCategory`
- per-component properties such as `cdx:hostview:interface_addresses:count`, `cdx:hostview:kernel_modules:count`, `cdx:hostview:mount_hardening:count`, and `cdx:hostview:runtime-storage:count` on linked interfaces or storage devices

This gives you a dependency tree and audit surface that are topology-aware without introducing speculative joins.

## Dry-run behavior

HBOM dry-run is handled natively by `@cdxgen/cdx-hbom`.

- `hbom --dry-run` and `cdxgen --dry-run -t hbom` still build a **read-only partial HBOM** when the collector can rely on local file- or native API-backed discovery.
- Command-based enrichment is blocked and reported per command in the activity summary, so you can see the exact planned hardware probes such as `sysctl`, `system_profiler`, `networksetup`, `pmset`, or `dmidecode`.
- Filesystem writes remain blocked, so dry-run is safe for review-first workflows.
- Because command execution is intentionally skipped, some command-derived hardware details may remain `unknown` or be absent until you rerun without `--dry-run`.

## Collector diagnostics and summary properties

`@cdxgen/cdx-hbom` 0.4.0 records Linux command failures such as missing native utilities and permission-denied enrichments in the BOM root as serialized evidence properties:

- `cdx:hbom:evidence:commandDiagnosticCount`
- repeated `cdx:hbom:evidence:commandDiagnostic` JSON values

cdxgen now adds a compact set of derived summary properties so audit rules and automation do not need to parse the raw JSON strings themselves:

- `cdx:hbom:analysis:commandDiagnosticCount`
- `cdx:hbom:analysis:actionableDiagnosticCount`
- `cdx:hbom:analysis:missingCommandCount`
- `cdx:hbom:analysis:missingCommands`
- `cdx:hbom:analysis:missingCommandIds`
- `cdx:hbom:analysis:installHintCount`
- `cdx:hbom:analysis:permissionDeniedCount`
- `cdx:hbom:analysis:permissionDeniedCommands`
- `cdx:hbom:analysis:permissionDeniedIds`
- `cdx:hbom:analysis:privilegeHintCount`
- `cdx:hbom:analysis:partialSupportIds`
- `cdx:hbom:analysis:timeoutIds`
- `cdx:hbom:analysis:commandErrorIds`
- `cdx:hbom:analysis:requiresPrivileged`

Use these in combination with `hbom diagnostics` and the `hbom-compliance` audit pack to decide whether you need to install missing host packages, accept a partial BOM, or rerun with `--privileged`.

If you import the resulting BOM into `cdxi`, the most useful host pivots for the richer 0.4.0 surface are:

- `.hbomdiagnostics` — parsed missing-command / permission-denied entries with install and privilege hints
- `.hbomfirmware` — firmware, board, TPM, and update-managed component pivots
- `.hbombuses` — USB, PCI, display-link, and external-expansion security pivots
- `.hbompower` — design-capacity and runtime power telemetry pivots

## Validation and safety notes

- HBOM generation currently targets **CycloneDX 1.7**.
- By default, the collector redacts sensitive identifiers such as serial numbers and MAC addresses where appropriate.
- Use `--sensitive` only when you explicitly need raw identifiers in the resulting BOM.
- Linux `--privileged` enrichment may require root or passwordless sudo depending on the target environment.
- Prefer `hbom diagnostics` before enabling `--privileged` broadly so you can see exactly which enrichments failed due to missing commands or permissions.
- In `--dry-run` mode, cdxgen returns a partial HBOM from safe local discovery where available, reports each blocked HBOM command in the activity summary, and still skips filesystem writes.

## When to use HBOM vs OBOM

Use **HBOM** when your goal is to inventory the hardware that makes up a host.

Use **OBOM** when your goal is to inventory the running operating system, runtime posture, trust state, services, packages, persistence signals, and other operational artifacts.

In practice:

- `hbom` → hardware-centric host inventory
- `hbom --include-runtime` → merged host inventory with strict hardware/runtime topology links
- `obom` / `cdxgen -t os` → operational/runtime host inventory

# HBOM Generation

## Overview

`cdxgen` now ships a dedicated `hbom` command for generating a CycloneDX **Hardware Bill of Materials (HBOM)** for the current host.

The command dynamically loads the optional [`@cdxgen/cdx-hbom`](https://www.npmjs.com/package/@cdxgen/cdx-hbom) library only when HBOM generation is requested, so normal SBOM workflows stay unchanged.

If you prefer a single-file release asset instead of an npm installation, GitHub Releases now also publish dedicated `hbom-<os>-<arch>` and `hbom-<os>-<arch>-slim` executables. The standard `hbom` release bundles both `@cdxgen/cdx-hbom` and the platform-matching `@cdxgen/cdxgen-plugins-bin*` companion helpers, while `hbom-slim` keeps only `@cdxgen/cdx-hbom`.

## Supported targets

Current hardware collectors come from `@cdxgen/cdx-hbom` and support:

- `darwin/arm64` (Apple Silicon macOS)
- `linux/amd64`
- `linux/arm64`
- `windows/amd64` and `windows/arm64` (needs `@cdxgen/cdx-hbom` 0.6.0 or later and the Windows PowerShell 5.1 that ships with Windows; verified on Windows 11 and on Windows Server 2025)

Each collector runs only on a host of its own operating system, so run `hbom` on the machine you want to inventory. On Windows the architecture comes from `Win32_Processor` and not from the Node.js process: an x64 Node.js running under emulation on an ARM64 PC still reports `arm64`, and `cdx:hbom:collectorProcessArchitecture` records the process architecture when it differs.

## Commands

Use the dedicated command when you want a host hardware inventory:

```shell
hbom -o hbom.json
hbom -o hbom.json --export-proto --proto-bin-file hbom.cdx
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
hbom diagnostics --input hbom.cdx
```

## Common options

| Option                    | Purpose                                                                                                                                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-o, --output <file>`     | Write the generated HBOM to a file. Default: `hbom.json`                                                                                                                                                                                                                                      |
| `--export-proto`          | Also serialize the generated HBOM as CycloneDX protobuf binary                                                                                                                                                                                                                                |
| `--proto-bin-file <file>` | Path for the protobuf sidecar when `--export-proto` is enabled. Default: `hbom.cdx`                                                                                                                                                                                                           |
| `-p, --print`             | Print the generated HBOM to stdout instead of writing a file                                                                                                                                                                                                                                  |
| `--pretty`                | Pretty-print JSON output                                                                                                                                                                                                                                                                      |
| `--validate`              | Validate the generated HBOM using the CycloneDX schema                                                                                                                                                                                                                                        |
| `--dry-run`               | Generate a read-only partial HBOM, block collector commands and writes, and report the attempted activity                                                                                                                                                                                     |
| `--include-runtime`       | Collect an OBOM runtime inventory alongside the HBOM and emit a merged host view with strict topology links                                                                                                                                                                                   |
| `--platform <value>`      | Override platform detection (`linux`, `darwin`, `windows` or `win32`)                                                                                                                                                                                                                         |
| `--arch <value>`          | Override architecture detection                                                                                                                                                                                                                                                               |
| `--sensitive`             | Include raw identifiers instead of redacted defaults                                                                                                                                                                                                                                          |
| `--no-command-enrichment` | Disable optional command-based enrichment. Linux then runs no command, Windows still runs the `windows-cim-platform` batch, and the Darwin collector ignores the option                                                                                                                       |
| `--privileged`            | Enable privileged enrichment. Linux: privileged enrichment and non-interactive `sudo -n` retries for documented commands. Windows: the TPM, BitLocker, storage-reliability and Secure Boot batch, which an already-elevated session can read (HBOM never prompts for UAC). No effect on macOS |
| `--plist-enrichment`      | Enable extra plist-based enrichment. Darwin only; ignored on Linux and Windows                                                                                                                                                                                                                |
| `--strict`                | Fail instead of returning partial results when enrichment fails                                                                                                                                                                                                                               |
| `--timeout <ms>`          | Per-command timeout. Increase this on slower hosts such as Raspberry Pi systems. On Windows it replaces the per-batch defaults (60 s per CIM batch, 90 s for `windows-pnp-devices`)                                                                                                           |

## Examples

Generate a local HBOM file:

```shell
hbom -o hbom.json
hbom -o hbom.json --export-proto --proto-bin-file hbom.cdx
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

On Windows, start the shell with **Run as administrator** and add `--privileged` to include the TPM, BitLocker, storage-reliability and Secure Boot data. Without administrator rights the same command still succeeds and records `permission-denied` diagnostics for those items:

```shell
hbom --privileged -o hbom.json
```

Run a focused diagnostic pass to identify missing utilities and permission-denied enrichments before deciding whether you need `--privileged`:

```shell
hbom diagnostics
```

Review an existing HBOM file and summarize the serialized collector diagnostics without touching the live host again:

```shell
hbom diagnostics --input hbom.json
hbom diagnostics --input hbom.cdx
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

## Permissions

Run `hbom` as a normal local user: that gives almost the whole hardware inventory on every supported operating system. Elevation adds a few security- and health-related details, and HBOM never asks for it: there is no `sudo` password prompt and no UAC prompt.

| Platform | Normal user, local session                                             | Administrator or root                                                                                                     | Non-administrator over SSH or WinRM                         |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| macOS    | Full inventory                                                         | Nothing extra                                                                                                             | Not measured; expected to match a local session             |
| Linux    | `/proc` and `/sys` baseline plus the optional tools that are installed | `--privileged` runs `dmidecode` and retries `drm_info` with non-interactive `sudo -n`                                     | Not measured; expected to match a local session             |
| Windows  | Nearly everything                                                      | `--privileged` adds TPM details, BitLocker status, the firmware-confirmed Secure Boot state and disk reliability counters | Every WMI query is denied, so only the baseline is produced |

See [Permissions](PERMISSIONS.md#hbom-permissions) for the three Windows session types, the diagnostics each one records, and how to recover from a denied session.

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
- on Windows, a storage volume's drive letter (`cdx:hbom:mountPoint`, for example `C:`) that exactly matches an OBOM `logical_drives.device_id`; the Windows osquery pack has no `interface_addresses`, `mount_hardening` or `secureboot_certificates`, so drive letters are the strict join available there
- explicit Secure Boot trust identifiers such as certificate fingerprints, subject-key IDs, serials, or paths when HBOM metadata and OBOM `secureboot_certificates` expose the same value

The merged document adds:

- deterministic synthetic `bom-ref` values for HBOM components that previously lacked them
- host/root dependency edges from `metadata.component` to hardware components
- strict hardware → runtime dependency edges when exact matches exist
- strict host → Secure Boot trust dependency edges when HBOM metadata exposes exact Secure Boot identifiers that match runtime certificate evidence
- summary properties such as `cdx:hostview:mode`, `cdx:hostview:topologyLinkCount`, `cdx:hostview:linkedHardwareComponentCount`, and `cdx:hostview:linkedRuntimeCategory`
- per-component properties such as `cdx:hostview:interface_addresses:count`, `cdx:hostview:kernel_modules:count`, `cdx:hostview:mount_hardening:count`, `cdx:hostview:runtime-storage:count`, and `cdx:hostview:logical_drives:count` on linked interfaces or storage devices

This gives you a dependency tree and audit surface that are topology-aware without introducing speculative joins.

## Dry-run behavior

HBOM dry-run is handled natively by `@cdxgen/cdx-hbom`.

- `hbom --dry-run` and `cdxgen --dry-run -t hbom` still build a **read-only partial HBOM** when the collector can rely on local file- or native API-backed discovery.
- Command-based enrichment is blocked and reported per command in the activity summary, so you can see the exact planned hardware probes such as `sysctl`, `system_profiler`, `networksetup`, `pmset`, `dmidecode`, or, on Windows, the `powershell.exe` batches.
- On Windows each planned batch is reported by its command id (`windows-cim-platform`, `windows-cim-storage-network`, `windows-cim-display-media`, `windows-pnp-devices`, `windows-cim-trust`, and `windows-cim-privileged` with `--privileged`) and a short `script sha256:<12 hex>` target, never the script text. The BOM holds only the Node baseline (processor and memory), and no PowerShell process is started. The full single-line scripts are in `getCommandPlan({ platform: "win32" })` from `@cdxgen/cdx-hbom`.
- When secure mode is enabled **and** you configure `CDXGEN_ALLOWED_COMMANDS` and/or `CDXGEN_ALLOWED_PATHS`, cdxgen reuses the same HBOM dry-run declaration as a preflight plan and aborts the live run before host probing continues if the declared commands or paths fall outside those allowlists.
- Filesystem writes remain blocked, so dry-run is safe for review-first workflows.
- Because command execution is intentionally skipped, some command-derived hardware details may remain `unknown` or be absent until you rerun without `--dry-run`.

### Secure-mode allowlist workflow

For hardened host collection:

1. Run `hbom --dry-run` first and review the declared commands and filesystem paths.
2. Set `CDXGEN_ALLOWED_COMMANDS` to the approved HBOM probe commands for that target.
3. Set `CDXGEN_ALLOWED_PATHS` when you want to constrain HBOM file-backed discovery to explicit host locations.
4. Rerun the live command with `CDXGEN_SECURE_MODE=true`.

On Linux hosts, the path allowlist normally needs at least the relevant system inventory roots such as `/proc`, `/sys`, and `/etc` for the hardware surfaces you intend to collect. On Apple Silicon macOS, command allowlists are usually the primary secure-mode control unless you also enable plist-backed enrichment.

On Windows the collector reads no files, so no path allowlist is needed. Every batch is run by the built-in Windows PowerShell, so allowlist `powershell.exe`:

```powershell
$env:CDXGEN_SECURE_MODE = "true"
$env:CDXGEN_ALLOWED_COMMANDS = "powershell.exe"
hbom -o hbom.json
```

An entry matches either the exact command or its file name, and the comparison is case-sensitive, as it is inside `@cdxgen/cdx-hbom`: `powershell.exe` and the full path exactly as the preflight message prints it both work, while `PowerShell.exe` does not. `--no-command-enrichment` does not remove the need, because `windows-cim-platform` always runs. Because `@cdxgen/cdx-hbom` applies `CDXGEN_ALLOWED_COMMANDS` again when it starts a process, an allowlist without `powershell.exe` also blocks collection outside secure mode: every batch fails with a `command-error` diagnostic (`Command blocked by allowlist`) and the BOM contains only the baseline.

With `@cdxgen/cdx-hbom`, privileged Linux enrichment can also declare a non-interactive `sudo -n` retry path for specific commands such as `drm_info`. When you enable `--privileged` in secure mode, include `sudo` in `CDXGEN_ALLOWED_COMMANDS` if you want that hardened retry path to remain available.

## Collector diagnostics and summary properties

`@cdxgen/cdx-hbom` records command failures such as missing native utilities and permission-denied enrichments in the BOM root as serialized evidence properties (Linux commands since 0.4.0, and the Windows CIM batches since 0.6.0):

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

On Windows the diagnostic ids are `<command id>:<result key>` for one denied class, for example `windows-cim-privileged:tpm`, and `windows-cim-platform:network-logon` for a session whose WMI queries were all denied. The issue vocabulary is the same (`permission-denied`, `partial-support`, `timeout`, `missing-command`, `command-error`), so the `cdx:hbom:analysis:*` properties and the audit rules read Windows BOMs without changes. `hbom diagnostics` prints the Windows recovery steps for a Windows BOM.

If you import the resulting BOM into `cdxi`, the most useful host pivots for the richer 0.4.0 surface are:

- `.hbomdiagnostics` — parsed missing-command / permission-denied entries with install and privilege hints
- `.hbomfirmware` — firmware, board, TPM, and update-managed component pivots
- `.hbombuses` — USB, PCI, display-link, and external-expansion security pivots
- `.hbompower` — design-capacity and runtime power telemetry pivots

## Validation and safety notes

- HBOM generation writes **CycloneDX 1.7**; `cdxgen -t hbom --spec-version 2.0` writes **2.0** (see [CycloneDX 2.0 output](#cyclonedx-20-output)). The `hbom` command supports 1.7 only.
- By default, the collector redacts sensitive identifiers such as serial numbers and MAC addresses where appropriate.
- Use `--sensitive` only when you explicitly need raw identifiers in the resulting BOM.
- Linux `--privileged` enrichment may require root or passwordless sudo depending on the target environment.
- Windows `--privileged` needs an already-elevated session (**Run as administrator**). HBOM never requests elevation and never starts `sudo.exe`; without administrator rights it records `permission-denied` diagnostics and still returns a BOM.
- If Constrained Language Mode, AppLocker or WDAC restricts PowerShell, the collector still runs and records the mode in `cdx:hbom:evidence:languageMode`. If `powershell.exe` is blocked entirely, only the Node baseline (processor and memory) is produced.
- Prefer `hbom diagnostics` before enabling `--privileged` broadly so you can see exactly which enrichments failed due to missing commands or permissions.
- In `--dry-run` mode, cdxgen returns a partial HBOM from safe local discovery where available, reports each blocked HBOM command in the activity summary, and still skips filesystem writes.
- In secure mode with HBOM allowlists configured, cdxgen aborts before live collection when the dry-run plan includes commands outside `CDXGEN_ALLOWED_COMMANDS` or declared paths outside `CDXGEN_ALLOWED_PATHS`.

## CycloneDX 2.0 output

`cdxgen -t hbom --spec-version 2.0` always asks the `@cdxgen/cdx-hbom` collector for CycloneDX 1.7 and renders 2.0 itself, the
same way it renders every other BOM: the 1.7 collector output becomes cdxgen's
1.x-shaped model, post-processing runs on it, and the 2.0 renderer runs once at
the end. If a collector answers with a 2.0 document anyway, cdxgen reads it
into the 1.x model first, so no hardware component is lost.

What each `cdx:hbom:*` property means in 2.0 is owned by cdx-hbom, through its
optional `./cdx20` export (`toCdx20HardwareComponent`). cdxgen loads it from
the same place it loads the collector (a local `cdx-hbom` checkout next to
cdxgen, else the installed package) and passes it to the renderer;
`cdx-convert --to 2.0` and `tracebom` do the same. cdx-hbom 0.8.0 is the
first release with the export; an older cdx-hbom leaves the generic conversion
in place.
From the mapper's result the renderer takes, for each hardware component:

- identifiers such as `serial-number`, `asset-tag`, `mac-address`, `imei` and
  `model-number`, appended to the component's own identifiers (a purl stays)
  and asserted by the same party as the rest of the document's identifiers
  (`party-cdxgen`), which is declared when referenced. Per-unit identifiers
  (serial number, asset tag, MAC address, IMEI) are asserted only when the
  collector recorded `cdx:hbom:identifierPolicy` = `raw-identifiers-enabled`
  for the run. A model number names the product, not the unit, so it is
  asserted in a redacted run too. Redacted values never become identities.
- `boardLocation` is not written: 2.0 reserves `boardLocation.designators` for
  circuit-board reference designators, so firmware slot labels such as `DIMM3`
  stay in the `cdx:hbom:*` properties.
- `classification` (`category` from `cdx:hbom:hardwareClass`, and taxonomy
  `codes` as `{standard, value}` objects; anything else is dropped and
  counted).
- a manufacturer party, when the component has none yet.

Every `cdx:hbom:*` property stays on the component, so the `hbom-compliance`,
`hbom-performance` and `hbom-security` audit rules find the same issues in a
2.0 HBOM as in the 1.7 one.

## When to use HBOM vs OBOM

Use **HBOM** when your goal is to inventory the hardware that makes up a host.

Use **OBOM** when your goal is to inventory the running operating system, runtime posture, trust state, services, packages, persistence signals, and other operational artifacts.

In practice:

- `hbom` → hardware-centric host inventory
- `hbom --include-runtime` → merged host inventory with strict hardware/runtime topology links
- `obom` / `cdxgen -t os` → operational/runtime host inventory

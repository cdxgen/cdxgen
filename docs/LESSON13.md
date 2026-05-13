# Lesson 13 — Generating and validating an HBOM

This lesson shows how to generate a CycloneDX **Hardware Bill of Materials (HBOM)** for the current host using the new `hbom` command in `cdxgen`.

## 1) When to use HBOM

Use HBOM when you want a hardware-focused CycloneDX inventory for the current host, including items such as processors, storage devices, displays, buses, network interfaces, and selected platform-specific peripherals.

HBOM is different from a software SBOM or an operations-focused OBOM:

- **SBOM** → software packages and dependencies
- **OBOM** → runtime and operating-system posture
- **HBOM** → hardware inventory for the host itself

## 2) Check the command surface

```shell
hbom --help
```

You should see options for:

- output control (`-o`, `-p`, `--pretty`)
- read-only review (`--dry-run`)
- validation (`--validate`)
- platform overrides (`--platform`, `--arch`)
- enrichment (`--privileged`, `--plist-enrichment`, `--no-command-enrichment`)
- identifier handling (`--sensitive`)
- merged runtime view (`--include-runtime`)

## 3) Generate a baseline HBOM

Create a hardware BOM with the default redaction behavior:

```shell
hbom -o hbom.json
```

This writes a CycloneDX 1.7 document to `hbom.json`.

If you prefer stdout for quick inspection:

```shell
hbom -p
```

## 4) Preview a read-only dry run

When you want to inspect the planned hardware collection before allowing command execution or output writes:

```shell
hbom --dry-run
```

With the optional `@cdxgen/cdx-hbom` library, dry-run is handled inside the HBOM collector itself:

- cdxgen still produces a **partial HBOM** from safe local discovery where possible
- command-based probes are blocked and listed individually in the activity summary
- output-file writes remain blocked

This is especially useful on supported macOS and Linux hosts when you want to review exactly which collector commands would run before doing a full inventory.

## 5) Diagnose missing utilities and permission-sensitive enrichments

Before enabling `--privileged` broadly on Linux, ask cdxgen to summarize the HBOM collector gaps:

```shell
hbom diagnostics
```

This command focuses on the actionable Linux issues surfaced by `@cdxgen/cdx-hbom` 0.4.0:

- **missing-command** — a useful native utility such as `lsusb`, `lspci`, `fwupdmgr`, or `dmidecode` was not installed
- **permission-denied** — the collector reached a documented permission-sensitive enrichment that usually needs `--privileged`

After you have already generated a BOM, you can summarize the serialized collector diagnostics from the file itself without touching the host again:

```shell
hbom diagnostics --input hbom.json
```

## 6) Validate the result

The `hbom` command validates by default. If you want to validate the file again with the standalone validator:

```shell
cdx-validate -i hbom.json
```

## 7) Use platform-specific enrichment carefully

### Apple Silicon macOS

Enable additional plist-based enrichment:

```shell
hbom --platform darwin --arch arm64 --plist-enrichment -o mac-hbom.json
```

### Linux

Use `hbom diagnostics` first. If it reports permission-denied enrichments that matter to your workflow, then enable privileged enrichment when the environment already allows it:

```shell
hbom --platform linux --arch amd64 --privileged -o linux-hbom.json
```

> `--privileged` may require elevated access or passwordless sudo depending on the system. Use it as a targeted follow-up to the diagnostics report rather than as the default first step.

## 8) Preserve sensitive identifiers only when necessary

By default, supported identifiers are redacted. If you explicitly need raw identifiers in the BOM:

```shell
hbom --sensitive -o hbom-sensitive.json
```

Use this mode carefully before distributing the BOM externally.

## 9) Use the main `cdxgen` command when needed

The same integration is available through the main CLI:

```shell
cdxgen -t hbom -o hbom.json .
```

This is useful when your automation already standardizes on `cdxgen`.

The same native dry-run behavior is also available through the main CLI:

```shell
cdxgen --dry-run -t hbom -p .
```

On slower arm64 hosts such as Raspberry Pi systems, it is often worth increasing the collector timeout:

```shell
hbom --include-runtime --timeout 180000 -o host-view.json
```

## 10) Build a merged HBOM + OBOM host view

When you want one CycloneDX document that combines hardware inventory with runtime evidence for the same host, use `--include-runtime`:

```shell
hbom --include-runtime -o host-view.json
```

This runs the HBOM collector and the OBOM/osquery collector, then merges them with **strict topology links only**. cdxgen will not guess that two entries are related just because their names look similar.

Examples of links that are allowed:

- NIC name `wlp2s0` ↔ OBOM `interface_addresses.interface = wlp2s0`
- HBOM driver `iwlwifi` ↔ OBOM `kernel_modules.name = iwlwifi`
- HBOM storage device `/dev/nvme0n1` ↔ OBOM mount or logical-drive device identity `/dev/nvme0n1`
- HBOM Secure Boot trust fingerprint or subject-key ID ↔ OBOM `secureboot_certificates` identifier with the exact same value

The merged document adds summary properties such as:

- `cdx:hostview:mode = hbom-obom-merged`
- `cdx:hostview:topologyLinkCount`
- `cdx:hostview:linkedHardwareComponentCount`
- `cdx:hostview:linkedRuntimeCategory`

Linked interfaces and storage devices also gain per-component properties such as `cdx:hostview:interface_addresses:count`, `cdx:hostview:kernel_modules:count`, `cdx:hostview:mount_hardening:count`, and `cdx:hostview:runtime-storage:count`.

## 11) Audit the merged host view

The merged host view enables a new `host-topology` BOM audit category.

```shell
cdxgen -t hbom --include-runtime -o host-view.json --bom-audit .
```

With `--include-runtime`, cdxgen automatically adds `host-topology` to the default HBOM audit packs. These rules focus on higher-confidence host findings such as:

- weak wireless security on interfaces that also have live runtime address evidence
- degraded wired links that are clearly in active runtime use
- degraded storage that is explicitly linked to active runtime mounts or logical drives
- revoked Secure Boot trust anchors when HBOM metadata and runtime certificate inventory match on an exact identifier
- merged host views that still produced zero strict topology links and therefore need collection review

## 12) Do not mix HBOM with software project types

HBOM must be generated separately from software project types.

This is **not** allowed:

```shell
cdxgen -t hbom -t js .
```

Instead, generate the documents separately:

```shell
hbom -o hbom.json
cdxgen -t js -o bom.json .
```

Or use the dedicated merged-host option when the second inventory is the local runtime/OBOM view for the same host:

```shell
hbom --include-runtime -o host-view.json
```

## 13) What to inspect in the resulting BOM

A generated HBOM typically includes:

- `metadata.component` describing the host/device
- `components` of CycloneDX `type: "device"`
- `cdx:hbom:*` properties describing hardware class and collected attributes
- platform-level evidence properties showing which native commands contributed data
- Linux diagnostic evidence properties such as `cdx:hbom:evidence:commandDiagnostic*` when command enrichment was missing tools or hit permission-sensitive paths
- cdxgen-derived summary properties under `cdx:hbom:analysis:*` for counts, missing command names, and permission-denied rerun guidance

In a merged host view, also inspect:

- `dependencies` for host → hardware and hardware → runtime topology edges
- `cdx:hostview:*` summary properties on the BOM and host metadata component
- `cdx:hostview:*` per-interface properties that capture linked runtime address and driver-module evidence

In dry-run mode, expect the same overall structure, but with fewer command-derived attributes and an activity summary that lists each blocked probe explicitly.

## 14) Practical next steps

- Use `hbom --include-runtime` when you need one explainable, topology-aware host document instead of two separate files.
- Use `hbom diagnostics` before enabling `--privileged` so you can justify the extra permissions with concrete missing-command or permission-denied evidence.
- Keep software SBOM generation separate from HBOM/OBOM host collection.
- Review redaction-sensitive runs before sharing BOMs outside your organization.

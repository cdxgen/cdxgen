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

## 5) Validate the result

The `hbom` command validates by default. If you want to validate the file again with the standalone validator:

```shell
cdx-validate -i hbom.json
```

## 6) Use platform-specific enrichment carefully

### Apple Silicon macOS

Enable additional plist-based enrichment:

```shell
hbom --platform darwin --arch arm64 --plist-enrichment -o mac-hbom.json
```

### Linux

Enable privileged SMBIOS enrichment when the environment already allows it:

```shell
hbom --platform linux --arch amd64 --privileged -o linux-hbom.json
```

> `--privileged` may require elevated access or passwordless sudo depending on the system.

## 7) Preserve sensitive identifiers only when necessary

By default, supported identifiers are redacted. If you explicitly need raw identifiers in the BOM:

```shell
hbom --sensitive -o hbom-sensitive.json
```

Use this mode carefully before distributing the BOM externally.

## 8) Use the main `cdxgen` command when needed

The same integration is available through the main CLI:

```shell
cdxgen -t hbom -o hbom.json .
```

This is useful when your automation already standardizes on `cdxgen`.

The same native dry-run behavior is also available through the main CLI:

```shell
cdxgen --dry-run -t hbom -p .
```

## 9) Build a merged HBOM + OBOM host view

When you want one CycloneDX document that combines hardware inventory with runtime evidence for the same host, use `--include-runtime`:

```shell
hbom --include-runtime -o host-view.json
```

This runs the HBOM collector and the OBOM/osquery collector, then merges them with **strict topology links only**. cdxgen will not guess that two entries are related just because their names look similar.

Examples of links that are allowed:

- NIC name `wlp2s0` ↔ OBOM `interface_addresses.interface = wlp2s0`
- HBOM driver `iwlwifi` ↔ OBOM `kernel_modules.name = iwlwifi`

The merged document adds summary properties such as:

- `cdx:hostview:mode = hbom-obom-merged`
- `cdx:hostview:topologyLinkCount`
- `cdx:hostview:linkedHardwareComponentCount`
- `cdx:hostview:linkedRuntimeCategory`

Linked interfaces also gain per-component properties such as `cdx:hostview:interface_addresses:count` and `cdx:hostview:kernel_modules:count`.

## 10) Audit the merged host view

The merged host view enables a new `host-merged` BOM audit category.

```shell
cdxgen -t hbom --include-runtime -o host-view.json --bom-audit .
```

With `--include-runtime`, cdxgen automatically adds `host-merged` to the default HBOM audit packs. These rules focus on higher-confidence host findings such as:

- weak wireless security on interfaces that also have live runtime address evidence
- degraded wired links that are clearly in active runtime use
- merged host views that still produced zero strict topology links and therefore need collection review

## 11) Do not mix HBOM with software project types

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

## 12) What to inspect in the resulting BOM

A generated HBOM typically includes:

- `metadata.component` describing the host/device
- `components` of CycloneDX `type: "device"`
- `cdx:hbom:*` properties describing hardware class and collected attributes
- platform-level evidence properties showing which native commands contributed data

In a merged host view, also inspect:

- `dependencies` for host → hardware and hardware → runtime topology edges
- `cdx:hostview:*` summary properties on the BOM and host metadata component
- `cdx:hostview:*` per-interface properties that capture linked runtime address and driver-module evidence

In dry-run mode, expect the same overall structure, but with fewer command-derived attributes and an activity summary that lists each blocked probe explicitly.

## 13) Practical next steps

- Use `hbom --include-runtime` when you need one explainable, topology-aware host document instead of two separate files.
- Keep software SBOM generation separate from HBOM/OBOM host collection.
- Review redaction-sensitive runs before sharing BOMs outside your organization.

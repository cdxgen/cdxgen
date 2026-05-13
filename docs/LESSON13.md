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
- validation (`--validate`)
- platform overrides (`--platform`, `--arch`)
- enrichment (`--privileged`, `--plist-enrichment`, `--no-command-enrichment`)
- identifier handling (`--sensitive`)

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

## 4) Validate the result

The `hbom` command validates by default. If you want to validate the file again with the standalone validator:

```shell
cdx-validate -i hbom.json
```

## 5) Use platform-specific enrichment carefully

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

## 6) Preserve sensitive identifiers only when necessary

By default, supported identifiers are redacted. If you explicitly need raw identifiers in the BOM:

```shell
hbom --sensitive -o hbom-sensitive.json
```

Use this mode carefully before distributing the BOM externally.

## 7) Use the main `cdxgen` command when needed

The same integration is available through the main CLI:

```shell
cdxgen -t hbom -o hbom.json .
```

This is useful when your automation already standardizes on `cdxgen`.

## 8) Do not mix HBOM with software project types

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

## 9) What to inspect in the resulting BOM

A generated HBOM typically includes:

- `metadata.component` describing the host/device
- `components` of CycloneDX `type: "device"`
- `cdx:hbom:*` properties describing hardware class and collected attributes
- platform-level evidence properties showing which native commands contributed data

## 10) Practical next steps

- Pair `hbom` with `obom` when you want both hardware and runtime inventory for the same host.
- Keep SBOM, HBOM, and OBOM generation as separate steps in CI or fleet workflows.
- Review redaction-sensitive runs before sharing BOMs outside your organization.

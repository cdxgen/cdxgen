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

## Common options

| Option                    | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `-o, --output <file>`     | Write the generated HBOM to a file. Default: `hbom.json`        |
| `-p, --print`             | Print the generated HBOM to stdout instead of writing a file    |
| `--pretty`                | Pretty-print JSON output                                        |
| `--validate`              | Validate the generated HBOM using the CycloneDX schema          |
| `--platform <value>`      | Override platform detection                                     |
| `--arch <value>`          | Override architecture detection                                 |
| `--sensitive`             | Include raw identifiers instead of redacted defaults            |
| `--no-command-enrichment` | Disable optional command-based enrichment                       |
| `--privileged`            | Enable privileged Linux SMBIOS enrichment via `dmidecode`       |
| `--plist-enrichment`      | Enable extra Darwin plist-based enrichment                      |
| `--strict`                | Fail instead of returning partial results when enrichment fails |
| `--timeout <ms>`          | Per-command timeout                                             |

## Examples

Generate a local HBOM file:

```shell
hbom -o hbom.json
```

Print the generated document to stdout:

```shell
hbom -p
```

Collect Linux SMBIOS enrichment when you already have the required privileges:

```shell
hbom --platform linux --arch amd64 --privileged -o linux-hbom.json
```

Enable Darwin plist enrichment on Apple Silicon:

```shell
hbom --platform darwin --arch arm64 --plist-enrichment -o mac-hbom.json
```

Generate an HBOM and immediately audit it with the built-in hardware rules:

```shell
cdxgen -t hbom -o hbom.json --bom-audit .
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

You can also use `--bom-audit-categories hbom` as a shorthand alias for all three.

## Validation and safety notes

- HBOM generation currently targets **CycloneDX 1.7**.
- By default, the collector redacts sensitive identifiers such as serial numbers and MAC addresses where appropriate.
- Use `--sensitive` only when you explicitly need raw identifiers in the resulting BOM.
- Linux `--privileged` enrichment may require root or passwordless sudo depending on the target environment.

## When to use HBOM vs OBOM

Use **HBOM** when your goal is to inventory the hardware that makes up a host.

Use **OBOM** when your goal is to inventory the running operating system, runtime posture, trust state, services, packages, persistence signals, and other operational artifacts.

In practice:

- `hbom` → hardware-centric host inventory
- `obom` / `cdxgen -t os` → operational/runtime host inventory

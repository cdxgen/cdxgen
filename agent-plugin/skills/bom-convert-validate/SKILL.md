---
name: bom-convert-validate
description: Converts CycloneDX BOMs to SPDX 3.0.1 JSON-LD or between CycloneDX spec versions with cdx-convert, and validates BOMs against JSON schema, deep consistency checks, and OWASP SCVS and EU Cyber Resilience Act compliance benchmarks with cdx-validate, emitting SARIF for code scanning. Use when asked to convert an SBOM to SPDX, downgrade or upgrade a BOM spec version, validate or lint a BOM, check SCVS or CRA compliance, or score SBOM quality.
---

# Convert and validate BOMs

Two post-processing commands for BOMs that already exist.

Read [reference/safety.md](../../reference/safety.md) first.

## Convert

```bash
# CycloneDX to SPDX 3.0.1 JSON-LD (default target)
cdx-convert -i /absolute/path/to/bom.json -o /absolute/path/to/bom.spdx.json

# Cross-convert between CycloneDX spec versions
cdx-convert -i /absolute/path/to/bom.json --to 1.6 -o /absolute/path/to/bom.1.6.json
```

| Flag             | Purpose                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `-i, --input`    | Source BOM                                                           |
| `-o, --output`   | Destination                                                          |
| `--to`           | `spdx` (default) or a CycloneDX version: `1.5`, `1.6`, `1.7`         |
| `--validate`     | Validate the conversion result                                       |
| `--json-pretty`  | Pretty-print output                                                  |

### The legacy spec-version path

`cdxgen` **rejects `1.4` and `1.5` as generation targets** — only `1.6`, `1.7`
(default), and `2.0` are accepted. When a consumer needs an older document, the
supported route is to generate at a valid version and downgrade the serialized
output here:

```bash
cdxgen -o /absolute/path/to/bom.json /absolute/path/to/project
cdx-convert -i /absolute/path/to/bom.json --to 1.5 -o /absolute/path/to/bom.1.5.json
```

Tell the user that a downgrade drops fields the older schema cannot express. A
1.5 document converted from 1.7 is not the same document.

### SPDX directly from source

If SPDX is the only target, skip the round trip:

```bash
cdxgen --format spdx -o /absolute/path/to/bom.spdx.json /absolute/path/to/project
```

`spdxgen` is the dedicated command for the same thing. Use `cdx-convert` when
the CycloneDX document already exists or is also wanted.

## Validate

```bash
cdx-validate -i /absolute/path/to/bom.json
```

Three layers run together:

1. **Schema validation** — CycloneDX JSON schema
2. **Deep validation** — metadata, purl, `bom-ref`, and property consistency
3. **Compliance rule packs** — OWASP SCVS (all 87 controls across L1/L2/L3) and EU Cyber Resilience Act SBOM expectations (8 controls)

Protobuf input works too:

```bash
cdx-validate -i /absolute/path/to/bom.cdx
```

### Compliance benchmarks

```bash
cdx-validate -i /absolute/path/to/bom.json --benchmark scvs-l2 -r sarif -o /absolute/path/to/results.sarif
```

Benchmark aliases: `scvs`, `scvs-l1`, `scvs-l2`, `scvs-l3`, `cra`. Defaults to
all. Categories: `compliance-scvs`, `compliance-cra`.

Rules that cannot be decided from a BOM alone — "SBOMs are required for new
procurements", for example — are surfaced as **manual-review** items so coverage
is still tracked. Include them with `--include-manual`.

This matters when reporting a score: a control marked manual-review is neither
passing nor failing. Do not fold it into either bucket.

### Validation flags

| Flag                  | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `--schema` / `--no-schema` | JSON-schema layer, on by default                              |
| `--deep`              | Deep consistency checks                                            |
| `--benchmark, -b`     | Compliance benchmarks to score                                     |
| `--categories`        | Compliance rule categories                                         |
| `--strict`            | Treat warnings as failures                                         |
| `--min-severity`      | Minimum severity to report                                         |
| `--fail-severity`     | Severity that causes a non-zero exit                               |
| `--include-manual`    | Include manual-review controls in output                           |
| `--include-pass`      | Show passing controls, not just failures                            |
| `--report, -r`        | `sarif` and other formats                                          |
| `--report-file, -o`   | Write the report to a file                                          |
| `--public-key`        | Verify the JSF signature during validation                          |
| `--require-signature` | Fail validation when no signature is present                        |
| `--platform`          | Platform-specific validation behaviour                              |

### Release-gate pattern

```bash
cdx-validate -i /absolute/path/to/bom.json \
  --benchmark scvs-l2,cra \
  --public-key /absolute/path/to/public.pem --require-signature \
  --strict \
  -r sarif -o /absolute/path/to/results.sarif
```

Schema, deep consistency, SCVS L2, CRA, and signature presence in one gate.

## Validation during generation

`cdxgen --validate` is on by default, so a generated BOM is already
schema-checked. `cdx-validate` adds the deep and compliance layers, which
generation does not run. Do not tell the user their BOM is "already validated"
when they are asking about SCVS or CRA coverage.

Rule details: <https://cdxgen.github.io/cdxgen/#/VALIDATION_RULES>.

## Reference

- Conversion: <https://cdxgen.github.io/cdxgen/#/CDX_CONVERT>
- Validation: <https://cdxgen.github.io/cdxgen/#/CDX_VALIDATE>
- Validation rules: <https://cdxgen.github.io/cdxgen/#/VALIDATION_RULES>

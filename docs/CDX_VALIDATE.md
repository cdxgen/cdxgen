# cdx-validate — Supply-Chain Compliance Validator

`cdx-validate` is a zero-install CLI and library that validates CycloneDX
BOMs against **structural**, **deep**, and **compliance** checks.

It combines three layers:

1. **Schema validation** – the existing CycloneDX JSON schema check shipped
   with cdxgen (`lib/validator/bomValidator.js`).
2. **Deep validation** – metadata, purl, bom-ref and property consistency
   checks, also from `lib/validator/bomValidator.js`.
3. **Compliance rule packs** – internal JavaScript rule catalog covering
   **OWASP SCVS (all 87 controls across L1/L2/L3)**, **EU Cyber Resilience
   Act (CRA) SBOM expectations** (8 controls) and the **CISA 2026 minimum
   elements for an SBOM** (15 rules). Rules that cannot be decided
   from a BOM alone (for example, "SBOMs are required for new procurements")
   are surfaced as _manual-review_ items so coverage can still be tracked.

It is distributed as:

- an npm entry point (`cdx-validate` — installed alongside `cdxgen`)
- a single-executable-application (SEA) binary produced by the
  `binary-builds` GitHub workflow, alongside `cdxgen`, `cdx-verify` and
  `cdx-sign`.

---

## Quick start

```shell
# Validate a BOM, print a table and a scorecard
cdx-validate -i bom.json

# Validate a protobuf BOM exported by cdxgen
cdx-validate -i bom.cdx

# Run only the SCVS Level 2 benchmark, emit SARIF for GitHub code scanning
cdx-validate -i bom.json --benchmark scvs-l2 -r sarif -o results.sarif

# Verify the signature and the structure in one go (JSON input only)
cdx-validate -i bom.json --public-key builder_public.pem

# Machine-readable output for a CI system
cdx-validate -i bom.json -r json --fail-severity medium
```

---

## CLI reference

| Flag                                       | Default    | Description                                                                                                                   |
| ------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input`                              | `bom.json` | Local SBOM JSON/protobuf path or an OCI reference (resolved natively without `oras`).                                         |
| `--platform`                               | —          | Platform to pass when the input is an OCI ref.                                                                                |
| `-r, --report`                             | `console`  | `console`, `json`, `sarif`, `annotations`.                                                                                    |
| `-o, --report-file`                        | stdout     | Write the report to a file.                                                                                                   |
| `--schema` / `--no-schema`                 | on         | Toggle JSON-schema validation.                                                                                                |
| `--deep` / `--no-deep`                     | on         | Toggle metadata / purl / ref / property deep checks.                                                                          |
| `-b, --benchmark`                          | all        | Comma list of `scvs`, `scvs-l1`, `scvs-l2`, `scvs-l3`, `cra`, `cisa`.                                                         |
| `--categories`                             | all        | Comma list of rule categories (`compliance-scvs`, `compliance-cra`, `compliance-cisa`).                                       |
| `--min-severity`                           | `info`     | Drop findings below this severity from the report.                                                                            |
| `--fail-severity`                          | `high`     | Exit code 3 if any failing finding is ≥ this severity.                                                                        |
| `--include-manual` / `--no-include-manual` | on         | Show non-automatable manual-review findings.                                                                                  |
| `--include-pass`                           | off        | Include passing findings (useful for audits).                                                                                 |
| `--public-key`                             | —          | PEM file. When set, verify the BOM signature for JSON or OCI BOM input. Local protobuf input is not signature-verifiable yet. |
| `--secret-key`                             | —          | Shared secret file for `HS256`, `HS384`, and `HS512` signatures. HMAC signatures are only accepted with this option.          |
| `--no-nested-signatures`                   | off        | Verify only the root signature, for a co-signer's key. By default nested signatures are verified too.                         |
| `--require-signature`                      | with a key | Exit 4 if verification fails. On whenever `--public-key` or `--secret-key` is given; `--no-require-signature` only reports.   |
| `--strict`                                 | off        | Exit 2 when schema / deep validation fails.                                                                                   |

### Exit codes

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| `0`  | All checks passed, or no findings at/above `--fail-severity`.    |
| `1`  | Configuration error (bad input, missing file, unknown reporter). |
| `2`  | Schema / deep validation failed (only with `--strict`).          |
| `3`  | One or more failing findings at/above `--fail-severity`.         |
| `4`  | Signature verification was required and failed.                  |

> **Note:** Local protobuf BOM input (`.cdx`, `.cdx.bin`, `.proto`) is supported for structure, deep, and compliance validation. JSF signature verification still requires the source JSON BOM because `cdx-proto` does not currently preserve signature blocks in protobuf form.

Signature verification follows [`cdx-verify`](CDX_VERIFY.md#verification-behavior): the BOM needs a root signature, its root must be a CycloneDX BOM root, and the BOM must be UTF-8 and must not repeat a member name, hold a number an IEEE 754 double cannot represent exactly, or hold an unpaired surrogate escape. An empty `--public-key` or `--secret-key` path, or an empty key file, is a configuration error (exit 1). When the root signature verifies but some of its `signers` or `chain` entries do not, `cdx-validate` prints a warning naming them, and the `json` report lists every entry under `signatureEntries`.

---

## Output formats

### `console` (default)

A three-part human-readable report:

1. one-line summary (`pass=… fail=… manual=… errors=…`)
2. per-benchmark scorecard table
3. detail tables for _Failing_ and _Manual-review_ findings.

### `json`

A stable, documented JSON schema:

```json
{
  "schemaValid": true,
  "deepValid": true,
  "signatureVerified": null,
  "signatureEntries": null,
  "validationErrors": [],
  "summary": { "total": 95, "pass": 28, "fail": 2, "manual": 65, "errors": 1 },
  "benchmarks": [ { "id": "scvs-l2", "name": "OWASP SCVS Level 2", "pass": 15, "fail": 1, "manual": 46, "scorePct": 94, "controls": [ … ] } ],
  "findings": [
    { "ruleId": "SCVS-2.4", "status": "fail", "severity": "high", "standard": "SCVS", "standardRefs": ["SCVS-2.4"], "message": "BOM is not signed.", "mitigation": "Use cdx-sign.", "locations": [], "evidence": null }
  ]
}
```

### `sarif`

A valid SARIF 2.1.0 log suitable for `github/codeql-action/upload-sarif`:

```yaml
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: cdx-validate.sarif
    category: cdx-validate
```

Each finding becomes a SARIF `result` with `ruleId`, `level` (error/warning/
note mapped from severity) and `properties.standardRefs`. Rules are
deduplicated into the `tool.driver.rules` array.

### `annotations`

Returns the original BOM with CycloneDX `annotations[]` appended, one per
finding. Properties follow the `cdx:validate:*` namespace (e.g.
`cdx:validate:ruleId`, `cdx:validate:standardRefs`,
`cdx:validate:mitigation`). This is the same shape the `bom-audit` engine
emits, making the two streams directly mergeable.

---

## Validator errors are not findings

A validator that throws has not produced a verdict on the BOM, so an
exception is never folded into `schemaValid`/`deepValid` or counted as a
failing control. When the schema or deep stage throws (for example on an
unexpected input shape), `validateBomAdvanced()` records it in
`validationErrors: [{ "stage": "schema" | "deep", "message": "…" }]`, and
`summary.errors` counts how many occurred.

Each reporter surfaces the list differently:

- the **console** reporter prints `Validator error during <stage> validation: <message>` lines after the summary
- the **json** reporter includes the `validationErrors` array verbatim
- the **sarif** reporter emits each entry as a `toolExecutionNotifications` error on the invocation, so code-scanning UIs show the tool itself had a problem
- **cdx-validate** additionally prints every entry to stderr as `<stage> validation threw: <message>`

If a run reports `errors > 0`, treat the corresponding stage's verdict as
unknown rather than failed, fix or report the validator fault, and re-run.
A finding, by contrast, is always a statement about the BOM.

---

## Compliance rule catalogs

### OWASP SCVS

All 87 controls from OWASP SCVS (V1–V6) are present. For each control the
catalog records:

- the canonical id (`SCVS-1.1`, `SCVS-6.7`, …),
- the levels at which it is required (`L1` / `L2` / `L3`),
- whether it is **automatable** from a BOM alone,
- a `severity` for failing automatable controls.

Automatable highlights (non-exhaustive): `SCVS-1.1` (components + versions),
`SCVS-1.7` (machine-readable identifiers), `SCVS-2.1` (CycloneDX format),
`SCVS-2.3` (unique identifier), `SCVS-2.4` (signed), `SCVS-2.7` (timestamp),
`SCVS-2.9` (dependency graph), `SCVS-2.11` (asset metadata), `SCVS-2.12`
(valid purls), `SCVS-2.13` (purl preferred), `SCVS-2.14`/`SCVS-5.12`
(license data), `SCVS-2.15` (SPDX expressions), `SCVS-2.16` (copyright),
`SCVS-2.18`/`SCVS-3.18` (hashes), `SCVS-3.20` (no orphans), `SCVS-5.11`
(inventory count), `SCVS-6.3` (pedigree on modified components).

Non-automatable controls (for example, "package manager enforces MFA") are
reported as `status: manual`, `severity: info`, with the upstream
description included so reviewers can assess them manually.

Some manual SCVS controls now include an explicit `cdx-audit` evidence hint.
These are the controls where predictive audit can materially help a reviewer
inspect repository workflows, provenance, publishing, or source-correlation
signals even though the control still cannot be proven from the BOM alone.

Current mappings include:

- `SCVS-2.8` — SBOM is analyzed for risk
- `SCVS-3.3` — Application uses CI build pipeline
- `SCVS-3.6` — No arbitrary code execution
- `SCVS-4.10` — Version-to-source correlation
- `SCVS-4.11` — Package repository auditability
- `SCVS-6.1` — Point of origin verifiable
- `SCVS-6.2` — Chain of custody auditable

For these controls, use the same SBOM as input to predictive audit:

```shell
cdx-audit --bom bom.json --scope required
```

Then attach the resulting workflow, provenance, publishing, and repository
findings as supporting evidence for the manual review.

### EU Cyber Resilience Act (CRA)

Eight controls extracted from CRA Annex I and the ENISA SBOM guidance:

| Id            | Check                                                               |
| ------------- | ------------------------------------------------------------------- |
| `CRA-MIN-001` | `metadata.supplier.name` (or `manufacturer.name`) is declared.      |
| `CRA-MIN-002` | Manufacturer has a contact (email / phone / URL).                   |
| `CRA-MIN-003` | BOM has a `serialNumber` of shape `urn:uuid:<uuid>`.                |
| `CRA-MIN-004` | BOM has a non-empty `dependencies[]` covering ≥ 75 % of components. |
| `CRA-MIN-005` | `metadata.timestamp` is present and ISO-8601 parseable.             |
| `CRA-MIN-006` | Every component has a `purl`, `cpe`, or `swid.tagId`.               |
| `CRA-MIN-007` | Every component declares license information.                       |
| `CRA-MIN-008` | `metadata.tools` records the generating tool(s).                    |

The current CRA catalog intentionally focuses on minimum SBOM content and
manufacturer-contact expectations. The new predictive-audit capabilities are
therefore **not** currently mapped to an additional `CRA-MIN-*` rule. You can
still use `cdx-audit` as supplementary evidence during a broader CRA review,
but cdxgen does not currently claim a direct CRA control mapping for those
workflow/provenance checks.

### CISA 2026 minimum elements

Fifteen rules for the [2026 Minimum Elements for a Software Bill of
Materials](https://www.cisa.gov/resources-tools/resources/2026-minimum-elements-software-bill-materials-sbom)
published by CISA, NSA, FBI and international partners on 29 July 2026, which
replace the NTIA 2021 elements. Every rule cites the element it implements in
`standardRefs` (for example `CISA-2026-COMPONENT-HASH-VALUE`) so a user can
judge the mapping against the source. Elements the guidance allows to carry an
explicit `unknown` value (component version, tool version, component producer,
component license) pass when that marker is present.

| Id            | CISA element(s)                                | CycloneDX field read                                                       |
| ------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `CISA-MIN-001` | SBOM Author                                    | `metadata.authors[].name` (1.4: `metadata.author.name`)                    |
| `CISA-MIN-002` | SBOM Author Signature                          | `signature` (the JSF block `cdx-sign` writes)                              |
| `CISA-MIN-003` | SBOM Data Format Name, Data Format Version     | `bomFormat`, `specVersion` (1.0 to 1.3 count as deprecated)                |
| `CISA-MIN-004` | SBOM Generation Context                        | `metadata.lifecycles[].phase`                                              |
| `CISA-MIN-005` | SBOM Tool Name, SBOM Tool Version              | `metadata.tools` (array or `components`/`services`)                        |
| `CISA-MIN-006` | SBOM Version                                   | `version` (integer of 1 or more)                                           |
| `CISA-MIN-007` | SBOM Timestamp                                 | `metadata.timestamp` (RFC 9557 shape)                                      |
| `CISA-MIN-008` | Component Name                                 | `components[].name`                                                        |
| `CISA-MIN-009` | Component Version                              | `components[].version`                                                     |
| `CISA-MIN-010` | Component Producer                              | `components[].supplier.name` or `manufacturer.name`                        |
| `CISA-MIN-011` | Component Identifiers                          | `components[].purl`, `cpe`, `swid.tagId`                                   |
| `CISA-MIN-012` | Component Hash Value, Component Hash Algorithm | `components[].hashes[]` (`alg` plus hex `content`; MD5/SHA-1 do not alone)  |
| `CISA-MIN-013` | Component License                              | `components[].licenses`                                                    |
| `CISA-MIN-014` | Component Dependency Relationship, Coverage    | `dependencies[]` covering every component                                  |
| `CISA-MIN-015` | Explicitly Identifying Unknown Information     | manual review; not decidable from the BOM alone                            |

Checked against a default `cdxgen` BOM for a small npm project (spec 1.7), the
profile scores 10 pass, 4 fail, 1 manual. cdxgen fills the author, data
format, generation context, tool, SBOM version, timestamp, component name,
version, identifier and dependency elements by default. The remaining gaps and
the step that fills each one:

- **Author signature**: sign the generated BOM with `cdx-sign`; cdxgen keeps
  signing an explicit step.
- **Component producer**: cdxgen does not record the maintaining organisation
  for packages by default; record it in `supplier.name`, or `"unknown"` to
  mark the provenance unknown.
- **Component hashes**: a lockfile-only npm generation records no hashes;
  generate where the artifacts are reachable (installed directories, image
  scans) so hashes can be computed.
- **Component license**: run with `FETCH_LICENSE=true` or a license allow-list
  so licenses are resolved.

Run the profile on its own with:

```shell
cdx-validate -i bom.json --benchmark cisa --fail-severity medium
```

---

## Benchmark scoring

For every benchmark, `cdx-validate` reports:

- total controls
- passing controls
- failing controls
- manual-review controls
- **automatable score** = `pass / (pass + fail)` expressed as a percentage

Manual controls are **excluded from the percentage** (they are informational
only) but are counted separately so you can track how much of the catalog
still needs manual attention.

---

## Library API

```js
import {
  validateBomAdvanced,
  shouldFail,
} from "@cdxgen/cdxgen/lib/validator/index.js";
import { render } from "@cdxgen/cdxgen/lib/validator/reporters/index.js";

const bom = JSON.parse(await readFile("bom.json", "utf8"));
const report = validateBomAdvanced(bom, {
  benchmarks: ["scvs-l2", "cra"],
  minSeverity: "low",
});

console.log(
  render("sarif", report, { toolName: "cdx-validate", toolVersion: "VERSION" }),
);

const { shouldFail: fail, reason } = shouldFail(report, {
  failSeverity: "high",
});
if (fail) throw new Error(reason);
```

Reporters are intentionally implemented as independent modules under
`lib/validator/reporters/*`. They accept the same `report` object, so
`bom-audit` and any future validator can reuse them without duplication.

---

## See also

- [`BOM_AUDIT.md`](./BOM_AUDIT.md) — the YAML/JSONata audit engine shipped with
  cdxgen. Its output shape is deliberately compatible with
  `cdx-validate`'s SARIF and annotations reporters.
- [`LESSON7.md`](./LESSON7.md) — end-to-end tutorial using `cdx-validate`.
- [`LESSON3.md`](./LESSON3.md) and [`LESSON6.md`](./LESSON6.md) — signing
  workflows that pair naturally with `--public-key` / `--require-signature`.

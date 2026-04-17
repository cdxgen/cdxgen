# cdx-validate — Supply-Chain Compliance Validator

`cdx-validate` is a zero-install CLI and library that validates CycloneDX
BOMs against **structural**, **deep**, and **compliance** checks.

It combines three layers:

1. **Schema validation** – the existing CycloneDX JSON schema check shipped
   with cdxgen (`lib/validator/bomValidator.js`).
2. **Deep validation** – metadata, purl, bom-ref and property consistency
   checks, also from `lib/validator/bomValidator.js`.
3. **Compliance rule packs** – internal JavaScript rule catalog covering
   **OWASP SCVS (all 87 controls across L1/L2/L3)** and **EU Cyber Resilience
   Act (CRA) SBOM expectations** (8 controls). Rules that cannot be decided
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

# Run only the SCVS Level 2 benchmark, emit SARIF for GitHub code scanning
cdx-validate -i bom.json --benchmark scvs-l2 -r sarif -o results.sarif

# Verify the signature and the structure in one go
cdx-validate -i bom.json --public-key builder_public.pem --require-signature

# Machine-readable output for a CI system
cdx-validate -i bom.json -r json --fail-severity medium
```

---

## CLI reference

| Flag                                       | Default    | Description                                                          |
| ------------------------------------------ | ---------- | -------------------------------------------------------------------- |
| `-i, --input`                              | `bom.json` | SBOM JSON path or an OCI reference (resolved with `oras`).           |
| `--platform`                               | —          | Platform to pass to `oras` when the input is an OCI ref.             |
| `-r, --report`                             | `console`  | `console`, `json`, `sarif`, `annotations`.                           |
| `-o, --report-file`                        | stdout     | Write the report to a file.                                          |
| `--schema` / `--no-schema`                 | on         | Toggle JSON-schema validation.                                       |
| `--deep` / `--no-deep`                     | on         | Toggle metadata / purl / ref / property deep checks.                 |
| `-b, --benchmark`                          | all        | Comma list of `scvs`, `scvs-l1`, `scvs-l2`, `scvs-l3`, `cra`.        |
| `--categories`                             | all        | Comma list of rule categories (`compliance-scvs`, `compliance-cra`). |
| `--min-severity`                           | `info`     | Drop findings below this severity from the report.                   |
| `--fail-severity`                          | `high`     | Exit code 3 if any failing finding is ≥ this severity.               |
| `--include-manual` / `--no-include-manual` | on         | Show non-automatable manual-review findings.                         |
| `--include-pass`                           | off        | Include passing findings (useful for audits).                        |
| `--public-key`                             | —          | PEM file. When set, verify the BOM signature.                        |
| `--require-signature`                      | off        | Exit 4 if `--public-key` is supplied but verification fails.         |
| `--strict`                                 | off        | Exit 2 when schema / deep validation fails.                          |

### Exit codes

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| `0`  | All checks passed, or no findings at/above `--fail-severity`.    |
| `1`  | Configuration error (bad input, missing file, unknown reporter). |
| `2`  | Schema / deep validation failed (only with `--strict`).          |
| `3`  | One or more failing findings at/above `--fail-severity`.         |
| `4`  | Signature verification was required and failed.                  |

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
} from "@cyclonedx/cdxgen/lib/validator/index.js";
import { render } from "@cyclonedx/cdxgen/lib/validator/reporters/index.js";

const bom = JSON.parse(await readFile("bom.json", "utf8"));
const report = validateBomAdvanced(bom, {
  benchmarks: ["scvs-l2", "cra"],
  minSeverity: "low",
});

console.log(
  render("sarif", report, { toolName: "cdx-validate", toolVersion: "12.2.0" }),
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

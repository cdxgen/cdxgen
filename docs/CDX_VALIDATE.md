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
   Act (CRA) SBOM expectations** (8 controls), the **CISA 2026 minimum
   elements for an SBOM** (18 rules) and the **CISA and G7 minimum elements
   for an AI SBOM** (16 rules). Rules that cannot be decided
   from a BOM alone (for example, "SBOMs are required for new procurements")
   are surfaced as _manual-review_ items so coverage can still be tracked.

A CycloneDX 2.0 document is schema-checked as the 2.0 document. The deep
checks and the compliance rules read cdxgen's 1.x-shaped model of it (the
model `cdx-convert` and `cdx-audit` read), so the same project gives the same
rule results at 1.7 and at 2.0. Anything of the 2.0 document that model cannot
hold is a read loss: `validateBomAdvanced()` returns them as `readLosses`
(`[{ "pointer": "/risks", "reason": "…" }]`), the `json` report lists them
under `readLosses`, and `cdx-validate` prints their count on stderr. Set `CDXGEN_THINK_MODE=true` to list them. A document nested
deeper than 256 objects is cut at that depth, with one loss for each cut
object.

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
| `-b, --benchmark`                          | all        | Comma list of `scvs`, `scvs-l1`, `scvs-l2`, `scvs-l3`, `cra`, `cisa`, `cisa-ai`.                                              |
| `--categories`                             | all        | Comma list of rule categories (`compliance-scvs`, `compliance-cra`, `compliance-cisa`, `compliance-cisa-ai`).                 |
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
  "readLosses": [],
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
`validationErrors: [{ "stage": "read" | "schema" | "deep", "message": "…" }]`, and
`summary.errors` counts how many occurred.

Each reporter surfaces the list differently:

- the **console** reporter prints `Validator error during <stage> validation: <message>` lines after the summary
- the **json** reporter includes the `validationErrors` array verbatim
- the **sarif** reporter emits each entry as a `toolExecutionNotifications` error on the invocation, so code-scanning UIs show the tool itself had a problem
- **cdx-validate** additionally prints every entry to stderr as `<stage> validation threw: <message>`, and a `read` entry (a 2.0 document the reader could not read) as its message alone

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

Eighteen rules for the [2026 Minimum Elements for a Software Bill of
Materials](https://www.cisa.gov/resources-tools/resources/2026-minimum-elements-software-bill-materials-sbom)
(version 2.1, [PDF](https://www.cisa.gov/sites/default/files/2026-07/2026_cisa_sbom_minimum_elements_508c.pdf)),
published by CISA, NSA, FBI and international partners on 29 July 2026 to
replace the NTIA 2021 elements. The guidance defines seventeen data fields
(Appendix A, Table 1) and six practices and processes. Every rule cites the
elements it implements in `standardRefs`, for example
`CISA-2026-COMPONENT-HASH-VALUE`, and `lib/validator/complianceRules.poku.js`
checks that the rules together cite all twenty-three.

The component rules judge the target component, `metadata.component`, as well
as every software component in `components[]` (applications, frameworks,
libraries, containers, operating systems, firmware, device drivers and AI
models), because the guidance applies the component elements to "the target
component (the component for which the SBOM is generated) and all enumerated
subcomponents". Where the guidance allows an explicit unknown (tool version,
component version, component producer, component license), the string
`unknown` in that field passes.

| Id             | CISA element(s)                                               | CycloneDX field read                                                                                                                                     |
| -------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CISA-MIN-001` | SBOM Author                                                   | `metadata.authors[].name` or `metadata.manufacturer.name`; the `--author` default `OWASP Foundation` alone does not count                                 |
| `CISA-MIN-002` | SBOM Author Signature                                         | JSF `signature` with a `value`, or its `signers[]` or `chain[]`, from an RSA, RSA-PSS, ECDSA or EdDSA key; an HMAC (`HS256` to `HS512`) does not count    |
| `CISA-MIN-003` | SBOM Data Format Name, Data Format Version, Machine-Processable Data | `bomFormat` (1.x) or `specFormat` (2.0) and a published `specVersion`; CycloneDX has declared no version deprecated                                  |
| `CISA-MIN-004` | SBOM Generation Context                                       | `metadata.lifecycles[]`: a CycloneDX `phase` or a named lifecycle                                                                                        |
| `CISA-MIN-005` | SBOM Tool Name, SBOM Tool Version                             | `metadata.tools` (array or `components`/`services`)                                                                                                      |
| `CISA-MIN-006` | SBOM Version                                                  | `version` (integer of 1 or more), and `serialNumber`, when present, as an RFC 9562 UUID URN                                                              |
| `CISA-MIN-007` | SBOM Timestamp                                                | `metadata.timestamp` (RFC 9557 shape with a real calendar day, hour 0-23, minute 0-59 and second 0-60, so a leap second passes)                          |
| `CISA-MIN-008` | Component Name                                                | `metadata.component.name` and `components[].name`; a BOM without `metadata.component` fails                                                              |
| `CISA-MIN-009` | Component Version                                             | `version` of the target and every component                                                                                                              |
| `CISA-MIN-010` | Component Producer                                            | `manufacturer.name`, `supplier.name`, `authors[].name` or the deprecated `author` of the target and every component                                     |
| `CISA-MIN-011` | Component Identifiers                                         | `purl`, `cpe`, `swid.tagId`, `omniborId[]` or `swhid[]` of the target and every component                                                               |
| `CISA-MIN-012` | Component Hash Value, Component Hash Algorithm                | `hashes[]` (`alg` plus hex `content`; MD5 and SHA-1 do not count alone) of every component, and of the target once a lifecycle phase is after build     |
| `CISA-MIN-013` | Component License                                             | `licenses` of the target and every component                                                                                                             |
| `CISA-MIN-014` | Component Dependency Relationship, Coverage                   | `dependencies[]`: every component is in some node's `dependsOn` or `provides`                                                                            |
| `CISA-MIN-015` | Explicitly Identifying Unknown Information                    | manual review                                                                                                                                            |
| `CISA-MIN-016` | Accommodation of Updates to SBOM Data                         | manual review                                                                                                                                            |
| `CISA-MIN-017` | Distribution and Delivery                                     | manual review                                                                                                                                            |
| `CISA-MIN-018` | Frequency                                                     | manual review                                                                                                                                            |

Three rules read the guidance where it leaves room. The hash element covers "an
executable component artifact", which does not exist for the target of an
SBOM generated before or during the build, so `CISA-MIN-012` judges the
target's hash only when `metadata.lifecycles` records `post-build`,
`operations`, `discovery` or `decommission`. The producer element replaces the
NTIA 2021 Supplier Name; CycloneDX `manufacturer` and `authors` name the
creator the element asks for, and `supplier` is accepted as well because it is
what most ecosystems record and where an `unknown` provenance marking goes. A
component that appears in `dependencies[]` only as its own node, with no other
node depending on it, is not related to the target, so `CISA-MIN-014` does not
count it as covered.

Measured on a default `cdxgen -t js --no-install-deps` BOM (spec 1.7) for
`test/data/svelte-precision`, an npm project with a lockfile version 3 whose
entries carry `integrity` and `license`, the profile scores 10 pass, 4 fail
and 4 manual. cdxgen fills the data format, generation context, tool, SBOM
version, timestamp, component name, version, identifier, hash and dependency
elements by default. Hashes come from the lockfile's `integrity` values
(SHA-512), so no installed packages are needed. A lockfile entry with only a
SHA-1 `integrity` value leaves that component without an approved hash (one
of 129 components on `test/data/package-json/v2`). The same scores hold for
`--spec-version 2.0`. `lib/validator/cisaDefaultBom.poku.js` regenerates these
BOMs and checks every rule outcome. The failing rules and the step that fills
each one:

- **Author** (`CISA-MIN-001`): the `--author` default `OWASP Foundation`
  names the tool's maintainer, so it does not count; pass `--author` with the
  person or organisation generating the SBOM.
- **Author signature** (`CISA-MIN-002`): sign the generated BOM with
  `cdx-sign` and an RSA, ECDSA or EdDSA key; cdxgen keeps signing an explicit
  step.
- **Component producer** (`CISA-MIN-010`): cdxgen does not record the
  maintaining organisation for npm packages read from a lockfile; record it in
  `manufacturer.name` or `supplier.name`, or `"unknown"` to mark the
  provenance unknown.
- **Component license** (`CISA-MIN-013`): `svelte-precision` declares no
  license in its own `package.json`, so the target component fails although
  every dependency carries the lockfile's license. On
  `test/data/package-json/v3`, whose `package.json` declares `ISC` but whose
  lockfile has no `license` fields, the dependencies fail instead; run with
  `FETCH_LICENSE=true` so their licenses are looked up in the registry.

Run the profile on its own with:

```shell
cdx-validate -i bom.json --benchmark cisa --fail-severity medium
```

### CISA and G7 minimum elements for an AI SBOM

Sixteen rules for [Software Bill of Materials for AI: Minimum
Elements](https://www.cisa.gov/resources-tools/resources/software-bill-materials-si-minimum-elements)
([PDF](https://www.bsi.bund.de/SharedDocs/Downloads/EN/BSI/KI/SBOM-for-AI_minimum-elements.pdf?__blob=publicationFile&v=4)),
which the G7 Cybersecurity Working Group (BSI, ACN, ANSSI, CSE, CISA, NCSC and
NCO, with the European Commission) published on 12 May 2026. Its elements are
in addition to the general SBOM minimum elements, so its Metadata cluster and
the component elements stay in the `cisa` benchmark, where AI model
components count as well. The `cisa-ai` rules cover the System Level
Properties, Models and Datasets clusters, and report the elements that need
the producer's documentation, including the Infrastructure, Security
Properties and KPI clusters, as one manual-review item. The test suite checks
that the rules cite every one of those elements, and
[AI_BOM.md](AI_BOM.md) maps all fifty elements onto a cdxgen AI-BOM. Every
`cisa-ai` rule, the system rules included, passes with a note on a BOM
without model or dataset components. cdxgen does not populate the system
producer that `CISA-AI-002` reads; add it to `metadata.supplier` after
generation, for example by post-processing the BOM before signing it.

| Id            | CISA/G7 element(s)                                                                                 | CycloneDX field read                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `CISA-AI-001` | System name, System version                                                                        | `metadata.component.name` / `.version`                                                                                             |
| `CISA-AI-002` | System producer                                                                                    | `metadata.supplier.name`, the deprecated `metadata.manufacture.name`, or the producer fields of `metadata.component`              |
| `CISA-AI-003` | Model name, Model version                                                                          | model component `name` / `version`                                                                                                 |
| `CISA-AI-004` | Model producer                                                                                     | model component `manufacturer.name`, `supplier.name` or `authors[].name`                                                          |
| `CISA-AI-005` | Model identifier                                                                                   | model component `purl`, `cpe`, `swid.tagId`, `omniborId[]` or `swhid[]`                                                           |
| `CISA-AI-006` | Model hash value, Model hash algorithm                                                             | model component `hashes[]`                                                                                                         |
| `CISA-AI-007` | Model license                                                                                      | model component `licenses`                                                                                                         |
| `CISA-AI-008` | Model description                                                                                  | model component `description` or `modelCard`                                                                                       |
| `CISA-AI-009` | Dataset name, Dataset identifier                                                                   | dataset component `name`, and a `purl` or other identifier, `data[].contents.url` or an `externalReferences[].url`                 |
| `CISA-AI-010` | Dataset license                                                                                    | dataset component `licenses`                                                                                                       |
| `CISA-AI-011` | System timestamp, data flow, data usage, input/output properties and intended application area; Model timestamp and training properties; Dataset content, provenance, statistical properties, sensitivity and dependency relationship; Infrastructure hardware; the Security Properties and KPI clusters | manual review                                                                                                                      |
| `CISA-AI-012` | Model properties                                                                                   | model component `modelCard.modelParameters.architectureFamily` or `modelArchitecture`                                              |
| `CISA-AI-013` | Model input-output properties                                                                      | model component `modelCard.modelParameters.inputs[]` and `outputs[]`                                                               |
| `CISA-AI-014` | Model external references                                                                          | model component `externalReferences[].url`                                                                                         |
| `CISA-AI-015` | Dataset description                                                                                | dataset component `description` or `data[].description`                                                                           |
| `CISA-AI-016` | Dataset hash                                                                                       | dataset component `hashes[]`; cdxgen references Hub datasets by repository and records no file hash, so this rule fails on them    |

Check an AI-BOM with both profiles:

```shell
cdx-validate -i aibom.json --benchmark cisa,cisa-ai
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

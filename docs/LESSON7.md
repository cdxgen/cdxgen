# Lesson 7 — Validating an SBOM against OWASP SCVS and the EU CRA

## Learning Objective

In this lesson we will produce a CycloneDX SBOM, sign it, and run it through
the new `cdx-validate` CLI to measure how well it satisfies two major
supply-chain compliance frameworks:

- **OWASP SCVS (Software Component Verification Standard)** — levels L1, L2
  and L3.
- **EU Cyber Resilience Act (CRA)** — SBOM expectations derived from Annex I
  and the ENISA guidance.

By the end, you will be able to:

1. Run `cdx-validate` locally and read its scorecards.
2. Wire it into a CI pipeline using SARIF + GitHub code scanning.
3. Plug signature verification into the same invocation so a failed
   signature blocks the pipeline alongside compliance issues.

---

## Pre-requisites

- Node.js ≥ 20
- OpenSSL (for generating keys)
- `@cyclonedx/cdxgen` globally installed (gives you `cdxgen`, `cdx-sign`,
  `cdx-verify`, and `cdx-validate`):
  ```shell
  npm install -g @cyclonedx/cdxgen
  ```

## Step 1: Produce an SBOM

From any Node.js / Python / Java project root:

```shell
cdxgen -t nodejs -o bom.json .
```

## Step 2: Baseline compliance score

Run `cdx-validate` with all defaults:

```shell
cdx-validate -i bom.json
```

You will see three sections:

1. A one-line summary:
   ```
   schemaValid=true  deepValid=true  pass=28  fail=2  manual=65  errors=1
   ```
2. A per-benchmark scorecard. Each row shows the number of pass/fail/manual
   controls and the _automatable score_ (what percentage of the automatable
   controls the BOM passes):
   ```
   OWASP SCVS (all levels)          87   20   2   65   91% (20/22)
   OWASP SCVS Level 1               36   13   0   23   100% (13/13)
   OWASP SCVS Level 2               62   15   1   46   94% (15/16)
   OWASP SCVS Level 3               87   20   2   65   91% (20/22)
   EU Cyber Resilience Act (SBOM)    8    8   0    0   100% (8/8)
   ```
3. A table listing each failing control and its remediation.

Failing controls typically include **`SCVS-2.4` — SBOM is signed** (we
haven't signed it yet) and **`SCVS-2.16` — copyrights** (cdxgen only
records copyrights when `FETCH_LICENSE=true`).

## Step 3: Sign the SBOM and re-validate

```shell
# Generate a key pair (see LESSON6 for multi-signer scenarios)
openssl genpkey -algorithm RSA -out builder_private.pem -pkeyopt rsa_keygen_bits:4096
openssl rsa -pubout -in builder_private.pem -out builder_public.pem

# Sign the BOM in place
cdx-sign -i bom.json -k builder_private.pem -a RS512 --key-id "builder-system"

# Validate and require a valid signature
cdx-validate -i bom.json --public-key builder_public.pem --require-signature
```

The `SCVS-2.4` finding should now be resolved, and the _Automatable score_
for SCVS L2 should jump (the exact delta depends on the rest of your
project). If the signature were invalid, `cdx-validate` would exit with
code **4** and refuse to report success.

## Step 4: Filter by benchmark

Running all benchmarks at once is handy locally, but in a CI gate you may
want to focus on exactly one framework. For example, EU CRA only:

```shell
cdx-validate -i bom.json --benchmark cra --fail-severity high -r json -o cra-report.json
```

Or SCVS Level 2 only (the common "production-grade" target):

```shell
cdx-validate -i bom.json --benchmark scvs-l2 --no-include-manual
```

## Step 4b: Gather evidence for manual SCVS controls with `cdx-audit`

Several SCVS controls remain manual because they cannot be proven from the BOM
alone, but cdxgen can still help you collect supporting evidence. In
particular, `cdx-audit` can inspect upstream repositories and surface workflow,
publishing, provenance, and source-correlation signals that are useful when
reviewing controls such as:

- `SCVS-2.8` — SBOM is analyzed for risk
- `SCVS-3.3` — Application uses CI build pipeline
- `SCVS-3.6` — No arbitrary code execution
- `SCVS-4.10` — Version-to-source correlation
- `SCVS-4.11` — Package repository auditability
- `SCVS-6.1` — Point of origin verifiable
- `SCVS-6.2` — Chain of custody auditable

Run predictive audit against the same BOM:

```shell
cdx-audit --bom bom.json --scope required
```

Use the resulting console table, SARIF, or CycloneDX annotations as evidence
for your manual review notes. When the dependency belongs to an external
maintainer, the next-step guidance will also suggest opening an upstream issue
or discussion instead of assuming you can remediate the repository directly.

## Step 5: Upload SARIF to GitHub code scanning

`cdx-validate` emits SARIF 2.1.0 out of the box. In a workflow:

```yaml
- name: Validate SBOM
  run: cdx-validate -i bom.json -r sarif -o cdx-validate.sarif --fail-severity high
  continue-on-error: true

- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: cdx-validate.sarif
    category: cdx-validate
```

Every finding becomes a dot on GitHub's Code Scanning tab, with the
original SCVS / CRA identifier in `ruleId`, the remediation in `help.text`,
and the severity mapped to SARIF's `level` (`error` / `warning` / `note`).

## Step 6: Embed findings as CycloneDX annotations

If you want the report to travel with the BOM itself, use the `annotations`
reporter. The output is a valid CycloneDX document with every finding
appearing as a `annotations[]` entry under `cdx:validate:*` properties:

```shell
cdx-validate -i bom.json -r annotations -o bom-annotated.json
```

Downstream tooling (including the `bom-audit` engine in cdxgen itself) can
read these annotations directly — there is no separate format to parse.

## Step 7: Wire it all together in CI

A typical production gate looks like this:

```yaml
jobs:
  sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Produce SBOM
        run: cdxgen -t nodejs -o bom.json .
      - name: Sign SBOM
        run: cdx-sign -i bom.json -k ${{ secrets.BUILDER_PRIVATE_KEY_PATH }} -a RS512 --key-id builder-ci
      - name: Validate SBOM
        run: |
          cdx-validate \
            -i bom.json \
            --public-key builder_public.pem \
            --require-signature \
            --benchmark scvs-l2,cra \
            --fail-severity high \
            -r sarif -o cdx-validate.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: cdx-validate.sarif
          category: cdx-validate
      - uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: bom.json
```

This produces a signed SBOM, proves via `--require-signature` that the
signature verifies, asserts that SCVS L2 and CRA both hold, fails the job
if any rule fails at severity _high_ or above, and publishes the SARIF log
to GitHub so reviewers can triage failures directly in the Security tab.

## Going further

- The full rule catalog (with per-control severity and SCVS level) is
  documented in [`CDX_VALIDATE.md`](./CDX_VALIDATE.md).
- Combine `cdx-validate` with `bom-audit` (see [`BOM_AUDIT.md`](./BOM_AUDIT.md))
  — both tools share the same annotations format.
- For reproducible build + sign + validate pipelines across multiple
  signers see [`LESSON6.md`](./LESSON6.md).

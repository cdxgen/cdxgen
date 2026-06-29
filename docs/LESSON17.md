# Lesson 17 — License Normalization, Enrichment, and Compliance Policies

This lesson shows how cdxgen normalizes license data, enriches it with factual
metadata, and how to author a **license compliance policy** that turns those
facts into pass/warn/fail signals — including a CI gate that blocks a build when
a prohibited license is detected.

## Goal

By the end of this lesson you should be able to answer:

1. What does cdxgen do to license identifiers and expressions automatically?
2. What metadata gets attached to each license, and how do I read it?
3. How do I author a policy file, and what shapes does it support?
4. How do I enforce a policy in CI so a build fails on a disallowed license?

## Step 1: Understand the default behavior

License normalization and enrichment are **on by default**. For every component,
cdxgen:

- Canonicalizes raw strings to valid SPDX identifiers
  (`Apache 2.0` → `Apache-2.0`, `BSD New` → `BSD-3-Clause`).
- Upgrades deprecated identifiers (`GPL-3.0` → `GPL-3.0-only`,
  `GPL-3.0+` → `GPL-3.0-or-later`).
- Parses and validates SPDX expressions (`mit OR apache-2.0` →
  `MIT OR Apache-2.0`), including `WITH` exceptions and `+` suffixes.
- Attaches factual metadata as namespaced `properties` on each license:

  | Property                  | Example value |
  | ------------------------- | ------------- |
  | `cdx:license:category`    | `Permissive`  |
  | `cdx:license:foss`        | `true`        |
  | `cdx:license:osiApproved` | `true`        |
  | `cdx:license:fsfLibre`    | `false`       |
  | `cdx:license:deprecated`  | `false`       |

To disable these behaviors, set the environment variables
`CDXGEN_LICENSE_ENHANCE=false` and/or `CDXGEN_LICENSE_ENRICH=false`.

> cdxgen ships only **factual** flags (category, OSI/FSF approval, deprecation).
> Any legal conclusion — what is "allowed" or "disallowed" — is supplied by you
> through a policy file. cdxgen does not bundle legal opinions.

## Step 2: Author a policy file

A policy is a YAML file with a `license_policies` list. Each entry matches a
license either by **license_key** (an SPDX identifier) or by **category**, and
assigns a **label**. A `license_key` match takes precedence over a `category`
match.

```yaml
license_policies:
  - license_key: MIT
    label: approved
  - license_key: GPL-3.0-only
    label: prohibited
  - category: Copyleft
    label: prohibited
```

Labels are normalized to one of three compliance alerts:

| Alert     | Triggered by labels containing                          |
| --------- | ------------------------------------------------------- |
| `pass`    | `approve`, `pass`, `allow`, or `green`                  |
| `warning` | `restrict`, `warn`, or `yellow`                         |
| `error`   | `prohibit`, `reject`, `fail`, `error`, `deny`, or `red` |

> Tip: use stems the normalizer recognizes. `prohibited` and `rejected` map to
> `error`; the literal word `denied` does **not** (it lacks the `deny` stem), so
> prefer `prohibited`.

The result is emitted as a `cdx:license:complianceAlert` property on each license
and rolled up to the component (the worst alert across its licenses wins).

This format is compatible with ScanCode's license-policy plugin (`license_key` →
`label`), extended to also key on `category`, so existing policy files can be
reused.

### Example shapes

**Allow-list by category** (everything copyleft is flagged):

```yaml
license_policies:
  - category: Permissive
    label: approved
  - category: Public Domain
    label: approved
  - category: Copyleft
    label: prohibited
  - category: Copyleft Limited
    label: warning
```

**Deny specific identifiers** (precise control over individual licenses):

```yaml
license_policies:
  - license_key: AGPL-3.0-only
    label: prohibited
  - license_key: SSPL-1.0
    label: prohibited
  - license_key: BUSL-1.1
    label: warning
```

Valid categories follow the ScanCode taxonomy: `Permissive`, `Copyleft`,
`Copyleft Limited`, `Patent License`, `Public Domain`, `CLA`, `Commercial`,
`Non-Commercial`, `Proprietary Free`, `Free Restricted`, `Source-available`,
and `Unstated License`.

## Step 3: Run a scan with the policy

Pass the policy with `--license-policy` (or the `CDXGEN_LICENSE_POLICY`
environment variable):

```bash
cdxgen -t js -o bom.json --license-policy policy.yml .
```

Inspect the resulting alerts:

```bash
grep -A1 complianceAlert bom.json | head
```

By default a violation only **annotates** the BOM. To make cdxgen abort with a
non-zero exit code on any `error`-level license, add `--fail-on-error`:

```bash
cdxgen -t js -o bom.json --license-policy policy.yml --fail-on-error .
```

```text
License policy violation: 2 component(s) use a prohibited license. Found: pkg:npm/foo@1.0.0; pkg:npm/bar@2.3.1
```

## Step 4: Enforce the policy in CI

cdxgen ships an example policy that disallows the GPL family of licenses at
[`contrib/license-policy.yml`](https://github.com/CycloneDX/cdxgen/blob/master/contrib/license-policy.yml),
and a workflow that runs it against cdxgen's own dependencies at
`.github/workflows/license-policy.yml`. The key step is:

```yaml
- name: Enforce license policy (disallow GPL-family licenses)
  run: |
    node bin/cdxgen.js -t js -o bom.json \
      --license-policy contrib/license-policy.yml \
      --fail-on-error \
      --no-recurse .
  env:
    CDXGEN_LICENSE_ENRICH: "true"
```

Because `--fail-on-error` is set, the workflow turns the `cdx:license:complianceAlert`
annotations into a hard gate: if any dependency resolves to a GPL, LGPL, or AGPL
license, the job exits non-zero and the pull request is blocked.

Adapt the policy file to your own organization's allowed/disallowed lists, then
wire the same step into your project's CI.

## Step 5: Comprehensive auditing with `cdx-audit`

`cdxgen --license-policy` evaluates the BOM produced for the project you scan.
For a deeper, supply-chain-wide evaluation, pass the same policy to
[`cdx-audit`](CDX_AUDIT.md):

```bash
# Evaluate an existing BOM directly
cdx-audit --bom bom.json --direct-bom-audit --license-policy policy.yml

# Predictive mode: also evaluate the child SBOMs generated from cloned sources
cdx-audit --bom bom.json --license-policy policy.yml
```

In predictive mode, `cdx-audit` clones each dependency's upstream source and
generates a child SBOM to assess supply-chain risk. With `--license-policy`, the
license policy is evaluated against those child SBOMs **as well as** the input
BOM, so source-derived and deeper transitive licenses are covered. License
violations appear as a dedicated table next to the supply-chain findings, and a
prohibited license causes a non-zero (`3`) exit.

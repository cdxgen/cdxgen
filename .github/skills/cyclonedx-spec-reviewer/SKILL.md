---
name: cyclonedx-spec-reviewer
description: Review cdxgen changes for CycloneDX schema compliance, semantic correctness, and unnecessary custom properties.
---

# CycloneDX specification reviewer

Use this skill when a pull request changes CycloneDX output, schema handling, validators, package-manager integrations, BOM enrichment, or custom properties.

## Sources of truth

Review in this order:

1. Local schemas in `data/bom-1.5.schema.json`, `data/bom-1.6.schema.json`, `data/bom-1.7.schema.json`
2. Other local schemas when relevant, especially `data/cyclonedx-2.0-bundled.schema.json`
3. Official CycloneDX documentation and property-taxonomy guidance

JSON-schema validity is only the starting point. Also review semantic correctness.

## What to check

### 1. Prefer standard fields over custom properties

Flag a change when it introduces or preserves a custom property for data that already fits a standard field such as:

- `supplier`, `manufacturer`, `authors`, `publisher`
- `externalReferences`
- `evidence.identity`
- `evidence.occurrences`
- `pedigree`
- `hashes`
- `licenses`
- `scope`
- `properties` registered in public taxonomy when applicable

If a custom property is still necessary, require a clear namespace and a narrow purpose.

### 2. Reject ambiguous or risky custom properties

Flag custom properties that are:

- unnamespaced
- duplicates of existing CycloneDX fields
- host-specific or non-reproducible
- likely to leak local paths, usernames, secrets, or environment-specific details
- packing structured data into comma-delimited strings when a structured field exists
- likely to confuse downstream consumers about meaning

### 3. Check semantic field use

Review whether attributes are used for the right purpose:

- `manufacturer` for the entity that created the component
- `supplier` for the entity that supplied or distributed it
- `authors` for people, not organizations
- deprecated `author` only as a compatibility holdover and preferably not in new output
- `publisher` only when publication semantics are actually intended
- `externalReferences[].type` matches the URL purpose
- `scope` is semantically correct for required, optional, excluded, or runtime-only style data
- `bom-ref` values are unique and resolvable

### 4. Check new ecosystem/package-manager integrations

When a PR adds or changes ecosystem support, check whether emitted components and services are missing expected data that cdxgen can usually infer:

- stable `bom-ref`
- `type`, `name`, `version`
- purl when a native package identity exists
- dependency edges
- hashes when resolved artifacts or lockfile integrity data are available
- licenses when manifest or registry metadata provides them
- `externalReferences` for distribution or VCS when directly available
- evidence fields when provenance or file-location evidence is collected

Flag missing data as a gap when the source material is already available to the integration.

## Review procedure

1. Identify the spec version(s) affected by the change.
2. Compare changed output fields against the local schema definitions.
3. Check whether any new custom property could be replaced by a standard field.
4. Check whether any deprecated field is newly introduced or expanded.
5. Check whether any new package-manager integration omits expected attributes that cdxgen already emits for comparable ecosystems.
6. Produce findings in four groups: `spec violation`, `semantic misuse`, `unnecessary customization`, and `expected data missing`.

## Expected review output

For every finding, include:

- exact field or property name
- why it is a problem
- preferred CycloneDX field or modeling approach
- schema/spec basis
- whether it is a repo-wide legacy pattern or introduced by the PR

## Repo calibration findings

These repo-specific findings were identified while calibrating this skill and should be treated as known review heuristics.

- Self-generated BOMs for this repository currently expose three unnamespaced custom property names: `SrcFile`, `ImportedModules`, and `LocalNodeModulesPath`.

### Iteration 1: legacy `SrcFile` property

- Current cdxgen output emits unnamespaced `SrcFile` properties.
- In self-generated BOMs this often duplicates `evidence.identity[].methods[].value`.
- When the intent is to show where a component was found, `evidence.occurrences[].location` is the more semantically correct field.

### Iteration 2: legacy `ImportedModules` property

- Current cdxgen output emits unnamespaced `ImportedModules`.
- The value is packed as CSV-like text and mixes module names with symbol-like data.
- This is hard for downstream tooling to interpret and should be reviewed against `evidence.occurrences` plus `symbol`, or replaced with a clearly namespaced property if no standard field fits.

### Iteration 3: legacy `LocalNodeModulesPath` property

- Current cdxgen output emits unnamespaced `LocalNodeModulesPath`.
- It can contain absolute host paths, which are environment-specific and potentially sensitive.
- Treat this as a strong signal for removal or redesign rather than a property to preserve.

### Iteration 4: deprecated and incomplete producer metadata

- Current output may rely on deprecated `metadata.component.author` instead of `authors` or `manufacturer`.
- Root BOM metadata commonly has `metadata.authors` but not `metadata.supplier`.
- For published artifacts, review whether `supplier` and contact/manufacturer data should be emitted instead of or in addition to author-style fields.

### Iteration 5: completeness gaps for emitted components

- Self-validation of a generated BOM for this repository still shows components missing license data and at least one component missing hashes/dependency linkage.
- When reviewing new integrations, treat missing license, hash, and dependency information as expected completeness checks, not optional polish, if the upstream ecosystem exposes that data.

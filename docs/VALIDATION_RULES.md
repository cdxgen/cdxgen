# Validation rules

This document is the authoritative registry of every validation rule id
`cdx-validate` emits. Rule ids are a public API: once published, an id never
changes meaning, so CI pipelines can filter on these strings.

## Severity model

| Severity  | Meaning                                                                 | Exit code                      |
| --------- | ----------------------------------------------------------------------- | ------------------------------ |
| `error`   | The BOM is not well-formed CycloneDX.                                   | 3 (or 0 with `--fail-on none`) |
| `warning` | The BOM is well-formed but has a quality issue. Never fails by default. | 0                              |
| `info`    | Informational observation. Never fails.                                 | 0                              |

Warnings never cause a non-zero exit unless `--fail-on warning` is set;
`error` findings always produce exit code 3.

## Execution order

Schema validation runs first. When it produces any `error` finding the
semantic rules are skipped, so a structurally broken BOM reports the structural
problem rather than a cascade of consequences.

## Rule registry

### Schema rules

| Rule id                      | Severity | Meaning                                                                               |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `schema.unsupported-version` | `error`  | `specVersion` is not in the supported set (1.6, 1.7).                                 |
| `schema.invalid`             | `error`  | The BOM does not conform to the CycloneDX JSON schema for its declared `specVersion`. |

### Metadata rules (`validateMetadata`)

All metadata checks produce `warning`; none can fail the BOM on their own.

| Rule id                                   | Severity  | Meaning                                                                                          |
| ----------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `metadata.component-missing`              | `warning` | `metadata.component` is absent or empty.                                                         |
| `metadata.component-purl-missing`         | `warning` | `metadata.component` has no `purl`.                                                              |
| `metadata.component-bomref-missing`       | `warning` | `metadata.component` has no `bom-ref`.                                                           |
| `metadata.component-version-missing`      | `warning` | `metadata.component` has no `version`.                                                           |
| `metadata.component-placeholder-name`     | `warning` | `metadata.component.name` is a placeholder (`app`, `application`, `project`).                    |
| `metadata.duplicate-parent-in-components` | `warning` | Parent component `bom-ref` appears inside `metadata.component.components`.                       |
| `metadata.duplicate-parent-by-name`       | `warning` | Parent component `name` appears inside `metadata.component.components` when `bom-ref` is absent. |

### PURL rules (`validatePurls`)

| Rule id                                           | Severity  | Meaning                                                                           |
| ------------------------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `purl.crypto-asset-has-purl`                      | `error`   | A `cryptographic-asset` component has a `purl` (spec forbids it).                 |
| `crypto.asset-missing-crypto-properties`          | `error`   | A `cryptographic-asset` component lacks `cryptoProperties`.                       |
| `crypto.algorithm-missing-oid`                    | `error`   | A `cryptographic-asset` of `assetType: algorithm` has no `oid`.                   |
| `crypto.certificate-missing-algorithm-properties` | `error`   | A `cryptographic-asset` of `assetType: certificate` has no `algorithmProperties`. |
| `purl.invalid-syntax`                             | `error`   | The purl string cannot be parsed.                                                 |
| `purl.encoded-slash-without-namespace`            | `error`   | An `npm` or `golang` purl contains `%2F` in the name but has no namespace.        |
| `purl.version-missing-epoch`                      | `error`   | The component `version` does not start with the epoch qualifier value.            |
| `purl.type-not-normalized`                        | `warning` | The purl type contains uppercase characters.                                      |
| `purl.unexpected-qualifiers`                      | `warning` | Qualifiers are present on a purl type that does not use them per spec.            |
| `purl.too-many-frameworks`                        | `warning` | More than 20 components are typed as `framework`.                                 |

### Dependency / ref rules (`validateRefs`)

| Rule id                       | Severity  | Meaning                                                                                                 |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| `ref.encoded-dependency-ref`  | `error`   | A dependency `ref` contains URL-encoded characters (`%40`, `%3A`, `%2F`).                               |
| `ref.partial-tree`            | `warning` | The dependency tree has multiple empty `dependsOn` entries.                                             |
| `ref.dangling-dependency-ref` | `warning` | A dependency `ref` does not correspond to any component `bom-ref`.                                      |
| `ref.dangling-dependson-ref`  | `warning` | A `dependsOn` entry does not correspond to any component `bom-ref`.                                     |
| `ref.dangling-provides-ref`   | `warning` | A `provides` entry does not correspond to any component `bom-ref`.                                      |
| `ref.parent-without-children` | `warning` | The parent component's dependency entry has an empty `dependsOn` in a non-trivial tree.                 |
| `ref.type-mismatch`           | `warning` | A parent and child in the dependency graph have different purl types (non-`oci`/`generic`/`container`). |

### Property / evidence rules (`validateProps`)

All property checks produce `warning`; none can fail the BOM. These checks only
run when `metadata.component.type` is `application`, `framework`, or `library`.
They are cdxgen quality checks, not CycloneDX spec violations.

| Rule id                              | Severity  | Meaning                                                                                               |
| ------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------- |
| `props.missing-properties`           | `warning` | A library/framework npm or pypi component lacks `properties`.                                         |
| `props.missing-srcfile`              | `warning` | A component lacks a `internal:SrcFile` property.                                                      |
| `props.missing-workspace-properties` | `warning` | In workspace mode, a component lacks workspace-related properties.                                    |
| `props.missing-evidence`             | `warning` | A component lacks `evidence`.                                                                         |
| `props.npm-missing-tarball`          | `warning` | Some npm components lack `externalReferences.distribution` while others have it.                      |
| `props.absolute-srcfile-path`        | `warning` | A `internal:SrcFile` property value starts with `/` (absolute path).                                  |
| `props.suspicious-native-name`       | `warning` | An npm package has a native-sounding name but no `cdx:npm:native_addon` flag. Not emitted; see below. |

## Not covered by these rules

- **Compliance benchmarks** (SCVS, CRA, the CISA 2026 minimum elements and
  their AI extension). Those answer "does this satisfy a policy?" rather than
  "is this well-formed CycloneDX?" and are selected with `--benchmark`.
- **SPDX export validation.** Converted SPDX documents are checked against the
  SPDX schema, not against this registry.
- **CycloneDX 1.4 and 1.5.** Below the v13 floor; both validators reject them
  identically.
- **Suspicious native package names.** Warning on any package named `native`
  or `bindings` produced false positives for ordinary projects, so no rule id
  is emitted for it.

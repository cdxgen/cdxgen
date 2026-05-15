# Introduction

Contents of data directory and their purpose.

| Filename                | Purpose                                                                                                              |
|-------------------------|----------------------------------------------------------------------------------------------------------------------|
| bom-1.4.schema.json     | CycloneDX 1.4 jsonschema for validation                                                                              |
| bom-1.5.schema.json     | CycloneDX 1.5 jsonschema for validation                                                                              |
| bom-1.6.schema.json     | CycloneDX 1.6 jsonschema for validation                                                                              |
| bom-1.7.schema.json     | CycloneDX 1.7 jsonschema for validation                                                                              |
| cosdb-queries.json      | osquery useful for identifying OS packages for C                                                                     |
| cbomosdb-queries.json   | osquery for identifying ssl packages in OS                                                                           |
| gtfobins-index.json     | GTFOBins reference data used to enrich Linux container and live-runtime executable findings                          |
| jsf-0.82.schema.json    | jsonschema for validation                                                                                            |
| known-licenses.json     | Hard coded list to correct any license id. Not maintained.                                                           |
| lic-mapping.json        | Hard coded list to match a license id based on name                                                                  |
| pypi-pkg-aliases.json   | Hard coded list to match a pypi package name from module name                                                        |
| python-stdlib.json      | Standard libraries that can be filtered out in python                                                                |
| queries-win.json        | osquery query pack used to generate OBOM for Windows, including startup/runtime and targeted handle triage           |
| queries.json            | osquery query pack used to generate OBOM for Linux, including package, service, Secure Boot, and hardening inventory |
| queries-darwin.json     | osquery query pack used to generate OBOM for macOS, including apps, launchd, and Gatekeeper posture                  |
| rules/                  | Built-in BOM audit rule packs, including `obom-runtime`, `container-risk`, and `rootfs-hardening`                    |
| spdx-licenses.json      | valid spdx id                                                                                                        |
| spdx.schema.json        | jsonschema for validation                                                                                            |
| spdx-export.schema.json | spdx 3.0.1 jsonschema for validation                                                                                 |
| vendor-alias.json       | List to correct the group names. Used while parsing .jar files                                                       |
| wrapdb-releases.json    | Database of all available meson wraps. Generated using contrib/wrapdb.py.                                            |
| frameworks-list.json    | List of string fragments to categorize components into frameworks                                                    |
| crypto-oid.json         | Peter Gutmann's crypto oid [mapping](https://www.cs.auckland.ac.nz/~pgut001). GPL, BSD, or CC BY license             |
| glibc-stdlib.json       | Standard libraries that can be filtered out in C++                                                                   |
| component-tags.json     | List of tags to extract from component description text for easy classification.                                     |
| ruby-known-modules.json | Module names for certain known gems. Example: rails                                                                  |

## osquery query packs

The three `queries*.json` files are osquery query packs. Each entry maps a table name to an object with the following fields:

| Field           | Required | Purpose |
|-----------------|----------|---------|
| `query`         | yes      | The SQL query executed against the osquery table |
| `description`   | yes      | Human-readable description of what the query collects |
| `purlType`      | yes      | The purl type assigned to components created from query results |
| `componentType` | no       | The CycloneDX component type (defaults to `library` when absent) |
| `name`          | no       | Override the component name (useful when the table has no `name` column) |

To add a new table query, add an entry to the appropriate platform file. Keep the table name as the JSON key and mirror the entry across platform files when the table is supported on multiple operating systems.

## Rule files

Rules live in `data/rules/` as YAML files. Each file groups related rules by category. `cdx-audit` loads all files in the directory automatically.

### Rule structure

Each rule is a YAML list item with the following fields:

| Field              | Required | Purpose |
|--------------------|----------|---------|
| `id`               | yes      | Unique rule identifier, e.g. `CTR-001` |
| `name`             | yes      | Short human-readable rule title |
| `description`      | yes      | Explanation of what the rule detects and why it matters |
| `severity`         | yes      | One of `critical`, `high`, `medium`, `low`, `info` |
| `category`         | yes      | Must match the file's category, e.g. `container-risk` |
| `dry-run-support`  | yes      | `full` if the rule works against a dry-run BOM, `partial` or `none` otherwise |
| `condition`        | yes      | JSONata expression evaluated against the BOM's `components` array |
| `location`         | yes      | JSONata expression returning the location object for a matched component |
| `message`          | yes      | Human-readable finding message; supports `{{ expression }}` template placeholders |
| `mitigation`       | yes      | Recommended remediation steps |
| `evidence`         | no       | JSONata expression returning structured evidence for the finding |
| `attack`           | no       | MITRE ATT&CK tactic and technique IDs |

### JSONata condition expressions

Conditions use [JSONata](https://jsonata.org/) evaluated against the full BOM document. The expression must return an array of matching components (or an empty array when nothing matches).

Inside the condition, `$` refers to each component in the array being filtered. A typical pattern is:

```yaml
condition: |
  components[
    $prop($, 'cdx:some:property') = 'expected-value'
    and type = 'library'
  ]
```

cdxgen registers several helper functions available inside JSONata expressions:

| Function | Purpose |
|---|---|
| `$prop(component, name)` | Returns the value of a CycloneDX `properties` entry by name, or `undefined` |
| `$nullSafeProp(component, name)` | Like `$prop` but returns `null` instead of `undefined` for use inside comparisons |
| `$listContains(list, value)` | Returns `true` if the string `list` contains `value` as a comma-separated entry |
| `$firstNonEmpty(a, b, ...)` | Returns the first argument that is not `null`, `undefined`, or empty string |

### Message template placeholders

The `message` field can reference component fields and JSONata expressions using double-brace syntax:

```yaml
message: "Package '{{ name }}' at version '{{ version }}' is affected"
```

Any valid JSONata expression inside the braces is evaluated with `$` bound to the matching component.

### Adding a new rule

1. Decide which category file in `data/rules/` best fits the rule, or create a new YAML file for a new category.
2. Give the rule a unique `id` following the existing naming convention (e.g. `CTR-999` for a new container-risk rule).
3. Write the `condition` as a JSONata expression filtered over `components[...]`.
4. Test the rule by running `cdx-audit --rules data/rules/ -i your-bom.json`.
5. Add a corresponding test assertion in `lib/stages/postgen/auditBom.poku.js`.


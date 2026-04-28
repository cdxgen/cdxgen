# REPL / cdxi — Explore BOMs interactively

`cdxi` opens an interactive shell for creating, importing, querying, and reviewing CycloneDX BOMs.

It is useful when you want fast, ad hoc investigation without writing one-off scripts.

## Who should use this

- **Developers** — inspect dependencies, services, formulation data, and evidence quickly
- **AppSec engineers** — triage audit annotations, provenance signals, and dependency relationships
- **IR / platform teams** — pivot through OBOM categories and runtime inventory interactively

## Quick start

```shell
# Start an empty REPL
cdxi

# Import a BOM immediately
cdxi bom.json

# Import an enriched evidence BOM
cdxi bom.evinse.json
```

If `bom.json` exists in the current directory, `cdxi` imports it automatically.

## Common workflows

### Create a BOM and inspect it

```text
.create .
.summary
.print
.tree
```

### Search and query

```text
.search spring
.query components[name ~> /spring/i]
.sort name
.inspect pkg:npm/lodash@4.17.21
```

### Review provenance and trusted publishing

```text
.trusted
.provenance
```

### Review audit output carried in annotations

```text
.auditfindings
.auditactions
.dispatchedges
```

### Review evidence and services

```text
.occurrences
.callstack
.services
.formulation
```

### OBOM investigation pivots

```text
.osinfocategories
.processes
.services_snapshot
.startup_items
.obomtips
```

## Command reference

### BOM lifecycle

| Command          | Description                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| `.create <path>` | Generate a BOM for a local path and load it into the session               |
| `.import <path>` | Import a CycloneDX JSON BOM, SPDX JSON-LD BOM, or `.cdx` / `.proto` binary |
| `.save [path]`   | Save the current BOM                                                       |
| `.summary`       | Print a high-level BOM summary                                             |
| `.sbom`          | Print the current BOM object                                               |
| `.exit`          | Exit the shell                                                             |

### Query and navigation

| Command                            | Description                                            |
| ---------------------------------- | ------------------------------------------------------ |
| `.search <text>`                   | Case-insensitive search across common component fields |
| `.query <jsonata>`                 | Run a raw JSONata expression                           |
| `.sort <field-or-jsonata-order>`   | Sort components and print the result                   |
| `.inspect <name-or-purl-fragment>` | Print the full JSON for a matching component           |
| `.update \| query \| object \|`    | Modify components with a JSONata update expression     |

### Inventory views

| Command       | Description                                            |
| ------------- | ------------------------------------------------------ |
| `.print`      | Print components as a table                            |
| `.tree`       | Print the dependency tree                              |
| `.provides`   | Print the `provides` tree                              |
| `.cryptos`    | Show `cryptographic-asset` components                  |
| `.frameworks` | Show framework components                              |
| `.licenses`   | Show license distribution                              |
| `.tagcloud`   | Show a text cloud from component descriptions and tags |
| `.validate`   | Validate the current BOM against CycloneDX JSON Schema |

### Provenance and trust

| Command       | Description                                       |
| ------------- | ------------------------------------------------- |
| `.trusted`    | Show components with trusted publishing metadata  |
| `.provenance` | Show components with registry provenance evidence |

### Audit-oriented commands

| Command          | Description                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| `.auditfindings` | Summarize `--bom-audit` and `cdx-audit` annotations from the loaded BOM       |
| `.auditactions`  | Show `cdx-audit` next actions and upstream guidance                           |
| `.dispatchedges` | Show correlated sender → receiver workflow edges captured by predictive audit |

These commands are most useful after importing a BOM generated with `--bom-audit` or a BOM annotated by `cdx-audit`.

### Evidence and SaaSBOM review

| Command            | Description                              |
| ------------------ | ---------------------------------------- |
| `.occurrences`     | Show components with occurrence evidence |
| `.callstack`       | Show components with call-stack evidence |
| `.services`        | Show services                            |
| `.vulnerabilities` | Show vulnerabilities from a VDR          |
| `.formulation`     | Show formulation data                    |

### OBOM and runtime inventory

| Command             | Description                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `.osinfocategories` | List available osquery-derived categories                                                                                    |
| `.obomtips`         | Print suggested OBOM investigation pivots                                                                                    |
| `.<category>`       | Run a built-in OS-query category command such as `.processes`, `.services_snapshot`, `.scheduled_tasks`, or `.startup_items` |

## Input types

`cdxi` can import:

- CycloneDX JSON BOMs
- SPDX JSON-LD documents, converted into a CycloneDX-like interactive view
- protobuf `.cdx` / `.proto` BOMs
- OCI references such as `ghcr.io/...` or `docker.io/...` when a CycloneDX attachment is present

## REPL history

History is stored under `$HOME/.config/.cdxgen/.repl_history`.

Set `CDXGEN_REPL_HISTORY` to override the history file location.

## Security notes

- `.create` can invoke the same dependency-resolution paths as `cdxgen`; treat untrusted source trees with the same caution you would use for CLI scans.
- `.query` and `.update` execute JSONata expressions against the loaded BOM. They are powerful and intended for trusted interactive use.
- Imported audit annotations may contain repository URLs, workflow file paths, and remediation notes. Review before sharing screenshots or session logs.

## Related docs

- [CLI Usage](CLI.md)
- [BOM Audit](BOM_AUDIT.md)
- [cdx-audit](CDX_AUDIT.md)
- [evinse](EVINSE.md)
- [OBOM lessons](OBOM_LESSONS.md)

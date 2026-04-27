# cdx-convert — CycloneDX to SPDX converter

`cdx-convert` is a dedicated CLI command for converting an existing
CycloneDX JSON BOM into an SPDX 3.0.1 JSON-LD document.

It is distributed with `@cyclonedx/cdxgen` alongside `cdxgen`,
`cdx-sign`, `cdx-verify`, and `cdx-validate`, and is also published as a
standalone binary via the `binary-builds` workflow.

---

## Quick start

```shell
# Convert bom.json (CycloneDX) to bom.spdx.json (SPDX 3.0.1)
cdx-convert -i bom.json -o bom.spdx.json

# Convert and pretty-print output
cdx-convert -i bom.json -o bom.spdx.json --json-pretty

# Skip SPDX validation (enabled by default)
cdx-convert -i bom.json -o bom.spdx.json --no-validate
```

---

## CLI reference

| Flag | Default | Description |
| --- | --- | --- |
| `-i, --input` | `bom.json` | Input CycloneDX BOM JSON file. |
| `-o, --output` | `<input>.spdx.json` | Output SPDX JSON file path. |
| `--from` | `cyclonedx` | Input format alias (`cyclonedx`, `cdx`). |
| `--to` | `spdx` | Output format alias (`spdx`, `spdx-json`, `spdx3`, `spdx3-json`). |
| `--validate` / `--no-validate` | on | Validate converted SPDX JSON output. |
| `--json-pretty` | off | Pretty-print JSON output. |

---

## Notes

- `cdx-convert` currently supports **CycloneDX JSON → SPDX JSON-LD** conversion.
- Input BOM must have `bomFormat: "CycloneDX"`.
- Use `cdxgen --format cyclonedx,spdx` when you want both outputs in one
  generation run.

# cdx-convert - CycloneDX to SPDX converter

`cdx-convert` converts an existing CycloneDX JSON BOM into SPDX 3.0.1 JSON-LD.

It is distributed with `@cyclonedx/cdxgen` alongside `cdxgen`, `cdx-sign`,
`cdx-verify`, and `cdx-validate`. It is also published as a standalone binary
via the `binary-builds` workflow.

## Scope and supported versions

`cdx-convert` supports this conversion path:

- Input: CycloneDX JSON, `bomFormat: "CycloneDX"`
- Input spec versions: `1.6` and `1.7`
- Output: SPDX `3.0.1` JSON-LD

If the input is not CycloneDX JSON, or if the CycloneDX `specVersion` is not
`1.6` or `1.7`, the command fails with a clear error.

## Quick start

```shell
# Convert bom.json (CycloneDX 1.6 or 1.7) to SPDX 3.0.1 JSON-LD
cdx-convert -i bom.json -o bom.spdx.json

# Pretty-print output JSON
cdx-convert -i bom.json -o bom.spdx.json --json-pretty

# Skip SPDX validation (enabled by default)
cdx-convert -i bom.json -o bom.spdx.json --no-validate
```

## CLI reference

| Flag                           | Default             | Description                          |
| ------------------------------ | ------------------- | ------------------------------------ |
| `-i, --input`                  | `bom.json`          | Input CycloneDX BOM JSON file.       |
| `-o, --output`                 | `<input>.spdx.json` | Output SPDX JSON file path.          |
| `--validate` / `--no-validate` | on                  | Validate converted SPDX JSON output. |
| `--json-pretty`                | off                 | Pretty-print JSON output.            |

## Conversion algorithm

The conversion logic uses `convertCycloneDxToSpdx()` in
`lib/stages/postgen/spdxConverter.js`.

High-level flow:

```text
read input file
  -> parse JSON
  -> validate input shape and CycloneDX specVersion (1.6 or 1.7)
  -> convert CycloneDX object to SPDX 3.0.1 JSON-LD graph
  -> validate SPDX output (unless --no-validate)
  -> write output file
```

SPDX mapping behavior includes:

- document-level creation info and root element mapping
- component mapping to SPDX packages/files
- dependency mapping to SPDX relationships
- retention of CycloneDX-specific data in `cdxgen:cyclonedx` extension fields
  when there is no direct SPDX 3.0.1 field

## Features

- deterministic field mapping for CycloneDX 1.6/1.7 to SPDX 3.0.1 conversion
  when the input BOM includes stable `serialNumber` and `metadata.timestamp`
- optional SPDX validation after conversion
- predictable output naming (`<input>.spdx.json` when `-o` is omitted)
- directory auto-creation for output paths
- preservation of key compliance metadata in extension fields, including
  authors, publisher, maintainers, tags, and licenses

## Limitations

- input must be CycloneDX JSON, not XML
- only CycloneDX `1.6` and `1.7` input is accepted
- output target is fixed to SPDX `3.0.1`
- CycloneDX fields without equivalent SPDX core fields are retained via
  extension fields, not promoted to standard SPDX core fields

## When to use cdx-convert vs cdxgen --format spdx

Use `cdx-convert` when you already have a CycloneDX JSON file and need SPDX.

Use `cdxgen --format spdx` or `cdxgen --format cyclonedx,spdx` when you are
generating a new BOM and want SPDX output during the same run.

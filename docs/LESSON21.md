# Lesson 21 - Exporting CycloneDX BOMs to SPDX with cdx-convert

Your downstream consumers, partners, and regulators do not all speak
CycloneDX. Some require SPDX. Others accept only an older CycloneDX version
because their tooling has not caught up. Rather than regenerate the BOM from
scratch for each consumer, cdxgen ships a dedicated converter, `cdx-convert`,
that rewrites an existing CycloneDX document into SPDX 3.0.1 JSON-LD or into a
different CycloneDX spec version.

## Goal

By the end of this lesson you should be able to answer:

1. How do I convert a CycloneDX 1.6 or 1.7 BOM to SPDX 3.0.1 JSON-LD?
2. How do I produce a legacy CycloneDX document (1.5, 1.6, or 1.7) from a
   newer one, and what gets dropped?
3. How do I round-trip BOMs through the protobuf binary format?
4. When should I trust the converter output, and how do I validate it?
5. How do I wire conversion into a release pipeline?

## Prerequisites

- Node.js >= 24 (the v13 floor)
- `@cdxgen/cdxgen` installed globally, which provides `cdxgen` and
  `cdx-convert`:

```shell
npm install -g @cdxgen/cdxgen
```

- An existing CycloneDX 1.6 or 1.7 BOM. If you do not have one handy:

```shell
cdxgen -t nodejs -o bom.json .
```

## Step 1: Convert CycloneDX to SPDX 3.0.1

The default conversion target is SPDX. With no extra flags, `cdx-convert` reads
a CycloneDX 1.6 or 1.7 JSON BOM and writes SPDX 3.0.1 JSON-LD:

```shell
cdx-convert -i bom.json -o bom.spdx.json
```

The output path is optional. If you omit `-o`, the converter derives
`<input>.spdx.json` automatically. Pretty-print when you want human-readable
output: `cdx-convert -i bom.json --json-pretty`.

The converter accepts only CycloneDX 1.6 or 1.7 input for the SPDX path. A BOM
at any other `specVersion` is rejected with a clear error.

### Inspecting the SPDX output

The SPDX 3.0.1 document is a JSON-LD graph. The `@context` points at the
official SPDX context URL, and `@graph` contains the CreationInfo,
SpdxDocument, package elements, and relationship elements:

```shell
jq '.["@context"]' bom.spdx.json
# "https://spdx.org/rdf/3.0.1/spdx-context.jsonld"

jq '.["@graph"] | length' bom.spdx.json
```

Each CycloneDX component becomes an SPDX package (or `software_File` for
file-type components) with `software_packageUrl` set to the original purl:

```shell
jq '.["@graph"][] | select(.type == "software_Package") | {name, spdxId, "purl": .software_packageUrl}' bom.spdx.json
```

CycloneDX dependencies become SPDX `Relationship` elements with
`relationshipType: "dependsOn"`:

```shell
jq '.["@graph"][] | select(.type == "Relationship") | {from, to}' bom.spdx.json | head -40
```

Fields with no direct SPDX 3.0.1 equivalent (properties, evidence, pedigree,
licenses, supplier, and so on) are preserved inside an `extension` block keyed
`cdxgen:cyclonedx`, so no compliance metadata is silently lost.

## Step 2: Cross-version CycloneDX conversion

When a consumer needs an older CycloneDX document, pass the target version to
`--to`:

```shell
cdx-convert -i bom.json --to 1.6
cdx-convert -i bom.json --to 1.5
```

The output filename defaults to `<input>-<version>.<ext>`. For example,
`bom.json --to 1.6` writes `bom-1_6.json`. The converter refuses to overwrite
the input file, so an explicit `-o` is required only when you want a custom
name.

The reshaping uses `applySpecVersionCompatibility()` from
`lib/stages/postgen/specVersionCompat.js`, the same normalizer that fresh BOM
generation uses, so `cdx-convert --to 1.6` and `cdxgen --spec-version 1.6`
produce the same result.

Conversion is not purely subtractive. Beyond removing fields the target version
does not define, it reshapes fields the versions model differently.
`evidence.identity` is a single object up to 1.5 and an array from 1.6, so a
downgrade past that boundary keeps the first identity and drops
`concludedValue`. Component types the target version does not define are
filtered out, and dependencies pointing at pruned components are removed so the
graph never references a missing `bom-ref`.

Every field path that did not survive is listed on stderr before the file is
written, so a lossy downgrade is never silent:

```text
Converting to CycloneDX 1.6 dropped 5 field path(s) that version does not define:
  - citations
  - citations.attributedTo
  ...
```

## Step 3: Protobuf input and output

cdxgen can serialize BOMs to a compact protobuf binary using the optional
`@cdxgen/cdx-proto` dependency. Export one during generation:

```shell
cdxgen -t nodejs -o bom.json --export-proto --proto-bin-file bom.cdx .
```

`cdx-convert` auto-detects protobuf input from the file extension (`.cdx`,
`.cdx.bin`, or `.proto`) and decodes it transparently. There is no separate
input-format flag to pass:

```shell
# Convert a protobuf BOM directly to SPDX
cdx-convert -i bom.cdx -o bom.spdx.json

# Cross-convert protobuf to protobuf at a different version
cdx-convert -i bom.cdx --to 1.6 -o bom-1_6.cdx

# protobuf -> JSON, or JSON -> protobuf based on output extension
cdx-convert -i bom.cdx --to 1.7 -o bom-from-proto.json
cdx-convert -i bom.json --to 1.7 -o bom-as-proto.cdx
```

When the output path ends in a protobuf extension, the converter writes binary
protobuf. When it ends in `.json`, it writes JSON. Protobuf support requires
the optional `@cdxgen/cdx-proto` dependency, which installs `@bufbuild/protobuf`. If
they are missing, the error message tells you exactly what to install.

## Step 4: Validating the converted output

Validation is on by default. For SPDX output, the converter runs
`validateSpdx()` from `lib/validator/bomValidator.js` against the SPDX 3.0.1
schema. If validation fails, the file is not written and the exit code is 1:

```shell
cdx-convert -i bom.json -o bom.spdx.json
echo $?
# 0 on success, 1 on validation failure or bad input
```

Skip validation when you trust the input structure:
`cdx-convert -i bom.json -o bom.spdx.json --no-validate`.

For CycloneDX version conversion, the converter validates against the bundled
schema when the target is 1.6, 1.7, or 2.0. For other versions (such as 1.5),
it prints a warning and writes the file without a schema check.

## Step 5: CI integration sketch

A release pipeline generates a CycloneDX BOM, exports an SPDX sidecar,
downgrades a legacy copy, and uploads them as release artifacts:

```yaml
jobs:
  release-boms:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - run: npm install -g @cdxgen/cdxgen
      - run: cdxgen -t nodejs -o bom.json --spec-version 1.7 .
      - run: cdx-convert -i bom.json -o bom.spdx.json --json-pretty
      - run: cdx-convert -i bom.json --to 1.6 -o bom-1_6.json
      - run: cdx-validate -i bom.json && cdx-validate -i bom-1_6.json
      - name: Attach BOMs to release
        if: startsWith(github.ref, 'refs/tags/')
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh release upload "${GITHUB_REF_NAME}" bom.json bom.spdx.json bom-1_6.json
      - uses: actions/upload-artifact@v4
        with:
          name: boms
          path: |
            bom.json
            bom.spdx.json
            bom-1_6.json
```

Use `cdx-convert` when you already have a CycloneDX file and need SPDX or a
different CycloneDX version. Use `cdxgen --format spdx` (or
`cdxgen --format cyclonedx,spdx`) when you are generating a new BOM and want
SPDX output during the same run. Use `cdxgen --spec-version` when you are
generating directly at an older version instead of downgrading afterward.

## What to take away

1. `cdx-convert -i bom.json` exports SPDX 3.0.1 JSON-LD from any CycloneDX 1.6
   or 1.7 BOM, with schema validation on by default.
2. `--to 1.5`, `--to 1.6`, and `--to 1.7` cross-convert between CycloneDX
   versions using the same normalizer as fresh generation, and every dropped
   field path is reported on stderr.
3. Protobuf input and output are auto-detected from the file extension, so
   `.cdx` files round-trip through the converter without extra flags.
4. The converter never silently overwrites its input, and output naming is
   deterministic when `-o` is omitted.
5. For new BOMs, `cdxgen --format spdx` produces SPDX in one step; reserve
   `cdx-convert` for transforming existing files.

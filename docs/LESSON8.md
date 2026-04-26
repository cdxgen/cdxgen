# Lesson 8 — Exporting SPDX 3.0.1 SBOMs

## Learning objective

In this lesson we will generate a CycloneDX SBOM, export it as SPDX 3.0.1
JSON-LD, and validate the generated SPDX document.

By the end, you will be able to:

1. Generate SPDX 3.0.1 output directly from cdxgen.
2. Produce CycloneDX and SPDX exports in the same run.
3. Use the `.spdx.json` extension to switch formats automatically.
4. Validate the generated SPDX document as part of the export flow.

---

## Pre-requisites

- Node.js ≥ 20
- `@cyclonedx/cdxgen` installed globally:

  ```shell
  npm install -g @cyclonedx/cdxgen
  ```

## Step 1: Generate a CycloneDX SBOM

Start with the default CycloneDX export:

```shell
cdxgen -t nodejs -o bom.cdx.json .
```

This remains the default behaviour and is useful when you need the native
CycloneDX document for signing, Dependency-Track uploads, or protobuf export.

## Step 2: Export SPDX 3.0.1 only

To emit SPDX 3.0.1 JSON-LD instead, request the SPDX format explicitly:

```shell
cdxgen -t nodejs --format spdx -o bom.spdx.json .
```

cdxgen first builds and validates the CycloneDX BOM, then converts the final BOM
into SPDX 3.0.1 and validates the generated SPDX export before writing it.

## Step 3: Emit CycloneDX and SPDX together

If you need both formats for downstream tooling, request both in one run:

```shell
cdxgen -t nodejs --format cyclonedx,spdx -o bom.cdx.json .
```

This creates:

- `bom.cdx.json` — the CycloneDX SBOM
- `bom.spdx.json` — the sibling SPDX 3.0.1 export

This is a good option when CycloneDX is still your primary interchange format
but some consumers require SPDX.

## Step 4: Let the file extension select SPDX automatically

If the output file ends with `.spdx.json`, cdxgen automatically switches to the
SPDX export format even without `--format spdx`:

```shell
cdxgen -t nodejs -o api.spdx.json .
```

This makes it easy to integrate SPDX output into CI jobs and artifact naming
conventions.

## Step 5: Keep validation enabled

SPDX export validation runs when `--validate` is enabled, which is the default:

```shell
cdxgen -t nodejs --format spdx --validate -o bom.spdx.json .
```

Use `--no-validate` only when you are intentionally skipping validation for a
local experiment or debugging session.

## Step 6: Use SPDX export in automation

A simple CI example:

```yaml
jobs:
  sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Generate CycloneDX + SPDX SBOMs
        run: cdxgen -t nodejs --format cyclonedx,spdx -o bom.cdx.json .
      - uses: actions/upload-artifact@v4
        with:
          name: sbom-exports
          path: |
            bom.cdx.json
            bom.spdx.json
```

## Going further

- Use [`CLI.md`](./CLI.md) for the full argument reference.
- Use [`LESSON6.md`](./LESSON6.md) if you need to sign the CycloneDX output.
- Use [`LESSON7.md`](./LESSON7.md) if you want to validate CycloneDX SBOMs for
  compliance after generation.

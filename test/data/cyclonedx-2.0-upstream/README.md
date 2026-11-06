# Upstream CycloneDX 2.0 example documents

Every `valid-*.json` and `invalid-*.json` file in this directory is copied
verbatim from the CycloneDX specification repository's test resources:

- Source: https://github.com/CycloneDX/specification
- Branch: `2.0-dev`
- Commit: `ea8c3605829d1da13339a0790b6da73548e42a6b`
- Path: `tools/src/test/resources/2.0/`

This is the draft pinned for cdxgen's CycloneDX 2.0 work (cdxgen/cdxgen#4589);
the same commit supplies `data/cyclonedx-2.0-bundled.schema.json`,
`data/behavior-taxonomy.schema.json` and `data/cryptography-defs.schema.json`.
When the pinned draft moves, refresh the schemas, regenerate the validators
(`node contrib/gen-validators.mjs`) and re-copy this directory in one change.

The licence is Apache-2.0 (see `LICENSE`, the upstream repository's licence
file at that commit).

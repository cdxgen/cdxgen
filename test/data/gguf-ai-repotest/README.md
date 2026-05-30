# GGUF AI repotest fixture

This fixture directory is populated by `write-gguf-fixtures.mjs` during repo tests.

It creates a tiny GGUF header-only artifact that exercises:

- spec-compliant GGUF filenames
- `general.file_type` → encoding mapping
- architecture-specific context window extraction
- GGUF source/repository metadata to CycloneDX external references
- GGUF base-model lineage to `pedigree.ancestors`
- GGUF tokenizer metadata to safe `cdx:gguf:*` custom properties
- GGUF datasets / task / text I/O mapping into CycloneDX `modelCard`
- GGUF shard metadata on the emitted file component

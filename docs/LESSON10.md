# Tutorials - Auditing Cargo workspaces, caches, and native build surfaces

This lesson shows how to use cdxgen for three related Cargo workflows:

- generate richer SBOMs for Cargo workspaces
- catalogue cached crate artifacts with the new `cargo-cache` project type
- review Cargo-native predictive audit signals, including workspace/build-role prioritization and workflow/build correlations

## 1) Generate a Cargo workspace SBOM with formulation and BOM audit

```bash
cdxgen -t cargo \
  --include-formulation \
  --bom-audit \
  --bom-audit-scope required \
  -o bom.json \
  /path/to/cargo-workspace
```

Why this matters:

- `Cargo.toml` workspace members and inherited dependencies are captured more faithfully
- formulation captures `build.rs`, build-helper, target, and workspace metadata
- `--bom-audit` adds Cargo-native rules such as yanked crates, mutable Cargo setup actions, and native build workflow correlations

## 2) Catalogue the local Cargo cache

Use the new cache-oriented project type when you want inventory of cached crate archives rather than a source tree:

```bash
cdxgen -t cargo-cache -o cargo-cache-bom.json .
```

By default this catalogs:

- `$CARGO_HOME/registry/cache/**/*.crate`
- or `$HOME/.cargo/registry/cache/**/*.crate`

Override the cache location with `CARGO_CACHE_DIR`:

```bash
CARGO_CACHE_DIR=/mnt/shared/cargo-cache \
  cdxgen -t cargo-cache -o cargo-cache-bom.json .
```

The resulting components include:

- Cargo package identity from cached crate filenames
- SHA-256 digests of the cached crate archives
- `cdx:cargo:cacheSource=registry-cache`

## 3) Understand Cargo prioritization in predictive audit

When `cdx-audit` or `cdxgen --bom-audit` must trim a large Cargo queue, cdxgen now keeps:

1. runtime-facing crates
2. required/direct crates
3. build-only workspace helper crates

This helps triage focus on the crates most likely to influence the shipped runtime before spending time on build-only helpers.

## 4) Review Cargo-native workflow/build correlations

Cargo predictive audit now correlates:

- Cargo formulation metadata such as `cdx:cargo:hasNativeBuild`
- build.rs capability signals such as `process-execution` and `network-access`
- exact GitHub Actions used to set up Cargo or cache Cargo state
- workflow `cargo build`, `cargo test`, `cargo package`, and `cargo publish` steps

Examples of the resulting BOM-audit rules:

- `INT-012` — native Cargo build surface plus mutable Cargo setup action
- `INT-013` — native Cargo build surface exercised by Cargo workflow build/test/package steps

## 5) Investigate the BOM interactively with `cdxi`

```bash
cdxi bom.json
```

Useful Cargo pivots:

```text
.cargohotspots
.cargoworkflows
.auditfindings
.formulation
.tree
```

Recommended flow:

1. `.cargohotspots` to find yanked crates, git/path sources, target-scoped dependencies, and build-only workspace helpers
2. `.cargoworkflows` to compare Cargo formulation with setup/cache/build workflow steps
3. `.auditfindings` to review the final BOM-audit or cdx-audit annotations

## 6) Suggested release-gate command

```bash
cdxgen -t cargo \
  --include-formulation \
  --bom-audit \
  --bom-audit-scope required \
  --bom-audit-fail-severity high \
  -o bom.json \
  /path/to/cargo-workspace
```

This keeps high-severity Cargo source/integrity findings blocking while still preserving medium-severity build/workflow correlations for review.

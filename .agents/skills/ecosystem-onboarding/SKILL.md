---
name: ecosystem-onboarding
description: Guides adding support for a new language, package manager, or lockfile format to cdxgen, covering alias registration, parser placement, the create-Lang-Bom dispatch branch, purl construction, fixtures, poku tests, and documentation. Use when asked to add or extend an ecosystem, project type, package manager, or manifest/lockfile parser.
---

# Ecosystem onboarding

Use this skill when adding a new language, package manager, or lockfile/manifest format to cdxgen. The full contributor guide is [docs/ADD_ECOSYSTEM.md](../../../docs/ADD_ECOSYSTEM.md); this skill gives the checklist and the conventions most often missed.

## Before writing code

Answer these first (from `docs/ADD_ECOSYSTEM.md`):

1. Is the ecosystem already supported under a different alias? Check `PROJECT_TYPE_ALIASES` in `lib/core/env.js` (re-exported from `lib/ecosystems/utils.js`).
2. Does a lockfile already contain everything needed (name, version, deps, integrity)? Prefer lockfile parsing over executing package managers.
3. Does it require a native tool or SDK? That affects `prepareEnv` (lib/stages/pregen), container images, and secure-mode behavior.
4. Does it need custom purl behavior (namespace rules, qualifiers)?

## Checklist

1. **Aliases** — add the canonical type and accepted aliases to `PROJECT_TYPE_ALIASES` in `lib/core/env.js:272`, and any package-manager aliases to `PACKAGE_MANAGER_ALIASES` in the same file. Note: AGENTS.md references `lib/ecosystems/utils.js`, but the definitions live in `lib/core/env.js` and are re-exported from utils.js.
2. **Parser functions** — lockfile/manifest parsers go in `lib/ecosystems/utils.js` (or a dedicated helper module under `lib/helpers/` or `lib/inventory/` for larger formats). Follow the pure-ESM, `node:`-prefixed import conventions.
3. **BOM function** — add `create<Language>Bom(path, options)` in `lib/cli/index.js`, following the same signature and return shape (`{ bomJson, dependencies, parentComponent, … }`) as existing functions.
4. **Dispatch** — register the branch in `createXBom`/`createBom` in `lib/cli/index.js`.
5. **Purls** — build purls only via `tryBuildPurl`/`applyPurl` from `lib/inventory/purl.js`. Never concatenate purl strings; if the coordinates cannot form a valid purl, drop the purl (or use `pkg:generic` with `cdx:purl:proposedType`).
6. **Hashes** — set `_integrity` on the package (`sha512-<base64>` npm-style, `sha256-<base64>` Go-style); `processHashes` converts it into a CycloneDX `hashes[]` entry. Never put integrity strings in properties.
7. **Fixtures** — add real-world sample lockfiles/manifests under `test/`.
8. **Tests** — co-located `<module>.poku.js` files (poku framework). Cover parsing and generation; treat tests as cross-platform (Windows path separators).
9. **Docs** — update `docs/PROJECT_TYPES.md`; check `docs/FEATURE_COVERAGE.md` and `docs/CLI.md` if the type adds CLI-visible behavior.
10. **CI** — consider adding a representative public repo to `.github/workflows/repotests.yml`; if no stable public repo exists, add fixture-backed repo tests under `test/data/` and exercise them from `repotests.yml`.

## Conventions that reviews flag

- **Layering**: parsers and helpers must not import from `lib/cli/index.js`. Extract shared utilities downward instead (see AGENTS.md layer table).
- **Once-per-BOM logic** belongs in `postProcess` (`lib/stages/postgen/postgen.js`), not `buildBomNSData` (runs once per language type).
- **Custom properties**: any new `cdx:*` property must be added to `docs/CUSTOM_PROPERTIES.md` or the build fails (see the `custom-property-author` skill).
- **Subprocess/network/fs**: use `safeSpawnSync`, `cdxgenAgent`, `safeExistsSync`/`safeMkdirSync` — never the raw Node APIs.
- **Completeness**: components should carry stable `bom-ref`, `type`, `name`, `version`, purl when a native identity exists, dependency edges, hashes and licenses when the source material provides them, and `externalReferences` for distribution/VCS when directly available. Reviewers treat omitted-but-available data as a gap.

## Verification

```bash
pnpm test          # poku suite including the new tests
pnpm run lint      # Biome check + autofix
node bin/cdxgen.js -t <newtype> test/<fixture-dir> -o /tmp/bom.json
```

Validate the emitted BOM against the schemas in `data/` (e.g. via `bin/validate.js`).

## Plan: Fix Angular scope=optional false positives

This plan outlines investigating and resolving issues where the Babel analyzer incorrectly marks CSS, templates, and CLI packages as optional in Angular apps, using dependency-free regex and configuration enhancements.

### Steps

1. Create a sample Angular workspace test fixture containing SCSS `@import`s, CLI scripts, and `angular.json` assets marking dependencies as used.
2. Implement `parseAngularStyleFiles` in [lib/helpers/analyzer.js](lib/helpers/analyzer.js) to scan `.css`, `.scss`, and `.less` files for `@import` and `@use` regex patterns.
3. Update `parseAngularPackageJsonScripts` in [lib/helpers/analyzer.js](lib/helpers/analyzer.js) to dynamically extract executable command names from scripts instead of relying solely on `ANGULAR_SCRIPT_COMMAND_PACKAGES`.
4. Add `assets` and `includePaths` to `ANGULAR_WORKSPACE_PACKAGE_STRING_KEYS` in [lib/helpers/analyzer.js](lib/helpers/analyzer.js) for `angular.json` parsing.
5. Add unit tests for the new parsers in `lib/helpers/analyzer.poku.js` ensuring the identified packages correctly appear in `allImports`.
6. Add new test fixtures to repotests.yml

## Implementation tracking (May 27, 2026)

### Work completed

1. Implemented production analyzer enhancements in `lib/helpers/analyzer.js`:
   - Added Angular workspace key support for `assets` and `includePaths`.
   - Added `parseAngularStyleFiles()` to detect package usage from `.css`, `.scss`, `.sass`, and `.less` files via `@import`, `@use`, `@forward`, and `url(...)` references.
   - Added dynamic script executable detection for Angular/JS toolchain commands, including support for wrapper invocations such as `node ./node_modules/.bin/<tool>` and `pnpm dlx <pkg>`.
   - Added executable-to-package mapping for common Angular frontend tooling (`@angular/cli`, `tailwindcss`, `sass`, `less`, `postcss-cli`, etc.).
   - Wired style analysis into Angular evidence collection inside `findJSImportsExports()`.

2. Added regression harnesses in `lib/helpers/analyzer.poku.js`:
   - `captures Angular package usage from styles, angular.json assets/includePaths, and script executables`
   - `captures scoped package executables invoked through pnpm dlx`

3. Verified test execution:
   - Ran `pnpm exec poku lib/helpers/analyzer.poku.js`
   - Result: PASS (`1 test file(s) passed`, `0 failed`)

### Accuracy improvement tracking (Angular required-scope signal)

#### Harness A: mixed Angular app evidence (styles + scripts + angular.json)

- Expected used packages: `@angular/cli`, `@angular/compiler-cli`, `typescript`, `tailwindcss`, `bootstrap`, `@fortawesome/fontawesome-free`, `flag-icons` (7 total)
- Before implementation (baseline behavior from previous analyzer logic):
  - Detected: `@angular/cli`, `@angular/compiler-cli`, `typescript`, `@fortawesome/fontawesome-free` (4/7)
  - Missed: `tailwindcss` (CLI wrapper path), `bootstrap` (style-only `@use`), `flag-icons` (`assets` path)
  - Coverage: **57.1%**
- After implementation:
  - Detected: all 7/7 expected packages
  - Coverage: **100%**

#### Harness B: scoped CLI invocation (`pnpm dlx @angular/cli ...`)

- Expected used packages: `@angular/cli` (1 total)
- Before implementation: 0/1 (no scoped wrapper extraction)
- After implementation: 1/1
- Coverage: **0% → 100%**

#### Combined harness coverage snapshot

- Before: 4/8 = **50.0%**
- After: 8/8 = **100.0%**

## Follow-up refinement backlog

1. Expand template-only detection beyond known Angular package patterns (custom component/tag heuristics).
2. Add fixture-driven integration checks in CI (`repotests.yml`) for Angular projects that rely on style-only and CLI-wrapper-only package usage.
3. Optionally classify command-evidence-derived packages with confidence metadata to aid future scope tuning.

## Iteration 2 tracking (discussioncomment-17066480 alignment)

### Observation coverage from linked discussion comment

1. **CSS-only deps (`@use`, `@import`)**
   - Observation: packages like `material-symbols` can be used only in styles.
   - Status: **captured** via `parseAngularStyleFiles()` and fixture assertions.
2. **`angular.json` path references (`assets.input`, `styles`, `includePaths`)**
   - Observation: packages like `angular-i18n` and `bootstrap` can be used only as build config paths.
   - Status: **captured** by extending workspace key parsing to include `assets` and `includePaths`.
3. **Template usage (`fontSet`/class strings for material symbols)**
   - Observation: `material-symbols-outlined` appears in templates without TS imports.
   - Gap found in prior iteration: template string pattern was missing.
   - Status: **captured in this iteration** via Angular template pattern for `material-symbols`.
4. **CLI via npm scripts (`npx license-report`, chained scripts)**
   - Observation: CLI-only packages can be invoked by wrappers (`npx`, `npm run`).
   - Gap found in prior iteration: `npx <package>` fallback-to-package inference was missing.
   - Status: **captured in this iteration** via wrapper-aware executable extraction and package fallback for `npx`/`npm exec`/`pnpm dlx`/`yarn dlx`.

### Expanded sample app matrix (fixture-based)

Added sample apps under `test/data/`:

1. `angular-css-config-repotest` (styles + `angular.json` assets/includePaths + unused package for precision)
2. `angular-template-repotest` (template-only `material-symbols` usage + unused package)
3. `angular-cli-scripts-repotest` (`npx license-report`, chained scripts, unused package)

These fixtures are wired into `.github/workflows/repotests.yml` with required/optional scope assertions.

### Continuous comparison checkpoints

#### Unit-level regression checks (`lib/helpers/analyzer.poku.js`)

- Added/expanded Angular tests for:
  - styles/config/script evidence
  - scoped `pnpm dlx`
  - template-only `fontSet`/class signal
  - `npx` command detection with false-positive guards (`run`, `echo`)
- Result: **PASS**

#### Fixture-level integration checks (local run mirrors repotests commands)

- Generated BOMs:
  - `bom-angular-css-config-fixture.local.json`
  - `bom-angular-template-fixture.local.json`
  - `bom-angular-cli-scripts-fixture.local.json`
- Assertions passed for required/optional scope expectations across all fixtures.

#### Precision/recall snapshot (current iteration)

- Metric basis:
  - positives = expected `required` packages from style/template/script/config evidence
  - negatives = known unused fixture package (`left-pad`) expected `optional`
- Results:
  - `angular-css-config`: TP=4, FN=0, FP=0, TN=1 (recall=1.000, precision=1.000)
  - `angular-template`: TP=1, FN=0, FP=0, TN=1 (recall=1.000, precision=1.000)
  - `angular-cli-scripts`: TP=2, FN=0, FP=0, TN=1 (recall=1.000, precision=1.000)
  - **overall**: TP=7, FN=0, FP=0, TN=3 (recall=1.000, precision=1.000)

### Remaining gaps (next autonomous iteration candidates)

1. Template heuristics for additional icon/font ecosystems beyond `material-symbols`.
2. Wrapper command support for more script launchers where package identity is explicit but currently unmapped.

## Iteration 3 tracking (additional template icon/font heuristics)

### Why public samples were added in this iteration

Earlier iterations used synthetic fixtures first because they isolate the reported failure modes and provide deterministic required/optional assertions without depending on network availability or upstream repository churn. In this iteration, public GitHub samples were also downloaded and analyzed to validate the heuristics against real Angular layouts.

Downloaded public samples under `/tmp/cdxgen-angular-samples/` for local validation:

1. `primefaces/sakai-ng`
2. `coreui/coreui-free-angular-admin-template`

### Gaps found from public samples

1. `primefaces/sakai-ng` declares `primeicons`, but the previous analyzer iteration did not mark it as used.
   - Real usage appeared in Angular templates and inline component templates as `pi pi-*` classes.
   - Real usage also appeared in TypeScript metadata/data strings such as `icon: 'pi pi-fw pi-inbox'`, `expandedIcon`, and `collapsedIcon`.
2. `coreui/coreui-free-angular-admin-template` already detected `@coreui/icons` and `@coreui/icons-angular`, so no new CoreUI-specific heuristic was added.

### Production changes added

1. Added narrow Angular template/icon heuristics for:
   - `primeicons`: `pi pi-*` and `pi pi-fw pi-*`
   - `bootstrap-icons`: `bi bi-*`
   - `@fortawesome/fontawesome-free`: `fa-*`, `fas fa-*`, `far fa-*`, `fab fa-*`, `fa-solid fa-*`, `fa-regular fa-*`, `fa-brands fa-*`
2. Reused the same heuristics across:
   - external `.html` Angular templates
   - inline Angular `template` metadata strings
   - narrow icon metadata/data keys: `icon`, `expandedIcon`, `collapsedIcon`
3. Preserved precision guardrails by requiring package-specific class pair signatures rather than broad words like `icon`, `font`, `pi`, `bi`, or `fa` alone.
4. Added an Angular-evidence guard for AST string scanning so inline `template` and icon metadata heuristics only run after Angular package evidence is present in the project.

### Test fixture expansion

Updated `test/data/angular-template-repotest` to include:

1. `material-symbols`
2. `primeicons`
3. `bootstrap-icons`
4. `@fortawesome/fontawesome-free`
5. unused `left-pad` negative-control package

Updated `.github/workflows/repotests.yml` to assert all four icon/font packages are `required` and `left-pad` remains `optional`.

### Unit precision guards

Expanded `lib/helpers/analyzer.poku.js` with:

1. positive external template class cases for `pi pi-*`, `bi bi-*`, and Font Awesome classes
2. positive inline template cases
3. positive icon metadata string cases (`icon`, `expandedIcon`, `collapsedIcon`)
4. negative controls for non-icon class names such as `pilot` and `binary-icon`

### Public sample comparison

Before this iteration:

- `primefaces/sakai-ng`: expected icon deps = `primeicons`; detected = none
- `coreui/coreui-free-angular-admin-template`: expected icon deps = `@coreui/icons`, `@coreui/icons-angular`; detected = both

After this iteration:

- `primefaces/sakai-ng`: expected icon deps = `primeicons`; detected = `primeicons`
- `coreui/coreui-free-angular-admin-template`: expected icon deps = `@coreui/icons`, `@coreui/icons-angular`; detected = both

Real BOM validation:

- Ran cdxgen against `/tmp/cdxgen-angular-samples/sakai-ng`
- Assertion passed: `primeicons` is emitted with `scope == "required"`

### Updated precision/recall snapshot

- `angular-css-config`: TP=4, FN=0, FP=0, TN=1 (recall=1.000, precision=1.000)
- `angular-template`: TP=4, FN=0, FP=0, TN=1 (recall=1.000, precision=1.000)
- `angular-cli-scripts`: TP=2, FN=0, FP=0, TN=1 (recall=1.000, precision=1.000)
- **overall**: TP=10, FN=0, FP=0, TN=3 (recall=1.000, precision=1.000)

### Remaining future refinements

1. Add more public Angular samples when stable repositories with `bootstrap-icons` or Font Awesome class-only usage are identified.
2. Consider a lightweight allowlisted map for additional icon fonts only when real-world evidence and negative controls are available.

## Iteration 4 tracking (programmatic npm bin command matching)

### User feedback addressed

Observation: `license-report` from the discussion should be marked required, but this should not depend on hardcoding package names. Preferred approach: use bin command metadata from the current component/package list so invoked commands can mark the matching package purl as required.

### Implementation changes

1. Analyzer behavior changed for wrapper commands:
   - `npx license-report ...`, `npm exec <cmd>`, `pnpm dlx <cmd>`, and `yarn dlx <cmd>` now emit synthetic command evidence as `cdx:npm:bin/<command>`.
   - The analyzer no longer assumes an unknown wrapper command token is directly a package name.
2. Package metadata preservation:
   - `parsePkgLock()` now preserves `node.package.bin` as `cdx:npm:bin` and `cdx:npm:has_binary` properties for package-lock/arborist components.
3. Component scope resolution:
   - `listComponents()` can mark a component required when analyzer bin command evidence matches package bin metadata.
   - `addEvidenceForImports()` applies the same bin evidence after evidence enrichment, preventing later optional-scope normalization from undoing the match.
   - Matching supports both `cdx:npm:bin` and `cdx:npm:binPaths` metadata.

### Validation

1. Unit tests:
   - Added `lib/cli/index.poku.js` coverage proving `cdx:npm:bin/license-report` only marks the package with matching `cdx:npm:bin=license-report` as required while unrelated packages remain optional.
   - Updated analyzer test to expect command evidence (`cdx:npm:bin/license-report`) instead of package-name inference.
2. Fixture integration:
   - Updated `test/data/angular-cli-scripts-repotest/package-lock.json` with `license-report` bin metadata.
   - BOM assertion now requires both `scope == "required"` and a matching `cdx:npm:bin` property for `license-report`.
3. Regression results:
   - `pnpm exec poku lib/helpers/analyzer.poku.js lib/cli/index.poku.js`: PASS
   - Angular fixture BOM assertions: PASS for CSS/config/template/icon/bin CLI cases.

### Precision impact

- This iteration improves precision over package-name fallback: unknown wrapper commands only become required if the command is backed by bin metadata in the component list.
- `left-pad` remains optional in all Angular fixtures.

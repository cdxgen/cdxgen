# Vue.js SBOM Precision Evaluation

Scripts that measure the precision improvement of cdxgen's Vue.js component-scope
detection introduced by the vite-config-parsing branch (PR: `evaluate-cdxgen-evinse`).

The enhancement parses `vite.config.*` and `vue.config.*` files for both direct
`import` statements and CSS preprocessor `additionalData` strings, allowing cdxgen
to correctly classify build-tool and CSS-preprocessor packages as `required` instead
of `optional`.

---

## What Is Being Measured?

CycloneDX SBOM components carry a `scope` field (`required`, `optional`, `excluded`).
A `required` classification means the package is actively used at runtime or
build-time.  Packages that truly are used but are marked `optional` are
**false negatives** — they will be hidden when consumers run
`cdxgen --required-only` or filter by scope in Dependency-Track.

**Precision improvement = reduction in false negatives for vite/vue-config packages.**

Two complementary improvements ship on this branch:

| Change | Effect |
|---|---|
| `IGNORE_FILE_PATTERN` negative lookbehind for `vite.` / `vue.` | `vite.config.*` files are no longer skipped in regular JS import analysis, so direct imports (`defineConfig`, `@vitejs/plugin-vue`, etc.) are found |
| `parseVueConfigFiles` | The `additionalData` CSS preprocessor strings inside vite/vue config are scanned for package references (e.g. `@use "element-plus/theme-chalk/…"`) |

---

## Usage

### Quick mode (no network, local fixtures only)

```bash
node contrib/vue-precision-eval/index.js
```

### With real-world Vue.js apps (requires git + internet)

```bash
node contrib/vue-precision-eval/index.js --clone-samples
```

Cloned repositories are cached under `--output-dir/_repos` so subsequent runs
are fast.

### Full options

```
--apps-dir <dir>         Local directory containing Vue app sub-directories.
--baseline-cdxgen <dir>  Path to a second cdxgen installation (e.g. master clone).
                         Omit to use ASTGEN simulation mode (faster, approximate).
--output-dir <dir>       Where to write per-app BOM JSON files (default: /tmp/vue-precision-eval).
--samples <file>         JSON array of sample descriptors (default: samples.json next to this script).
--clone-samples          Git-clone remote samples before evaluating.
--help                   Show help.
```

### Side-by-side comparison against master

For the most accurate comparison, point `--baseline-cdxgen` at a local master clone:

```bash
git clone https://github.com/CycloneDX/cdxgen /tmp/cdxgen-master
cd /tmp/cdxgen-master && npm ci

node contrib/vue-precision-eval/index.js \
  --clone-samples \
  --baseline-cdxgen /tmp/cdxgen-master
```

---

## Benchmark Results (2026-05-30)

Results from running against the two built-in local fixtures **plus** four popular
real-world Vue 3 + Vite open-source admin applications.

> **Comparison mode:** ASTGEN simulation (old `ASTGEN_IGNORE_FILE_PATTERN` used as
> baseline).  Direct `parseVueConfigFiles` contribution is additive on top.

### Per-app breakdown

| App | Baseline required | Enhanced required | Delta | Notes |
|-----|:-----------------:|:-----------------:|:-----:|-------|
| vue-repotest *(fixture)* | 4 | 6 | **+2 (+33.3%)** | `@vitejs/plugin-vue`, `vite` → required |
| vue-scss-app *(fixture)* | 4 | 6 | **+2 (+25.0%)** | `@vitejs/plugin-vue`, `vite` → required |
| vue-vben-admin | 251 | 252 | **+1 (+0.0%)** | `unplugin-element-plus` → required |
| vue-pure-admin | 135 | 136 | **+1 (+0.1%)** | `vite` → required |
| naive-ui-admin | 33 | 34 | **+1 (+0.1%)** | `vite` → required |
| vue-element-plus-admin | 69 | 92 | **+23 (+1.8%)** | 23 Vite plug-ins and vue-i18n helpers → required |

### Overall

| Metric | Value |
|--------|-------|
| Apps evaluated | 6 / 6 |
| Apps with improvement | **6 / 6 (100%)** |
| Total components across all apps | 5 583 |
| Required-scope delta | **+30 components** |
| Overall precision delta | **+0.5% of total components** |

The `vue-element-plus-admin` app shows the largest single-app gain (+23 packages)
because its `vite.config.ts` imports a wide array of Vite plugins directly, all
of which were previously invisible to scope analysis.

---

## Samples File

`samples.json` lists the apps evaluated.  Add or remove entries to customise
the benchmark.  Each entry supports:

```jsonc
{
  "name":        "my-app",          // unique identifier
  "local":       true,              // true → resolved against cdxgen test/data/
  "path":        "/absolute/path",  // explicit filesystem path (overrides local)
  "repoUrl":     "https://…",       // git URL used when --clone-samples is set
  "commit":      "abc1234",         // optional pinned commit/tag
  "description": "…"               // human-readable note
}
```

---

## Output Files

After a run, `--output-dir` (default `/tmp/vue-precision-eval`) contains:

```
vue-precision-eval/
  precision-report.json      ← machine-readable aggregate report
  _repos/                    ← cloned remote repos (with --clone-samples)
  <app-name>/
    enhanced.bom.json        ← BOM generated by current branch
    baseline.bom.json        ← BOM generated by baseline / simulation
```

# Lesson 30 - Monorepos and large-project scanning

A monorepo rarely speaks one language. The same tree holds a Java service, a
Node frontend, a batch of Python jobs, and folders of fixtures and generated
code that should not be scanned at all. Scanning it well is a sequence:
recurse, collect per ecosystem, merge, dedupe, then filter. This lesson walks
that pipeline end to end; for scan-shape decisions (one BOM versus many) the
reference is [MONOREPO.md](MONOREPO.md).

## Goal

Pre-requisites: Node.js 24 or newer, `@cdxgen/cdxgen` installed globally.

By the end of this lesson you should be able to:

1. Explain what `cdxgen -r -t js,java,python .` does and what the merged BOM
   looks like.
2. Trim the merged BOM with `--only`, `--filter`, and `--exclude-type`.
3. Generate a Python BOM from `requirements.txt` files without installing.
4. Decide when `--deep` and `--profile` are worth their cost.
5. Keep large scans fast with exclude globs and concurrency settings.

## Step 1: Recursive scanning of a monorepo

Recursion is on by default (`--recurse`, alias `-r`); pass `--no-recurse` to
limit discovery to the manifests in the directory you named. With more than
one project type, cdxgen switches to its multi-type path: `createMultiXBom`
in `lib/cli/index.js` runs one collector per ecosystem (`createNodejsBom`,
`createJavaBom`, `createPythonBom`, and so on), each discovering manifests
with recursive globs such as `**/pom.xml`. Multiple root paths may be scanned
in parallel, bounded by `CDXGEN_MAX_PATH_SCANS` (default: the CPU count,
capped at 8).

```shell
cdxgen -r -t js,java,python . -o bom.json
```

Inspect the shape of the result:

```shell
jq '.components | length' bom.json                                # after the merge
jq -r '.components[] | .purl // empty' bom.json | cut -d/ -f1 | sort | uniq -c
jq -r '.metadata.component.components[] | "\(.name) \(.version // "")"' bom.json
```

That last query matters. Each sub-project's parent component is retained
under `metadata.component.components`, and the top-level parent gains
`dependsOn` links to them, so the BOM records one product built from several
projects.

Which project becomes the top-level parent? When none is given
(`--project-name`), each ecosystem's collector detects its own project from
its own manifest, and the one whose manifest sits at the scan root wins: it
describes the repository, while a manifest found deeper describes a part of it
(a web client under `tools/ui/`, a helper script's `pyproject.toml`). Among
equally deep manifests the order the ecosystems were scanned in decides, as
before. A C++ compiler repository with a root `CMakeLists.txt` and a small Vue
client in a subdirectory therefore gets the CMake project as its parent, with
the client among its sub-components. Each collector starts from the parent the
caller gave, so one ecosystem's detected project never replaces the next one's.

## Step 2: Filter the merged BOM

Filtering runs once, in post-processing (`filterBom` in
`lib/stages/postgen/postgen.js`), after every ecosystem has been collected
and merged. The filters see the whole picture, and the dependency graph is
pruned to match whatever survives:

- `--only` keeps components whose purl contains the given word (a
  first-party-only view). The document is marked
  `aggregate: "incomplete_first_party_only"` so downstream tools know it is a
  slice, not the full inventory.
- `--filter` drops components whose purl or any property value matches the
  word.
- `--exclude-type` removes whole project types, at collection time and in
  post-filtering. Multiple values are allowed.

```shell
cdxgen -r -t js,java . --only mycompany -o bom-first-party.json   # first party only
cdxgen -r . --exclude-type github --exclude-type dotnet -o bom.json
jq -r '.composition' bom-first-party.json                          # slice marker
```

## Step 3: Generate from requirements files without installing

Note an accuracy point first: current cdxgen has no `--requirement` flag.
Requirement-based generation is automatic. The Python collector looks for
`*requirements*.txt` and `requirements/*.txt` (recursively when `-r` is on)
and always parses those files directly, no virtual environment needed.

By default cdxgen then goes further: it attempts a pip install and freeze to
produce a build-lifecycle BOM with a resolved tree. To stop after parsing the
requirement files themselves, disable that step:

```shell
cdxgen -r -t python --no-install-deps . -o bom.json
cdxgen -r -t python --lifecycle pre-build . -o bom.json   # equivalent here
```

Two caveats from the collector logic: a `uv.lock` or `pylock.toml` wins over
requirements files, and an unconstrained line like `flask` yields a component
without a version, while `flask==3.0.0` is precise. Treat the result as a
declared-dependency view, not a resolved one.

Import analysis (`atom parsedeps`) also needs no installation: with `--deep`,
or when no manifest yielded a component, the collector reads the project's
imports and adds the distributions they come from, with or without
`--no-install-deps`. Imports the project satisfies itself are left out: a
module at the root or in `src/`, and the top-level packages found anywhere in
the tree (with the modules beside them), so libraries a repository keeps in
places such as `dev_tools/pylibs/` do not become PyPI components. Virtual
environments and `site-packages` directories are not counted as the project's
own.

## Step 4: Deep mode

`--deep` widens discovery rather than switching it on. Among other things it
forces scanning inside `node_modules` even when you selected project types
explicitly (see `shouldIncludeNodeModulesDir` in `lib/cli/bomAssembly.js`),
and it enables the heavier collection paths used for C/C++ applications,
live-OS scans, and OCI images. Expect it to be noticeably slower; prove the
manifest-level scan first, then enable deep analysis only where needed.

```shell
cdxgen -r -t js . --deep -o bom-deep.json
```

## Step 5: Profiles

A profile is a meta-flag: an opinionated bundle of settings that deliberately
overrides individual flags. `--profile generic` (the default) changes
nothing. The ones you will reach for in a monorepo:

- `research`: `--deep`, evidence generation, crypto inclusion
- `appsec`: `--deep` plus BOM audit
- `operational`: adds the `os` project type plus BOM audit
- `threat-modeling`: `--deep`, evidence, BOM audit
- `license-compliance`: license fetching on (`FETCH_LICENSE=true`)
- `introspect`: build introspection with annotations, formulation, and
  evidence; never `--install-deps` or `--deep`, because introspection measures
  the environment the user actually has

```shell
cdxgen -r -t python . --profile research -o bom.json
```

## Step 6: Deduplication across subprojects

When five services depend on the same npm package, the merged BOM should say
so once. After collection, `dedupeBom` (in `lib/cli/bomAssembly.js`) runs
`trimComponents`, which keys components on their purl and bom-ref, keeps the
first occurrence, and unions metadata such as properties rather than
discarding it. Sub-project parents are deduped the same way before being
attached under the top-level parent, which is why a combined multi-type BOM
does not double-count shared dependencies.

## Step 7: Performance tips for large trees

```shell
cdxgen -r -t js,java . \
  --exclude "**/node_modules/**" \
  --exclude "**/dist/**" \
  --exclude "**/fixtures/**" \
  --exclude "**/.github/**" \
  -o bom.json
```

`--exclude` (alias `--exclude-regex`) takes ignore-style globs and may be
repeated; brace expansion like `**/{dist,build}/**` works. To narrow from the
other side, `--include-regex` replaces the default discovery globs:

```shell
cdxgen -r -t js . --include-regex "**/services/*/package.json" -o bom.json
```

Concurrency and overhead knobs that matter in CI:

- `CDXGEN_MAX_PATH_SCANS`: parallel root paths (default: CPU count, max 8)
- `CDXGEN_MAX_WORKERS` and `CDXGEN_WORKER_THRESHOLD`: worker-thread pool
  sizing for CPU-bound parsing
- `--no-install-deps`: skip package manager installs entirely
- `FETCH_LICENSE=false`: skip license enrichment network calls
- `--required-only`: drop `scope: optional/excluded` components

For repeated scans, the biggest win is structural: scan only the services
that changed, and keep package manager caches persistent between runs.

## Step 8: CI sketch

```yaml
jobs:
  monorepo-sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @cdxgen/cdxgen
      - name: Generate merged monorepo BOM
        run: |
          cdxgen -r -t js,java,python . \
            --exclude "**/fixtures/**" \
            --exclude "**/.github/**" \
            --no-install-deps \
            -o bom.json
      - name: Sanity check
        run: test "$(jq '.components | length' bom.json)" -gt 0
      - uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: bom.json
```

`--no-install-deps` keeps the job honest about what it measures (declared
dependencies); drop it, or add `--deep`, once the baseline is trusted.

## What to take away

1. `-r` plus multiple `-t` types runs the multi-type pipeline: collect per
   ecosystem, merge, dedupe by purl, keep sub-project parents as sub-components.
2. `--only`, `--filter`, and `--exclude-type` shape the document after the merge.
3. Requirements-file generation needs no flag and no install; add
   `--no-install-deps` to stop at the declared view.
4. `--deep` and profiles buy coverage with time; earn them with a clean
   manifest-level baseline first.
5. Excludes and concurrency variables keep a scan inside its CI budget.

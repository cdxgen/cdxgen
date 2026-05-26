# Tutorial: Go Evinse with Golem

This lesson walks through a practical Go evidence workflow. You will generate a base Go SBOM, enrich it with Golem-backed semantic evidence, audit the Golem properties, and inspect the result in `cdxi`.

## Goal

By the end of this lesson you should be able to answer these questions for a Go project:

1. Which modules are referenced by source code?
2. Which modules are runtime scoped versus test, benchmark, fuzz, or example scoped?
3. Which modules have security-sensitive API signals?
4. Which modules and application components carry data-flow or crypto-flow evidence?
5. Does the project rely on local replacements, vendored modules, generated code, embedded assets, or native artifacts?
6. Which BOM audit findings are driven by Golem evidence?

## Prerequisites

Install cdxgen with the optional plugin package available. The normal npm package installs `@cdxgen/cdxgen-plugins-bin` as an optional dependency when the platform package is available.

```bash
corepack pnpm dlx --package=@cyclonedx/cdxgen cdxgen --version
corepack pnpm dlx --package=@cyclonedx/cdxgen evinse --help
```

If you are working from source, install dependencies first:

```bash
pnpm install --config.strict-dep-builds=true --frozen-lockfile --package-import-method copy
```

## Step 1: Generate the base Go SBOM

```bash
cdxgen -t go -o bom.json /absolute/path/to/go/project
```

Open the BOM and confirm it contains `pkg:golang/...` components. Golem evidence attaches by matching module package URLs, including versionless aliases when possible.

## Step 2: Add Go Evinse evidence

```bash
evinse -i bom.json -o bom.evinse.json -l go --golem-callgraph static /absolute/path/to/go/project
```

For routine CI, `static` is the recommended default. Use `none` when you only need source and module properties, and use `rta` or `vta` when you want a stronger root-based call graph and can tolerate more analysis cost.

If your project depends on build tags, pass them explicitly:

```bash
evinse -i bom.json -o bom.evinse.json -l go --golem-tags enterprise,linux /absolute/path/to/go/project
```

If you need test package variants:

```bash
evinse -i bom.json -o bom.evinse.json -l go --golem-tests /absolute/path/to/go/project
```

## Step 2b: Add data-flow and crypto-flow evidence

For deeper AppSec review, enable Golem data-flow. `--deep` is the shortest form and applies cdxgen's performance safeguards automatically:

```bash
evinse -i bom.json -o bom.evinse.json -l go --deep /absolute/path/to/go/project
```

For a narrower crypto-flow investigation, request only the crypto data-flow mode and pattern pack:

```bash
evinse -i bom.json -o bom.evinse.crypto.json -l go \
  --with-data-flow \
  --golem-dataflow crypto \
  --golem-dataflow-pattern-packs crypto \
  /absolute/path/to/go/project
```

Look for metadata properties such as `cdx:golem:dataFlowMode`, `cdx:golem:dataFlowSliceCount`, and `cdx:golem:cryptoDataFlowCount`. Components with crypto flows receive `cdx:golem:cryptoDataFlow=true`, `cdx:golem:cryptoDataFlowCategories`, and call-stack frames from the ordered data-flow trace.

## Step 3: Review the enriched BOM

```bash
cdxi bom.evinse.json
```

Useful commands:

```text
.golemsummary
.golemhotspots
.golemcoverage
.occurrences
.callstack
.inspect <component name or purl fragment>
```

Use `.golemsummary` first. It shows the Golem tool version, call graph and data-flow modes, package and file counts, generated/native build surface counts, security signal categories, crypto/data-flow counters, and the number of components with Golem evidence.

Use `.golemhotspots` next. It focuses on components with security signals, local replacement flags, private module candidates, or vendored module evidence.

Use `.golemcoverage` when you want to see all components that received usage scope, occurrence kind, occurrence, or call-stack evidence.

## Step 4: Run focused BOM audit rules

```bash
cdx-audit --bom bom.evinse.json --direct-bom-audit --categories golem
```

The rule pack uses `cdx:golem:*` properties for three review tracks:

| Category            | What it catches                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `golem-security`    | Runtime security signals, crypto-flow/crypto findings, and local replacement risk.       |
| `golem-performance` | Native boundaries, generated/embedded build inputs, and truncated data-flow coverage.    |
| `golem-compliance`  | Private modules, vendored modules without license-file evidence, and exclude directives. |

## Step 5: Decide what to ship

A good shippable integration is not just a populated BOM. It should support repeatable decisions:

- If high-severity semantic signals appear, inspect the occurrence and call-stack evidence before deciding whether the use is acceptable.
- If `cdx:golem:cryptoDataFlow=true` appears, inspect the source/sink categories, taint kinds, and call-stack frames before deciding whether key-management or data-handling changes are needed.
- If local replacements appear, remove them from release builds or document why a local or vendored source is part of the release baseline.
- If private module candidates appear, make sure internal provenance and license review evidence exists outside public registry metadata.
- If native or generated build surfaces appear, check reproducibility and cross-platform build behavior.
- If most components have no runtime evidence, verify whether the selected patterns, build tags, or test inclusion settings match the intended application build.

## Troubleshooting

If no Golem properties appear, verify that `evinse` was run with `-l go` or `-l golang` and that the `golem` binary is available. You can point to a local helper with `--golem-command /absolute/path/to/golem`.

If evidence does not attach to expected modules, regenerate the base SBOM from the same source tree and compare the component purls with the module paths in the Go project.

If analysis is too slow, switch to `static` or `none`, narrow `--golem-patterns`, use `--golem-dataflow crypto` instead of `all`, lower `--golem-dataflow-max-slices`, set `--golem-memory-limit 4GiB`, or skip test variants unless they are needed for the review.

## Related docs

- [Go Evinse with Golem](GO_EVINSE_GOLEM.md)
- [Threat model: Go Evinse with Golem](GO_EVINSE_GOLEM_THREAT_MODEL.md)
- [evinse](EVINSE.md)
- [BOM Audit](BOM_AUDIT.md)
- [REPL / cdxi](REPL.md)

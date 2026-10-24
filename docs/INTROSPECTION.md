# Build introspection

Build introspection grades how completely cdxgen was able to read your project.
A scan that fell back to parsing `pom.xml` because Maven was unavailable
produces a very different SBOM from a scan where Maven resolved the dependency
tree; this feature tells the two apart, ranks what would improve the result,
and — when the environment is repaired — proves that the SBOM actually
improved.

Introspection degrades nothing and installs nothing. It reports; you fix.

## Switching it on

```sh
# Flag only
cdxgen -t java --introspect -o bom.json ~/projects/java-sec-code

# Full profile (adds formulation and evidence passes)
cdxgen --profile introspect -t java -o bom.json ~/projects/java-sec-code

# CI gate: exit 4 when the overall score is below the threshold
cdxgen --profile introspect --introspect-fail-below 70 -t java -o bom.json ~/projects/java-sec-code
```

| Flag                                                 | Meaning                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `--introspect`                                       | Run the build ledger, reflection, scoring, and write the reports |
| `--profile introspect`                               | `--introspect` plus `--include-formulation` and evidence passes  |
| `--introspect-report <path>`                         | Markdown report path (default `<output>.introspection.md`)       |
| `--introspect-json <path>`                           | JSON report path (default `<output>.introspection.json`)         |
| `--introspect-fail-below <0-100>`                    | Exit with status 4 when the score is below the threshold         |
| `--introspect-annotate` / `--no-introspect-annotate` | Attach the verdict to the BOM (default on)                       |
| `CDXGEN_INTROSPECT=true`                             | Environment equivalent of `--introspect`                         |

Exit codes: `0` success, `1` cdxgen failed to generate a BOM (not a fidelity
result), `4` the BOM and both reports were written but the score is below
`--introspect-fail-below`, `5` a `--fail-on-error` extractor failure that was
deferred so the BOM and both reports could still be written. The gate never
withholds output — always read the report before reacting to the exit code.

`--fail-on-error` keeps its meaning under introspection with one change of
timing: the extractor that failed stops immediately (no incomplete-result
fallback runs), the run still completes the BOM from what was collected, both
reports are written, and the process exits `5` — a claim distinct from `0`
(everything succeeded) and `4` (the toolchains answered, the result is not
good enough). Without `--introspect`, `--fail-on-error` exits `1` and writes
no BOM, exactly as before. When both a deferred failure and a failed gate
apply, the deferred failure wins the exit status and the report still carries
the gate decision.

## The tiers

Each scanned ecosystem is graded against a fidelity ladder:

| Tier        | Meaning                                                           |
| ----------- | ----------------------------------------------------------------- |
| `resolved`  | Working build or resolver; the full dependency graph was captured |
| `lockfile`  | Pinned versions captured; the graph is not fully resolved         |
| `manifest`  | Direct declarations only                                          |
| `heuristic` | Components inferred from build artifacts                          |
| `absent`    | The ecosystem was requested but produced nothing                  |

Some ecosystems can never reach `resolved`. Those carry
`state: "at-ceiling"` and score 100 with nothing proposed. Two kinds of
ceiling exist:

- **No resolver to drive** — a helm chart is `manifest` forever, a Swift
  package `lockfile`, a dart package `manifest`.
- **Lockfile-derived evidence** — npm, python and rust BOMs always carry the
  pinning evidence of their lockfile (integrity hashes, Cargo.lock checksums,
  per-package provenance), installed or not, so `resolved` is not a state any
  environment can produce evidence for in those ecosystems. Their ceiling is
  `lockfile`; the dependency graph itself is still guarded by the
  build-fidelity rules, which demote the row to `manifest` the moment graph
  coverage drops.

A degradation recorded against an at-ceiling row proposes nothing — there is
no tier left to reach — and is reported in `observations[]` instead. An npm
project scanned without `node_modules` is the common case: it scores 100 at
its `lockfile` ceiling, and the absent installed tree is an observation for a
reader who wants the fuller graph an install would add.

Ecosystems cdxgen cannot parse at all (elm, crystal, nim, perl, r today) are
`unsupported`: they are excluded from the score and appear in
`coverageGaps[]` as cdxgen's backlog, never as a defect in the project.

### Remediation catalog coverage

Every remediation id in `data/remediations.json` names an ecosystem, and a
producer in `lib/` records it at a specific fallback or failure; the catalog
and the producers are kept in lock-step by a test that fails when an id
appears on one side only. The per-ecosystem coverage today:

| Ecosystem | Entries | Produced by                                                                                                                            |
| --------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| java      | 9       | Maven, Gradle and sbt fallbacks and command failures, the jar heuristic, and Maven skipped with installs off                           |
| generic   | 9       | Binary and OS package inventory, the Brotli decoder probe's caps, build rate limits, secure mode, host allow-list, dry-run, offline and rate-limit policy |
| python    | 7       | The generic lockfile and pyproject entries, per-manager uv/poetry/pdm/pipenv variants, and poetry/pdm export skipped with installs off |
| npm       | 6       | Missing lockfile, missing `node_modules`, unparseable or old lockfiles, git dependencies, and the Node.js host probe's unreadable package databases |
| csharp    | 5       | The .NET SDK unavailable, msbuild skipped with installs off, and dosai reports that could not be kept whole                            |
| clojure   | 3       | lein and the Clojure CLI unavailable, and lein skipped with installs off                                                               |
| swift     | 3       | Toolchain and `swift package resolve` failures, and SwiftPM skipped with installs off                                                  |
| cocoa     | 3       | cocoapods unavailable, and the Podfile or Ruby podspecs not evaluated with installs off                                                |
| rust      | 3       | `rust.cargo-lock-missing` (manifest-only parse), `rust.toolchain.missing` (cargo could not run) and `rust.cargo-metadata-unavailable`  |
| ruby      | 2       | host build-requirements gaps                                                                                                           |
| go        | 2       | `go.toolchain.missing` (the go executable could not run) and `go.mod-only-fallback` (the manual `go.mod` parse)                        |
| php       | 4       | `php.no-lockfile`, `php.composer.missing`, `php.host-probe.package-db-unreadable` and `php.composer.platform-unattributed`             |
| dart      | 1       | `dart.pub-get-needed`: `pubspec.yaml` parsed without `pubspec.lock`                                                                    |
| elixir    | 1       | `elixir.deps-not-fetched`: `mix.exs` without `mix.lock`                                                                                |
| haskell   | 1       | `haskell.freeze-missing`: no `cabal.project.freeze`                                                                                    |
| helm      | none    | A chart is `manifest` forever (`at-ceiling`); it scores 100 and proposes nothing                                                       |

## The report

Every run writes a markdown report for people and a JSON report for tools. The
diagnostic stream carries a short summary:

```text
Build introspection: overall manifest (45/100), confidence high
Build introspection: 2 remediation(s) ranked
Build introspection: markdown report: bom.json.introspection.md
Build introspection: json report: bom.json.introspection.json
```

The JSON document (`schemaVersion: "1.1"`) is the contract agents read; it is
documented field for field in
[the skill's report schema reference](../.agents/skills/sbom-fidelity-loop/reference/report-schema.md).
`overall.tier` is the worst tier among scored rows, `overall.score` is the
component-count-weighted mean, and `remediation[]` is ranked by expected score
gain. Ledger-sourced entries carry an `evidence` block — the failed command,
its exit code, the diagnosed cause, and a bounded, redacted `outputExcerpt` of
the command's combined output — so the entry an agent is about to act on
shows why it exists. Excerpts are redacted through the same field-aware
redactor as every other free-text field (assignment and space-separated
credential flags, echoed `Authorization` headers, credential-adjacent token
runs, URL userinfo and the home directory path), and
`CDXGEN_INTROSPECT_NO_OUTPUT=true` suppresses them entirely for users who
will not ship tool output under any redaction. Entries sourced from the
build ledger also carry `actions[]` — concrete install/build/rerun steps
with Windows variants — while rule-sourced entries (`BF-*` ids) propose the
re-scan in which cdxgen drives the resolver itself. Suggested commands adapt
to the project: a repo that ships a `mvnw` or `gradlew` wrapper gets the
wrapper in the build command, a Python lock file problem names the
manager that owns the failing lock (`uv lock`, `poetry lock`, `pdm lock`,
`pipenv lock`) instead of one command for every manager, and a `composer`
command prefers the project's own `composer.phar` when the repo ships one.
Each shaped action
carries a `shapedBy` field naming the detection behind the command, so a
reviewer can tell a correct detection from a default; an action without
`shapedBy` names the ecosystem's plain default executable.

## Re-scanning a foreign BOM

Introspection can also grade a BOM nobody generated in this run —
`cdx-audit --bom <file> --direct-bom-audit --introspect`. Such a BOM carries
no build ledger, so on its own the verdict rests on BOM structure alone
(confidence `low`). Most BOMs generated with `--introspect` or
`--profile introspect`, though, carry a `formulation` section, and that
section is evidence of two different kinds:

- **Run-derived** — the `type: "platform"` components record the toolchain
  the generating run actually probed, with names and versions. On a foreign
  re-scan this record substitutes for the missing `tool.resolved` events and
  appears in the row's `tools.resolved` with `source: "formulation"`. It is
  also how the report shows the BOM was not generated by the environment
  re-scanning it: when the formulation's entry for the runtime's own family
  carries a different version (or names other toolchains and no entry for
  this family at all), the `BF-FORM-002` finding fires — a different
  environment produced the record (another machine, or the same machine
  under a different runtime), and the verdict cannot be verified as-is here
  without regenerating.
- **Config-parsed** — the commands under `formulation[].workflows[]` come
  from the repo's CI configuration. A declared command was **never observed
  to run**; it may have failed, or belong to a job that never fires. When a
  finding needs the command the build attempted (`BF-FORM-001`: a resolver
  command is declared yet the BOM carries no dependency edges at all), it
  travels as `evidence.attemptedCommand` with
  `attemptedCommandSource: "formulation"`, and every surface renders it as a
  hypothesis to check, never as something that ran. Action references
  (`actions/checkout@<sha>`) are not commands and never surface as one.

Formulation-derived findings exist **only** on this foreign path. In a
same-run scan the formulation's toolchain record is the ledger's own probes
reported twice and its commands were not observed either, so a scan with a
ledger keeps its verdict untouched: no score moves, no confidence changes,
and no declared command appears in the report. The `D-formulation-foreign`
and `D-formulation-samerun-neutral` matrix cells pin both directions.

Because the run was not observed, foreign-BOM confidence is capped at
`medium` even with formulation evidence in hand — `high` is reserved for a
verdict corroborated by an observed run. A foreign BOM whose formulation
records no toolchain stays at `low`.

## The loop

[The sbom-fidelity-loop skill](../.agents/skills/sbom-fidelity-loop/SKILL.md)
is the agent contract: scan, read the report, execute the ranked remediation's
actions, re-scan, and stop in one of six ways (`success`, `stalled`, `blocked`,
`nothing-further-available`, `unverifiable`, `budget-exhausted`). The loop
fixes the environment; it never modifies the project to make a rule pass.

One latitude beyond the catalog is documented, and bounded: when a report's
evidence names a cause the catalog has no action for — a `JAVA_HOME` pointing
at a deleted JDK, say — the skill allows exactly one evidence-driven host
repair, which must be recorded in `.cdxgen/introspection-history.json`
(schema `1.1`) with `inferred: true`, a `remediationId` prefixed `inferred:`,
and the evidence quote it rests on. An inferred entry without the quote is
malformed. The repair is judged by the next report like any catalog fix, and
at most one is allowed per `inputsFingerprint`, so a stalled loop cannot
churn through guesses.

## A worked transition

One project, scanned twice: first with Maven made unavailable
(`MVN_CMD=/cdxgen-nonexistent/mvn`), then after executing what the report
proposed. The project is a small Maven tree; the degraded scan falls back to
parsing `pom.xml`.

**Degraded run** — 2 components, no dependency graph:

````markdown
# cdxgen build introspection

Overall: manifest (45/100) — the SBOM is missing transitive dependencies for java; 2 remediation(s) proposed.

## Ecosystems

| ecosystem | tier     | score | components | edges | confidence |
| --------- | -------- | ----- | ---------- | ----- | ---------- |
| java      | manifest | 45    | 2          | 0     | high       |

## What to fix

Ranked by expected score gain.

### 1. Maven build failed; only the direct dependencies declared in pom.xml were captured

- Remediation: `jvm.maven.manifest-fallback` (source: ledger) — ecosystem: `java`, confidence: high
- Why: transitive dependency evidence was lost (1 event).
- Score: 45 → 100 (tier `resolved`); expected overall gain: +55.00
- Also resolves: `BF-JVM-001`
- Confirm `BF-JVM-001`, `BF-JVM-002` no longer fire and the tier reaches `resolved`.
- Docs: https://cyclonedx.github.io/cdxgen/#/PROJECT_TYPES?id=java

POSIX:

```sh
sdk install java {{version}}
sdk install maven {{version}}
mvn -q package -DskipTests
```
````

Windows:

```bat
winget install --id EclipseAdoptium.Temurin.{{major}}.JDK
winget install --id Apache.Maven
mvn -q package -DskipTests
```

- no version for `java` was recorded by this run, so `{{version}}` is left unsubstituted — ask the user which version to install; never invent one
- no version for `maven` was recorded by this run, so `{{version}}` is left unsubstituted — ask the user which version to install; never invent one
- Re-run the cdxgen invocation from the Reproduce section to confirm the fix.

### 2. Only 0 of 2 components appear in the dependency graph (100% uncovered); the BOM reads like a flat list of declarations

- Remediation: `BF-GEN-001` (source: rule) — ecosystem: `java`, confidence: high
- Why: Run the ecosystem resolver before generating the BOM (or let cdxgen --install-deps drive it) so transitive edges are captured, then re-scan
- Score: 45 → 75 (tier `lockfile`); expected overall gain: +30.00
- Confirm `BF-GEN-001` no longer fires and the tier reaches `lockfile`.

## Evidence

### java

Rule findings:

- **BF-GEN-001** (high): Only 0 of 2 components appear in the dependency graph (100% uncovered); the BOM reads like a flat list of declarations
- **BF-JVM-001** (high): 2 pkg:maven components were captured with no dependency graph, so only declared dependencies are present

````

After the tools are made available and the project is built
(`mvn -q package -DskipTests`), the re-scan of the same project:

```markdown
# cdxgen build introspection

Overall: resolved (100/100) — every scanned ecosystem is at its best achievable fidelity; nothing needs fixing.

## Ecosystems

| ecosystem | tier | score | components | edges | confidence |
| --- | --- | --- | --- | --- | --- |
| java | resolved | 100 | 8 | 6 | medium |
````

Both reports are real fixture output. The transition is asserted end to end by
`lib/stages/postgen/introspection/e2e.poku.js`, which also checks the claim the
tier makes: the repaired BOM must contain strictly more components, dependency
nodes, and edges than the degraded one.

## The fixture matrix

The e2e suite and `ci/introspection-tests.sh` assert three groups:

- **Group B — healthy projects stay silent.** go-smoke, cargo-smoke,
  poetry-smoke, pnpm-smoke, mix-smoke, composer-smoke, dotnet-eshop and
  npm-smoke rank zero remediations. A report that nags about a healthy project
  is a defect.
- **Group C — ceiling and unsupported.** pubspec-smoke (dart), the helm and
  clojure fixtures grade at-ceiling with score 100; the unsupported-markers
  fixture reports exactly dub (the D package manager) as a coverage gap with
  no score row.
- **Group A — transitions.** The maven row (manifest → resolved), the
  manifest-only js row (absent → lockfile), and the gradle row
  (`introspect-gradle-manifest`, absent → resolved) repair through the actions
  their reports emitted, and the SBOM must grow. The gradle row degrades by
  pointing `JAVA_HOME` at a JDK the effective gradle refuses, and skips itself
  on machines where no such pair exists.

Group D asserts per-ecosystem isolation on a polyglot fixture
(`test/data/introspection-polyglot`): degrading only the Maven toolchain moves
only the java tier.

## The toolchain version matrix

`contrib/toolchain-matrix.js` is the confidence instrument behind the claim
above: for every declared (image, project) cell in
`test/matrix/toolchain-matrix.yaml` it runs this cdxgen tree with
`--introspect` inside a published toolchain image from
[ci/images](../ci/images/README.md), with the project mounted read-only, and
diffs the verdict against a coarse expectation (tier, remediation ids, a
component floor). Every test before it degrades the environment by removing a
tool; the matrix covers the class that generates real bug reports — the tool
is present and the wrong version.

```sh
node contrib/toolchain-matrix.js --cell python-poetry   # one cell, ~2 min
node contrib/toolchain-matrix.js --group C              # the false-positive gate
node contrib/toolchain-matrix.js --all                  # maintainer-invoked; 40-90 min
node contrib/toolchain-matrix.js --all --update-baseline
node contrib/toolchain-matrix.js --compare <run-id>     # verdict delta between two runs
```

When a gradle build refuses to run at all — an unsupported class file
version, a JDK below the launcher's floor, a `JAVA_HOME` that names no JDK, a
daemon that will not start — the ledger records a `tool.mismatch` (or
`tool.missing`) event naming the versions together with the
`jvm.gradle.invocation-failed` degradation, so the report says why the scan
produced nothing instead of grading a silent empty BOM.

Cell outcomes land in a git-ignored `results/toolchain-matrix/<run-id>/`
directory. `SUMMARY.md` is the only file a reader needs: one table row per
cell of the whole run — including the cells an earlier invocation of it
measured — and a capped set of failure blocks underneath, each a two-line
diff. Everything bulky (per-cell `cdxgen.log`, the emitted
BOM and reports) is a sibling file under `cells/<id>/`, and `summary.json`
carries the same facts for tools. `--update-baseline` records the measured
verdicts in `test/matrix/baseline.json`, and later runs flag cells whose
verdict drifted from it.

Groups, one axis at a time:

- **C — the false-positive gate.** Healthy projects (ipsw, poetry, eShop) on
  the image built for them must produce zero remediations. A container is
  exactly where a spurious "tool missing" fires, because minimal images
  legitimately lack tools the host had. Build this group green first.
- **A — version skew.** One image axis at a time (Java, Python, Node, Go,
  .NET, Ruby) over a fixed project. Some cells genuinely degrade — measured:
  the Go 1.23 image cannot serve ipsw's declared `go 1.26` and grades
  `manifest` with the graph-coverage finding ranked — while others measure
  invariance, which is its own confidence result: the .NET 8 SDK scans the
  net10.0-targeting eShop without loss because cdxgen reads the resolver's
  `project.assets.json`, and python 3.6 parses a poetry lockfile as well as
  python 3.13, if with fewer captured packages (149 vs 248 — the newer
  interpreter lets cdxgen capture more of the environment).
- **B — runtime.** The default, deno and bun images over vendored
  lockfile-only fixtures; the ledger must record and the verdict must not
  crash on any runtime, including under the deno image's permission model.
- **D — secure mode.** The `cdxgen-secure` image runs the shipped permission
  policy, where installs are off, so Maven is skipped and the cell expects
  `jvm.maven.tooling-disabled` ranked as advice. A second cell passes
  `--install-deps`, restricts the command policy explicitly and requires
  the denied Maven remediation to be ranked _blocked_ with a policy reason,
  never an unblocked instruction to install Maven. Since the deferred
  fail-on-error exit, the shipped posture (fail-on-error defaulting on in
  secure mode) completes with the BOM, both reports and exit 5; only the
  blocked-classification cell still passes `--no-fail-on-error`, because the
  manifest tier it asserts is made of the pom fallback that fail-on-error
  forbids.

The matrix is on-demand by construction: it is not wired into CI, agents must
not run `--all` (ask the maintainer, then read the results directory), and a
single `--cell` is fair game when a hypothesis needs one answer.

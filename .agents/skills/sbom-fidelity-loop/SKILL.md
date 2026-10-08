---
name: sbom-fidelity-loop
description: Runs the cdxgen SBOM fidelity loop: scan with --introspect or --profile introspect, read the cdxgen fidelity report, execute its ranked remediations (the catalog spans the mainstream build ecosystems, and the loop may add one evidence-driven host repair the catalog missed), and re-scan until the fidelity tiers stop improving. Use when improving SBOM accuracy or completeness, fixing missing transitive dependencies in a generated BOM, build tool setup for SBOM generation, or interpreting a cdxgen fidelity/introspection report.
---

# SBOM fidelity loop

Use this skill to raise a cdxgen SBOM from a shallow scan (direct dependencies
only) to a fully resolved one. `cdxgen --introspect` grades each scanned
ecosystem against a fidelity tier ladder and ranks the fixes that would improve
it; this skill is the loop that executes those fixes and re-scans. The report
format is documented in [reference/report-schema.md](reference/report-schema.md)
and the six remediation action kinds in
[reference/remediation-actions.md](reference/remediation-actions.md); the
user-facing feature docs are [docs/CLI.md](../../docs/CLI.md) ("Build
introspection") and
[docs/INTROSPECTION.md](../../docs/INTROSPECTION.md), which shows a worked
degraded-to-repaired transition with both real reports.

The loop measures the environment the user actually has. It fixes the
environment; it never fixes the project.

## What this loop can and cannot do

The remediation catalog in `data/remediations.json` is deepest where the
build ecosystems are mainstream: java, npm, python and the generic findings
carry most of the 45 entries, and go, rust, php, clojure, swift, ruby, dart,
elixir, haskell, csharp and cocoa each carry at least one concrete repair.
It is shallowest — **zero entries — for c/cpp**: nothing in cdxgen today
reads a compilation database, so a c/cpp row grading `absent` is the honest
verdict, not a defect to chase. On any ecosystem without catalog entries a
low score with an empty or near-empty `remediation[]` is expected; report it
as such. An agent that invents work there has misread the tool's reach, and
ecosystems listed in `coverageGaps[]` are cdxgen's backlog, never yours.

Two entry-specific scope notes:

- `rust.toolchain.missing` can fire only where cdxgen actually spawns cargo:
  under `--deep`, or with `--install-deps` and a `build`/`post-build`
  lifecycle on a project that has no `Cargo.lock`. A plain scan of a
  manifest-only rust project reports `rust.cargo-lock-missing` instead — do
  not expect the toolchain entry, and do not treat its absence as an
  oversight.
- On a re-scanned (foreign) BOM, the `BF-FORM-*` entries reason from commands
  the BOM's CI workflows *declare*. A declared command was never observed to
  run; treat it as a hypothesis to check against the project, not an
  instruction (see
  [remediation-actions.md](reference/remediation-actions.md)).

## The loop

```text
history = read .cdxgen/introspection-history.json (fresh when absent)
for iteration in 1..maxIterations (default 6):
    run: cdxgen <user args> --profile introspect \
         --introspect-report .cdxgen/report.md --introspect-json .cdxgen/report.json
    exit 1 means cdxgen failed to generate a BOM at all: fix the invocation,
    do not count it as a fidelity iteration
    report = read .cdxgen/report.json
    if report.ledger.complete is false:
        set CDXGEN_INTROSPECT_LEDGER=.cdxgen/ledger.jsonl and re-run once;
        if still incomplete: STOP — unverifiable
    append {n, score: report.overall.score, tier: report.overall.tier,
            inputsFingerprint: report.inputsFingerprint} to history.iterations
    candidates = report.remediation entries where blocked is false
                 and remediationId was not attempted at this inputsFingerprint
    done = every row in report.ecosystems has state "at-ceiling", or tier
           "resolved", or tier "lockfile" with no candidate naming that
           ecosystem — a lockfile row is finished only once nothing is left
           to try on it
    if done and (no report.gate or report.gate.passed):
        STOP — success
    if iteration > 1 and report.overall.score <= previous score
       and report.inputsFingerprint == previous inputsFingerprint:
        STOP — stalled
    if candidates empty:
        if no inferred attempt is recorded at this inputsFingerprint
           and an evidence excerpt, an evidence cause, an observation or a
           tier reason names a cause the catalog has no action for:
            attempt exactly one host repair under the bounded rule below,
            recorded with inferred: true
            continue
        STOP — nothing-further-available
    pick candidates[0]  (report.remediation is ranked by expected gain)
    execute its actions under the rules below
    record the attempt in history.attempted with the outcome
STOP — budget-exhausted
```

Prefer `--introspect` over `--profile introspect` when the project's language
does not support evidence collection or when the profile's extra passes add
noise the loop does not need; both produce the same report.

## Stop conditions — report which one you hit, and the final report path

Every stop condition is a legitimate result. `stalled` and `blocked` are
findings about the project or environment, not failures to hide; an agent that
reports success because it ran out of ideas has failed.

| Stop | When | Report to the user |
| --- | --- | --- |
| `success` | Every ecosystem is at-ceiling or at `resolved`/`lockfile` and the gate (if configured) passed | Final score and report path |
| `stalled` | A re-run with the same `inputsFingerprint` did not raise the score — the applied fix did not change the inputs | The attempted remediation id; the fix did not take effect |
| `blocked` | Every remaining candidate is `blocked: true` (secure mode, offline, dry-run, in-container) | The `blockedReason` values; these are facts for the human, not work for you |
| `nothing-further-available` | No unblocked, unattempted candidate remains and no diagnosable evidence block earns the one inferred repair (or that repair is already spent) — including a score below 100 with an empty `remediation[]` | The score and the reason no action exists; never improvise a fix to close the gap |
| `unverifiable` | The ledger is incomplete even after the sidecar retry, or the report cannot be read/parsed | Say the verdict cannot be trusted and what is missing |
| `budget-exhausted` | `maxIterations` reached with work still ranked | What would be attempted next |

A score below 100 with an empty `report.remediation[]` is real: the deduction
has no catalog entry yet (a bare missing interpreter on PATH behaves this way
today). Before declaring `nothing-further-available`, check the report for a
diagnosable cause — an evidence excerpt or cause, an observation or a tier
reason that *names* one earns exactly one inferred host repair under the
bounded rule below, judged by the next report like any catalog fix. With
that repair spent or no such evidence present, the stop stands: report it,
leave the project untouched, and take no second guess at the same
`inputsFingerprint`.

## Rules for executing actions

- **Ask before installing.** `install` and `container` actions change the
  user's machine. Present the planned actions and wait, unless the user said to
  run unattended. In CI with an explicit mandate, proceed.
- **Never modify the project to make a rule pass.** Do not add a lockfile the
  project does not have, do not edit `pom.xml`/`build.sbt`/manifests to pin
  versions, do not touch source files. The goal is an accurate SBOM of the
  project *as it is*; adding a lockfile the project does not carry falsifies
  the subject of the measurement. Where a remediation's fix is a project
  change (`config` actions), surface it to the human as advice instead of
  executing it. The same prohibition covers the subtler shapes: do not create
  wrapper scripts (`mvnw`, `gradlew`) the project does not ship; do not add
  toolchain pin files (`.java-version`, `.tool-versions`) the project does not
  carry — these look like environment setup and are project changes; and do
  not write `compile_commands.json`, which nothing in cdxgen reads — that is
  fabricated work on top of being a project change.
- **Beyond the catalog you may repair the environment the run measured, and
  you must say how.** The catalog is not omniscient. Once no unblocked,
  unattempted candidate remains — the `candidates empty` branch of the loop
  above, never alongside a ranked action — and an `evidence.outputExcerpt`,
  an `evidence.cause`, an observation or a tier reason *names* a cause the
  catalog has no action for, you may act on that evidence to fix the *host*:
  set `JAVA_HOME`, install a toolchain the error names, start a required
  daemon, configure a registry mirror the excerpt shows is unreachable.
  Every condition below holds every time:
  1. The action changes the host or the shell environment only — never a file
     inside the project (the absolute rule above).
  2. The reasoning is recorded in `history.attempted` with `inferred: true`,
     a `remediationId` prefixed `inferred:`, and the evidence quote it rests
     on (schema below). No quote, no action.
  3. If the repair installs anything or runs a container, the ask-first rule
     above applies unchanged.
  4. Verification is by the *next* report exactly as with a catalog fix — an
     inferred repair that does not move the report is `no-change` and is
     never retried at the same `inputsFingerprint`.
  Cap: **one** inferred repair per `inputsFingerprint`. A second guess at
  the same inputs is churn, not diagnosis.
- **Never weaken the measurement.** Do not pass `--skip-*` flags, do not lower
  `--introspect-fail-below`, do not disable rules. If you find yourself wanting
  to, stop and report `blocked`. The bounded latitude above does not reach
  here: no excerpt, however clear, licenses a weaker scan.
- **Prefer `container` over host installs** when the report offers both and
  the environment can run containers — a container run is reversible.
- **Verify on the next iteration.** After executing actions, judge the fix by
  the *next* report's entry `verify` clause (rules stopped firing, tier
  reached) — never by the action's exit code. Record the outcome in
  `history.attempted`; a `no-change` or `failed` outcome is never retried at
  the same `inputsFingerprint`.

## Reading the report

| tier | meaning | keep going? |
| --- | --- | --- |
| `resolved` | Working build/resolver; full dependency graph captured | No — done |
| `lockfile` | Pinned versions captured, graph not fully resolved | Done when nothing is actionable; a remediation may still target `resolved` |
| `manifest` | Direct declarations only | Yes — the highest-gain remediation usually lives here |
| `heuristic` | Components inferred from build artifacts | Yes |
| `absent` | Nothing was produced for the ecosystem | Yes |

- A row with `state: "at-ceiling"` is done regardless of tier: the ecosystem
  already parses at the best fidelity cdxgen can achieve for it (helm charts
  are `manifest` forever). Do not try to improve one.
- Rows named in `coverageGaps` are cdxgen's backlog, not your work.
- `confidence: "low"` means the verdict rests on thin evidence: set
  `CDXGEN_INTROSPECT_LEDGER` to a sidecar path, re-run, and only then act on
  remediations.
- Ledger-derived entries carry an `evidence` block: `failedCommand`,
  `exitCode`, `cause`, and `outputExcerpt` — the command's own output,
  redacted, at most its last 2000 characters, and suppressed entirely when
  the operator sets `CDXGEN_INTROSPECT_NO_OUTPUT=true`. Read it before acting
  on the entry; it is what the bounded repair rule rests on. Field notes:
  [report-schema.md](reference/report-schema.md).
- Placeholders in action commands (`{{version}}`, `{{major}}`) are resolved
  by the report itself when it can — from the build's own mismatch report
  first, then the project's pin files, then anything else the run recorded;
  each action's `versionFrom` and `versionSource` say which answered. An
  action carrying `versionSourceMissing: true` (or `versionFrom:
  "unresolved"`) keeps the placeholder on purpose: ask the user which
  version to install; never silently invent one.
- Build commands are shaped for the project: the report names the wrapper
  (`./mvnw`, `./gradlew`), the Python manager (`uv lock`, `poetry lock`) or
  the project's own `./composer.phar` it detected, and `shapedBy` on the
  action says so. Run the command as emitted; an agent that "knows better"
  and substitutes `mvn` for `./mvnw` — or picks a manager the report did not
  name — is wrong. An unresolved `{{pythonManager}}` means two managers
  compete: ask the user which one governs the project before locking.
- On a re-scanned (foreign) BOM, rule entries carry `evidence.attemptedCommand`
  with `attemptedCommandSource: "formulation"` — a command the BOM's CI
  workflows declare. A declared command was never observed to run: it is a
  hypothesis to check against the project, not an instruction and not
  history. A same-run report carries none of these — there the ledger
  recorded what actually ran.

Keep loop state in `.cdxgen/introspection-history.json` so other agents and
later sessions share it. Schema version `1.1` separates catalog-driven
attempts from agent-inferred ones:

```json
{
  "schemaVersion": "1.1",
  "iterations": [
    {
      "n": 1,
      "score": 45,
      "tier": "manifest",
      "inputsFingerprint": "sha256:4c734642d88a9bc75b9496f2840397d14320cd3bb28a3ba14d45b00c5e3d69c6",
      "at": "2026-08-30T13:21:11.300Z"
    }
  ],
  "attempted": [
    {
      "remediationId": "jvm.maven.manifest-fallback",
      "inputsFingerprint": "sha256:4c734642d88a9bc75b9496f2840397d14320cd3bb28a3ba14d45b00c5e3d69c6",
      "at": "2026-08-30T13:25:00.000Z",
      "actions": ["sdk install maven 3.9.9", "mvn -q package -DskipTests"],
      "outcome": "verified",
      "detail": "BF-JVM-001 no longer fires; java graded resolved"
    },
    {
      "remediationId": "inferred:jvm.java-home-invalid",
      "inferred": true,
      "inputsFingerprint": "sha256:4c734642d88a9bc75b9496f2840397d14320cd3bb28a3ba14d45b00c5e3d69c6",
      "evidence": {
        "from": "observations[0].detail",
        "quote": "JAVA_HOME is set to an invalid directory: /opt/jdk17"
      },
      "at": "2026-08-30T13:31:00.000Z",
      "actions": ["export JAVA_HOME=/opt/jdk21"],
      "outcome": "no-change",
      "detail": "the next report still graded manifest at 45; not retried at this fingerprint"
    }
  ]
}
```

`outcome` is one of `verified`, `no-change`, `failed` for both entry kinds. A
catalog-driven attempt is the plain first entry: the `remediationId` the
report emitted and the actions as run, keyed by the `inputsFingerprint` they
were made at. An agent-inferred attempt — the bounded repair rule above —
additionally carries:

- `inferred: true`;
- a `remediationId` prefixed `inferred:` — a short slug naming the cause,
  chosen by you; it is not a catalog id;
- an `evidence` block: `from` names where in the report the fact lives
  (`remediation[0].evidence.outputExcerpt`, `observations[0].detail`,
  `ecosystems[0].tierReasons[0].detail`), and `quote` is the exact excerpt
  that justified the action.

**An inferred entry with no `evidence.quote` is malformed.** The quote is
what makes the latitude auditable: a reader who was not present must be able
to trace every host change back to a fact the report carried. At most one
`inferred: true` entry may exist per `inputsFingerprint`. A `1.0` history
file (catalog entries only, no `inferred` flags, no evidence blocks) is
still valid and needs no migration. The history file is written by the
agent, never by cdxgen. `.cdxgen/` is scratch state, not project content:
add it to the target repo's `.gitignore` and never commit it.

## Worked example

Measured on a real Java project (`java-sec-code`) scanned without Maven. The
environment variable forces the degradation any machine can reproduce:

```sh
MVN_CMD=/nonexistent cdxgen --profile introspect --introspect-fail-below 70 \
  -t java -o /tmp/d09/x.bom.json --no-install-deps ~/sandbox/java-sec-code
```

The run falls back to parsing `pom.xml`, then prints:

```text
Falling back to parsing pom.xml files. Only direct dependencies would get included!
Multiple errors occurred while building this project with maven. The SBOM is therefore incomplete!
✔ Generating BOM  58 components  0.2s
Build introspection: overall manifest (45/100), confidence high
Build introspection: 2 remediation(s) ranked
Build introspection: markdown report: /tmp/d09/x.bom.json.introspection.md
Build introspection: json report: /tmp/d09/x.bom.json.introspection.json
Build introspection: score 45 is below the --introspect-fail-below threshold 70.
```

Exit code **4**: the BOM and both reports were written, and the gate failed.
`report.remediation[0]` is `jvm.maven.manifest-fallback`, 45 → 100, with two
`install` actions, one `build`, and a `rerun`; it `subsumes` `BF-JVM-001`, so
fixing it clears that finding too. The `install` commands carry `{{version}}`
placeholders because this run recorded no expected version. Per the rules: the
agent presents the actions to the user instead of installing unprompted. Here
the machine already had Java 25 and Maven under SDKMAN (visible in
`ecosystems[0].tools.resolved`), so no install was needed; the loop re-runs the
same command for iteration 2:

```text
✔ Generating BOM  204 components  4.7s
Build introspection: overall resolved (100/100), confidence medium
Build introspection: 0 remediation(s) ranked
Build introspection: markdown report: /tmp/d09/x.bom.json.introspection.md
Build introspection: json report: /tmp/d09/x.bom.json.introspection.json
```

Exit code **0**. Every row is `resolved` and the gate passes: STOP — success,
204 components against 58 before, report at the same path.

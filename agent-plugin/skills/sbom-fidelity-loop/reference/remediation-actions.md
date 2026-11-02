# Remediation actions — the six kinds and how to execute them safely

Every `remediation[]` entry in the JSON report carries `actions[]` in the
order the fix is performed — install, then build, then re-run is a recipe, not
a set. Each action is one of six kinds; the kind tells you who may run it and
what it changes. Never run an action the report did not emit.

| kind | What it does | Changes | Who executes it |
| --- | --- | --- | --- |
| `install` | Installs a build tool on the host (SDKMAN, winget, a manual installer) | The user's machine | Ask the user first; proceed only unattended or in CI with an explicit mandate |
| `env` | Names an environment variable the *next* cdxgen run needs (`CDXGEN_ALLOWED_COMMANDS`, `CDXGEN_ALLOWED_HOSTS`, dropping `--dry-run`) | The next run's policy | Safe to set for one invocation; confirm with the user, because allowlists widen what cdxgen may touch |
| `build` | Runs the project's own build command so the resolver produces a full graph (`mvn -q package -DskipTests`) | Build outputs only | Safe to run |
| `config` | Asks for a project configuration change (enable sbt dependency locking, bake an explicit PATH into an image) | The project | **Surface as advice, do not execute** — the loop never modifies the project |
| `container` | Runs cdxgen's container image over the project, supplying the missing toolchain from the image | Nothing on the host (a read-only bind mount) | Ask the user first; prefer over `install` when offered — it is reversible |
| `rerun` | Re-run the cdxgen invocation; the *next* report is the verdict | Nothing | Safe; this is how the loop verifies |

Two real entries showing the shape — an `install`/`build`/`rerun` recipe and a
`container` answer:

```json
{
  "remediationId": "jvm.maven.manifest-fallback",
  "actions": [
    {
      "kind": "install",
      "tool": "java",
      "via": "sdkman",
      "versionFrom": "pin",
      "versionSource": "pinned in .java-version",
      "command": "sdk install java 21",
      "windows": "winget install --id EclipseAdoptium.Temurin.21.JDK"
    },
    {
      "kind": "install",
      "tool": "maven",
      "via": "sdkman",
      "versionFrom": "unresolved",
      "versionSourceMissing": true,
      "command": "sdk install maven {{version}}",
      "windows": "winget install --id Apache.Maven"
    },
    {
      "kind": "build",
      "command": "mvn -q package -DskipTests"
    },
    {
      "kind": "rerun"
    }
  ],
  "verify": {
    "rules": ["BF-JVM-001", "BF-JVM-002"],
    "expectTier": "resolved"
  }
}
```

```json
{
  "remediationId": "ruby.build-deps.missing",
  "actions": [
    {
      "kind": "container",
      "image": "ghcr.io/cyclonedx/cdxgen",
      "command": "docker run --rm -v \"$PWD:/app\" -w /app ghcr.io/cyclonedx/cdxgen -t ruby /app",
      "windows": "docker run --rm -v \"%cd%:/app\" -w /app ghcr.io/cyclonedx/cdxgen -t ruby %cd%"
    }
  ],
  "verify": {
    "expectTier": "resolved",
    "eventsCleared": ["ruby.build-deps.missing"]
  }
}
```

A `config` entry — the kind an agent surfaces instead of executing (the sbt
lockfile the project does not have is the human's decision, and adding it
would change the project the SBOM is supposed to describe):

```json
{
  "remediationId": "jvm.sbt.no-lockfile",
  "actions": [
    {
      "kind": "config",
      "command": "Enable sbt dependency locking so the build writes build.sbt.lock"
    },
    {
      "kind": "build",
      "command": "sbt -batch compile"
    },
    {
      "kind": "rerun"
    }
  ],
  "verify": {
    "rules": ["BF-JVM-001"],
    "expectTier": "resolved"
  }
}
```

## Fields on an action

- `kind` — one of `install`, `env`, `build`, `config`, `container`, `rerun`.
- `command` — the action itself. Prose for `config` and some `env` actions; a
  shell command for `install`, `build`, `container`. Never truncated, always
  safe to paste.
- `windows` — the Windows variant of the command, or `null` together with
  `windowsReason` when none exists (then prefer the `container` action's
  `%cd%` variant or name the reason to the user). An action without a
  `windows` field runs the same `command` on every platform.
- `tool` / `via` — which tool the action installs and through which
  provisioner (`sdkman`, `winget`, `manual`).
- `versionFrom` — which evidence filled the `{{version}}` placeholder, from
  the strongest source that answered: `mismatch` (the build itself refused
  the running version and named the one it needs — the ecosystem row's
  `tools.mismatched` entries), `pin` (the project's own pin file, such as
  `.java-version`, `.sdkmanrc` or `gradle-wrapper.properties`), `expected`
  (a CLI type pin such as `-t maven3.9.9`, or anything else the run
  recorded), or `latest`. This is an additive widening of an older
  two-value enum: a `1.0`-era consumer that string-matches `expected` must
  treat an unknown value as "the command already names the version to
  install; read `versionSource` for the provenance" — never as an error.
- `versionSource` — the human-readable why behind a resolved version: the
  run's own diagnosis for a `mismatch` answer ("The gradle launcher requires
  Java 17; the active JDK is older and refused its class files."), or the
  pin file / request that declared it. Free text derived from tool output,
  redacted like every other free-text field. Optional: omitted when it adds
  nothing over `versionFrom`.
- `versionSourceMissing: true` — no recorded source answered, the
  placeholders (`{{version}}`, `{{major}}`) survive verbatim in the command,
  and the version is for you to resolve **with the user**: ask which version
  to install; never invent one silently. Branch on this field (or on
  `versionFrom: "unresolved"`) rather than string-matching `{{` in the
  command — an unsubstituted command is a question to ask, not a template
  bug. `{{major}}` resolves to the wanted version's major line.
- `shapedBy` — the detection the command's executable came from, present
  only when the report shaped the command for this project. The report
  adapts the suggested commands to what it detected: a repo that ships
  `./mvnw` or `./gradlew` gets the wrapper in the build command (Windows
  strings get `mvnw.cmd` / `gradlew.bat`), a Python lock file problem
  names the manager that owns the failing lock (`uv lock`, `poetry lock
  --no-interaction`, `pdm lock`, `pipenv lock`), and a `composer` command
  prefers the project's own `./composer.phar` when the repo ships one.
  Values:
  - `wrapper:./mvnw`, `wrapper:mvnw.cmd`, `wrapper:./gradlew`,
    `wrapper:gradlew.bat`, `wrapper:./composer.phar` — the project's wrapper
    was detected and used.
  - `wrapper-not-executable:./mvnw` — the wrapper exists but is not
    executable, so the command fell back to the installed `mvn`/`gradle`.
  - `manager:uv` (or `poetry`, `pdm`, `pipenv`) — the Python manager was
    detected from its lock file.
  - `manager:ambiguous` — two managers compete and the project's build
    backend does not settle it; the entry summary names both candidates.
    **Ask the user which manager governs the project before locking** — do
    not pick one because it is first. An unresolved `{{pythonManager}}`
    placeholder in a command means exactly this.
  - `npm-client:pnpm` (or `yarn`, `bun`, `deno`) — the npm client was read
    from the project's `packageManager` field or its lock file.
  A build command without `shapedBy` ran no detection: the executable is
  the ecosystem's plain default. **If you believe you know better and
  substitute a different executable than the one the report named — say,
  `mvn` where the report shaped `./mvnw` — you are wrong**: the report
  shaped the command from what it detected in this project; run what it
  emitted, and if it looks wrong, say why in the loop output instead of
  substituting silently.

## Declared commands are hypotheses, not history

A foreign BOM — one re-scanned with `cdx-audit --bom` instead of generated by
the run — carries no build ledger, and its formulation section is the only
surviving trace of what its build attempted. When a formulation-derived
finding needs a command (most commonly `BF-FORM-001`: the BOM's CI workflows
declare a resolver command yet the BOM carries no dependency edges at all),
the entry carries it as:

```json
{
  "evidence": {
    "attemptedCommand": "mvn -B dependency:tree -DoutputFile=/tmp/dependency-tree.txt",
    "attemptedCommandSource": "formulation"
  }
}
```

**A declared command was never observed to run.** It comes from parsing the
repo's CI configuration; it may have failed, been changed, or belong to a job
that never fires. Treat it as a hypothesis to check — "the project's build
attempts this" — and verify against the project before relying on it. It is
distinct from `evidence.failedCommand` on ledger-derived entries, which is a
command this run actually executed and watched fail. Neither phrasing of the
markdown report will render a declared command as something that ran.

The same foreign-BOM origin caps the entry's `confidence` at `medium` and
fills the row's `tools.resolved` from the generating run's toolchain record
(`source: "formulation"`). Nothing formulation-derived exists on a same-run
scan: the ledger already recorded what actually ran there.

## Blocked entries

An entry with `blocked: true` and a `blockedReason` would help, but this
environment cannot apply it: secure mode or a command allowlist denied the
install, the network is offline or host-blocked, the run is a dry-run, or a
container action would run inside a container. Blocked entries keep their
score projection. They are information for the human — lift the constraint and
they become actionable — and the loop's correct response to a candidate list
made entirely of blocked entries is to stop and report `blocked`, never to
substitute a workaround the report did not emit.

## Verifying a fix

Judge the applied fix by the *next* iteration's report, using the entry's
`verify` clause: every rule named in `rules` must stop firing, the ecosystem
tier must reach `expectTier`, and no further event of an `eventsCleared`
remediation id may be recorded. A build that exited 0 proves nothing on its
own. Record the outcome in `.cdxgen/introspection-history.json` as `verified`,
`no-change`, or `failed`; `no-change` and `failed` outcomes are never retried
at the same `inputsFingerprint`.

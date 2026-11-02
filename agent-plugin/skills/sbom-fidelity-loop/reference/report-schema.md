# Report schema — `buildIntrospectionJson` v1.1

The JSON report is the loop's contract. It is written by `--introspect` (the
JSON path defaults to `<output>.introspection.json`, or
`cdxgen-introspection.json` in the working directory when the BOM goes to
stdout) and by whatever `--introspect-json <path>` names. Key order is stable
and free text is redacted, so consecutive iterations diff cleanly everywhere
except `runId` and `generatedAt`, which identify the run rather than describe
it; `inputsFingerprint` is the field to compare across iterations. This
document describes
`schemaVersion: "1.1"`; new fields arrive as additive minor bumps, so read
reports tolerantly. A `1.0` report (no `evidence` blocks) is still valid
input for the loop; every `1.1` field is optional and absent, never null,
when the run recorded no such fact.

## Document at a glance

```json
{
  "schemaVersion": "1.1",
  "runId": "dfef56e9-aa87-4b91-965d-20dc7981f0d9",
  "inputsFingerprint": "sha256:4c734642d88a9bc75b9496f2840397d14320cd3bb28a3ba14d45b00c5e3d69c6",
  "generatedAt": "2026-08-30T13:21:11.300Z",
  "cdxgen": {
    "version": "13.0.1",
    "runtime": {
      "name": "Node.js",
      "version": "26.7.0"
    }
  },
  "bom": {
    "serialNumber": "urn:uuid:05b43960-0870-4c4d-90ea-7a4f608e0d8e",
    "componentCount": 58,
    "path": "/tmp/d09/x.bom.json"
  },
  "ledger": {
    "source": "sidecar",
    "complete": true,
    "eventCount": 10,
    "truncated": false
  },
  "overall": {
    "score": 45,
    "tier": "manifest",
    "confidence": "high"
  },
  "ecosystems": [],
  "coverageGaps": [],
  "remediation": [],
  "observations": [],
  "gate": {
    "threshold": 70,
    "passed": false
  }
}
```

The document above is the degraded Maven run from the SKILL.md worked example;
`ecosystems`, `remediation` and `observations` are shown expanded below. Every
value shown is real output.

| Field                                  | Meaning                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                        | Report contract version, currently `"1.1"` — `"1.1"` adds the optional remediation `evidence` block; `"1.0"` reports lack it, and every consumer must tolerate both                      |
| `runId`                                | Identifier of the cdxgen run that produced the report                                                                                                                                   |
| `inputsFingerprint`                    | `sha256:` over project path, project types, resolved tool versions and cdxgen version; invariant to timestamps — the loop's stalled/attempted key. It moves when an install takes effect only on the scan paths that record a `tool.resolved` event; the go path records none today, so installing go leaves it unchanged and a go row's progress must be read from its tier |
| `generatedAt`                          | ISO timestamp of the report                                                                                                                                                             |
| `cdxgen.version`, `cdxgen.runtime`     | The cdxgen release and host runtime that produced the verdict                                                                                                                           |
| `bom`                                  | Serial number, component count and output path of the BOM this report grades                                                                                                            |
| `ledger.source`                        | Where the build ledger was read from: `"sidecar"`, `"memory"`, or `"none"`                                                                                                              |
| `ledger.complete` / `ledger.truncated` | `false` when events were dropped (cap overflow or a torn run); such verdicts deserve low trust                                                                                          |
| `ledger.eventCount`                    | Number of recorded build events behind the verdict                                                                                                                                      |
| `overall.score`                        | 0–100, component-count-weighted mean of the per-ecosystem scores; 100 when nothing was scored                                                                                           |
| `overall.tier` / `overall.confidence`  | The **worst** tier and confidence among scored rows, so one weak ecosystem cannot hide behind the average; `null` when nothing was scored                                               |
| `gate`                                 | Present only when `--introspect-fail-below <n>` was configured; `passed: false` means the run exited with status 4 after writing the BOM and reports                                    |

## `ecosystems[]` — one row per scanned ecosystem

```json
{
  "ecosystem": "java",
  "state": "graded",
  "tier": "manifest",
  "ceilingTier": "resolved",
  "score": 45,
  "confidence": "high",
  "componentCount": 58,
  "dependencyEdgeCount": 0,
  "tierReasons": [
    {
      "source": "ledger",
      "id": "jvm.maven.manifest-fallback",
      "detail": "The maven dependency tree did not succeed, so only the direct dependencies parsed from pom.xml will be included.",
      "determining": true
    }
  ],
  "tools": {
    "expected": [],
    "resolved": [
      {
        "tool": "java",
        "source": "PATH",
        "found": "openjdk 25.0.2 2026-01-20"
      }
    ],
    "missing": [],
    "mismatched": []
  }
}
```

- `tier` sits on the ladder `resolved` > `lockfile` > `manifest` >
  `heuristic` > `absent`.
- `state` is `graded`, `at-ceiling`, `absent`, or `unsupported`.
  `at-ceiling` means this ecosystem already parses at the best fidelity
  cdxgen can achieve for it — the loop must not try to improve it, even at a
  low tier. `unsupported` ecosystems appear in `coverageGaps`, never here.
- `ceilingTier` is the best tier this ecosystem can ever reach; `at-ceiling`
  rows sit on it.
- `score` is 100 flat for at-ceiling rows; elsewhere the tier base minus
  deductions for missing tools, mismatches and corroborated degradations,
  floored 15 points under the tier base.
- `confidence` is `high` when ledger and rule evidence agree, `medium`
  otherwise, and `low` when the verdict rests on marker detection alone.
- `tierReasons[]` carries `determining: true` on the reasons that decided the
  tier. `source` is `ledger`, `rule`, `marker`, or — for findings derived
  from the BOM's formulation section on a foreign BOM — `formulation`.
- `tools.*` entries join what the project declared (`expected` — `wanted` from
  a pin file or CLI type), what answered (`resolved` — `found`; a resolved
  entry without `found` means present, version unknown), and what failed
  (`missing`, `mismatched`). These resolve `{{version}}`/`{{major}}`
  placeholders in remediation actions, strongest evidence first: a `mismatched`
  entry — the build refused the running version and named the one it needs —
  outranks a pin file, which outranks a CLI type pin, which outranks anything
  else the run recorded. Each resolved action names the band that answered in
  `versionFrom` and, where it adds information, the reason in `versionSource`.
  On a foreign BOM (no ledger), `resolved` additionally carries the
  toolchain record from the BOM's formulation section with
  `source: "formulation"` — what the generating run probed, not what this
  run observed.

## `remediation[]` — ranked, expected gain first

```json
{
  "remediationId": "jvm.maven.manifest-fallback",
  "source": "ledger",
  "ecosystem": "java",
  "confidence": "high",
  "summary": "Maven build failed; only the direct dependencies declared in pom.xml were captured",
  "impact": "transitive-deps",
  "targetTier": "resolved",
  "currentScore": 45,
  "projectedScore": 100,
  "expectedGain": 55,
  "evidenceCount": 1,
  "evidence": {
    "failedCommand": "mvn -B dependency:tree -DoutputFile=/tmp/cdxgen-mvn-tree.txt",
    "exitCode": 1,
    "cause": "The maven dependency tree did not succeed, so at best the direct dependencies parsed from pom.xml are available.",
    "outputExcerpt": "[ERROR] Failed to execute goal … Could not resolve dependencies for project com.example:demo:jar:1.0\n[ERROR] … Could not transfer artifact … from/to central (https://repo.maven.apache.org/maven2): Connection timed out"
  },
  "subsumes": ["BF-JVM-001"],
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
  },
  "docs": "https://cyclonedx.github.io/cdxgen/#/PROJECT_TYPES?id=java",
  "blocked": false
}
```

Entries are ordered by expected gain, then confidence, then id — `remediation[0]`
is the loop's next candidate. Field notes:

- `source` is `ledger` (a recorded build degradation) or `rule` (a build
  fidelity rule finding, ids beginning `BF-`). Rule-derived entries carry
  `severity` and `guidance` instead of `impact` and `evidence`, and
  `actions: []` — their fix is the re-scan in which cdxgen itself drives the
  ecosystem's resolver (`cdxgen <user args> --install-deps`), which the
  markdown report renders as a command block.
- `evidence` is the failure the run recorded, attached to the entry it
  explains, so the agent reading `remediation[0]` sees why without cross-
  referencing observations. Every subfield is optional and omitted when the
  run recorded none: `failedCommand` (the redacted command line), `exitCode`
  (the tool's exit status), `cause` (the diagnosed cause, falling back to the
  recorded consequence sentence), and `outputExcerpt` — redacted, at most the
  last 2000 characters of the command's combined output with interior
  newlines preserved, so the error at the end of a build log is what an agent
  reads first. A run whose operator sets `CDXGEN_INTROSPECT_NO_OUTPUT=true`
  never carries `outputExcerpt`. Rule-derived entries carry no `evidence`.
- `subsumes[]` names rule findings the same fix clears; executing one entry
  resolves them too.
- `versionFrom`, `versionSource` and `versionSourceMissing` live on the
  `actions[]` entries and are documented in
  [remediation-actions.md](remediation-actions.md).
- `actions[]` kinds, safe execution, Windows variants, `shapedBy` (the
  detection behind a command shaped for this project's wrappers and package
  managers) and placeholders are documented in
  [remediation-actions.md](remediation-actions.md).
- `verify` is the acceptance test for the _next_ iteration's report: the named
  rules must stop firing (`rules`), the tier must reach `expectTier`, and/or
  no further event of the named `eventsCleared` remediation ids may be
  recorded. Judge a fix by this clause, never by the action's exit code.
- `blocked: true` entries carry a `blockedReason` and stay in the list with
  their gain intact. They are information for the human (secure mode, offline
  network, dry-run, running inside a container), not work for the loop.
- `docs` links to the ecosystem's cdxgen documentation.

## `coverageGaps[]` and `observations[]`

```json
{
  "coverageGaps": [
    {
      "ecosystem": "r",
      "markers": ["DESCRIPTION"]
    }
  ],
  "observations": [
    {
      "kind": "evidence.degraded",
      "ecosystem": "python",
      "impact": "components",
      "detail": "No active virtualenv or conda environment was detected; dependency resolution will use the system interpreter."
    },
    {
      "kind": "evidence.degraded",
      "ecosystem": "python",
      "remediationId": "python.lockfile-unparseable.poetry",
      "impact": "transitive-deps",
      "detail": "The poetry lock file could not be parsed, so no locked versions were captured from it."
    }
  ]
}
```

(The entries above are the real `observations` of a poetry scan run without an
active virtualenv; `coverageGaps` is the shape reported for an `-t r` scan.)
Absent optional fields are omitted, never null: an observation without
`tool` or `remediationId` simply carries the fields it has.

- `coverageGaps[]` lists ecosystems with markers on disk but no cdxgen project
  type: a cdxgen coverage gap, never a defect in the project or work for the
  loop.
- `observations[]` holds ledger events that did not change any verdict —
  uncorroborated degradations, ceiling noise, out-of-scope probes. Read them
  for context; they imply no remediation.

## Console summary and exit codes

The diagnostic stream (stderr) carries at most a few lines:

```text
Build introspection: overall manifest (45/100), confidence high
Build introspection: 2 remediation(s) ranked
Build introspection: markdown report: /tmp/d09/x.bom.json.introspection.md
Build introspection: json report: /tmp/d09/x.bom.json.introspection.json
Build introspection: score 45 is below the --introspect-fail-below threshold 70.
```

Exit codes the loop must distinguish: `0` success (gate passes or no gate
configured), `1` cdxgen itself failed to generate or validate a BOM (not a
fidelity result), `4` the BOM and reports were written but the overall score
is below `--introspect-fail-below`, `5` a `--fail-on-error` extractor failure
was deferred so the BOM and reports could be written anyway (a failure that
left no BOM keeps exit `1`) — an agent that
receives `5` should treat the run's remediations as unreliable in the failed
tool's ecosystem and expect the tool facts and observations to name the
failure. The gate never withholds output — always read the report before
reacting to the exit code.

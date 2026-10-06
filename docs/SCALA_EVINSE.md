# Scala Evinse with scalasem

`evinse -l scala` and `cdxgen --evidence -t scala|sbt|mill|scala3|scala-cli` run the
[scalasem](https://github.com/AppThreat/atom-parsetools) analyzer from
`@appthreat/atom-parsetools` over the project and project its report onto CycloneDX
evidence. atom, the analyzer evinse uses for the other JVM languages, is never invoked
for Scala: its Scala frontend resolves calls to temporary class files and reports no
Scala source lines, and its native image crashes on Scala projects.

## Pipeline

```text
  project dir
      |
      |  scalasem discovers the build (sbt, Mill, Maven, scala-cli) and inventories
      |  each module: Scala version, class directories, source roots, compiler jars
      |  and the dependency classpath with Maven coordinates
      v
  Scala 3 modules: TASTy read through the module's own compiler with the TASTy
                   Inspector API
  Scala 2 modules: SemanticDB, produced by a plugin injected on the build command
                   line (or read from what a previous build left), decoded in Node
      |
      v
  facts per file: definitions, calls with their arguments, references, constants
      |
      v
  derived evidence: crypto findings, endpoints, outbound services, entry points,
                    call graph and call stacks
      |
      v
  cdxgen joins the report to the BOM components and emits the evidence
```

The compiler always comes from the build, never from whatever `scalac` is on `PATH`:
sbt and Mill hand over the module's compiler instance, and the TASTy header of each
file names the release that wrote it.

## What the BOM receives

- **Occurrences** for every component whose classes the sources reference or call,
  at the exact source file and line. Components are joined through the dependency
  classpath the report records, the `internal:Namespaces` properties a `--deep` scan
  collected, and the jar namespace map cdxgen writes beside the BOM. Coordinates are
  normalized, so an sbt component named `upickle` meets the published `upickle_3`
  jar, and a cross-built library keeps one component per platform (`_sjs1` for
  Scala.js, `_native0.x` for Scala Native), with the platform of the referencing
  file picking the right one.
- **Call stacks** on the component a stack ends in, entry point first, library call
  last.
- **Crypto assets** for every finding that maps to a known OID in
  `data/crypto-oid.json`, with mode, padding, key size, curve and primitive where
  the source carries them, and the finding location as occurrence evidence. The
  library that provides the algorithms (Bouncy Castle, a JWT library) is linked
  through `dependencies[].provides`. Findings with no registry OID, such as Argon2,
  bcrypt or a DRBG, become `cdx:scalasem:crypto:*` properties instead of assets with
  invented identifiers.
- **Services**: the routes the application serves (one per route, named the way the
  OpenAPI reader names its own) and every outbound HTTP client, websocket, data
  store, messaging topic and cloud client, named after the host it talks to. Service
  locations ride in `cdx:scalasem:service:location` properties because CycloneDX
  services carry no evidence field before spec 2.0.
- **npm components** for the packages a Scala.js build bundles, from the
  scalajs-bundler manifest under `target` or a bundler workspace beside the build,
  with `@JSImport` modules attributed to them.

## Scala 2 and SemanticDB

Scala 2 compilers write no TASTy, so scalasem asks the build for SemanticDB. For sbt
this injects `semanticdbEnabled` on the command line, scoped to the Scala 2 projects
and compiled into a target directory of its own: no build file changes, the
project's own output and incremental state stay as they are. Mill runs its
`semanticDbData` task and Maven compiles once more with the plugin jar. The plugin
release is resolved per exact Scala version. The side effect to know about: after
such a scan, an `sbt clean` recompiles everything, which is also true of any other
first-party analysis. `--semanticdb never` turns the reader off, and with
`--no-install-deps` cdxgen passes `--no-build`, so no build tool runs at all and
only what a previous build left on disk is read.

## Options

| Option or variable | Effect |
| --- | --- |
| `SCALASEM_CMD` | Use a specific scalasem entry point instead of the installed atom-parsetools one. |
| `--scalasem-command` | Same, for the evinse command. |
| `--no-scalasem` / `CDXGEN_SCALASEM_DISABLE` | Skip the analyzer and keep the plain BOM. |
| `CDXGEN_SCALASEM_TIMEOUT` | Kill a scalasem run after this many milliseconds. Default 20 minutes. |
| `CDXGEN_SCALASEM_MAX_OCCURRENCES` | Occurrences kept per component. Default 200. |
| `--scalasem-include-tests` | Include test sources, tagged `test` in `cdx:scalasem:usageScopes`. |
| `--no-install-deps` | Passes `--no-build`: no sbt, Mill, Maven or scala-cli process starts. |

A Scala run never fails silently. A non-zero exit, a timeout, a missing report or a
degraded report becomes a `cdx:scalasem:diagnostic:<code>` property on the metadata
component and one printed reason, and `--fail-on-error` claims the exit status. The
full diagnostic vocabulary is in the scalasem documentation.

The `cdx:scalasem:*` properties are listed in
[CUSTOM_PROPERTIES.md](CUSTOM_PROPERTIES.md). Occurrences, crypto, services and call
stacks are always collected for a Scala evidence run; there is no data-flow pass and
nothing to enable beyond the caps.

## OpenAPI for Scala

cdxgen no longer writes a `scala-openapi.json`. Inbound endpoints arrive as services
in the BOM itself, and an OpenAPI document comes from atom-tools over the scalasem
report:

```shell
scalasem "$(pwd)" scalasem.slices.json
atom-tools convert -t scala -e scalasem.slices.json -o openapi.json
```

## Limits that remain by design

- Findings without a registry OID are properties, not assets. Adding OIDs the
  registry does not define would invent identifiers.
- Call-graph edges from SemanticDB carry `confidence: approximate` in the report;
  the lexer recovers what the compiler did not record.
- Value propagation is bounded: string and numeric literals, project code, at most
  four call or local-value boundaries, no fields. scalasem is not a taint engine.
- Test sources are excluded until asked for, and the Scala standard library is
  capped at one occurrence per file.

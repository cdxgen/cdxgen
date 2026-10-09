# Scala Evinse with scalasem

`evinse -l scala` and `cdxgen --evidence -t scala|sbt|mill|scala3|scala-cli` run the
[scalasem](https://github.com/AppThreat/atom-parsetools) analyzer from
`@appthreat/atom-parsetools` over the project and project its report onto CycloneDX
evidence. A plain `cdxgen --evidence` run over a directory with an sbt, Mill or scala-cli
build takes the same path. atom, the analyzer evinse uses for the other JVM languages, is
never invoked for Scala evidence: its Scala frontend resolves calls to temporary class
files and reports no Scala source lines.

The schema 2 report this page describes needs atom-parsetools 1.10.0 or later. An older
analyzer writes a version 1 report, which cdxgen reports as `scalasem-old-report`.

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

- **Occurrences** for every component whose classes the sources reference or call, at
  the exact source file and line, at most 200 per component.
  - Components are joined through the dependency classpath the report records, the
    `internal:Namespaces` properties a `--deep` scan collected, and the jar namespace
    map cdxgen writes beside the BOM.
  - Coordinates are normalized, so an sbt component named `upickle` meets the published
    `upickle_3` jar. A cross-built library keeps one component per platform (`_sjs1`
    for Scala.js, `_native0.x` for Scala Native), and the platform of the referencing
    file picks the right one.
  - A jar answers for the classes it ships and the packages it ships classes in
    directly, never for the parents of those packages. A file joins only libraries on
    its own module's classpath.
  - The JDK has no component, and neither do the project's own classes. A `javax.`
    symbol joins a library only through a class the library ships.
  - The Scala runtime (`scala-library`, `scala3-library` and the Scala.js and Scala
    Native runtimes) is capped at one occurrence per file.
- **Call stacks** on the component a stack ends in, entry point first, library call
  last. Each stack the report found is offered on its own; CycloneDX holds one call
  stack per component, and the one with the most files and frames is published.
- **Crypto assets** for every finding that maps to a known OID in `data/crypto-oid.json`.
  - Each asset has the mode, padding, key size, curve and primitive the source carries,
    and its call sites as occurrence evidence.
  - A curve is written in the schema's spelling (`secg/secp256r1`) at spec 1.7, and as
    the free-text curve at 1.6.
  - RSA takes the OAEP or PKCS #1 identifier its padding names, and has no mode.
  - The library that provides the algorithms (Bouncy Castle, a JWT library) is linked
    through `dependencies[].provides`.
  - Findings with no registry OID, such as Argon2, bcrypt or a DRBG, become
    `cdx:scalasem:crypto:*` properties instead of assets with invented identifiers. A
    weak one is also recorded in `cdx:scalasem:crypto:weakFinding`.
  - A finding the report could not resolve never becomes an asset.
- **Services**, of two kinds:
  - the routes the application serves, one per route, named the way the OpenAPI reader
    names its own. A route of a mounted Play router is published at the path it is
    served at.
  - every outbound HTTP client, websocket, data store, messaging topic and cloud client,
    named after the host it talks to. JDBC addresses lose userinfo, parameters and
    driver properties.

  Service locations ride in `cdx:scalasem:service:location` properties because
  CycloneDX services carry no evidence field before spec 2.0.

- **npm components** for the packages a Scala.js build installs, from the lock file of
  scalajs-bundler's install under `target` and of a workspace beside the build whose
  manifest uses Scala.js (a Vite client with `@scala-js/vite-plugin-scalajs`, for
  example). `@JSImport` and `require` modules are attributed to them, and the rest are
  named in `cdx:scalasem:jsModules` on the project component.
- **Namespaces**: with `--deep`, components the build reported without namespaces gain
  `internal:Namespaces` from the classpath jar of their own version.

## Builds and SemanticDB

scalasem compiles a module only when the build produced no output yet. For Scala 2,
whose compilers write no TASTy, it asks the build for SemanticDB without touching a
build file:

- sbt gets `semanticdbEnabled` and the plugin release for the module's exact Scala
  version on its command line, and compiles into a target directory of its own in the
  scalasem cache, so the project's own output and incremental state stay as they are.
- Mill runs its own `semanticDbData` task.
- Maven compiles the module once more with the plugin jar; the class files it writes are
  the ones the normal build writes.

With `--no-install-deps` cdxgen passes `--no-build`, so no build tool runs at all and
only what a previous build left on disk is read. `SCALASEM_SEMANTICDB=never` turns the
SemanticDB reader off.

## Options

| Option or variable                | Effect                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `SCALASEM_CMD`                    | Use a specific scalasem entry point instead of the installed atom-parsetools one.                  |
| `--scalasem-command`              | Same, on the command line.                                                                         |
| `--no-scalasem`                   | Skip the analyzer and keep the plain BOM.                                                          |
| `CDXGEN_SCALASEM_DISABLE`         | `true`, `1` or `all` does the same.                                                                |
| `CDXGEN_SCALASEM_TIMEOUT`         | Milliseconds a scalasem run may take, its builds included. Default 20 minutes.                     |
| `CDXGEN_SCALASEM_MAX_OCCURRENCES` | Occurrences kept per component. Default 200.                                                       |
| `--scalasem-include-tests`        | Include test sources, tagged `test` in `cdx:scalasem:usageScopes`. Ignored with `--required-only`. |
| `--no-install-deps`               | Passes `--no-build`: no sbt, Mill, Maven or scala-cli process starts.                              |

scalasem stops the builds it started when its time is up, and then itself; cdxgen's own
timeout, a little later, only backs it up.

A Scala run never fails silently. Each way a run can fall short becomes a
`cdx:scalasem:diagnostic:<code>` property on the metadata component and one printed
reason:

| Code                      | Meaning                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `scalasem-missing`        | No analyzer was found.                                                       |
| `scalasem-not-runnable`   | The analyzer could not be started.                                           |
| `scalasem-timeout`        | The run did not finish in time and was stopped.                              |
| `scalasem-no-report`      | The run wrote no report.                                                     |
| `scalasem-invalid-report` | The report is not valid JSON.                                                |
| `scalasem-old-report`     | The report is a version 1 report from an older atom-parsetools.              |
| `scalasem-exit-status`    | The run exited with an error but wrote a report, which is used.              |
| any other code            | A diagnostic the report itself carries, such as `tasty-version-unsupported`. |

`cdx:scalasem:degraded=true` marks a run with any of them. `--fail-on-error` claims the
exit status for every one that costs evidence; a degraded report only prints its reason.
The scalasem documentation lists the report's own diagnostic codes.

The `cdx:scalasem:*` properties are listed in
[CUSTOM_PROPERTIES.md](CUSTOM_PROPERTIES.md). Occurrences, crypto, services and call
stacks are always collected for a Scala evidence run; there is no data-flow pass and
nothing to enable beyond the caps.

## Reports and slices

The report is written to the `--semantics-slices-file` path: an absolute path as given,
a file name in the directory of the output BOM. It is reused instead of running scalasem
again when it names this project and is newer than the input BOM. A run that produces no
usable report leaves the file at that path as it was.

Slices the user passes are still read: a version 1 semantics slice whose files exist in
this project, usages and reachables slices as for any other language, and an OpenAPI
spec, whose routes merge with the report's into one service each.

## OpenAPI for Scala

cdxgen no longer writes a `scala-openapi.json`. Inbound endpoints arrive as services in
the BOM itself, and an OpenAPI document comes from atom-tools 1.0.5 or later over the
scalasem report, with no usages slice:

```shell
cdxgen -t scala --evidence --semantics-slices-file "$(pwd)/scalasem.slices.json" -o bom.json .
atom-tools convert -t scala -e scalasem.slices.json -o openapi.json
```

## Limits that remain by design

- Findings without a registry OID are properties, not assets. Adding OIDs the registry
  does not define would invent identifiers.
- Call-graph edges from SemanticDB carry `confidence: approximate` in the report; the
  lexer recovers what the compiler did not record.
- Value propagation is bounded: string and numeric literals, project code, at most four
  call or local-value boundaries, no fields. scalasem is not a taint engine.
- Test sources are excluded until asked for.

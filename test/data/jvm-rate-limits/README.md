# Build tool output under a repository rate limit

Real output from Maven, Gradle and sbt (Coursier) when every artifact request
of a small project is answered by a local repository that returns HTTP 429
with `Retry-After: 1`, or HTTP 404 for the negative cases. A refused proxy
CONNECT is not the same failure: Gradle and Coursier word it differently, so
an origin response was recorded instead.

The fixture server is a plain HTTP server that answers every request with the
chosen status. Each tool was pointed at it on the smallest project that needs
one download:

- Maven 3.9: a `settings.xml` `<mirror>` with `mirrorOf *` and an empty
  `-Dmaven.repo.local`, running `mvn -B dependency:tree`. `maven-429.txt`
  keeps the plugin-descriptor and metadata failures and the final `BUILD
  FAILURE`; `maven-404.txt` the `Could not find artifact` form.
- Gradle 9.6: an init script repository with `allowInsecureProtocol = true`.
  `gradle-429.txt` is a task that fails the build (`compileJava` with a source
  file), which prints `Received status code 429 from server`.
  `gradle-429-dependencies.txt` is the `dependencies` task with `--info`: the
  build still exits 0 and only the per-configuration `Failed to get resource:
  HEAD. [HTTP 429: ...]` lines and the `FAILED` markers show the rate limit.
  `gradle-404.txt` is the failing task against the 404 server.
- sbt 1.10 with Coursier: a repositories file passed with
  `-Dsbt.repository.config` and `-Dsbt.override.build.repos=true`, an empty
  `-Dsbt.global.base` and a one-artifact Coursier cache warmed first so only
  the build's own dependency is fetched from the fixture. `sbt-coursier-429`
  shows Coursier's `download error: Caught java.io.IOException (Server
  returned HTTP response code: 429 for URL: ...)`; `sbt-coursier-404` the
  `not found: <url>` form.

Maven backs off several seconds per artifact under 429, so a rate-limited run
takes minutes; the 404 runs fail in well under a second. The timings in the
files are from the recordings and only show that difference.

Mill and scala-cli also resolve through Coursier and print the same Coursier
download error, so they share the sbt matcher.

# Local Maven Central stand-in

Maven Central sometimes answers HTTP 429 to every request from a machine that has downloaded a
lot, for example a CI host or a laptop that runs many scans. Builds then fail to resolve whatever
the local caches do not already hold.

This directory holds a small caching proxy for that situation. It answers Maven repository
requests on `127.0.0.1` only. Files already present in the local Coursier cache or in
`~/.m2/repository` are served from there without being copied. Anything else is fetched from
Google's public mirror of Maven Central, with repo1.maven.org as the fallback, and kept in the
proxy's own store. `maven-metadata.xml` and SNAPSHOT files are fetched again after an hour. The
proxy needs Node.js and a POSIX shell.

## Usage

```bash
contrib/maven-proxy/maven-proxy.sh start
eval "$(contrib/maven-proxy/maven-proxy.sh env)"
cdxgen -t maven --deep -o bom.json /path/to/project
contrib/maven-proxy/maven-proxy.sh stop
```

`start` launches the proxy in the background and writes a Maven `settings.xml` and a Coursier
`mirror.properties` next to its store. `env` prints the exports for the current shell, and
`status` prints the proxy's counters: how many requests came from the store, the local caches
and upstream.

## What gets routed

Maven is routed through `MAVEN_ARGS`, which points it at the generated `settings.xml`. The
mirror there keeps the repository id `central`, so the bookkeeping Maven writes into
`~/.m2/repository` stays valid once the proxy is gone. Use Maven 3.9 or later, the first release
that reads `MAVEN_ARGS`.

sbt is routed only when it runs on a Coursier cache of its own, such as a clean cache on a CI
host named by `COURSIER_CACHE`. The exported `PATH` puts a small `sbt` wrapper first, and that
wrapper sets `COURSIER_MIRRORS` only when `COURSIER_CACHE` points somewhere other than the shared
cache. cdxgen runs sbt on the shared cache, with `--deep` too, so a project that has been built
resolves from there without the network. Mill, scala-cli and sbt on the shared cache are not
routed on purpose. Coursier files mirrored
downloads under the mirror's host name, and cdxgen derives the `repository_url` qualifier of sbt
purls from that path. Routing the shared cache would duplicate it under
`http/127.0.0.1%3A18081/` and give every later scan the wrong qualifier.

The proxy changes no configuration. `~/.m2/settings.xml` and the Coursier configuration stay as
they are, and Maven keeps storing what it resolves in `~/.m2/repository` as usual.

## Settings

The state directory is `$XDG_CACHE_HOME/cdxgen-maven-proxy`. If `XDG_CACHE_HOME` is unset, it is
`~/Library/Caches/cdxgen-maven-proxy` on macOS and `~/.cache/cdxgen-maven-proxy` elsewhere.
`MAVEN_PROXY_STATE` overrides it. Keep that path free of spaces, because `mvn` splits
`MAVEN_ARGS` on them. The proxy listens on port 18081 unless `MAVEN_PROXY_PORT` says otherwise.

`MAVEN_PROXY_UPSTREAM` is a comma-separated list of mirrors to try in order. A 404 from one of
them is final, and a rate limit or server error moves on to the next. `MAVEN_PROXY_TTL` sets the
refresh age of metadata and SNAPSHOT files in seconds. `COURSIER_SHARED_CACHE` names the shared
Coursier cache when it is not in the default place.

Delete the state directory to drop everything the proxy downloaded.

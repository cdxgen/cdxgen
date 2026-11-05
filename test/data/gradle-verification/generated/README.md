# Gradle verification metadata and lockfile from a real Gradle run

Both inventory files here were written by Gradle 9.5.0 against Maven Central
on 2026-11-04, for the tiny `build.gradle` in this directory, which resolves
Jackson through the `jackson-bom` platform, SLF4J, and JUnit Jupiter. The
commands, run inside this directory:

```console
$ gradle --no-daemon --write-verification-metadata sha256,sha512 dependencies
$ gradle --no-daemon dependencies --write-locks
```

`build.gradle` enables `dependencyLocking { lockAllConfigurations() }`, which
is what makes the second command write `gradle.lockfile`. The Gradle wrapper,
`build/` and `.gradle/` directories are intentionally not committed; any
recent Gradle regenerates both files with the commands above.

# Introduction

Custom language specific base images contributed by AppThreat from this [repo](https://github.com/AppThreat/base-images).

## Custom Container Images

Below table summarizes all available container image versions. These images include additional language-specific build tools and development libraries to enable automatic restore and build operations.

| Language   | Version                      | Container Image Tags                                                                                                                                                                                                      | Comments                                                                                               |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| All-in-One | Default (Java 25 + Node 24)  | ghcr.io/cyclonedx/cdxgen:master, ghcr.io/cyclonedx/cdxgen:v12                                                                                                                                                             | Default all-in-one container image with all the latest and greatest tools. Permission model is opt-in. |
| All-in-One | Secure (Java 25 + Node 24)   | ghcr.io/cyclonedx/cdxgen-secure:master, ghcr.io/cyclonedx/cdxgen-secure:v12                                                                                                                                               | Secure all-in-one container image. Uses Node.js permissions model by default.                          |
| All-in-One | Deno (Java 25 + Deno)        | ghcr.io/cyclonedx/cdxgen-deno:master, ghcr.io/cyclonedx/cdxgen-deno:v12                                                                                                                                                   | All-in-one container image with Deno runtime. Uses Deno permissions model by default.                  |
| All-in-One | Bun (Java 25 + Bun)          | ghcr.io/cyclonedx/cdxgen-bun:master, ghcr.io/cyclonedx/cdxgen-bun:v12                                                                                                                                                     | All-in-one container image with Bun runtime.                                                           |
| All-in-One | PowerPC (Java 25 + Node 24)  | ghcr.io/cyclonedx/cdxgen-ppc64:master, ghcr.io/cyclonedx/cdxgen-ppc64:v12                                                                                                                                                 | All-in-one container image optimized for PowerPC (ppc64le) architecture.                               |
| Java       | 8                            | ghcr.io/cyclonedx/cdxgen-temurin-java8:v12                                                                                                                                                                                | Java 8 version.                                                                                        |
| Java       | 11                           | ghcr.io/cyclonedx/cdxgen-java11-slim:v12, ghcr.io/cyclonedx/cdxgen-java11:v12, ghcr.io/cyclonedx/cdxgen-java:v12, ghcr.io/cyclonedx/cdxgen-java-slim:v12                                                                  | Java 11 version. Includes slim-only and standard variants.                                             |
| Java       | 17                           | ghcr.io/cyclonedx/cdxgen-java17-slim:v12, ghcr.io/cyclonedx/cdxgen-java17:v12                                                                                                                                             | Java 17 version. Includes slim-only and standard variants.                                             |
| Java       | 21                           | ghcr.io/cyclonedx/cdxgen-temurin-java21:v12, ghcr.io/cyclonedx/cdxgen-alpine-java21:v12                                                                                                                                   | Java 21 version. Includes Temurin (Ubuntu-based) and Alpine-based variants.                            |
| Java       | 24                           | ghcr.io/cyclonedx/cdxgen-temurin-java24:v12, ghcr.io/cyclonedx/cdxgen-alpine-java24:v12                                                                                                                                   | Java 24 version. Includes Temurin (Ubuntu-based) and Alpine-based variants.                            |
| Java       | 26                           | ghcr.io/cyclonedx/cdxgen-temurin-java26:v12, ghcr.io/cyclonedx/cdxgen-alpine-java26:v12                                                                                                                                   | Java 26 version. Includes Temurin (Ubuntu-based) and Alpine-based variants.                            |
| Dotnet     | .Net Framework 4.6 - 4.8     | ghcr.io/cyclonedx/cdxgen-debian-dotnet6:v12                                                                                                                                                                               | Uses mono to support old .NET Framework builds.                                                        |
| Dotnet     | .Net Core 2.1, 3.1, .Net 5.0 | ghcr.io/cyclonedx/cdxgen-debian-dotnet6:v12                                                                                                                                                                               | Invoke with `--platform=linux/amd64` for better compatibility.                                         |
| Dotnet     | .Net 6                       | ghcr.io/cyclonedx/cdxgen-debian-dotnet6:v12                                                                                                                                                                               | .Net 6 version.                                                                                        |
| Dotnet     | .Net 7                       | ghcr.io/cyclonedx/cdxgen-dotnet7:v12 (amd64 only)                                                                                                                                                                         | .Net 7 version. Only available on `amd64`.                                                             |
| Dotnet     | .Net 8                       | ghcr.io/cyclonedx/cdxgen-debian-dotnet8:v12, ghcr.io/cyclonedx/cdxgen-dotnet8:v12 (amd64 only)                                                                                                                            | .Net 8 version. Debian and SLE-based variants.                                                         |
| Dotnet     | .Net 9                       | ghcr.io/cyclonedx/cdxgen-debian-dotnet9:v12, ghcr.io/cyclonedx/cdxgen-alpine-dotnet9:v12, ghcr.io/cyclonedx/cdxgen-dotnet9:v12 (amd64 only)                                                                               | .Net 9 version. Debian, Alpine, and SLE-based variants.                                                |
| Dotnet     | .Net 10                      | ghcr.io/cyclonedx/cdxgen-ubuntu-dotnet10:v12, ghcr.io/cyclonedx/cdxgen-alpine-dotnet10:v12                                                                                                                                | .Net 10 version. Ubuntu and Alpine-based variants.                                                     |
| php        | 8.3                          | ghcr.io/cyclonedx/cdxgen-debian-php83:v12                                                                                                                                                                                 | php 8.3 version.                                                                                       |
| php        | 8.4                          | ghcr.io/cyclonedx/cdxgen-debian-php84:v12, ghcr.io/cyclonedx/cdxgen-alpine-php84:v12                                                                                                                                      | php 8.4 version. Debian and Alpine-based variants.                                                     |
| php        | 8.5                          | ghcr.io/cyclonedx/cdxgen-debian-php85:v12, ghcr.io/cyclonedx/cdxgen-alpine-php85:v12                                                                                                                                      | php 8.5 version. Debian and Alpine-based variants.                                                     |
| Python     | 3.6                          | ghcr.io/cyclonedx/cdxgen-python36:v12                                                                                                                                                                                     | No dependency tree support. Direct dependencies only.                                                  |
| Python     | 3.9                          | ghcr.io/cyclonedx/cdxgen-opensuse-python39:v12, ghcr.io/cyclonedx/cdxgen-python39:v12                                                                                                                                     | OpenSUSE-based.                                                                                        |
| Python     | 3.10                         | ghcr.io/cyclonedx/cdxgen-opensuse-python310:v12, ghcr.io/cyclonedx/cdxgen-python310:v12                                                                                                                                   | OpenSUSE-based.                                                                                        |
| Python     | 3.11                         | ghcr.io/cyclonedx/cdxgen-python311:v12                                                                                                                                                                                    | Python 3.11 version.                                                                                   |
| Python     | 3.12                         | ghcr.io/cyclonedx/cdxgen-python312:v12, ghcr.io/cyclonedx/cdxgen-python:v12                                                                                                                                               | Python 3.12 version. Includes rolling alias `cdxgen-python`.                                           |
| Python     | 3.13                         | ghcr.io/cyclonedx/cdxgen-python313:v12, ghcr.io/cyclonedx/cdxgen-alpine-python313:v12                                                                                                                                     | Python 3.13 version. Includes standard and Alpine-based variants.                                      |
| Node.js    | 20                           | ghcr.io/cyclonedx/cdxgen-node20:v12, ghcr.io/cyclonedx/cdxgen-node:v12, ghcr.io/cyclonedx/cdxgen-alpine-node20:v12                                                                                                        | Node.js 20 version. Use `--platform=linux/amd64` in case of npm install errors.                        |
| Node.js    | 24                           | ghcr.io/cyclonedx/cdxgen-alpine-node24:v12                                                                                                                                                                                | Node.js 24 Alpine version. Note: Default all-in-one uses Node 24 runtime.                              |
| Node.js    | 25                           | ghcr.io/cyclonedx/cdxgen-alpine-node25:v12                                                                                                                                                                                | Node.js 25 Alpine version.                                                                             |
| Node.js    | 26                           | ghcr.io/cyclonedx/cdxgen-alpine-node26:v12                                                                                                                                                                                | Node.js 26 Alpine version.                                                                             |
| Ruby       | 4.0.x                        | ghcr.io/cyclonedx/cdxgen-debian-ruby4:v12, ghcr.io/cyclonedx/cdxgen-alpine-ruby4:v12                                                                                                                                      | Ruby 4.0.x. Supports automatic installation for other Ruby versions.                                   |
| Ruby       | 3.3.x                        | ghcr.io/cyclonedx/cdxgen-debian-ruby33:v12                                                                                                                                                                                | Ruby 3.3.6. Supports automatic installation (e.g., `-t ruby3.3.1`).                                    |
| Ruby       | 3.4.x                        | ghcr.io/cyclonedx/cdxgen-debian-ruby34:v12, ghcr.io/cyclonedx/cdxgen-alpine-ruby34:v12                                                                                                                                    | Ruby 3.4.x. Supports automatic installation (e.g., `-t ruby3.4.0`).                                    |
| Ruby       | 2.5.x                        | ghcr.io/cyclonedx/cdxgen-ruby25:v12 (amd64 only)                                                                                                                                                                          | Ruby 2.5.0. Supports automatic installation (e.g., `-t ruby2.5.1`).                                    |
| Ruby       | 2.6.x                        | ghcr.io/cyclonedx/cdxgen-debian-ruby26:v12 (amd64 only)                                                                                                                                                                   | Ruby 2.6.10. Supports automatic installation (e.g., `-t ruby2.6.1`).                                   |
| Ruby       | 1.8.x                        | ghcr.io/cyclonedx/debian-ruby18:master                                                                                                                                                                                    | Base helper for `bundle install` only. No cdxgen equivalent with Ruby 1.8.x.                           |
| Swift      | 6                            | ghcr.io/cyclonedx/cdxgen-debian-swift6:v12, ghcr.io/cyclonedx/cdxgen-debian-swift:v12                                                                                                                                     | Swift 6 version. Debian-based.                                                                         |
| golang     | 1.23                         | ghcr.io/cyclonedx/cdxgen-debian-golang123:v12, ghcr.io/cyclonedx/cdxgen-alpine-golang123:v12                                                                                                                              | Go 1.23 version. Debian and Alpine-based variants.                                                     |
| golang     | 1.24                         | ghcr.io/cyclonedx/cdxgen-debian-golang124:v12, ghcr.io/cyclonedx/cdxgen-alpine-golang124:v12                                                                                                                              | Go 1.24 version. Debian and Alpine-based variants.                                                     |
| golang     | 1.26                         | ghcr.io/cyclonedx/cdxgen-debian-golang126:v12, ghcr.io/cyclonedx/cdxgen-debian-golang:v12, ghcr.io/cyclonedx/cdxgen-golang:v12, ghcr.io/cyclonedx/cdxgen-alpine-golang126:v12, ghcr.io/cyclonedx/cdxgen-alpine-golang:v12 | Go 1.26 version. Debian and Alpine-based variants. Includes rolling aliases.                           |
| Rust       | 1                            | ghcr.io/cyclonedx/cdxgen-debian-rust1:v12, ghcr.io/cyclonedx/cdxgen-debian-rust:v12, ghcr.io/cyclonedx/cdxgen-alpine-rust1:v12                                                                                            | Rust 1 version (rolling to latest stable). Debian and Alpine-based variants.                           |

Replace `:v12` with a release version tag or sha256 hash for fine-grained control over the image tag.

### Tagging Scheme

Every container image is built and tagged automatically with multiple tag formats to support different use cases:

- **Exact Version Tag (e.g., `12.6.0`)**: Resolves to the exact patch release. Recommended for production pipelines where reproducibility is critical.
- **Minor Version Tracking Tag (e.g., `v12.6`)**: Tracks the minor release line. Users pulling this tag automatically receive patch and security updates within the minor release.
- **Major Version Tracking Tag (e.g., `v12`)**: Tracks the major release line (consistent with historical tags like `:v12`).
- **Latest Tag (`latest`)**: The absolute newest stable release of cdxgen.

### Automatic Rebuilds

A scheduled workflow runs weekly to rebuild container images for the last 2 patch releases (if available) of the last two minor releases. This keeps dependencies, base OS packages, and security fixes up-to-date in published release containers. Only the workflow run corresponding to the absolute latest version publishes the `:latest` tag, ensuring it is never accidentally overwritten by older patch rebuilds.

## cdxgen variants

### Legacy Java applications

The official cdxgen image bundles Java >= 25 with the latest maven and gradle. Legacy applications that rely on Java 11 can use the custom image `ghcr.io/cyclonedx/cdxgen-java11-slim:v12`. For Java 17, use `ghcr.io/cyclonedx/cdxgen-java17-slim:v12`.

Example invocations:

Java 11 version

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $HOME/.m2:$HOME/.m2 -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-java11-slim:v12 -r /app -o /app/bom.json -t java
```

Java 11 version with gcc

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $HOME/.m2:$HOME/.m2 -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-java11:v12 -r /app -o /app/bom.json -t java
```

Java 8

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $HOME/.m2:$HOME/.m2 -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-temurin-java8:v12 -r /app -o /app/bom.json -t java
```

Java 17 version

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $HOME/.m2:$HOME/.m2 -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-java17-slim:v12 -r /app -o /app/bom.json -t java
```

Java 17 version with gcc

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $HOME/.m2:$HOME/.m2 -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-java17:v12 -r /app -o /app/bom.json -t java
```

Java 21 version

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $HOME/.m2:$HOME/.m2 -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-temurin-java21:v12 -r /app -o /app/bom.json -t java
```

### .Net Framework, .Net Core 3.1, and .Net 6.0 applications

Use the custom image `ghcr.io/cyclonedx/cdxgen-debian-dotnet6:v12`.

Example invocation:

.Net Framework 4.6 - 4.8 (debian)

A bundled version of [nuget](./nuget/) and mono is used to support .Net framework apps.

```shell
docker run --rm --platform=linux/amd64 -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-debian-dotnet6:v12 -r /app -o /app/bom.json -t dotnet
```

Dotnet 3.1 or Dotnet 6.0 (debian)

```shell
docker run --rm --platform=linux/amd64 -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-debian-dotnet6:v12 -r /app -o /app/bom.json -t dotnet
```

Dotnet 7.0 (SLE)

Only SLE version is available for dotnet 7. Use this image only as a last resort, when the project doesn't restore with the debian dotnet 8 version.

```shell
docker run --rm --platform=linux/amd64 -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-dotnet7:v12 -r /app -o /app/bom.json -t dotnet
```

Dotnet 8.0 (debian)

Use the debian version for better performance and compatibility.

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-debian-dotnet8:v12 -r /app -o /app/bom.json -t dotnet
```

Dotnet 8.0 (SLE)

```shell
docker run --rm --platform=linux/amd64 -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-dotnet8:v12 -r /app -o /app/bom.json -t dotnet
```

Dotnet 9.0 (debian)

Dotnet 9 is also bundled with the official `ghcr.io/cyclonedx/cdxgen` image.

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-debian-dotnet9:v12 -r /app -o /app/bom.json -t dotnet
```

Dotnet 9.0 (Alpine version)

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-alpine-dotnet9:v12 -r /app -o /app/bom.json -t dotnet
```

Dotnet 9.0 (SLE)

```shell
docker run --rm --platform=linux/amd64 -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-dotnet9:v12 -r /app -o /app/bom.json -t dotnet
```

NOTE: SLE dotnet images are only available for the `amd64` architecture. See this [discussion](https://github.com/SUSE/bci/discussions/41). Use `--platform=linux/amd64` as shown when using the SLE images. We highly recommend the debian images for dotnet.

## Including .NET Global Assembly Cache dependencies in the results

For `dotnet` and `dotnet-framework`, SBOM could include components without a version number. Often, these components begin with the prefix `System.`.

Global Assembly Cache (GAC) dependencies (System Runtime dependencies) must be made available in the build output of the project for version detection. A simple way to have the dotnet build copy the GAC dependencies into the build directory is to place the file `Directory.Build.props` into the root of the project and ensure the contents include the following:

```
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
<ItemDefinitionGroup>
  <Reference>
    <Private>True</Private>
  </Reference>
</ItemDefinitionGroup>
</Project>
```

Then, run cdxgen cli with the `--deep` argument.

### Swift applications

Use the custom image `ghcr.io/cyclonedx/cdxgen-debian-swift:v12`.

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-debian-swift:v12 -r /app -o /app/bom.json -t swift
```

### Go applications

Use the custom image `ghcr.io/cyclonedx/cdxgen-debian-golang:v12`.

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-debian-golang:v12 -r /app -o /app/bom.json -t golang
```

alpine-based golang images are also available.

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-alpine-golang:v12 -r /app -o /app/bom.json -t golang
```

### Python applications

Use the custom image `ghcr.io/cyclonedx/cdxgen-python312:v12` or `ghcr.io/cyclonedx/cdxgen-python311:v12`. This includes additional build tools and libraries to build a range of Python applications. Construction of the dependency tree is supported with Python >= 3.9.

Example invocation:

Python 3.6 (Direct dependencies only without dependency tree)

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-python36:v12 -r /app -o /app/bom.json -t python
```

NOTE: dependency tree is unavailable with Python 3.6

Python 3.9

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-python39:v12 -r /app -o /app/bom.json -t python
```

Python 3.10

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-python310:v12 -r /app -o /app/bom.json -t python
```

Python 3.11

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-python311:v12 -r /app -o /app/bom.json -t python
```

Python 3.12

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-python312:v12 -r /app -o /app/bom.json -t python
```

### Node.js applications

Use the custom image `ghcr.io/cyclonedx/cdxgen-node20:v12`.

Node.js 20

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-node20:v12 -r /app -o /app/bom.json -t js
```

### Ruby applications

Use the custom image `ghcr.io/cyclonedx/cdxgen-debian-ruby34:v12`.

Ruby 3.3.6 (debian version)

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-debian-ruby33:v12 -r /app -o /app/bom.json -t ruby
```

Ruby 3.4.1 (debian version)

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-debian-ruby34:v12 -r /app -o /app/bom.json -t ruby
```

Ruby 2.6.0 (Debian version)

Use the custom image `ghcr.io/cyclonedx/cdxgen-debian-ruby26:v12`.

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-debian-ruby26:v12 -r /app -o /app/bom.json -t ruby
```

Ruby 2.5.0 (SLE version)

Use the custom image `ghcr.io/cyclonedx/cdxgen-ruby25:v12`.

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-ruby25:v12 -r /app -o /app/bom.json -t ruby
```

Pass any Ruby version with the type argument to make cdxgen automatically install the appropriate version using `rbenv` prior to BOM generation.

Example: Pass `-t ruby3.3.1` to install Ruby 3.3.1

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-debian-ruby34:v12 -r /app -o /app/bom.json -t ruby3.3.1
```

Working with Ruby 1.8 applications? We have a Ruby 1.8 image that uses `debian:jessie` as the base image. Unfortunately, we couldn't find a way to install nodejs >= 20 in jessie, so we need a split workflow:

1. Perform bundle install with our debian-ruby18 image.

```shell
docker run --rm -v /tmp:/tmp:rw -e GEM_HOME=/tmp/gems -v $(pwd):/app:rw -w /app -t ghcr.io/cyclonedx/debian-ruby18:master bundle install

# Optionally, pass any bundle install args to build those stubborn projects
# docker run --rm -v /tmp:/tmp:rw -e GEM_HOME=/tmp/gems -e "BUNDLE_INSTALL_ARGS=--without test" -v $(pwd):/app:rw -w /app -t ghcr.io/cyclonedx/debian-ruby18:master bundle install
```

2. Run cdxgen using ruby25 image.

```shell
docker run --rm -e CDXGEN_DEBUG_MODE=verbose -e CDXGEN_GEM_HOME=/tmp/gems -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-ruby25:v12 -r /app -o /app/bom.json -t ruby --lifecycle pre-build
```

Notice the use of `GEM_HOME` and `CDXGEN_GEM_HOME` environment variables. `--deep` mode is currently not supported for Ruby 1.8.

## Troubleshooting

### .Net restore crashes

We have observed the below error on Mac M series, while cdxgen attempts to perform a restore.

```text
Restore has failed. Check if dotnet is installed and available in PATH.
Authenticate with any private registries such as Azure Artifacts feed before running cdxgen.
 Fatal error. System.AccessViolationException: Attempted to read or write protected memory. This is often an indication that other memory is corrupt.
   at System.Collections.Immutable.ImmutableDictionary`2[[System.__Canon, System.Private.CoreLib, Version=8.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e],[System.__Canon, System.Private.CoreLib, Version=8.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e]].AddRange(System.Collections.Generic.IEnumerable`1<System.Collections.Generic.KeyValuePair`2<System.__Canon,System.__Canon>>, MutationInput<System.__Canon,System.__Canon>, KeyCollisionBehavior<System.__Canon,System.__Canon>)
```

A workaround could be to use the debian container images instead of SLE images. SLE dotnet image only support the amd64 architecture.

### .Net framework issues

Old .Net framework applications (<= 4.7) are well known for their dislike of linux and hence may not restore/build easily. To troubleshoot, try running the `nuget restore` command manually using the `debian-dotnet6` image as shown.

```shell
docker run --rm -v /tmp:/tmp -v $(pwd):/app:rw -w /app -it ghcr.io/cyclonedx/debian-dotnet6:master nuget restore -Verbosity detailed /app/<solution file name>
```

If you see any mono-related crashes, there isn't a lot that can be done other than using the correct version of Windows for the restore step.

### View the assemblies in the Global Assembly Cache

Assemblies that are present in the Global Assembly Cache can be referred to and used directly without specifying a version number. This style of includes is common with namespaces such as `System.`, `Microsoft.`, and `Mono.`. Use the command `gacutil -l` to [obtain](https://learn.microsoft.com/en-us/dotnet/framework/app-domains/how-to-view-the-contents-of-the-gac#view-the-assemblies-in-the-gac) the version details for libraries from GAC.

```shell
docker run --rm -v /tmp:/tmp -v $(pwd):/app:rw -w /app -it ghcr.io/cyclonedx/debian-dotnet6:master gacutil -l
```

Sample output:

```text
System, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.ComponentModel.Composition, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.ComponentModel.DataAnnotations, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35
System.Configuration, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Configuration.Install, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Core, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.Data, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.Data.DataSetExtensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.Data.Entity, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.Data.Linq, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.Data.OracleClient, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.Data.Services, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.Data.Services.Client, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.Deployment, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Design, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.DirectoryServices, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.DirectoryServices.Protocols, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Drawing.Design, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Dynamic, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.EnterpriseServices, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.IO.Compression, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.IO.Compression.FileSystem, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.IdentityModel, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.IdentityModel.Selectors, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.Json, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35
System.Json.Microsoft, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35
System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Messaging, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Net, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Net.Http, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Net.Http.Formatting, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35
System.Net.Http.WebRequest, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Numerics, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089
System.Numerics.Vectors, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a
System.Reactive.Core, Version=2.2.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35
```

### Testing arm64 from x64 machines

- Install [Rancher Desktop](https://rancherdesktop.io/) and setup [nerdctl](https://docs.rancherdesktop.io/tutorials/working-with-containers) instead of docker
- Setup multi-platform by following this [doc](https://github.com/containerd/nerdctl/blob/main/docs/multi-platform.md)

Include the below argument with the `nerdctl run` command.

```
--platform=linux/arm64
```

Example:

```shell
nerdctl run --rm --platform=linux/arm64 -e CDXGEN_DEBUG_MODE=verbose -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-node20:v12 -r /app -o /app/bom.json -t js
```

## License

MIT

## Useful links

- [Identifying .Net vs .Net Framework](https://learn.microsoft.com/en-us/dotnet/standard/frameworks)

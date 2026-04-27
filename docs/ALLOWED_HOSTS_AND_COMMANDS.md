# List of allowed hosts and commands

cdxgen supports allowlisting for external commands and remote hosts. Use the environment variables `CDXGEN_ALLOWED_COMMANDS` and `CDXGEN_ALLOWED_HOSTS` to set these values. To allow commands and hosts correctly, make sure to add Operating System-specific [commands](#platform-specific-commands) along with common [commands](#common-commands-all-platforms) if there are any!

Examples:-

**add "ldd" command only when the testing system is linux**. Check [commands](#platform-specific-commands) for more details.

```
CDXGEN_ALLOWED_COMMANDS="foo" (other systems)
CDXGEN_ALLOWED_COMMANDS="foo,ldd" (linux systems)
```

- Nodejs

```
CDXGEN_ALLOWED_HOSTS="localhost,registry.npmjs.org"
CDXGEN_ALLOWED_COMMANDS="npm,pnpm,yarn,rush"
```

- Golang

```
CDXGEN_ALLOWED_HOSTS="localhost,proxy.golang.org,pkg.go.dev"
CDXGEN_ALLOWED_COMMANDS="go"
```

- Rust

```
CDXGEN_ALLOWED_HOSTS="localhost,crates.io"
CDXGEN_ALLOWED_COMMANDS="cargo"
```

These env variables should provided like this:

```shell
CDXGEN_ALLOWED_HOSTS=<hosts>
CDXGEN_ALLOWED_COMMANDS=<commands>
CDXGEN_TRACE_ID=<foo>
node bin/cdxgen.js -t <type of projects> --json-pretty -o bom.json $(pwd)
```

> Try to avoid using broader shell and runtime commands such as bash, zsh, java, node, etc. If this is unavoidable, carefully evaluate the arguments and the underlying scripts and configuration that might get used for execution.

## Common Commands (All Platforms)

| Language / Platform            | Project Types                                                                                                                                                    | External Commands             | Remote Hosts                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| **Node.js**                    | `npm`, `pnpm`, `nodejs`, `js`, `javascript`, `typescript`, `ts`, `tsx`, `yarn`, `rush`                                                                           | `npm`, `pnpm`, `yarn`, `rush` | `registry.npmjs.org`                                                              |
| **Node.js (Specific version)** | `node*` (Example: node10, node12, node18, node20)                                                                                                                | `npm`, `pnpm`, `yarn`, `rush` | `registry.npmjs.org`                                                              |
| **Java (Default)**             | `java`, `groovy`, `kotlin`, `scala`, `jvm`, `gradle`, `mvn`, `maven`, `sbt`, `quarkus`, `mill`                                                                   | `mvn`, `gradle`, `sbt`        | `*.maven.org`                                                                     |
| **Java (Specific version)**    | `java*` (Example: java11, java17)                                                                                                                                | `mvn`, `gradle`, `sbt`        | `*.maven.org`                                                                     |
| **Android**                    | `android`, `apk`, `aab`                                                                                                                                          | Usually none                  | Usually none                                                                      |
| **JAR**                        | `jar`                                                                                                                                                            | Usually none                  | Usually none                                                                      |
| **JAR (Gradle Cache)**         | `gradle-index`, `gradle-cache`                                                                                                                                   | Usually none                  | Usually none                                                                      |
| **JAR (SBT Cache)**            | `sbt-index`, `sbt-cache`                                                                                                                                         | Usually none                  | Usually none                                                                      |
| **JAR (Maven Cache)**          | `maven-index`, `maven-cache`, `maven-repo`                                                                                                                       | Usually none                  | Usually none                                                                      |
| **Python (Default)**           | `python`, `py`, `pypi`, `uv`, `pip`, `poetry`, `pdm`, `hatch`                                                                                                    | `pip`, `poetry`, `uv`         | `pypi.org`                                                                        |
| **Python (Specific version)**  | `python*` (Example: python38, python39, python311)                                                                                                               | `pip`, `poetry`, `uv`         | `pypi.org`                                                                        |
| **Golang**                     | `go`, `golang`                                                                                                                                                   | `go`                          | `pkg.go.dev`, `proxy.golang.org`, `pkg.go.dev`                                    |
| **Rust**                       | `rust`, `rust-lang`, `cargo`                                                                                                                                     | `cargo`                       | `crates.io`                                                                       |
| **Ruby**                       | `ruby`, `gems`, `rubygems`, `bundler`, `rb`, `gemspec`                                                                                                           | `bundle`                      | `rubygems.org`                                                                    |
| **Ruby (Specific version)**    | `ruby*` (Example: ruby2.5.4, ruby3.4.0)                                                                                                                          | `bundle`                      | `rubygems.org`                                                                    |
| **PHP**                        | `php`, `composer`                                                                                                                                                | `composer`                    | Usually none _(add `api.github.com` if using packages that fetch from GitHub)_    |
| **.NET (C#)**                  | `csharp`, `netcore`, `dotnet`, `vb`, `dotnet-framework`                                                                                                          | `dotnet`                      | `api.nuget.org` _(add `api.github.com` if using packages that fetch from GitHub)_ |
| **Dart**                       | `dart`, `flutter`, `pub`                                                                                                                                         | `pub`                         | `pub.dev`                                                                         |
| **Haskell**                    | `haskell`, `hackage`, `cabal`                                                                                                                                    | `cabal`                       | Usually none                                                                      |
| **Elixir**                     | `elixir`, `hex`, `mix`                                                                                                                                           | `mix`                         | Usually none                                                                      |
| **C++**                        | `c`, `cpp`, `c++`, `conan`                                                                                                                                       | `conan`, `cmake`              | Usually none                                                                      |
| **Clojure**                    | `clojure`, `edn`, `clj`, `leiningen`                                                                                                                             | `clj`, `lein`                 | Usually none                                                                      |
| **GitHub Actions**             | `github`, `actions`                                                                                                                                              | Usually none                  | Usually none                                                                      |
| **Jenkins Plugins**            | `jenkins`                                                                                                                                                        | Usually none                  | Usually none                                                                      |
| **Helm**                       | `helm`, `charts`                                                                                                                                                 | `helm`                        | Usually none                                                                      |
| **Helm (Cache)**               | `helm-index`, `helm-repo`                                                                                                                                        | `helm`                        | Usually none                                                                      |
| **Container**                  | `oci`, `docker`, `podman`, `container`                                                                                                                           | `docker`, `podman`            | `docker.io`, `api.nuget.org`, `*.maven.org`                                       |
| **Container File**             | `universal`, `containerfile`, `docker-compose`, `dockerfile`, `swarm`, `tekton`, `kustomize`, `operator`, `skaffold`, `kubernetes`, `openshift`, `yaml-manifest` | Usually none                  | Usually none                                                                      |
| **Google Cloud Build**         | `cloudbuild`                                                                                                                                                     | Usually none                  | Usually none                                                                      |
| **Swift (iOS)**                | `swift`                                                                                                                                                          | `swift`                       | Usually none _(add `api.github.com` if using packages that fetch from GitHub)_    |
| **Binary**                     | `binary`, `blint`                                                                                                                                                | `blint`, `cargo`, `jar`       | Usually none                                                                      |
| **Nix Flakes**                 | `nix`, `nixos`, `flake`                                                                                                                                          | Usually none                  | Usually none _(add `api.github.com`, `github.com` if flakes fetch from GitHub)_   |
| **Open API**                   | `yaml-manifest`                                                                                                                                                  | Usually none                  | Usually none                                                                      |
| **Operating System**           | `os`, `osquery`, `windows`, `linux`, `mac`, `macos`, `darwin`                                                                                                    | `osquery`                     | Usually none                                                                      |

## Platform-Specific Commands

These external commands are only invoked in certain platforms.

### Linux Only

| Language / Platform  | External Commands    | Purpose                      |
| -------------------- | -------------------- | ---------------------------- |
| **All Languages**    | `ldd`                | List dynamic dependencies    |
| **Operating System** | `dpkg`, `rpm`, `apk` | Package managers             |
| **Container**        | `dpkg`, `rpm`, `apk` | Container package inspection |

### macOS Only

| Language / Platform  | Additional Commands | Purpose                      |
| -------------------- | ------------------- | ---------------------------- |
| **cocoapods**        | `pod`               | CocoaPods dependency manager |
| **Operating System** | `brew`              | Homebrew package manager     |

### Windows Only

| Language / Platform  | Additional Commands | Purpose                    |
| -------------------- | ------------------- | -------------------------- |
| **.NET (C#)**        | `nuget`             | NuGet package manager      |
| **Operating System** | `choco`             | Chocolatey package manager |
| **Operating System** | `winget`            | Winget package manager     |

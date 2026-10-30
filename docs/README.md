# Getting Started <!-- {docsify-ignore-all} -->

cdxgen is available as standalone executable binaries, container images, and an npm package. The standalone binaries and container images are recommended for CI and production because they have no runtime dependencies. Begin your journey by selecting your use case.

## Installation

### Standalone executables (recommended)

`cdxgen`, `aibom`, and `hbom` are available as standalone binaries for Linux, macOS, and Windows. These binaries do not require Node.js or `npm` to be installed on the system, making them ideal for CI/CD environments, containerized scans, or quick local usage.

Binaries are available in the [GitHub Releases](https://github.com/cdxgen/cdxgen/releases) page.

**Available Variants:**

- **Standard:** (`cdxgen-linux-amd64`, `aibom-linux-amd64`, `hbom-linux-amd64`, etc.) The default standalone binaries with the node runtime. For HBOM, the standard variant also bundles `@cdxgen/cdx-hbom` and the matching `@cdxgen/cdxgen-plugins-bin*` companion helpers.
- **Slim:** (`-slim`) Smaller binaries with the node runtime and without the companion plugin bundle. `cdxgen-*-slim` omits the binary plugins, and `hbom-*-slim` keeps `@cdxgen/cdx-hbom` while omitting `@cdxgen/cdxgen-plugins-bin*`.
- **Musl:** (`-musl`) Linked against Musl libc, specifically for **Alpine Linux**.

#### Linux and macOS (Bash)

```bash
OS=linux
ARCH=amd64
BINARY_NAME=cdxgen-$OS-$ARCH

curl -LO "https://github.com/cdxgen/cdxgen/releases/latest/download/$BINARY_NAME"
curl -LO "https://github.com/cdxgen/cdxgen/releases/latest/download/$BINARY_NAME.sha256"

if command -v sha256sum >/dev/null; then
  sha256sum -c "$BINARY_NAME.sha256"
else
  shasum -a 256 -c "$BINARY_NAME.sha256"
fi

chmod +x "$BINARY_NAME"
./"$BINARY_NAME" --version
```

#### Windows (PowerShell)

```powershell
$Arch = "amd64"
$BinaryName = "cdxgen-windows-$Arch.exe"
$BaseUrl = "https://github.com/cdxgen/cdxgen/releases/latest/download"

Invoke-WebRequest -Uri "$BaseUrl/$BinaryName" -OutFile $BinaryName
Invoke-WebRequest -Uri "$BaseUrl/$BinaryName.sha256" -OutFile "$BinaryName.sha256"

$ExpectedHash = (Get-Content "$BinaryName.sha256").Split(" ")[0].Trim()
$ActualHash = (Get-FileHash $BinaryName -Algorithm SHA256).Hash.ToLower()

if ($ExpectedHash -eq $ActualHash) {
    Write-Host "Hash verified successfully!" -ForegroundColor Green
    & .\$BinaryName --version
} else {
    Write-Error "Hash mismatch! Do not run the binary."
}
```

> **Note:** `hbom` and `hbom-slim` follow the same release naming convention
> (for example, `hbom-linux-amd64` and `hbom-linux-amd64-slim`). The
> `cdx-verify`, `cdx-sign`, `cdx-validate`, and `cdx-convert`
> tools are also available as standalone binaries in the releases using the
> same naming convention (e.g., `cdx-convert-linux-amd64`).

Package managers that install the standalone executable with a single command:

If you are a [Homebrew](https://brew.sh/) user, you can install [cdxgen](https://formulae.brew.sh/formula/cdxgen) via:

```bash
brew install cdxgen
```

If you are a [Winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/) user on windows, you can also install cdxgen via:

```shell
winget install cdxgen
```

#### First run and the extraction cache

The standalone binaries are self-extracting [caxa](https://github.com/cdxgen/caxa) executables. The first run of a release extracts it into a cache directory, `caxa` under the system temp directory, and later runs start from there. Set `CAXA_TEMP_DIR` to use another directory, for example when the temp directory is read-only or mounted `noexec`.

On Linux and macOS, the large native plugins such as atom, trivy and osquery are extracted the first time a scan runs them, so the first run stays short. A low-priority background process then extracts the rest; set `CAXA_PREFETCH=0` to turn it off. Windows binaries extract everything on the first run.

Each release extracts into a directory of its own, and old ones are never removed automatically. To reclaim the space, delete the `caxa` cache directory while no cdxgen binary is running; the next run extracts again.

### npm and JavaScript package managers

The npm package is an alternative when you already have Node.js >= 24 available or need cdxgen as a library.

**npm**:

```shell
npm install -g @cdxgen/cdxgen --omit=optional --ignore-scripts --min-release-age=2
```

**pnpm**:

```shell
pnpm add -g @cdxgen/cdxgen --ignore-scripts --config.minimum-release-age=2880
```

**bun**:

```shell
bun install -g @cdxgen/cdxgen --ignore-scripts
```

> **Note:** cdxgen v13 moved to the `@cdxgen/cdxgen` package (the older `@cyclonedx/cdxgen` name is deprecated). If you are upgrading from v0.x or v1.x, review the migration guide in [MIGRATING-TO-V13.md](../MIGRATING-TO-V13.md) and the list of removed features in [docs/DEPRECATIONS.md](DEPRECATIONS.md) before installing.

## Generate BOM for source code inputs

Minimal example.

```shell
cd <Path to source code>
cdxgen -o bom.json
```

For a java project. This would automatically detect maven, gradle or sbt and build bom accordingly

```shell
cdxgen -t java -o bom.json
```

To print the SBOM as a table pass `-p` argument.

```shell
cdxgen -t java -o bom.json -p
```

To recursively generate a single BOM for all languages pass `-r` argument.

```shell
cdxgen -r -o bom.json
```

Generate an AI/ML BOM and run the preferred AI-BOM audit pack:

```shell
cdxgen -r --include-formulation -o aibom.json --bom-audit --bom-audit-categories ai-bom
```

Read next: [AI-BOM Guide](AI_BOM.md), [BOM Audit](BOM_AUDIT.md), and [Tutorial: AI-BOM governance and audit](LESSON15.md).

Generate directly from a git URL:

```shell
cdxgen -t java -o bom.json --git-branch main https://github.com/HooliCorp/java-sec-code.git
```

Generate from a package URL (purl):

```shell
cdxgen -t js -o bom.json "pkg:npm/lodash@4.17.21"
```

Supported purl source types: `npm`, `pypi`, `gem`, `cargo`, `pub`, `github`, `bitbucket`, `maven` (version required), `composer`, and `generic` (with `vcs_url` or `download_url` qualifier).

> **Warning:** For purl inputs, cdxgen resolves repository metadata from registries. This information can be inaccurate or malicious, so review resolved sources before trusting output.

cdxgen generates CycloneDX documents at specification version `1.6`, `1.7`, or `2.0`. Pass the desired target with the `--spec-version` argument.

```shell
cdxgen -r -o bom.json --spec-version 1.6
```

Legacy `1.4` and `1.5` documents are no longer produced directly, because those versions predate required v13 features. To obtain a `1.5` document, generate at `1.6` or later and then convert with `cdx-convert`.

```shell
cdxgen -r -o bom.json --spec-version 1.6
cdx-convert -i bom.json -o bom-1.5.json --to 1.5
```

To generate SBOM for C or Python, cdxgen uses the bundled atom companion, which ships as a native binary needing no JDK on linux-amd64, linux-arm64 (glibc), linux-amd64-musl, darwin-arm64, and windows-amd64. Only the jar-based triples (darwin-amd64, windows-arm64, linux-arm64-musl) require Java >= 23.

```shell
cdxgen -t c -o bom.json
```

## Generate BOM for container images

`docker` type is automatically detected based on the presence of values such as `sha256` or `docker.io` prefix etc in the path.

```shell
cdxgen odoo@sha256:4e1e147f0e6714e8f8c5806d2b484075b4076ca50490577cdf9162566086d15e -o bom.json
```

You can also pass `-t docker` for simple labels. Only the `latest` tag would be pulled if none was specified.

```shell
cdxgen ghcr.io/owasp-dep-scan/depscan:nightly -o bom.json -t docker
```

For offline or staged scans, point cdxgen at a locally reconstructed root filesystem directory. The container pipeline accepts `-t docker`, `-t rootfs`, or `-t oci-dir` for this mode.

```shell
cdxgen /tmp/remote_target -o /tmp/bom.json -t rootfs
```

With the packaged helpers installed, rootfs and container BOMs gain repository trust-source components, deep keyring / CA-store `cryptographic-asset` components, native CycloneDX origin fields such as `supplier`, `manufacturer`, and `authors` for OS package trust metadata, plus additional package trust-state properties such as `PackageArchitecture`, `PackageSource`, and `PackageStatus`.

You can also pass the .tar file of a container image.

```shell
docker pull ghcr.io/owasp-dep-scan/depscan
docker save -o /tmp/slim.tar ghcr.io/owasp-dep-scan/depscan
podman save -q --format oci-archive -o /tmp/slim.tar ghcr.io/owasp-dep-scan/depscan
cdxgen /tmp/slim.tar -o /tmp/bom.json -t docker
```

### Podman in rootless mode

Setup podman in either [rootless](https://github.com/containers/podman/blob/master/docs/tutorials/rootless_tutorial.md) or [remote](https://github.com/containers/podman/blob/master/docs/tutorials/mac_win_client.md) mode

On Linux, do not forget to start the podman socket which is required for API access.

```bash
systemctl --user enable --now podman.socket
systemctl --user start podman.socket
podman system service -t 0 &
```

## Generate BOM for operating environments (OBOM)

Use the `obom` command to generate an OBOM for a live system or a VM for compliance and vulnerability management purposes. Linux, Windows, and macOS are supported in this mode, though some macOS tables require elevated privileges and Full Disk Access.

```shell
# obom is an alias for cdxgen -t os
obom -o obom.json
cdxgen -t os -o obom.json .
```

This feature is powered by osquery, which is [installed](https://github.com/cdxgen/cdxgen-plugins-bin/blob/main/build.sh#L8) along with the binary plugins. cdxgen would opportunistically try to detect as many components, apps, and extensions as possible using the platform-specific default queries under `data/queries*.json`. With osquery 5.24.0, the default profiles include Gatekeeper posture on macOS, Secure Boot certificate inventory on Linux, targeted Windows process-open-handle telemetry, improved npm package discovery, the packages of pacman, snap, flatpak, Homebrew on Linux and MacPorts, the AI agent skills installed for each user, GPUs with their driver versions, and the default search engine of each Chromium-based browser profile. The process would take several minutes and result in an SBOM file with thousands of components of various types such as operating-system, device-drivers, files, and data.

The operating system packages of an OBOM are named the way a container scan names them, so a package found by `cdxgen -t docker <image>` and by `obom` run inside that image has the same purl. A deb, rpm or apk package takes the vendor of the distro as its namespace, the `arch`, `distro` and `distro_name` qualifiers, and `epoch` when it has one. A pacman package takes the vendor and the `arch` qualifier, the only one the alpm type defines. None of them has a subpath.

| Package manager | Example purl                                                                                         | Read from                                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| deb             | `pkg:deb/ubuntu/php8.3-cli@8.3.6-0ubuntu0.24.04.13?arch=amd64&distro=ubuntu-24.04&distro_name=noble` | osquery `deb_packages`; the version is as dpkg reports it, epoch included                                                                                                                                                                                    |
| rpm             | `pkg:rpm/almalinux/openssl-libs@1:3.5.8-1.el9_8?arch=x86_64&distro=almalinux-9.8&epoch=1`            | osquery `rpm_packages`; the version is `[epoch:]version-release`                                                                                                                                                                                             |
| apk             | `pkg:apk/alpine/php84@8.4.27-r0?arch=x86_64&distro=alpine-3.24.3&distro_name=alpine-3.24`            | The apk installed database (`/lib/apk/db/installed`, `/usr/lib/apk/db/installed` on a usr-merged system, or `/var/lib/apk/db/installed`), because osquery has no apk table; Wolfi and Chainguard hosts give `pkg:apk/wolfi/...` and `pkg:apk/chainguard/...` |
| pacman          | `pkg:alpm/arch/zlib@1:1.3.2-4?arch=x86_64`                                                           | osquery `pacman_packages` (Arch and the distros built on it); the version is as pacman reports it, epoch and release included                                                                                                                                |
| Homebrew        | `pkg:brew/php@8.5.11_1`                                                                              | osquery `homebrew_packages`, on macOS and Linux; a cask has the same form, and `cdx:homebrew:type` says `formula` or `cask`                                                                                                                                  |
| MacPorts        | `pkg:macports/openssl3@3.6.0_0`                                                                      | osquery `macports_packages`; the version is `version_revision`, as `port installed` prints it                                                                                                                                                                |
| snap            | `pkg:snap/core22@20250408`                                                                           | osquery `snap_packages`, current revision only; the revision, channel and confinement are `cdx:snap:*` properties                                                                                                                                            |
| flatpak         | `pkg:flatpak/org.gnome.Calculator@48.1?arch=x86_64&branch=stable`                                    | osquery `flatpak_packages`, system-wide and per user; named by the application ID, with the AppStream name in `cdx:flatpak:displayName`                                                                                                                      |

The apk packages carry `cdx:osquery:category` = `apk_packages` like the packages of the other categories. If the apk database exists but cannot be read, for example because the scan does not run as root, the OBOM has no apk packages and the `os.apk-installed-db.unreadable` degradation is recorded when introspection is on.

The npm and pypi packages that osquery finds (`npm_packages`, `python_packages`) are named without the path they were found at, for example `pkg:npm/%40npmcli/agent@4.0.2` or `pkg:pypi/pyyaml@6.0`. Each path is an occurrence in `evidence.occurrences` (and the `path` property), so a package installed in several places, such as under two Node.js versions, is listed once with all of its locations.

A Firefox add-on (`firefox_addons`) is named by its add-on ID, not by the profile it was found in: `pkg:swid/uBlock%2BOrigin@1.75.0?tag_id=uBlock0%40raymondhill.net`. Each profile it is installed in is an occurrence, so an add-on in several profiles, or installed by several users, is listed once. On Linux, osquery 5.24.0 also reads the profiles that Firefox 147 and later create under `~/.config/mozilla/firefox`.

Chromium and VS Code extensions (`chrome_extensions`, `vscode_extensions`) get the purls `-t chrome-extension` and `-t vscode-extension` give them, for example `pkg:chrome-extension/nmmhkkegccagdldgiimedpiccmgmieda@1.0.0.6` and `pkg:vscode-extension/redhat/vscode-yaml@2.0.0`. Each browser profile or editor the extension is installed in is an occurrence.

When `trustinspector` is available, live-host OBOM generation also enriches matching macOS and Windows components with code-signing / notarization / Authenticode properties and emits additional host-trust `data` components for Gatekeeper and WDAC posture. See [Trust enrichment BOM diff examples](./TRUST_ENRICHMENT_DIFF.md) for compact before/after excerpts.

For macOS-specific setup and permission caveats, see [OBOM macOS troubleshooting](./OBOM_MACOS_TROUBLESHOOTING.md).

For practical SOC/IR and compliance playbooks, see [OBOM lessons](./OBOM_LESSONS.md). For container hardening and breakout-focused binary reviews, see [Lesson 9](./LESSON9.md).

## Generate BOM for hardware (HBOM)

Use the `hbom` command to generate a dedicated hardware inventory for the current host. Current collectors support Apple Silicon macOS, Linux amd64, Linux arm64, and Windows amd64 and arm64 (the Windows collector uses the PowerShell that ships with Windows).

```shell
hbom -o hbom.json
# or use the main CLI
cdxgen -t hbom -o hbom.json .
```

If you need a combined hardware and live runtime host view, generate a merged document with:

```shell
hbom --include-runtime -o host-view.json
```

For more options, diagnostics, and merged host workflows, see the [HBOM guide](./HBOM.md) and [Lesson 13](./LESSON13.md).

## Integrate with Dependency Track

Invoke cdxgen with the following arguments to automatically submit the BOM to your organization's Dependency-Track server. Pass the server URL and an API key, then identify the target project by name and version (or by its UUID).

Key Dependency-Track flags:

- `--server-url` - Dependency-Track base URL (e.g. `https://deptrack.cyclonedx.io`).
- `--api-key` - Dependency-Track API key.
- `--project-name` - Project name. Defaults to the scanned directory name.
- `--project-version` - Project version.
- `--project-id` - Existing project UUID. Either supply this, or the project name and version together.
- `--project-group` and `--project-tag` - Optional project group and tags (tags accept multiple values).
- `--parent-project-id` - UUID of an existing parent project. You must provide either this id, or both `--parent-project-name` and `--parent-project-version` so the parent can be resolved.
- `--auto-create` - Let Dependency-Track create the project if it does not exist.
- `--is-latest` - Mark the uploaded BOM as the latest version.
- `--skip-dt-tls-check` - Skip the TLS certificate check when calling Dependency-Track (use only for self-signed or internal servers).

## Example

```shell
cdxgen -t java -o bom.json \
  --server-url https://deptrack.server.com \
  --api-key "token" \
  --project-name my-service \
  --project-version 1.0.0 \
  --parent-project-name platform --parent-project-version main
```

## Companion CLI tools

cdxgen v13 ships several companion CLIs alongside the main `cdxgen` command. Each is available as an npm binary, a standalone SEA binary, and inside the container image.

- [`cdx-audit`](CDX_AUDIT.md) - Predictive supply-chain audit that scores a generated BOM and reports risk.
- [`cdx-convert`](CDX_CONVERT.md) - Export CycloneDX to SPDX, and convert between CycloneDX spec versions.
- [`cdx-validate`](CDX_VALIDATE.md) - Validate a BOM against SCVS and CRA requirements.
- [`cdx-sign`](CDX_SIGN.md) - Sign a CycloneDX BOM.
- [`cdx-verify`](CDX_VERIFY.md) - Verify BOM signatures, including nested component and service signatures.
- [`evinse`](EVINSE.md) - Enrich a BOM with evidence and produce a SaaSBOM.
- [`tracebom`](TRACEBOM.md) - Generate a dynamic SBOM by tracing a running process.

# Supported Languages and Package Managers

See our [Supported Project Types](https://cdxgen.github.io/cdxgen/#/PROJECT_TYPES) documentation

# Advanced Usage

cdxgen supports advanced use cases as a library and in REPL mode.

#### **Resolving Licenses**

cdxgen can automatically query public registries such as maven, npm, or nuget to resolve the package licenses. This is a time-consuming operation and is disabled by default. To enable, set the environment variable `FETCH_LICENSE` to `true`, as shown.

```bash
export FETCH_LICENSE=true
```

#### **SBOM Server**

Invoke cdxgen with `--server` argument to run it in server mode. By default, it listens to port `9090`, which can be customized with the arguments `--server-host` and `--server-port`.

```shell
cdxgen --server
```

Or use the container image.

```bash
docker run --rm -v /tmp:/tmp -p 9090:9090 -v $(pwd):/app:rw -t ghcr.io/cdxgen/cdxgen -r /app --server --server-host 0.0.0.0
```

Use curl or your favourite tool to pass arguments to the `/sbom` route.

### Scanning a local path

```shell
curl "http://127.0.0.1:9090/sbom?path=/Volumes/Work/sandbox/vulnerable-aws-koa-app&multiProject=true&type=js"
```

### Scanning a git repo

```shell
curl "http://127.0.0.1:9090/sbom?url=https://github.com/HooliCorp/vulnerable-aws-koa-app.git&multiProject=true&type=js"
```

If you need to pass credentials to authenticate.

```shell
curl "http://127.0.0.1:9090/sbom?url=https://<access_token>@github.com/some/repo.git&multiProject=true&type=js"
curl "http://127.0.0.1:9090/sbom?url=https://<username>:<password>@bitbucket.org/some/repo.git&multiProject=true&type=js"
```

You can POST the arguments.

```bash
curl -H "Content-Type: application/json" http://localhost:9090/sbom -XPOST -d $'{"url": "https://github.com/HooliCorp/vulnerable-aws-koa-app.git", "type": "nodejs", "multiProject": "true"}'
```

#### **Integration as Library**

cdxgen is [ESM only](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c) and could be imported and used with both deno and Node.js >= 24

Minimal example:

```ts
import { createBom, submitBom } from "npm:@cdxgen/cdxgen@^13";
```

See the [Deno Readme](https://github.com/cdxgen/cdxgen/blob/master/contrib/deno/README.md) for detailed instructions.

```javascript
import { createBom, submitBom } from "@cdxgen/cdxgen";
// bomNSData would contain bomJson
const bomNSData = await createBom(filePath, options);
// Submission to dependency track server
const dbody = await submitBom(args, bomNSData.bomJson);
```

#### **BOM Signing**

cdxgen can sign the generated BOM json file to increase authenticity and non-repudiation capabilities. To enable this, set the following environment variables.

- SBOM_SIGN_ALGORITHM: JSF algorithm. Example: RS512. It must match the key type.
- SBOM_SIGN_PRIVATE_KEY: Location of the private key (PEM format), or of the shared secret for HS256, HS384, and HS512
- SBOM_SIGN_PUBLIC_KEY: Optional. Location of the public key to embed. It must belong to the private key.

To generate a test key pair for `SBOM_SIGN_ALGORITHM`, you can run cdxgen by passing the argument `--generate-key-and-sign`. The generated json file would have an attribute called `signature`, a JSON Signature Format (JSF) signature that `cdx-verify` validates. JSF is not JWS, so JWT tools cannot verify it.

When signing is configured (`SBOM_SIGN_ALGORITHM` plus a private key), cdxgen signs the BOM it writes, prints, or submits to Dependency-Track, and exits with status 1 if it cannot sign it, including when the key file is missing. A private key without `SBOM_SIGN_ALGORITHM` leaves the BOM unsigned and prints a warning; set `SBOM_SIGN_ALGORITHM=none` to opt out explicitly.

![SBOM signing](_media/sbom-sign.jpg)

### Verifying the signature

Use the bundled `cdx-verify` command. By default it performs strict deep verification: it validates the top-level BOM signature and every nested component, service, and annotation signature against the provided public key. Pass `--no-deep` to check only the root signature.

```shell
npm install -g @cdxgen/cdxgen --omit=optional --ignore-scripts --min-release-age=2
cdx-verify -i bom.json --public-key public.key
```

### Verifying the signature (pnpm)

Use the bundled `cdx-verify` command. By default it performs strict deep verification of the top-level signature plus every nested component, service, and annotation signature. Pass `--no-deep` to verify only the root signature.

You can run it directly using pnpm (no global install needed):

```shell
pnpm dlx @cdxgen/cdxgen cdx-verify -i bom.json --public-key public.key
```

### Custom verification tool (Node.js example)

There are many [libraries](https://jwt.io/#libraries-io) available to validate JSON Web Tokens. Below is a javascript example.

```js
import { readFileSync } from "node:fs";

import jws from "jws";

// npm install jws
const bomJsonFile = "bom.json";
const publicKeyFile = "public.key";
const bomJson = JSON.parse(readFileSync(bomJsonFile, "utf8"));
// Retrieve the signature
const bomSignature = bomJson.signature.value;
const validationResult = jws.verify(
  bomSignature,
  bomJson.signature.algorithm,
  readFileSync(publicKeyFile, "utf8"),
);
if (validationResult) {
  console.log("Signature is valid!");
} else {
  console.log("SBOM signature is invalid :(");
}
```

#### **REPL Mode**

`cdxi` is the interactive REPL for creating, importing, querying, and reviewing BOMs.

[![cdxi demo](https://asciinema.org/a/602361.svg)](https://asciinema.org/a/602361)

Use it to:

- generate or import a BOM with `.create` or `.import`
- inspect trust and provenance with `.trusted` and `.provenance`
- review operator-friendly AI lineage with `.aibom`
- review audit annotations with `.auditfindings`, `.auditactions`, and `.dispatchedges`
- inspect evidence with `.occurrences`, `.callstack`, `.services`, and `.formulation`
- pivot through OBOM categories with `.osinfocategories` and built-in osquery commands such as `.processes`

See [`REPL.md`](REPL.md) for the full command reference.

### Sample REPL usage

Start the REPL server.

```shell
cdxi
```

Below are some example commands to create an SBOM for a spring application and perform searches and queries.

```
.create /mnt/work/vuln-spring
.print
.search spring
.query components[name ~> /spring/ and scope = "required"]
.trusted
.provenance
.auditfindings
// Supplier names
.query $distinct(components.supplier.name)

# Check obom metadata for windows os
.query metadata.component[purl ~> /Windows/]

# check if docker is installed in the c drive
.query components[name ~> /Docker/ and properties.value ~> "C:"]

# check if docker is running, exposing a pipe
.query components[name ~> /docker/ and properties[value = "pipes_snapshot"]]

.sort name
.sort components^(>name)
.update | components[name ~> /spring/] | {'publisher': "foo"} |
```

### REPL History

Repl history will persist under the `$HOME/.config/.cdxgen` directory. To override this location, use the environment variable `CDXGEN_REPL_HISTORY`.

[![SBOM](https://img.shields.io/badge/SBOM-with_%E2%9D%A4%EF%B8%8F_by_cdxgen-FF753D)](https://github.com/cdxgen/cdxgen)
[![AI-DECLARATION: pair](https://img.shields.io/badge/䷼%20AI--DECLARATION-pair-ffedd5?labelColor=ffedd5)](./AI-DECLARATION.md)
[![JSR][badge-jsr]][jsr-cdxgen]
[![NPM][badge-npm]][npmjs-cdxgen]
[![GitHub Releases][badge-github-releases]][github-releases]
[![NPM Downloads][badge-npm-downloads]][npmjs-cdxgen]
[![GitHub License][badge-github-license]][github-license]
[![GitHub Contributors][badge-github-contributors]][github-contributors]
[![SWH][badge-swh]][swh-cdxgen]

# CycloneDX Generator (cdxgen)

<img src="./docs/_media/cdxgen.png" width="200" height="auto" />

cdxgen is a CLI tool, library, [REPL](./ADVANCED.md), and server to create, validate, sign, and verify software BOMs. It generates CycloneDX JSON BOMs and supports SPDX 3.0.1 JSON-LD export. CycloneDX is a full-stack BOM specification that is easily created, human and machine-readable, and simple to parse. The tool supports CycloneDX specification versions from 1.5 - 1.7.

Supported BOM formats:

- Software (SBOM) - For many languages and container images.
- Cryptography (CBOM) - For Java and Python projects.
- Operations (OBOM) - For Linux container images and VMs running Linux or Windows operating systems.
- Software-as-a-Service (SaaSBOM) - For Java, Python, JavaScript, TypeScript, and PHP projects.
- Attestations (CDXA) - Generate SBOM with templates for multiple standards. Sign the BOM document at a granular level to improve authenticity.
- Vulnerability Disclosure Report (VDR) - Use cdxgen with [OWASP depscan](https://github.com/owasp-dep-scan/dep-scan) to automate the generation of VDR at scale.

Supported output document formats:

- CycloneDX JSON (primary native format)
- SPDX 3.0.1 JSON-LD (`cdxgen --format spdx` or `cdx-convert`)

## Choose your path

| Persona              | What cdxgen helps you do                                                               | First command                                                              | Read next                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Developers**       | Generate a CycloneDX BOM from a local repo, git URL, purl, or container image          | `cdxgen -o bom.json .`                                                     | [CLI Usage][docs-cli], [Supported Project Types][docs-project-types]                                      |
| **AppSec**           | Enrich BOMs with evidence, run BOM audit rules, and feed downstream security workflows | `cdxgen -o bom.json --profile appsec --evidence --bom-audit .`             | [BOM Audit](docs/BOM_AUDIT.md), [Threat Model](docs/THREAT_MODEL.md)                                      |
| **SOC analysts**     | Build OBOM inventories for live hosts and triage runtime posture issues                | `obom -o obom.json --deep --bom-audit --bom-audit-categories obom-runtime` | [OBOM lessons](docs/OBOM_LESSONS.md), [Server Usage][docs-server]                                         |
| **Compliance teams** | Validate BOM quality, check SCVS/CRA posture, and export SPDX deliverables             | `cdx-validate -i bom.json --benchmark scvs-l2,cra`                         | [cdx-validate](docs/CDX_VALIDATE.md), [cdx-convert](docs/CDX_CONVERT.md), [Permissions][docs-permissions] |

### Role-based quick starts

#### For developers

- Start with a local path, git URL, or purl and generate a BOM in one command.
- Use [Supported Project Types][docs-project-types] to confirm ecosystem coverage before wiring cdxgen into CI.

#### For AppSec

- Use `--profile appsec`, `--evidence`, and `--bom-audit` when you want richer security context.
- Combine generation with [BOM Audit](docs/BOM_AUDIT.md), [cdx-validate](docs/CDX_VALIDATE.md), signing, and verification for a fuller secure-SBOM workflow.

#### For SOC analysts

- Use `obom` for live-system and runtime inventory on Linux and Windows hosts.
- Focus on [OBOM lessons](docs/OBOM_LESSONS.md) when you need host triage, persistence review, LOLBAS-backed Windows startup analysis, or incident-response evidence.

#### For compliance and platform governance

- Use `cdx-validate` to assess structural and compliance posture, then `cdx-convert` when SPDX output is required.
- Review [Permissions][docs-permissions] and hardened-environment guidance before adopting cdxgen in controlled pipelines.

## Why cdxgen?

Most SBOM tools are like simple barcode scanners. For easy applications, they can parse a few package manifests and create a list of components only based on these files without any deep inspection. Further, a typical application might have several repos, components, and libraries with complex build requirements. Traditional techniques to generate an SBOM per language or package manifest either do not work in enterprise environments or don't provide the confidence required for both compliance and automated analysis. So we built cdxgen - the universal polyglot SBOM generator that is user-friendly, precise, and comprehensive!

**Our philosophy:**

- _Explainability:_ Don't list, but explain with evidence.
- _Precision:_ Try using multiple techniques to improve precision, even if it takes extra time.
- _Personas:_ Cater to the needs of a range of personas such as security researchers, compliance auditors, developers, and SOC.
- _Machine Learning:_ Optimize the generated data for Machine Learning (ML) purposes by considering the various model properties.
- _Safety:_ Execute external build tools and handle untrusted inputs defensively, with hardened defaults and a [secure mode](docs/PERMISSIONS.md) for sensitive environments.

## Documentation

Please visit our [GPT app][cdxgen-gpt] or the [documentation site][docs-homepage] for detailed usage, tutorials, and support documentation.

Sections include:

- [Getting Started][docs-homepage]
- [CLI Usage][docs-cli]
- [Server Usage][docs-server]
- [Hands-on Lessons](docs/LESSON8.md)
- [Container Escape & Privilege Lesson](docs/LESSON9.md)
- [Supported Project Types][docs-project-types]
- [Environment Variables][docs-env-vars]
- [Advanced Usage][docs-advanced-usage]
- [Permissions][docs-permissions]
- [Security Policy](SECURITY.md)
- [Threat Model](docs/THREAT_MODEL.md)
- [Support (Enterprise & Community)][docs-support]

## Usage

## Installing

Install the npm package when you want the full multi-command CLI surface.

```shell
npm install -g @cyclonedx/cdxgen
```

Installing `@cyclonedx/cdxgen` exposes these commands:

| Command         | Purpose                                                                                              | Standalone GitHub release binary |
| --------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------- |
| `cdxgen`        | Generate CycloneDX / SPDX BOMs from source, images, binaries, git URLs, or purls                     | yes                              |
| `cdx-audit`     | Prioritize existing BOM dependencies for upstream supply-chain review using explainable risk signals | yes                              |
| `cdx-convert`   | Convert CycloneDX JSON to SPDX 3.0.1 JSON-LD                                                         | yes                              |
| `cdx-sign`      | Sign BOMs with JSF signatures                                                                        | yes                              |
| `cdx-validate`  | Validate BOMs and benchmark posture                                                                  | yes                              |
| `cdx-verify`    | Verify BOM signatures                                                                                | yes                              |
| `cdxi`          | Open the interactive REPL                                                                            | no                               |
| `evinse`        | Add evidence, reachability, and service context                                                      | no                               |
| `cbom`          | Alias for CBOM-oriented `cdxgen` defaults                                                            | use `cdxgen`                     |
| `obom`          | Alias for `cdxgen -t os`                                                                             | use `cdxgen`                     |
| `saasbom`       | Alias for SaaSBOM-oriented `cdxgen` defaults                                                         | use `cdxgen`                     |
| `spdxgen`       | Alias for `cdxgen --format spdx`                                                                     | use `cdxgen`                     |
| `cdxgen-secure` | Alias for hardened `cdxgen` defaults                                                                 | use `cdxgen`                     |

Standalone GitHub release binaries are published for `cdxgen`, `cdxgen-slim`, `cdx-audit`, `cdx-convert`, `cdx-sign`, `cdx-validate`, and `cdx-verify`.

`cdx-audit` is designed to accelerate upstream dependency review with explainable, evidence-backed risk prioritization. It complements provenance, reproducibility, and manual investigation rather than replacing them.

To run cdxgen without installing (hotloading), use the [pnpm dlx](https://pnpm.io/cli/dlx) command.

```shell
corepack pnpm dlx @cyclonedx/cdxgen --help
```

You can call any packaged command the same way:

```shell
corepack pnpm dlx --package=@cyclonedx/cdxgen cdx-audit --help
corepack pnpm dlx --package=@cyclonedx/cdxgen cdx-convert --help
corepack pnpm dlx --package=@cyclonedx/cdxgen cdx-validate --help
corepack pnpm dlx --package=@cyclonedx/cdxgen cdx-sign --help
corepack pnpm dlx --package=@cyclonedx/cdxgen cdx-verify --help
corepack pnpm dlx --package=@cyclonedx/cdxgen evinse --help
corepack pnpm dlx --package=@cyclonedx/cdxgen cdxi --help
```

If you are a [Homebrew][homebrew-homepage] user, you can also install [cdxgen][homebrew-cdxgen] via:

```shell
$ brew install cdxgen
```

If you are a [Winget][winget-homepage] user on windows, you can also install cdxgen via:

```shell
winget install cdxgen
```

### Standalone GitHub release binaries

If you want a single-file executable instead of an npm installation, download a published release asset and verify its hash before executing it.

Common asset names:

- `cdxgen-linux-amd64`
- `cdxgen-linux-amd64-musl`
- `cdxgen-darwin-arm64`
- `cdxgen-windows-amd64.exe`
- `cdx-audit-linux-amd64`
- `cdx-audit-darwin-arm64`
- `cdx-audit-windows-amd64.exe`
- `cdx-convert-*`, `cdx-sign-*`, `cdx-validate-*`, `cdx-verify-*`

#### Linux

```bash
VERSION="v12.3.0"
ASSET="cdx-audit-linux-amd64"
BASE_URL="https://github.com/cdxgen/cdxgen/releases/download/${VERSION}"

curl -fsSLO "${BASE_URL}/${ASSET}"
curl -fsSLO "${BASE_URL}/${ASSET}.sha256"
sha256sum -c "${ASSET}.sha256"
chmod +x "${ASSET}"
./"${ASSET}" --help
```

#### macOS

```bash
VERSION="v12.3.0"
ASSET="cdx-audit-darwin-arm64"
BASE_URL="https://github.com/cdxgen/cdxgen/releases/download/${VERSION}"

curl -fsSLO "${BASE_URL}/${ASSET}"
curl -fsSLO "${BASE_URL}/${ASSET}.sha256"
shasum -a 256 -c "${ASSET}.sha256"
chmod +x "${ASSET}"
./"${ASSET}" --help
```

#### Windows (PowerShell)

```powershell
$Version = "v12.3.0"
$Asset = "cdx-audit-windows-amd64.exe"
$BaseUrl = "https://github.com/cdxgen/cdxgen/releases/download/$Version"

Invoke-WebRequest -Uri "$BaseUrl/$Asset" -OutFile $Asset
Invoke-WebRequest -Uri "$BaseUrl/$Asset.sha256" -OutFile "$Asset.sha256"
$Expected = (Get-Content "$Asset.sha256" | Select-Object -First 1).Trim().Split()[0]
$Actual = (Get-FileHash $Asset -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Actual -ne $Expected.ToLowerInvariant()) {
  throw "SHA256 mismatch for $Asset"
}
.\$Asset --help
```

#### GitHub Actions with the GitHub CLI

```yaml
permissions:
  contents: read

steps:
  - name: Download cdx-audit release binary
    env:
      GH_TOKEN: ${{ github.token }}
    run: |
      gh release download v12.3.0 \
        --repo cdxgen/cdxgen \
        --pattern 'cdx-audit-linux-amd64' \
        --pattern 'cdx-audit-linux-amd64.sha256'
      sha256sum -c cdx-audit-linux-amd64.sha256
      chmod +x cdx-audit-linux-amd64
      ./cdx-audit-linux-amd64 --help
```

Deno and bun runtime can be used with limited support.

```shell
deno install --allow-read --allow-env --allow-run --allow-sys=uid,systemMemoryInfo,gid,homedir --allow-write --allow-net -n cdxgen "npm:@cyclonedx/cdxgen/cdxgen"
```

You can also use the cdxgen container image with node, deno, or bun runtime versions.

The default version uses Node.js 23

```bash
docker run --rm -e CDXGEN_DEBUG_MODE=debug -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen:master -r /app -o /app/bom.json
```

To use the deno version, use `ghcr.io/cyclonedx/cdxgen-deno` as the image name.

```bash
docker run --rm -e CDXGEN_DEBUG_MODE=debug -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-deno:master -r /app -o /app/bom.json
```

For the bun version, use `ghcr.io/cyclonedx/cdxgen-bun` as the image name.

```bash
docker run --rm -e CDXGEN_DEBUG_MODE=debug -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-bun:master -r /app -o /app/bom.json
```

In deno applications, cdxgen could be directly imported without any conversion.

```ts
import { createBom, submitBom } from "npm:@cyclonedx/cdxgen@^12.2.1";
```

## Common workflows

| Goal                                                       | First command                                                              | Read next                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| Generate a BOM from the current repository                 | `cdxgen -o bom.json .`                                                     | [CLI Usage][docs-cli]                |
| Generate a BOM from a git URL                              | `cdxgen -o bom.json https://github.com/example/project.git`                | [CLI Usage][docs-cli]                |
| Generate a BOM from a package URL                          | `cdxgen -o bom.json "pkg:npm/lodash@4.17.21"`                              | [CLI Usage][docs-cli]                |
| Scan a container image                                     | `cdxgen ghcr.io/owasp-dep-scan/depscan:nightly -o bom.json -t docker`      | [Server Usage][docs-server]          |
| Audit a generated BOM for built-in supply-chain findings   | `cdxgen -o bom.json --bom-audit .`                                         | [BOM Audit](docs/BOM_AUDIT.md)       |
| Prioritize an existing BOM for upstream risk-driven review | `cdx-audit --bom bom.json`                                                 | [cdx-audit](docs/CDX_AUDIT.md)       |
| Validate a BOM against structural and compliance checks    | `cdx-validate -i bom.json`                                                 | [cdx-validate](docs/CDX_VALIDATE.md) |
| Convert CycloneDX JSON to SPDX JSON-LD                     | `cdx-convert -i bom.json -o bom.spdx.json`                                 | [cdx-convert](docs/CDX_CONVERT.md)   |
| Generate an OBOM for live-system triage                    | `obom -o obom.json --deep --bom-audit --bom-audit-categories obom-runtime` | [OBOM lessons](docs/OBOM_LESSONS.md) |

For the full option reference, use `cdxgen --help` or visit [CLI Usage][docs-cli].

Companion commands also expose built-in help:

- `cbom --help`
- `cdx-audit --help`
- `cdx-validate --help`
- `cdx-convert --help`
- `cdx-sign --help`
- `cdx-verify --help`
- `cdxgen-secure --help`
- `cdxi --help`
- `evinse --help`
- `obom --help`
- `saasbom --help`
- `spdxgen --help`

## Example

Minimal example.

```shell
cdxgen -o bom.json
```

The primary positional input can be:

- a local filesystem path (default: current directory)
- a git URL that cdxgen clones before scanning
- a package URL (purl) that cdxgen resolves to source and then scans

Common source input examples:

```shell
# Local path
cdxgen -o bom.json .

# Git URL
cdxgen -t java -o bom.json --git-branch main https://github.com/HooliCorp/java-sec-code.git

# Package URL (purl)
cdxgen -t js -o bom.json "pkg:npm/lodash@4.17.21"
```

For a java project. cdxgen would automatically detect maven, gradle, or sbt and build bom accordingly

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

To generate an SBOM directly from a git URL:

```shell
cdxgen -t java -o bom.json --git-branch main https://github.com/HooliCorp/java-sec-code.git
```

This works anywhere cdxgen expects its primary source input, so a git URL can be used in place of `.` or any other local path.

To generate an SBOM from a package URL (purl), cdxgen resolves registry metadata to a repository URL, clones it, and scans it:

```shell
cdxgen -t js -o bom.json "pkg:npm/lodash@4.17.21"
```

Supported purl source types: `npm`, `pypi`, `gem`, `cargo`, `pub`, `github`, `bitbucket`, `maven` (version required), `composer`, and `generic` (with `vcs_url` or `download_url` qualifier).

> **Warning:** Repository URLs resolved from registries may be inaccurate or malicious. Review resolved sources before trusting generated output.

The default specification used by cdxgen is 1.7. To generate BOM for a different specification version, such as 1.5 or 1.6, pass the version number using the `--spec-version` argument.

```shell
# 1.6 is supported by most tools
cdxgen -r -o bom.json --spec-version 1.6
```

To generate SBOM for C or Python, ensure Java >= 21 is installed.

```shell
# Install java >= 21
cdxgen -t c -o bom.json
```

NOTE: cdxgen is known to freeze with Java 8 or 11, so ensure >= 21 is installed and JAVA_HOME environment variable is configured correctly. If in doubt, use the cdxgen container image.

## Universal SBOM

By passing the type argument `-t universal`, cdxgen could be forced to opportunistically collect as many components and services as possible by scanning all package, container, and Kubernetes manifests. The resulting SBOM could have over a thousand components, thus requiring additional triaging before use with traditional SCA tools.

## SBOM server

Invoke cdxgen with `--server` argument to run it in server mode. By default, it listens to port `9090`, which can be customized with the arguments `--server-host` and `--server-port`.

```shell
cdxgen --server
```

Or use the container image.

```bash
docker run --rm -v /tmp:/tmp -p 9090:9090 -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen -r /app --server --server-host 0.0.0.0
```

Use curl or your favorite tool to pass arguments to the `/sbom` route.

### Server arguments

Arguments can be passed either via the query string or as a JSON body. Please refer to [Server Usage][docs-server]

### Health endpoint

Use the /health endpoint to check if the SBOM server is up and running.

```shell
curl "http://127.0.0.1:9090/health"
```

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

### Docker compose

```shell
git clone https://github.com/cdxgen/cdxgen.git
docker compose up
```

## War file support

cdxgen can generate a BOM file from a given war file.

```shell
# cdxgen -t java app.war
cdxgen app.war
```

## Resolving class names

Sometimes, it is necessary to resolve class names contained in jar files. By passing an optional argument `--resolve-class`, it is possible to get cdxgen to create a separate mapping file with the jar name (including the version) as the key and class names list as a value.

```shell
cdxgen -t java --resolve-class -o bom.json
```

This would create a bom.json.map file with the jar - class name mapping. Refer to [these](test/data/bom-maven.json.map) [examples](test/data/bom-gradle.json.map) to learn about the structure.

## Resolving licenses

cdxgen can automatically query public registries such as maven, npm, or nuget to resolve the package licenses. This is a time-consuming operation and is disabled by default. To enable, set the environment variable `FETCH_LICENSE` to `true`, as shown. Ensure that `GITHUB_TOKEN` is set or provided by [built-in GITHUB_TOKEN in GitHub Actions][github-rate-limit], otherwise rate limiting might prevent license resolving.

```bash
export FETCH_LICENSE=true
```

## Dependency Tree

cdxgen can retain the dependency tree under the `dependencies` attribute for a small number of supported package manifests. These are currently limited to:

- package-lock.json
- yarn.lock
- pnpm-lock.yaml
- Maven (pom.xml)
- Gradle
- Scala SBT
- Python (requirements.txt, setup.py, pyproject.toml, poetry.lock)
- .NET (packages.lock.json, project.assets.json, paket.lock, .nuspec/.nupkg)
- Go (go.mod)
- PHP (composer.lock)
- Ruby (Gemfile.lock)
- Rust (Cargo.lock)

## Plugins

cdxgen could be extended with external binary plugins to support more SBOM use cases. These are now installed as an optional dependency.

```shell
sudo npm install -g @cdxgen/cdxgen-plugins-bin
```

## Plugins (pnpm)

`cdxgen` can be extended with external binary plugins to support more SBOM use cases.  
These are now installed as optional dependencies and can be used without a global install.

```shell
pnpm dlx @cdxgen/cdxgen-plugins-bin
```

## Docker / OCI container support

`docker` type is automatically detected based on the presence of values such as `sha256` or `docker.io` prefix etc in the path.

```shell
cdxgen odoo@sha256:4e1e147f0e6714e8f8c5806d2b484075b4076ca50490577cdf9162566086d15e -o /tmp/bom.json
```

You can also pass `-t docker` with repository names. Only the `latest` tag would be pulled if none was specified.

```shell
cdxgen shiftleft/scan-slim -o /tmp/bom.json -t docker
```

You can also pass the .tar file of a container image.

```shell
docker pull shiftleft/scan-slim
docker save -o /tmp/slim.tar shiftleft/scan-slim
podman save -q --format oci-archive -o /tmp/slim.tar shiftleft/scan-slim
cdxgen /tmp/slim.tar -o /tmp/bom.json -t docker
```

### Podman in rootless mode

Setup podman in either [rootless][podman-github-rootless] or [remote][podman-github-remote] mode

Do not forget to start the podman socket required for API access on Linux.

```shell
systemctl --user enable --now podman.socket
systemctl --user start podman.socket
podman system service -t 0 &
```

## Generate OBOM for a live system

You can use the `obom` command to generate an OBOM for a live system or a VM for compliance and vulnerability management purposes. Windows and Linux operating systems are supported in this mode.

```shell
# obom is an alias for cdxgen -t os
obom
# cdxgen -t os
```

This feature is powered by osquery, which is [installed](https://github.com/cdxgen/cdxgen-plugins-bin/blob/main/build.sh#L8) along with the binary plugins. cdxgen would opportunistically try to detect as many components, apps, and extensions as possible using the [default queries](data/queries.json). The process would take several minutes and result in an SBOM file with thousands of components of various types, such as operating-system, device-drivers, files, and data.

For practical SOC/IR and compliance workflows, see the dedicated [OBOM lessons](./docs/OBOM_LESSONS.md).

## Generate Cryptography Bill of Materials (CBOM)

Use the `cbom` alias to generate a CBOM. This is currently supported only for Java projects.

```shell
cbom -t java
# cdxgen -t java --include-crypto -o bom.json .
```

## Generating SaaSBOM and component evidences

See [evinse mode](./ADVANCED.md) in the advanced documentation.

---

## BOM signing

cdxgen features a best-in-class, native **JSON Signature Format (JSF)** implementation for BOM signing, providing robust authenticity and non-repudiation capabilities. Unlike basic signing tools, our implementation fully supports granular signatures (signing individual components, services, and annotations), parallel Multi-Signatures (`signers`), and sequential Signature Chains (`chain`).

To enable automatic signing during BOM generation, set the following environment variables:

- `SBOM_SIGN_ALGORITHM`: JSF Algorithm. Examples: `RS512`, `ES256`, `Ed25519`, `HS256`
- `SBOM_SIGN_PRIVATE_KEY`: Location of the private key (PEM format)
- `SBOM_SIGN_PUBLIC_KEY`: Optional. Location of the public key
- `SBOM_SIGN_MODE`: Optional. Signature mode (`replace`, `signers`, `chain`). Default is `replace`.

To quickly generate test public/private key pairs and sign your first BOM, you can run cdxgen with the `--generate-key-and-sign` argument.

### Advanced Signing with `cdx-sign`

For complex supply chain orchestration, use the bundled `cdx-sign` CLI. This tool allows multiple entities (e.g., a Builder and an Auditor) to co-sign an existing BOM without modifying its original data.

```shell
# Append a parallel multi-signature (Auditor co-signing)
# Note: Granular component signing is disabled to preserve the Builder's original signature payload.
cdx-sign -i bom.json -k auditor_private.pem -a ES256 --key-id "auditor-qa" --mode signers --no-sign-components
```

### Validating CycloneDX BOMs

Use the bundled `cdx-validate` command to validate CycloneDX BOMs against **structural**, **deep**, and **compliance** checks. Refer to this [document](./docs/CDX_VALIDATE.md) for usage.

### Verifying the signature

Use the bundled `cdx-verify` command to validate BOM signatures. By default, `cdx-verify` performs a **strict deep verification**, meaning it mathematically validates the top-level BOM signature _and_ the signatures of every nested component, service, and annotation against the provided public key. Refer to this [lesson](./docs/LESSON6.md) for the usage of sign and verify commands.

```shell
npm install -g @cyclonedx/cdxgen

# Perform strict deep verification (default)
cdx-verify -i bom.json --public-key public.key

# Verify ONLY the top-level root signature (useful for verifying a multi-signer who didn't sign nested components)
cdx-verify -i bom.json --public-key auditor_public.key --no-deep
```

### Verifying the signature (pnpm)

You can run the verification tools directly using pnpm (no global install needed):

```shell
pnpm dlx @cyclonedx/cdxgen cdx-verify -i bom.json --public-key public.key
```

You can also use pnpm to invoke the signing tool:

```shell
pnpm dlx @cyclonedx/cdxgen cdx-sign -i bom.json -k private.key
```

---

## Automatic usage detection

For node.js projects, lock files are parsed initially, so the SBOM would include all dependencies, including dev ones. An AST parser powered by babel-parser is then used to detect packages that are imported and used by non-test code. Such imported packages would automatically set their scope property to `required` in the resulting SBOM. You can turn off this analysis by passing the argument `--no-babel`. Scope property would then be set based on the `dev` attribute in the lock file.

This attribute can be later used for various purposes. For example, [dep-scan][depscan-github] uses this attribute to prioritize vulnerabilities. Unfortunately, tools such as dependency track, do not include this feature and might over-report the CVEs.

With the argument `--required-only`, you can limit the SBOM only to include packages with the scope "required", commonly called production or non-dev dependencies. Combine with `--no-babel` to limit this list to only non-dev dependencies based on the `dev` attribute being false in the lock files.

For go, `go mod why` command is used to identify required packages. For php, composer lock file is parsed to distinguish required (packages) from optional (packages-dev).

## Automatic services detection

cdxgen can automatically detect names of services from YAML manifests such as docker-compose, Kubernetes, or Skaffold manifests. These would be populated under the `services` attribute in the generated SBOM. With [evinse](./ADVANCED.md), additional services could be detected by parsing common annotations from the source code.

## Conversion to SPDX format

For direct conversion of an existing CycloneDX JSON BOM to SPDX JSON-LD, use
the bundled `cdx-convert` command:

```shell
cdx-convert -i bom.json -o bom.spdx.json
```

`cdx-convert` currently supports CycloneDX 1.6 and 1.7 inputs and exports
SPDX 3.0.1 JSON-LD.

Use `cdxgen --format spdx` (or `--format cyclonedx,spdx`) when generating BOMs.
Use the [CycloneDX CLI][cyclonedx-cli-github] tool for advanced use cases such
as diff and merging.

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

## License

Permission to modify and redistribute is granted under the terms of the Apache 2.0 license. See the [LICENSE][github-license] file for the full license.

## Integration as library

cdxgen is [ESM only](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c) and could be imported and used with both deno and Node.js >= 20

Minimal example:

```ts
import { createBom, submitBom } from "npm:@cyclonedx/cdxgen@^9.0.1";
```

See the [Deno Readme](./contrib/deno/README.md) for detailed instructions.

```javascript
import { createBom, submitBom } from "@cyclonedx/cdxgen";
// bomNSData would contain bomJson
const bomNSData = await createBom(filePath, options);
// Submission to dependency track server
const dbody = await submitBom(args, bomNSData.bomJson);
```

## Contributing

Please check out our [open issues][github-contribute] if you are interested in helping.

### Codeberg Mirror

The project is mirrored on [Codeberg](https://codeberg.org/cdxgen/cdxgen). Users can clone the repository using the following URL:

```shell
git clone https://codeberg.org/cdxgen/cdxgen.git
```

The maintainers accept Pull Requests (PRs) against the Codeberg repository.

> **Note:** The Codeberg repository is currently synced manually from GitHub.

Before raising a PR, please run the following commands.

```shell
corepack enable pnpm
pnpm install:frozen
# Generate types using jsdoc syntax
pnpm run gen-types
# Run biomejs formatter and linter with auto fix
pnpm run lint
# Run jest tests
pnpm test
```

### Testing main branch

Use `pnpm add -g` command to quickly test the main branch.

```shell
corepack pnpm bin -g
corepack pnpm setup
corepack pnpm add -g https://github.com/cdxgen/cdxgen
cdxgen --help
```

### Testing main branch (No Global Install)

To quickly test the latest main branch without installing globally, you can use `pnpm` in a local or temporary environment.

```shell
corepack enable
pnpm install --prefer-offline
pnpm dlx cdxgen --help
```

## Sponsors

<div style="display: flex; align-items: center; gap: 20px;">
  <img src="./docs/_media/GithubLogo-LightBg.png" width="180" height="180">
  <img src="./docs/_media/MicrosoftLogo.png" width="180" height="180">
</div>

Some features are funded through [NGI Zero Core](https://nlnet.nl/core), a fund established by [NLnet](https://nlnet.nl) with financial support from the European Commission's [Next Generation Internet](https://ngi.eu) program. Learn more at the [NLnet project page](https://nlnet.nl/project/OWASP-dep-scan).

[<img src="https://nlnet.nl/logo/banner.png" alt="NLnet foundation logo" width="20%" />](https://nlnet.nl)
[<img src="https://nlnet.nl/image/logos/NGI0_tag.svg" alt="NGI Zero Logo" width="20%" />](https://nlnet.nl/core)

cdxgen is an OWASP Foundation production project.

[<img src="https://owasp.org/assets/images/logo.png" width="20%" />](https://owasp.org)

## cdxgen badge

Copy the below block to your markdown files to show your ❤️ for cdxgen.

```markdown
[![SBOM](https://img.shields.io/badge/SBOM-with_%E2%9D%A4%EF%B8%8F_by_cdxgen-FF753D)](https://github.com/cdxgen/cdxgen)
```

<!-- LINK LABELS -->
<!-- Badges -->

[badge-github-contributors]: https://img.shields.io/github/contributors/cyclonedx/cdxgen
[badge-github-license]: https://img.shields.io/github/license/cyclonedx/cdxgen
[badge-github-releases]: https://img.shields.io/github/v/release/cyclonedx/cdxgen
[badge-jsr]: https://img.shields.io/jsr/v/%40cyclonedx/cdxgen
[badge-npm]: https://img.shields.io/npm/v/%40cyclonedx%2Fcdxgen
[badge-npm-downloads]: https://img.shields.io/npm/dy/%40cyclonedx%2Fcdxgen
[badge-swh]: https://archive.softwareheritage.org/badge/origin/https://github.com/cdxgen/cdxgen/

<!-- cdxgen github project -->

[github-contribute]: https://github.com/cdxgen/cdxgen/contribute
[github-contributors]: https://github.com/cdxgen/cdxgen/graphs/contributors
[github-issues]: https://github.com/cdxgen/cdxgen/issues
[github-license]: https://github.com/cdxgen/cdxgen/blob/master/LICENSE
[github-releases]: https://github.com/cdxgen/cdxgen/releases

<!-- cdxgen documentation site -->

[docs-homepage]: https://cdxgen.github.io/cdxgen
[docs-advanced-usage]: https://cdxgen.github.io/cdxgen/#/ADVANCED
[docs-cli]: https://cdxgen.github.io/cdxgen/#/CLI
[docs-env-vars]: https://cdxgen.github.io/cdxgen/#/ENV
[docs-permissions]: https://cdxgen.github.io/cdxgen/#/PERMISSIONS
[docs-project-types]: https://cdxgen.github.io/cdxgen/#/PROJECT_TYPES
[docs-server]: https://cdxgen.github.io/cdxgen/#/SERVER
[docs-support]: https://cdxgen.github.io/cdxgen/#/SUPPORT

<!-- web links-->

[appthreat-homepage]: https://www.appthreat.com
[cyclonedx-homepage]: https://cyclonedx.org
[cyclonedx-cli-github]: https://github.com/CycloneDX/cyclonedx-cli
[depscan-github]: https://github.com/cyclonedx/dep-scan
[github-rate-limit]: https://docs.github.com/en/rest/overview/rate-limits-for-the-rest-api#primary-rate-limit-for-github_token-in-github-actions
[homebrew-homepage]: https://brew.sh
[homebrew-cdxgen]: https://formulae.brew.sh/formula/cdxgen
[winget-homepage]: https://learn.microsoft.com/en-us/windows/package-manager/winget/
[jsr-cdxgen]: https://jsr.io/@cyclonedx/cdxgen
[jwt-homepage]: https://jwt.io
[jwt-libraries]: https://jwt.io/libraries
[librariesio]: https://libraries.io/npm/@cyclonedx%2Fcdxgen
[npmjs-cdxgen]: https://www.npmjs.com/package/@cyclonedx/cdxgen
[podman-github-rootless]: https://github.com/containers/podman/blob/master/docs/tutorials/rootless_tutorial.md
[podman-github-remote]: https://github.com/containers/podman/blob/master/docs/tutorials/mac_win_client.md
[swh-cdxgen]: https://archive.softwareheritage.org/browse/origin/?origin_url=https://github.com/cdxgen/cdxgen
[cdxgen-gpt]: https://chatgpt.com/g/g-673bfeb4037481919be8a2cd1bf868d2-cyclonedx-generator-cdxgen

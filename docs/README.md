# Getting Started <!-- {docsify-ignore-all} -->

cdxgen is available as an npm package, container image, and single executable binaries. Begin your journey by selecting your use case.

## Installation

```shell
npm install -g @cyclonedx/cdxgen
```

If you are a [Homebrew](https://brew.sh/) user, you can also install [cdxgen](https://formulae.brew.sh/formula/cdxgen) via:

```bash
brew install cdxgen
```

If you are a [Winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/) user on windows, you can also install cdxgen via:

```shell
winget install cdxgen
```

## Single Executable Application (SEA) Binaries

`cdxgen` is available as a standalone binary for Linux, macOS, and Windows. These binaries do not require Node.js or `npm` to be installed on the system, making them ideal for CI/CD environments, containerized scans, or quick local usage.

Binaries are available in the [GitHub Releases](https://github.com/cdxgen/cdxgen/releases) page.

**Available Variants:**

- **Standard:** (`cdxgen-linux-amd64`, etc.) The default standalone binary with bundled plugins and node runtime.
- **Slim:** (`-slim`) Smaller binaries with the node runtime and without the binary plugins. Some project types that require plugins such as `docker`, `os`, and features such as `evinse` will not work.
- **Musl:** (`-musl`) Linked against Musl libc, specifically for **Alpine Linux**.

### Linux and macOS (Bash)

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

### Windows (PowerShell)

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

> **Note:** The `cdx-verify`, `cdx-sign`, `cdx-validate`, and `cdx-convert`
> tools are also available as standalone binaries in the releases using the
> same naming convention (e.g., `cdx-convert-linux-amd64`).

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

To generate SBOM for an older specification version such as 1.4, pass the version using the `--spec-version` argument.

```shell
cdxgen -r -o bom.json --spec-version 1.4
```

To generate SBOM for C or Python, ensure Java >= 21 is installed.

```shell
# Install java >= 21
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

#### **Generate OBOM**

You can use the `obom` command to generate an OBOM for a live system or a VM for compliance and vulnerability management purposes. Windows and Linux operating systems are supported in this mode.

```shell
# obom is an alias for cdxgen -t os
obom
# cdxgen -t os
```

This feature is powered by osquery, which is [installed](https://github.com/cdxgen/cdxgen-plugins-bin/blob/main/build.sh#L8) along with the binary plugins. cdxgen would opportunistically try to detect as many components, apps, and extensions as possible using the [default queries](https://github.com/cdxgen/cdxgen/blob/master/data/queries.json). The process would take several minutes and result in an SBOM file with thousands of components of various types such as operating-system, device-drivers, files, and data.

For practical SOC/IR and compliance playbooks, see [OBOM lessons](./OBOM_LESSONS.md). For container hardening and breakout-focused binary reviews, see [Lesson 9](./LESSON9.md).

#### **Integrate with Dependency Track**

Invoke cdxgen with the below arguments to automatically submit the BOM to your organization's Dependency Track server.

```shell
      --type                   Project type. Please refer to https://cyclonedx.g
                               ithub.io/cdxgen/#/PROJECT_TYPES for supported lan
                               guages/platforms.
      --server-url             Dependency track url. Eg: https://deptrack.cyclon
                               edx.io
      --api-key                Dependency track api key
      --project-group          Dependency track project group
      --project-name           Dependency track project name. Default use the di
                               rectory name
      --project-version        Dependency track project version    [default: ""]
      --project-tag            Dependency track project tag. Multiple values all
                               owed.                                     [array]
      --project-id             Dependency track project id. Either provide the i
                               d or the project name and version together
      --parent-project-id      Dependency track parent project id. You must provide the id or both
                               parent project name and parent project version.
      --parent-project-name    Dependency track parent project name
      --parent-project-version Dependency track parent project version
```

## Example

```shell
cdxgen -t java -o bom.json --server-url https://deptrack.server.com --api-key "token" --project-group ...
```

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
docker run --rm -v /tmp:/tmp -p 9090:9090 -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen -r /app --server --server-host 0.0.0.0
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

cdxgen is [ESM only](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c) and could be imported and used with both deno and Node.js >= 20

Minimal example:

```ts
import { createBom, submitBom } from "npm:@cyclonedx/cdxgen@^9.9.0";
```

See the [Deno Readme](https://github.com/cdxgen/cdxgen/blob/master/contrib/deno/README.md) for detailed instructions.

```javascript
import { createBom, submitBom } from "@cyclonedx/cdxgen";
// bomNSData would contain bomJson
const bomNSData = await createBom(filePath, options);
// Submission to dependency track server
const dbody = await submitBom(args, bomNSData.bomJson);
```

#### **BOM Signing**

cdxgen can sign the generated BOM json file to increase authenticity and non-repudiation capabilities. To enable this, set the following environment variables.

- SBOM_SIGN_ALGORITHM: Algorithm. Example: RS512
- SBOM_SIGN_PRIVATE_KEY: Location to the RSA private key
- SBOM_SIGN_PUBLIC_KEY: Optional. Location to the RSA public key

To generate test public/private key pairs, you can run cdxgen by passing the argument `--generate-key-and-sign`. The generated json file would have an attribute called `signature`, which could be used for validation. [jwt.io](https://jwt.io) is a known site that could be used for such signature validation.

![SBOM signing](_media/sbom-sign.jpg)

### Verifying the signature

Use the bundled `cdx-verify` command, which supports verifying a single signature added at the bom level.

```shell
npm install -g @cyclonedx/cdxgen
cdx-verify -i bom.json --public-key public.key
```

### Verifying the signature (pnpm)

Use the bundled `cdx-verify` command, which supports verifying a single signature added at the BOM level.

You can run it directly using pnpm (no global install needed):

```shell
pnpm dlx @cyclonedx/cdxgen cdx-verify -i bom.json --public-key public.key
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

# Server Usage

## Overview

```mermaid
sequenceDiagram
    actor User
    User->>+cdxgen server: Invoke /sbom
    cdxgen server-->>-User: SBOM Response
```

## Running as a server

Invoke cdxgen with `--server` argument to run it in server mode. By default, it listens to port `9090`, which can be customized with the arguments `--server-host` and `--server-port`.

```shell
cdxgen --server
```

Or use the container image.

```bash
docker run --rm -v /tmp:/tmp -p 9090:9090 -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen -r /app --server --server-host 0.0.0.0
```

Use curl or your favorite tool to pass arguments to the `/sbom` route.

## API Specification

View the latest [cdxgen server API specification](https://github.com/cdxgen/cdxgen/blob/master/lib/server/openapi.yaml) online via [Swagger Editor](https://editor.swagger.io/?url=https://raw.githubusercontent.com/CycloneDX/cdxgen/master/lib/server/openapi.yaml).

## Server arguments

Arguments can be passed either via the query string or as a JSON body. The following arguments are supported.

| Argument           | Description                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| path               | Absolute local path to scan.                                                                                                                                                                                                                                                                                                          |
| url                | Remote source to scan. Supports Git URLs (`https://...git`, `ssh://...`, `git@...`) and package URLs (`pkg:npm/...`, `pkg:pypi/...`, `pkg:gem/...`, `pkg:cargo/...`, `pkg:pub/...`, `pkg:github/...`, `pkg:bitbucket/...`, `pkg:maven/...` with version, `pkg:composer/...`, `pkg:generic/...` with `vcs_url` or `download_url`).                                                                 |
| type               | Project type. Supports passing multiple types separated by `,`. For example, "dotnet java"                                                                                                                                                                                                                                            |
| multiProject       | [boolean]                                                                                                                                                                                                                                                                                                                             |
| requiredOnly       | Include only the packages with required scope on the SBOM. [boolean]                                                                                                                                                                                                                                                                  |
| noBabel            | Do not use babel to perform usage analysis for JavaScript/TypeScript projects. [boolean]                                                                                                                                                                                                                                              |
| installDeps        | Install dependencies automatically for some projects. Defaults to true but disabled for containers and oci scans. [boolean] [default: true]                                                                                                                                                                                           |
| projectId          | The UUID of the project. You must provide the UUID or the projectName and projectVersion (or all three).                                                                                                                                                                                                                              |
| projectName        | Dependency Track project name. Default use the directory name.                                                                                                                                                                                                                                                                        |
| projectGroup       | Dependency Track project group.                                                                                                                                                                                                                                                                                                       |
| projectVersion     | Dependency Track project version [default: ""]                                                                                                                                                                                                                                                                                        |
| parentUUID         | UUID of the parent project. You must provide the UUID or both parentProjectName and parentProjectVersion.                                                                                                                                                                                                                            |
| parentProjectName  | Name of the parent project.                                                                                                                                                                                                                                                                                                           |
| parentProjectVersion | Version of the parent project.                                                                                                                                                                                                                                                                                                      |
| serverUrl          | URL to the Dependency Track API server.                                                                                                                                                                                                                                                                                               |
| apiKey             | API key for the Dependency Track API server.                                                                                                                                                                                                                                                                                          |
| specVersion        | CycloneDX Specification version to use. [default: 1.5]                                                                                                                                                                                                                                                                                |
| filter             | Filter components containing this word in purl. Multiple values allowed. [array]                                                                                                                                                                                                                                                      |
| only               | Include components only containing this word in purl. Useful to generate BOM with first party components alone. Multiple values allowed.[array]                                                                                                                                                                                       |
| autoCompositions   | Automatically set compositions when the BOM was filtered. [boolean] [default: true]                                                                                                                                                                                                                                                   |
| gitBranch          | Git branch used when cloning the repository. If not specified will use the default branch assigned to the repository.                                                                                                                                                                                                                 |
| lifecycle          | Product lifecycle for the generated BOM. Choices are pre-build, build, post-build.                                                                                                                                                                                                                                                    |
| deep               | Perform deep searches for components. Useful while scanning C/C++ apps, live OS and oci images. [boolean] [default: false]                                                                                                                                                                                                            |
| profile            | BOM profile to use for generation. Default generic. Choices are appsec, research.                                                                                                                                                                                                                                                     |
| exclude            | Additional global pattern(s) to ignore. [array]                                                                                                                                                                                                                                                                                       |
| includeFormulation | Generate formulation section with git metadata and build tools. Use with caution, since there is a risk of exposure of sensitive data such as secrets. [boolean] [default: false]                                                                                                                                                     |
| includeCrypto      | Include crypto libraries as components. Useful for generating CBOM. [boolean] [default: false]                                                                                                                                                                                                                                        |
| standard           | The list of standards which may consist of regulations, industry or organizational-specific standards, maturity models, best practices, or any other requirements which can be evaluated against or attested to. Choices are asvs-4.0.3, bsimm-v13, masvs-2.0.0, nist_ssdf-1.1,pcissc-secure-slc-1.1, scvs-1.0.0, ssaf-DRAFT-2023-11. |

## Ways to use server mode

### Scanning a local path

```shell
curl "http://127.0.0.1:9090/sbom?path=/Volumes/Work/sandbox/vulnerable-aws-koa-app&multiProject=true&type=js"
```

### Scanning a git repo

```shell
curl "http://127.0.0.1:9090/sbom?url=https://github.com/HooliCorp/vulnerable-aws-koa-app.git&multiProject=true&type=js"
```

### Scanning from a purl

```shell
curl "http://127.0.0.1:9090/sbom?url=pkg:npm/lodash@4.17.21&type=js&multiProject=true"
```

> **Warning:** For purl requests, cdxgen resolves repository URLs from registry metadata. Registry metadata may be inaccurate or malicious.

If you need to pass credentials to authenticate.

```shell
curl "http://127.0.0.1:9090/sbom?url=https://<access_token>@github.com/some/repo.git&multiProject=true&type=js"
curl "http://127.0.0.1:9090/sbom?url=https://<username>:<password>@bitbucket.org/some/repo.git&multiProject=true&type=js"
```

You can POST the arguments.

```bash
curl -H "Content-Type: application/json" http://localhost:9090/sbom -XPOST -d $'{"url": "https://github.com/HooliCorp/vulnerable-aws-koa-app.git", "type": "nodejs", "multiProject": "true"}'
```

Using requests.post in Python:

```python
import requests
data = {
    "url": f"https://user:{github_api_key}@github.com/{organization}/{repository}.git",
    "serverUrl": dependencytrack_api_url,
    "apiKey": dependencytrack_api_key,
    "projectId": project_uuid,
    "projectName": project_name,
    "projectVersion": project_version,
    "parentUUID": parent_uuid
}
response = requests.post(url=cdxgen_server_url, json=data)
```

## Security and Hardening

When running `cdxgen` in server mode, especially if exposed to a network, it is highly recommended to configure the following environment variables to harden the server against Server-Side Request Forgery (SSRF) and Remote Code Execution (RCE) attacks.

### 1. Restricting Git Protocols

By default, `cdxgen` safely restricts Git clones to standard secure protocols (`https`, `git`, and `ssh`) and strictly blocks dangerous transport helpers like `ext::` or `fd::` at the application and OS level to prevent command execution.

You can further restrict allowed Git protocols using `CDXGEN_GIT_ALLOW_PROTOCOL` (preferred) or `CDXGEN_SERVER_GIT_ALLOW_PROTOCOL` (server-mode alias).

```shell
# Only allow HTTPS and SSH clones
export CDXGEN_GIT_ALLOW_PROTOCOL="https:ssh"
cdxgen --server
```

_(Note: SCP-style SSH URLs like `git@github.com:repo.git` are fully supported, automatically normalized, and validated securely)._

### 2. Restricting Allowed Hosts

To prevent SSRF and ensure the server only clones repositories from trusted sources, configure an allowlist of hostnames using `CDXGEN_GIT_ALLOWED_HOSTS` (preferred) or `CDXGEN_SERVER_ALLOWED_HOSTS` (server-mode alias).

```shell
export CDXGEN_GIT_ALLOWED_HOSTS="github.com,gitlab.com"
cdxgen --server
curl "http://127.0.0.1:9090/sbom?url=https://github.com/HooliCorp/vulnerable-aws-koa-app.git&multiProject=true&type=js"
```

### 3. Restricting Allowed Local Paths

If the server processes local paths instead of Git URLs, you must restrict which directories it can access using `CDXGEN_ALLOWED_PATHS` (preferred) or `CDXGEN_SERVER_ALLOWED_PATHS` (server-mode alias).

```shell
export CDXGEN_ALLOWED_PATHS="/mnt/work,/mnt/work2"
cdxgen --server
curl "http://127.0.0.1:9090/sbom?path=/mnt/work/vulnerable-aws-koa-app&multiProject=true&type=js"
```

## Health endpoint

Use the /health endpoint to check if the SBOM server is up and running.

```shell
curl "http://127.0.0.1:9090/health"
```

## Docker compose

Use the provided docker-compose file to quickly launch a cdxgen server instance.

```shell
git clone https://github.com/cdxgen/cdxgen.git
docker compose up
```

# Threat Model

This document describes the threat model for cdxgen — a polyglot CycloneDX BOM generator that produces SBOM, CBOM, OBOM, SaaSBOM, CDXA, and VDR documents. It identifies threat actors, attack surfaces, trust boundaries, and mitigations across cdxgen's components: CLI, library, HTTP server, REPL, CI/CD infrastructure, container images, and dependencies.

## System Overview

cdxgen generates CycloneDX Bill-of-Materials (BOM) documents — including SBOM, CBOM, OBOM, SaaSBOM, CDXA, and VDR — by parsing project manifests/lockfiles and optionally invoking external build tools. It operates in six modes:

1. **CLI** (`bin/cdxgen.js`) — Command-line invocation on local projects
2. **Library** (`lib/cli/index.js`) — Programmatic use via `createBom(path, options)`
3. **HTTP Server** (`lib/server/server.js`) — REST API accepting scan requests, optionally with Git clone
4. **REPL** (`bin/repl.js`) — Interactive shell for ad-hoc BOM operations
5. **Evinse** (`bin/evinse.js`) — Evidence generation for SBOM verification (analyzes call stacks, data flows, and usages)
6. **Verify** (`bin/verify.js`) — BOM signature verification using JWS

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────────┐
│                        User Environment                             │
│  ┌───────────┐  ┌────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ CLI / REPL │  │ Library    │  │ HTTP Server  │  │ CI Runner   │ │
│  └─────┬─────┘  └─────┬──────┘  └──────┬───────┘  └──────┬──────┘ │
│        │               │                │                  │        │
│  ══════╪═══════════════╪════════════════╪══════════════════╪══════  │
│  Trust boundary 1: cdxgen code ←→ external build tools              │
│        │               │                │                  │        │
│  ┌─────▼─────────────────────────────────────────────────────────┐ │
│  │                  External Build Tools                          │ │
│  │  npm, maven, gradle, pip, go, cargo, dotnet, ...              │ │
│  └─────┬─────────────────────────────────────────────────────────┘ │
│        │                                                            │
│  ══════╪════════════════════════════════════════════════════════════ │
│  Trust boundary 2: local system ←→ remote registries/hosts          │
│        │                                                            │
│  ┌─────▼─────────────────────────────────────────────────────────┐ │
│  │              Package Registries & Remote Hosts                 │ │
│  │  npmjs.org, maven.org, pypi.org, crates.io, ...               │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

Trust boundary 3: HTTP server ←→ external HTTP clients
Trust boundary 4: cdxgen process ←→ host operating system / filesystem
Trust boundary 5: cdxgen container ←→ container host
```

## Threat Actors

| Actor                        | Capability                                                                             | Motivation                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Malicious project author** | Controls manifest files, lockfiles, build scripts, `.npmrc`, `.mvn/`, `setup.py`, etc. | Supply-chain attack: execute code on machines that scan their project       |
| **Network attacker (MITM)**  | Intercepts HTTP traffic between cdxgen/build tools and registries                      | Inject malicious package metadata, steal credentials, tamper with SBOMs     |
| **Malicious HTTP client**    | Sends crafted requests to the cdxgen server                                            | Path traversal, SSRF, denial of service, Git clone exploits                 |
| **Environment manipulator**  | Controls environment variables in the cdxgen process                                   | Command injection via `NODE_OPTIONS`, credential theft, behavior alteration |
| **Compromised dependency**   | A direct or transitive npm dependency of cdxgen is compromised                         | Arbitrary code execution in the cdxgen process at import time               |
| **Compromised CI/CD**        | Access to GitHub Actions workflows or self-hosted runners                              | Tamper with releases, inject malicious code into published artifacts        |

## Threats and Mitigations by Component

### 1. CLI and Library (`bin/cdxgen.js`, `lib/cli/index.js`)

#### T1.1 — Command injection via project files

**Threat:** Attacker-controlled values from manifests or lockfiles (package names, versions, URLs) are passed to `safeSpawnSync` in a way that escapes command boundaries.

**Mitigations:**

- `safeSpawnSync` uses array-based arguments (not shell strings) via `spawnSync`, preventing shell metacharacter injection
- Command allowlisting via `CDXGEN_ALLOWED_COMMANDS` — only explicitly permitted commands can execute
- In secure mode, automatic package installations are disabled, reducing the set of commands invoked
- `commandsExecuted` tracks all invoked commands for post-run audit

**Residual risk:** Medium — cdxgen invokes many different commands with project-derived arguments. Continuous review is needed as new language support is added.

#### T1.2 — Arbitrary code execution via build tools

**Threat:** cdxgen invokes `npm install`, `mvn`, `pip install`, `gradle`, etc. These tools execute code from project files (postinstall scripts, `setup.py`, Gradle build scripts).

**Mitigations:**

- Secure mode (`CDXGEN_SECURE_MODE=true`) disables automatic package installation
- `safeSpawnSync` warns when `pip`/`uv install` is invoked without `--only-binary=:all:` (prevents `setup.py` execution during wheel builds)
- `safeSpawnSync` warns when Python is invoked without `-S` flag
- Users are advised to run in sandboxed environments for untrusted projects

**Residual risk:** High — this is a fundamental tension. Accurate dependency resolution often requires invoking build tools that may execute untrusted code. Secure mode trades accuracy for safety.

#### T1.3 — Environment variable poisoning

**Threat:** Attacker sets `NODE_OPTIONS` with `--require` or `--eval` to inject code, or manipulates `JAVA_TOOL_OPTIONS`, `NODE_PATH`, proxy variables, or TLS settings.

**Mitigations:**

- `auditEnvironment()` runs at startup and detects:
  - Code execution patterns in `NODE_OPTIONS` (`--require`, `--eval`, `--import`, `--loader`, `--inspect`)
  - JVM agent injection in `MVN_ARGS`, `GRADLE_ARGS`, `JAVA_TOOL_OPTIONS`
  - Module resolution poisoning via `NODE_PATH`
  - Disabled TLS verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`)
  - Credential-like variables
  - Debug mode exposure
  - Running as root outside containers
  - Proxy interception variables
- Findings are reported with severity ratings and remediation guidance

**Residual risk:** Medium — `auditEnvironment` is pattern-based and may not catch novel obfuscation. An attacker who can set environment variables often already has significant access.

#### T1.4 — Path traversal via file inputs

**Threat:** Attacker crafts file paths with `../`, Unicode tricks, or Windows device names to read or write outside the intended project directory.

**Mitigations:**

- `hasDangerousUnicode()` detects bidirectional control characters, zero-width characters, and other obfuscation
- `isValidDriveRoot()` prevents Unicode lookalike drive letters on Windows (CVE-2025-27210 mitigation)
- Node.js `--permission` model (in secure mode) restricts filesystem access to explicitly allowed paths
- `safeExistsSync` and `safeMkdirSync` check permissions before operations

**Residual risk:** Low in secure mode, Medium in default mode.

### 2. HTTP Server (`lib/server/server.js`)

#### T2.1 — Path traversal via scan requests

**Threat:** A client sends a scan request with a path like `/app/../../../etc/passwd` to scan or access files outside allowed directories.

**Mitigations:**

- `isAllowedPath()` resolves paths and checks they are within `CDXGEN_SERVER_ALLOWED_PATHS`
- Uses `path.relative()` to detect `..` traversal
- `hasDangerousUnicode()` blocks Unicode obfuscation in paths
- `isAllowedWinPath()` blocks Windows device names, UNC paths, and invalid drive roots
- Body parser has 1MB request size limit

**Residual risk:** Low when `CDXGEN_SERVER_ALLOWED_PATHS` is configured. Medium when unconfigured (any path is scannable).

#### T2.2 — Git clone exploits

**Threat:** A client sends a Git URL that exploits Git features to execute code during clone (e.g., `ext::` protocol, `fd::` protocol, malicious submodules).

**Mitigations:**

- `validateAndRejectGitSource()` rejects dangerous protocols (`ext::`, `fd::`)
- Validates URL format and hostname against `CDXGEN_SERVER_ALLOWED_HOSTS`
- Git clone uses hardened configuration:
  - `core.fsmonitor=false` — disables filesystem monitor hooks
  - `safe.bareRepository=explicit` — prevents bare repo attacks
  - `-c alias.clone=` — prevents alias abuse
  - `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_NOGLOBAL=1` in secure mode
  - `--depth 1` — limits history to reduce attack surface
- `GIT_ALLOW_PROTOCOL` defaults to `https:ssh` in secure mode

**Residual risk:** Low — multiple layers of Git hardening are applied.

#### T2.3 — Server-Side Request Forgery (SSRF)

**Threat:** A client triggers cdxgen to make HTTP requests to internal hosts via package registry lookups or Git clone URLs.

**Mitigations:**

- `CDXGEN_ALLOWED_HOSTS` restricts `cdxgenAgent` outbound connections
- `CDXGEN_SERVER_ALLOWED_HOSTS` restricts Git clone target hosts
- Secure mode enforces HTTPS-only
- Redirect following is disabled in secure mode

**Residual risk:** Medium — build tools invoked by cdxgen make their own HTTP requests that are not controlled by `CDXGEN_ALLOWED_HOSTS`.

#### T2.4 — Denial of service

**Threat:** A client sends many concurrent requests, very large bodies, or requests for enormous projects to exhaust server resources.

**Mitigations:**

- Body parser limit: 1MB
- Server timeout: 10 minutes (configurable via `CDXGEN_SERVER_TIMEOUT_MS`)
- Spawn timeout: 20 minutes (configurable via `CDXGEN_TIMEOUT_MS`)
- Max buffer: 100MB (configurable via `CDXGEN_MAX_BUFFER`)

**Residual risk:** Medium — no built-in rate limiting or concurrent request limits. The server is designed for trusted internal use. Deploy behind a reverse proxy for production exposure.

#### T2.5 — No authentication or authorization

**Threat:** Any client that can reach the server can trigger scans, potentially accessing the host filesystem.

**Mitigations:**

- `CDXGEN_SERVER_ALLOWED_PATHS` restricts scannable directories
- Users are expected to deploy behind a reverse proxy with authentication
- The server is intended for internal/CI use, not public exposure

**Residual risk:** High if exposed without access controls. Low in intended deployment behind a reverse proxy.

### 3. Dependencies

#### T3.1 — Compromised npm dependency

**Threat:** A direct or transitive dependency publishes a malicious update that executes code when imported.

**Mitigations:**

- `pnpm-lock.yaml` provides reproducible installs with integrity hashes
- `pnpm.onlyBuiltDependencies` restricts which packages can run install scripts
- Renovate provides automated dependency updates with CI testing
- CodeQL scanning runs on the codebase
- npm provenance attestation on published packages
- Optional heavy dependencies (atom, server middleware) are in `optionalDependencies` to reduce the attack surface of minimal installs

**Residual risk:** Medium — supply-chain attacks on npm packages are an industry-wide threat. cdxgen has a moderate dependency tree.

#### T3.2 — Dependency confusion

**Threat:** An attacker publishes a malicious package with the same name as a private dependency to a public registry.

**Mitigations:**

- cdxgen uses only public npm packages; no private registry dependencies
- All dependencies are explicitly versioned in `package.json`
- `pnpm-lock.yaml` pins exact versions with integrity hashes

**Residual risk:** Low.

### 4. CI/CD Infrastructure

#### T4.1 — GitHub Actions supply-chain attack

**Threat:** A compromised GitHub Action or workflow modification injects malicious code into cdxgen releases.

**Mitigations:**

- All GitHub Actions are pinned to full SHA digests (not mutable tags)
- `permissions: {}` default (no permissions) at workflow level; explicit per-job grants
- `persist-credentials: false` on all checkout steps
- npm provenance (`NPM_CONFIG_PROVENANCE=true`) provides verifiable build attestation
- Concurrency controls prevent parallel release workflows

**Residual risk:** Low — strong workflow hardening practices are in place.

#### T4.2 — Self-hosted runner compromise

**Threat:** A self-hosted CI runner is compromised, allowing an attacker to tamper with builds or access secrets.

**Mitigations:**

- Self-hosted runners are used only for specific heavy jobs (e.g., depscan analysis)
- Workflow permissions are scoped to specific jobs
- `persist-credentials: false` limits credential exposure
- Jobs on self-hosted runners do not have release/publish permissions

**Residual risk:** Medium — self-hosted runners inherently have a larger trust boundary than GitHub-hosted runners.

#### T4.3 — Release integrity

**Threat:** An attacker modifies the npm package or container image between build and publish.

**Mitigations:**

- npm provenance attestation links published packages to specific GitHub Actions runs
- Container base images are pinned to SHA digests
- Multi-platform container builds use consistent base images
- CodeQL analysis runs on PRs and pushes

**Residual risk:** Low.

### 5. Container Images

#### T5.1 — Container escape

**Threat:** A vulnerability in the container runtime or cdxgen's container configuration allows escaping to the host.

**Mitigations:**

- `cdxgen-secure` image runs as non-root user (`cyclonedx`)
- Node.js `--permission` model restricts filesystem and child process access within the container
- Limited `--allow-fs-write` to temp and output directories only
- `COMPOSER_ALLOW_SUPERUSER=0` prevents accidental root operations

**Residual risk:** Low for cdxgen-specific vectors. Container runtime vulnerabilities are the responsibility of the runtime vendor.

#### T5.2 — Vulnerable base image

**Threat:** The base container image contains known vulnerabilities.

**Mitigations:**

- Base images are pinned to SHA digests for reproducibility
- Images are regularly rebuilt with updated dependencies
- CI builds test images before publishing

**Residual risk:** Low — regular rebuilds reduce the window of vulnerability.

### 6. SBOM Output

#### T6.1 — Sensitive data in SBOM

**Threat:** Generated SBOMs contain sensitive information (file paths, emails, secrets, internal hostnames) that is inadvertently shared.

**Mitigations:**

- `thoughtLog` performs limited log normalization (for example, replacing the literal `'.'` with `'<project dir>'`), but logs may still include direct or absolute paths
- Warning when `--include-formulation` is used with `--server-url` (formulation may contain emails and secrets)
- In secure mode, using `--include-formulation` with `--server-url` calls `process.exit(1)` after the warning, preventing automatic upload of formulation data
- `auditEnvironment` detects and warns about credential-like environment variables

**Residual risk:** Medium — SBOMs inherently contain metadata about the project. Users should review SBOMs before sharing, especially when formulation data is included.

#### T6.2 — SBOM tampering in transit

**Threat:** An SBOM is modified during upload to a BOM server (Dependency-Track, etc.).

**Mitigations:**

- Secure mode enforces HTTPS-only for all connections including SBOM upload
- cdxgen supports SBOM signing via `SBOM_SIGN_PRIVATE_KEY`

**Residual risk:** Low when secure mode and SBOM signing are enabled.

## Data Flow Diagram

```
                                     ┌───────────────┐
                                     │ Package       │
                                     │ Registries    │
                                     │ (npm, maven,  │
                                     │  pypi, etc.)  │
                                     └───────┬───────┘
                                             │ HTTP(S)
                                             │ [TB2]
                                             │
┌──────────┐    ┌─────────────────┐  ┌───────▼───────┐     ┌──────────────┐
│ Project  │    │    cdxgen       │  │ Build Tools   │     │ BOM Server   │
│ Files    │───►│  ┌───────────┐  │  │ (npm, mvn,    │     │ (Dependency  │
│ (manifests,   │  │ Parsers   │  │  │  pip, go...)  │     │  Track, etc.)│
│ lockfiles,│   │  └─────┬─────┘  │  └───────────────┘     └──────▲───────┘
│ configs) │   │        │        │         ▲                      │
└──────────┘    │  ┌─────▼─────┐  │         │ safeSpawnSync       │ SBOM
   [TB4]        │  │ BOM       │  │─────────┘ [TB1]               │ Upload
                │  │ Builder   │  │                                │
┌──────────┐    │  └─────┬─────┘  │                                │
│ HTTP     │    │        │        │────────────────────────────────┘
│ Client   │───►│  ┌─────▼─────┐  │        HTTP(S) [TB2]
└──────────┘    │  │ Server    │  │
   [TB3]        │  └───────────┘  │
                └─────────────────┘
                     cdxgen
                     process
                     [TB4, TB5]
```

_TB = Trust Boundary (see Trust Boundaries section above)_

## Security Controls Summary

| Control                  | Implementation                                                      | Threat(s) Addressed          |
| ------------------------ | ------------------------------------------------------------------- | ---------------------------- |
| Command allowlisting     | `CDXGEN_ALLOWED_COMMANDS` + `safeSpawnSync`                         | T1.1, T1.2                   |
| Host allowlisting        | `CDXGEN_ALLOWED_HOSTS` + `cdxgenAgent` hooks                        | T2.3, T2.2                   |
| Path allowlisting        | `CDXGEN_SERVER_ALLOWED_PATHS` + `isAllowedPath`                     | T2.1                         |
| Node.js permission model | `--permission` flags in `NODE_OPTIONS`                              | T1.4, T5.1                   |
| Secure mode              | `CDXGEN_SECURE_MODE=true`                                           | T1.2, T2.2, T2.3, T6.2       |
| Environment audit        | `auditEnvironment()` at startup                                     | T1.3                         |
| Unicode validation       | `hasDangerousUnicode()`, `isValidDriveRoot()`                       | T1.4, T2.1                   |
| Git hardening            | `validateAndRejectGitSource()`, hardened clone config               | T2.2                         |
| Safe wrappers            | `safeExistsSync`, `safeMkdirSync`, `safeSpawnSync`                  | T1.1, T1.4                   |
| Structured logging       | `thoughtLog`, `traceLog`, `commandsExecuted`, `remoteHostsAccessed` | Auditability for all threats |
| Dependency pinning       | `pnpm-lock.yaml`, SHA-pinned Actions, SHA-pinned base images        | T3.1, T3.2, T4.1             |
| Provenance attestation   | `NPM_CONFIG_PROVENANCE=true`                                        | T4.3                         |
| Non-root container       | `USER cyclonedx` in Dockerfile-secure                               | T5.1                         |
| Request limits           | Body parser 1MB limit, server timeout, spawn timeout, max buffer    | T2.4                         |

## Recommendations for Deployers

1. **Use secure mode** — Set `CDXGEN_SECURE_MODE=true` and configure `NODE_OPTIONS` with the Node.js permission model, or use the `ghcr.io/cyclonedx/cdxgen-secure` container image.
2. **Configure allowlists** — Set `CDXGEN_ALLOWED_HOSTS` and `CDXGEN_ALLOWED_COMMANDS` based on your project types. Run once without allowlists and use the suggested values from cdxgen's output.
3. **Restrict server paths** — When running in server mode, always set `CDXGEN_SERVER_ALLOWED_PATHS` and `CDXGEN_SERVER_ALLOWED_HOSTS`.
4. **Deploy server behind a proxy** — The cdxgen server has no built-in authentication. Use a reverse proxy (nginx, Envoy, etc.) with authentication and rate limiting.
5. **Sandbox untrusted projects** — Scan untrusted code in containers or ephemeral CI environments, not on developer machines.
6. **Review environment** — Check `auditEnvironment` output for warnings. Remediate HIGH severity findings before production use.
7. **Enable trace logging in CI** — Set `CDXGEN_TRACE_MODE=true` in CI pipelines for auditability of commands and network access.
8. **Keep cdxgen updated** — Apply updates promptly, especially those that reference security fixes.

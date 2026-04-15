# Security Policy

## Reporting Security Issues

The OWASP cdxgen team and community take security bugs seriously. We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

To report a security issue, email [security@cyclonedx.org](mailto:security@cyclonedx.org) and include the word **"SECURITY"** in the subject line.

The OWASP cdxgen team will send a response indicating the next steps in handling your report. After the initial reply to your report, the security team will keep you informed of the progress towards a fix and full announcement, and may ask for additional information or guidance.

Report security bugs in third-party modules to the person or team maintaining the module.

## Service Level Agreements (SLAs)

We use the following target response and resolution times for reported security issues. These SLAs are best-effort commitments, not contractual guarantees.

| Severity | Initial Response | Triage / Confirmation | Remediation Target | Disclosure |
| -------- | ---------------- | --------------------- | ------------------- | ---------- |
| **Critical** (RCE, credential exfiltration, supply-chain compromise) | 48 hours | 5 business days | 15 business days | Coordinated with reporter |
| **High** (sandbox escape, path traversal in server mode, command injection) | 5 business days | 10 business days | 30 business days | Coordinated with reporter |
| **Medium** (information disclosure, denial of service, bypass of secure mode controls) | 10 business days | 15 business days | 60 business days | Next scheduled release |
| **Low** (verbose error messages, minor hardening improvements) | 15 business days | 30 business days | Best effort | Next scheduled release |

After remediation is available, we will publish a GitHub Security Advisory (GHSA) with CVE assignment where appropriate.

## What Counts as a Genuine Security Issue

### In scope

The following are considered genuine security issues in cdxgen:

- **Remote code execution (RCE)** — An attacker-controlled input (manifest, lockfile, environment variable, server request) leads to arbitrary code execution within cdxgen itself.
- **Command injection** — Unsanitized input reaches `safeSpawnSync` or any child-process API in a way that escapes the intended command boundary.
- **Path traversal in server mode** — A request to the cdxgen HTTP server (`--server`) allows reading or writing files outside the configured `CDXGEN_SERVER_ALLOWED_PATHS`.
- **Bypass of secure mode controls** — A technique that circumvents protections enforced when `CDXGEN_SECURE_MODE=true` or the Node.js `--permission` model is active (e.g., host allowlist bypass, HTTPS enforcement bypass, command allowlist bypass).
- **Supply-chain integrity** — Compromise of the npm package, container images, GitHub Actions workflows, or release provenance attestation.
- **Credential or secret leakage** — cdxgen unintentionally writes secrets, tokens, or credentials to SBOM output, logs, or error messages during normal (non-debug) operation.
- **Server-side request forgery (SSRF)** — The cdxgen server or `cdxgenAgent` HTTP client can be tricked into making requests to unintended internal hosts when allowlists are configured.
- **Git clone exploits** — A crafted Git URL provided to the server bypasses `validateAndRejectGitSource` to execute code, use dangerous protocols (`ext::`, `fd::`), or access disallowed hosts.

### Out of scope

The following are generally **not** considered security issues in cdxgen:

- **Vulnerabilities in scanned projects** — cdxgen intentionally parses untrusted manifests and lockfiles. Malicious content in those files that causes the *scanned project's own build tools* (npm, Maven, pip, etc.) to execute code is expected behavior of those build tools, not a cdxgen vulnerability. cdxgen's secure mode mitigates this by restricting package installations.
- **Vulnerabilities in upstream build tools** — Bugs in npm, Maven, Gradle, pip, Go, Cargo, or other package managers invoked by cdxgen are the responsibility of those projects. Report them to the respective maintainers.
- **Dependency vulnerabilities with no demonstrated impact** — A CVE in a transitive dependency of cdxgen that is not reachable or exploitable in cdxgen's usage context is not a cdxgen vulnerability. We still appreciate reports and will evaluate reachability.
- **Debug-mode information disclosure** — When `CDXGEN_DEBUG_MODE`, `CDXGEN_TRACE_MODE`, or `CDXGEN_THINK_MODE` is explicitly enabled, verbose output is expected and may include file paths, environment details, or command arguments. This is by design for diagnostic use.
- **Denial of service via large inputs** — cdxgen processes arbitrarily large projects. While we enforce buffer limits and timeouts, processing a very large monorepo may consume significant resources. This is expected behavior. Specific algorithmic complexity attacks (e.g., ReDoS) are in scope.
- **Self-hosted infrastructure access** — Reports about the configuration of our CI/CD runners, GitHub Actions, or container registries that require pre-existing privileged access to those systems.
- **Findings from automated scanners without proof of impact** — Reports that consist solely of automated scanner output (e.g., "Snyk found CVE-XXXX in dependency Y") without a demonstrated exploit path in cdxgen.
- **Social engineering or phishing** — Attacks that require tricking a cdxgen maintainer into running malicious commands.

### Grey areas

These require case-by-case evaluation:

- **Environment variable poisoning** — cdxgen reads many environment variables. The `auditEnvironment` function detects dangerous patterns in `NODE_OPTIONS`, JVM arguments, and other variables. Novel bypass techniques for `auditEnvironment` are in scope. However, an attacker who can set arbitrary environment variables in the cdxgen process typically already has code execution.
- **Unicode / encoding attacks** — cdxgen validates against dangerous Unicode in paths and hostnames via `hasDangerousUnicode`. Novel bypass techniques are in scope.
- **Container escape** — Issues that allow escaping the cdxgen container are in scope if the escape vector is specific to cdxgen's container configuration. Generic container runtime vulnerabilities should be reported to the runtime vendor.

## Shared Responsibility Model

cdxgen operates at the intersection of source code analysis, build tool invocation, and SBOM generation. Security responsibility is shared among cdxgen, its users, upstream build tools, and the broader ecosystem.

### What cdxgen is responsible for

| Area | Responsibility | Key Controls |
| ---- | -------------- | ------------ |
| **Own code safety** | Preventing injection, traversal, and unintended code execution within cdxgen's JavaScript codebase | `safeSpawnSync` command allowlisting, `safeExistsSync`/`safeMkdirSync` wrappers, input validation (`hasDangerousUnicode`, `isValidDriveRoot`), server path validation (`isAllowedPath`, `isAllowedWinPath`) |
| **Secure mode enforcement** | Providing a hardened execution mode that restricts cdxgen's own capabilities | Node.js `--permission` model integration, `CDXGEN_SECURE_MODE`, HTTPS-only HTTP, redirect blocking, command/host allowlists |
| **HTTP client safety** | Preventing SSRF and unintended network access | `CDXGEN_ALLOWED_HOSTS` enforcement, HTTPS-only in secure mode, redirect blocking, `cdxgenAgent` hooks |
| **Server mode safety** | Protecting the HTTP server from malicious requests | Path traversal prevention, Git URL validation, body size limits, request sanitization, Windows device name blocking |
| **Auditability** | Providing transparency into what cdxgen does at runtime | `thoughtLog`/`traceLog` structured logging, `commandsExecuted` and `remoteHostsAccessed` tracking, allowlist suggestion output, `auditEnvironment` startup checks |
| **Supply-chain integrity** | Ensuring published artifacts are not tampered with | npm provenance attestation (`NPM_CONFIG_PROVENANCE=true`), GitHub Actions with pinned SHA digests, `persist-credentials: false`, least-privilege workflow permissions (`permissions: {}`), container base images pinned to SHA digests |
| **Container hardening** | Providing secure container images | `ghcr.io/cyclonedx/cdxgen-secure` with Node.js permissions, non-root user (`cyclonedx`), restricted filesystem access, `CDXGEN_IN_CONTAINER=true` detection |
| **Timely patching** | Keeping cdxgen's own dependencies updated | Renovate automated dependency updates, CodeQL scanning, CI test matrix across Node.js versions and platforms |

### What users are responsible for

| Area | Responsibility | Guidance |
| ---- | -------------- | -------- |
| **Runtime environment** | Securing the machine, container, or CI runner where cdxgen executes | Run cdxgen in isolated environments. Use the `cdxgen-secure` container image for hardened defaults. Do not run as root outside containers. |
| **Environment variables** | Ensuring environment variables are not poisoned | cdxgen's `auditEnvironment` detects common dangerous patterns but cannot prevent all forms of environment manipulation. Review `NODE_OPTIONS`, `JAVA_TOOL_OPTIONS`, proxy variables, and credential variables. |
| **Build tool security** | Securing invoked build tools (npm, Maven, pip, etc.) | cdxgen invokes external build tools to resolve dependencies. These tools may execute arbitrary code from package manifests (e.g., npm `postinstall` scripts, pip `setup.py`). Users should keep build tools updated and use secure configurations. In secure mode, cdxgen disables automatic package installation. |
| **Network security** | Controlling network access for outbound connections | cdxgen and invoked build tools may contact package registries. Use `CDXGEN_ALLOWED_HOSTS` to restrict cdxgen's own connections. Use network policies or firewalls to restrict build tool connections. |
| **Secret management** | Not exposing secrets in environment variables or project files | cdxgen's `auditEnvironment` warns about credential-like variables and debug mode exposure. Do not pass secrets via `CDXGEN_*` environment variables. Avoid enabling `--include-formulation` with `--server-url` as formulation data may contain sensitive information. |
| **Input trust** | Understanding the trust level of scanned projects | cdxgen parses untrusted manifests and lockfiles. While cdxgen itself validates its inputs, invoked build tools may execute code embedded in project files. Scan untrusted projects in sandboxed environments. |
| **Access control (server mode)** | Restricting who can reach the cdxgen HTTP server | The cdxgen server does not include authentication or authorization. Deploy behind a reverse proxy with appropriate access controls. Set `CDXGEN_SERVER_ALLOWED_PATHS` to restrict scannable directories. |
| **Keeping cdxgen updated** | Applying cdxgen updates that include security fixes | Monitor GitHub Security Advisories and npm releases. |

### What upstream projects are responsible for

| Area | Responsible Party |
| ---- | ----------------- |
| Vulnerabilities in npm, Maven, Gradle, pip, Go, Cargo, and other package managers | Respective package manager maintainers |
| Vulnerabilities in Node.js, Deno, or Bun runtimes | Respective runtime maintainers |
| Malicious packages published to registries (npm, PyPI, Maven Central, etc.) | Registry operators and package maintainers |
| Vulnerabilities in cdxgen's direct dependencies (got, semver, packageurl-js, etc.) | Dependency maintainers; cdxgen tracks and updates via Renovate |
| GitHub Actions runner security | GitHub |
| Container runtime (Docker, Podman) vulnerabilities | Container runtime maintainers |

## Security Features Reference

cdxgen includes several built-in security features. See the following documentation for details:

- [Permissions Model](docs/PERMISSIONS.md) — Node.js `--permission` integration and `CDXGEN_SECURE_MODE`
- [Allowed Hosts and Commands](docs/ALLOWED_HOSTS_AND_COMMANDS.md) — Per-language allowlist reference
- [Environment Variables](docs/ENV.md) — All `CDXGEN_*` environment variables including security-related ones
- [Threat Model](docs/THREAT_MODEL.md) — Detailed threat model for cdxgen components

## Supported Versions

Security fixes are applied to the last two releases and cover the last two CycloneDX specification versions. Users are encouraged to stay on the latest version.

| Version | Supported |
| ------- | --------- |
| Last two releases | ✅ |
| Last two CycloneDX spec versions | ✅ |
| Older releases | ❌ |

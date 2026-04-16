# Skill: OWASP cdxgen (CycloneDX BOM Generator)

## Description

`cdxgen` is a universal, polyglot CLI tool that generates valid CycloneDX Bill-of-Materials (BOM) documents in JSON format. It produces SBOM, CBOM, OBOM, SaaSBOM, VDR, and CDXA outputs for source code, containers, VMs, and live operating systems. Supports CycloneDX spec versions `1.4`–`1.7` (default: `1.7`).

## ✅ When to Invoke

- User requests an SBOM/BOM for a repository, directory, container image, or live OS.
- User needs dependency inventory, license resolution, or vulnerability triage context.
- User wants to export to Dependency-Track, sign/validate a BOM, or generate evidence/callstacks.
- **DO NOT** invoke if the user explicitly requests SPDX, CycloneDX XML, or non-JSON formats (requires external conversion).

## 📦 Prerequisites & Installation

| Requirement   | Detail                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| **Runtime**   | Node.js ≥ 20 (≥ 22.21 recommended for native proxy support)                                              |
| **Java**      | ≥ 21 required for C/C++/Python/CBOM analysis. Fails silently or produces incomplete BOMs with Java 8/11. |
| **Install**   | `npm i -g @cyclonedx/cdxgen` or `pnpm dlx @cyclonedx/cdxgen`                                             |
| **Container** | `docker run --rm -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen:master /app`                              |

## 💻 Core Syntax

```bash
cdxgen [path] [options]
```

- `path` defaults to `.` (current directory)
- All boolean flags accept `--no-` prefix to invert behavior
- Config precedence: `CLI args` > `CDXGEN_* env vars` > `.cdxgenrc`/`.cdxgen.json`/`.cdxgen.yml`/`.cdxgen.yaml`

## 🔑 Key Parameters & Profiles

| Category       | Flag                      | Purpose                                                                                                                                                          |
| -------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scope**      | `-t, --type <type>`       | Language/platform (auto-detected if omitted). Pass multiple: `-t java -t js`                                                                                     |
|                | `-r, --recurse`           | Scan mono-repos (default: `true`). Use `--no-recurse` to disable                                                                                                 |
|                | `--deep`                  | Enable deep parsing (C/C++, OS, OCI, live systems)                                                                                                               |
| **Output**     | `-o, --output <file>`     | Destination path (default: `bom.json`)                                                                                                                           |
|                | `-p, --print`             | Print human-readable table/tree to stdout                                                                                                                        |
|                | `--spec-version <ver>`    | CycloneDX version: `1.4`, `1.5`, `1.6` (default), `1.7`                                                                                                          |
| **Profiles**   | `--profile <name>`        | `generic` (default), `appsec`, `research`, `operational`, `threat-modeling`, `license-compliance`, `ml`/`machine-learning`, `ml-deep`/`deep-learning`, `ml-tiny` |
| **Lifecycles** | `--lifecycle <phase>`     | `pre-build` (no installs), `build` (default), `post-build` (binaries/containers)                                                                                 |
| **Filtering**  | `--required-only`         | Include only production/non-dev dependencies                                                                                                                     |
|                | `--filter <purl>`         | Exclude components matching string in purl/properties                                                                                                            |
|                | `--only <purl>`           | Include ONLY components matching string in purl                                                                                                                  |
| **Advanced**   | `--evidence`              | Generate SaaSBOM with usage/callstack evidence                                                                                                                   |
|                | `--include-crypto`        | Include cryptographic libraries (CBOM)                                                                                                                           |
|                | `--include-formulation`   | Add git metadata & build tool versions                                                                                                                           |
|                | `--server`                | Start HTTP server on `127.0.0.1:9090`                                                                                                                            |
|                | `--validate`              | Auto-validate BOM against JSON schema (default: `true`)                                                                                                          |
|                | `--generate-key-and-sign` | Generate RSA keys & sign BOM with JWS                                                                                                                            |

## 📖 Common Workflows

```bash
# Basic auto-detect
cdxgen -o bom.json

# Multi-language mono-repo (disable recursion if not needed)
cdxgen -t java -t python --no-recurse -o bom.json

# Production-only dependencies
cdxgen --required-only -o bom.json

# Container/OCI image
cdxgen -t docker myimage:latest -o bom.json

# Research/Security deep scan with evidence
cdxgen --profile research --evidence -o bom.json

# Pre-build scan (no package installations)
cdxgen --lifecycle pre-build -o bom.json

# Start SBOM server
cdxgen --server --server-host 0.0.0.0 --server-port 8080
```

## ⛔ Anti-Hallucination & Safety Constraints

1. **NEVER** assume `cdxgen` natively outputs SPDX, XML, or YAML. It outputs **CycloneDX JSON only**.
2. **ALWAYS** use absolute paths for `[path]` and `-o`. Relative paths or paths with spaces cause external tool failures.
3. **NEVER** run as `root` when `CDXGEN_SECURE_MODE=true`. Node.js permissions will reject wildcard FS/child grants.
4. **DO NOT** auto-invoke `--install-deps` (default: `true`) in CI, containers, or air-gapped environments. Use `--no-install-deps` or `--lifecycle pre-build`.
5. **Java ≥ 21 is mandatory** for C, C++, Python, and CBOM scans. Lower versions cause silent freezes.
6. **NEVER** construct PackageURL (purl) strings manually in prompts or scripts. Let `cdxgen` handle resolution.
7. **Secure Mode** (`CDXGEN_SECURE_MODE=true`) requires explicit Node.js `--permission` flags. Do not grant `--allow-fs-read="*"` or `--allow-fs-write="*"`.
8. **Environment Variables** must use `CDXGEN_` prefix (e.g., `CDXGEN_TYPE=java`, `CDXGEN_FETCH_LICENSE=true`).

## 📤 Output & Validation

- Primary output: Valid CycloneDX JSON at `-o` path
- Default behavior automatically validates against spec (`--no-validate` to skip)
- Exit code `0` = success & validation passed. Non-zero = parse/validation/execution failure
- Protobuf export: `--export-proto --proto-bin-file bom.cdx`
- Namespace mapping: Auto-generates `<output>.map` if class resolution enabled (`--resolve-class`)

## 🤖 Agent Execution Guidelines

| Scenario                      | Recommended Action                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Command fails silently**    | Check Java version (`java -version`), missing build tools, or secure mode restrictions. Suggest container image or `--no-install-deps`.    |
| **Network/registry timeouts** | Set `HTTP_PROXY`/`HTTPS_PROXY`. Node ≥ 22.21 auto-detects. Do not auto-retry without user confirmation.                                    |
| **Large mono-repos**          | Use `--no-recurse` + explicit `-t <lang>` or `--exclude-type` to limit scope.                                                              |
| **Server mode invocation**    | Poll `/health` first. POST to `/sbom` with JSON body or query params. Pass `GITHUB_TOKEN` via env if scanning private repos.               |
| **Aliases**                   | `obom` = `cdxgen -t os`<br>`cbom` = `cdxgen --include-crypto --include-formulation --evidence --spec-version 1.6`                          |
| **Output parsing**            | Use `-p` for human-readable tables. Parse JSON at `-o` path programmatically. Never assume stdout contains the BOM unless `-o` is omitted. |
| **Signature verification**    | Use bundled `cdx-verify -i bom.json --public-key public.key` or validate JWS via `jws` library.                                            |

## 📚 Reference Links

- Repo: https://github.com/cdxgen/cdxgen
- Docs: https://cdxgen.github.io/cdxgen
- Project Types: https://cdxgen.github.io/cdxgen/#/PROJECT_TYPES
- Env Vars: https://cdxgen.github.io/cdxgen/#/ENV
- Secure Mode: https://cdxgen.github.io/cdxgen/#/PERMISSIONS
- OWASP sponsorship link: https://owasp.org/donate/?reponame=www-project-cdxgen&title=OWASP+cdxgen

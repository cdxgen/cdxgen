# Lesson 8 — Scanning Git URLs and purls with BOM Audit

## Learning Objective

In this lesson, you will generate SBOMs directly from a git URL and a package URL (purl), then run `bom-audit` as part of the same flow.

By the end, you will be able to:

1. Generate SBOMs without manually cloning source repositories.
2. Control branch selection with `--git-branch`.
3. Run `--bom-audit` for remotely resolved sources.
4. Apply host allowlists for safer remote-source scans.

---

## Pre-requisites

- Node.js ≥ 20
- `@cyclonedx/cdxgen` installed

```shell
npm install -g @cyclonedx/cdxgen
```

## Step 1: Generate SBOM from a git URL

```shell
cdxgen -t java -o bom-git.json --git-branch main https://github.com/HooliCorp/java-sec-code.git
```

This command clones to a temporary directory, runs the regular multi-type pipeline, and removes the temporary clone after completion.

## Step 2: Generate SBOM from a purl

```shell
cdxgen -t js -o bom-purl.json "pkg:npm/lodash@4.17.21"
```

For purl inputs, cdxgen queries the package registry, resolves a repository URL, clones it, and scans it.

> **Warning:** Registry metadata can be inaccurate or malicious. Validate resolved repositories before relying on generated SBOMs.

## Step 3: Run bom-audit on remote sources

```shell
cdxgen -t js -o bom-purl-audit.json --bom-audit "pkg:npm/lodash@4.17.21"
```

`--bom-audit` runs after SBOM generation and post-processing. Findings can be embedded as CycloneDX annotations based on your spec version and profile settings.

## Step 4: Use allowlists for remote scanning

Configure host allowlists before scanning remote sources in sensitive environments.

```shell
export CDXGEN_GIT_ALLOWED_HOSTS="github.com"
# Registry lookups for purl metadata still use CDXGEN_ALLOWED_HOSTS
export CDXGEN_ALLOWED_HOSTS="registry.npmjs.org,github.com"
cdxgen -t js -o bom-safe.json "pkg:npm/lodash@4.17.21"
```

For server mode, the same scan can be requested via:

```shell
curl "http://127.0.0.1:9090/sbom?url=pkg:npm/lodash@4.17.21&type=js&multiProject=true"
```

## Going further

- Review [SERVER.md](./SERVER.md) for secure server deployment and allowlist setup.
- Review [BOM_AUDIT.md](./BOM_AUDIT.md) for category/severity tuning.
- Review [THREAT_MODEL.md](./THREAT_MODEL.md) for remote source and purl lookup risks.

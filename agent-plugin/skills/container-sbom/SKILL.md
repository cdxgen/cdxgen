---
name: container-sbom
description: Generates CycloneDX BOMs for container images, OCI archives, mounted root filesystems, Electron ASAR archives, caxa executables, binaries, and Kubernetes or Dockerfile manifests using OWASP cdxgen post-build scanning. Use when asked to scan a Docker or OCI image, produce an SBOM for a container or golden image, inventory a rootfs, audit a packaged Electron app, or analyse Dockerfiles and Kubernetes manifests.
---

# Container, image, and binary BOMs

Use this skill when the target is a built artifact rather than a source tree.
For source repositories use `sbom-generate`; for a live running host use
`os-hardware-inventory`.

Read [reference/safety.md](../../reference/safety.md) first.

## Container images

```bash
cdxgen -t docker myimage:latest -o /absolute/path/to/bom.json
```

Types `oci`, `docker`, `podman`, `container`, and `oci-dir` all reach the same
pipeline. Use `oci-dir` for an unpacked OCI layout on disk.

Container scans belong to the `post-build` lifecycle. cdxgen sets that
automatically for image targets, but pass it explicitly when scripting:

```bash
cdxgen -t oci --lifecycle post-build myimage:latest -o /absolute/path/to/bom.json
```

## Mounted or reconstructed root filesystems

```bash
cdxgen /absolute/path/to/rootfs -t rootfs -o /absolute/path/to/bom.json
```

This is the right approach for golden images, forensic mounts, and any host you
cannot run osquery on. Add a hardening review without needing live collection:

```bash
cdxgen /absolute/path/to/rootfs -t rootfs \
  --bom-audit --bom-audit-categories rootfs-hardening \
  -o /absolute/path/to/bom.json
```

The `rootfs-hardening` category checks repository trust, privileged helpers, and
service drift offline.

## What container and rootfs scans include beyond packages

These scans are deliberately broader than a package list. Expect:

- OS package components with purls — the same purls `obom` gives the packages when run inside the image (vendor, `arch`, `distro`, `distro_name` and `epoch` qualifiers, no subpath), so the two can be diffed; see `os-hardware-inventory`
- source-package components tagged `source`, added for vulnerability matching; an OBOM has none, so leave them out of such a diff
- package-owned files and installed commands
- repository source records, modelled as ordinary `data` components
- trusted keys and certificates, modelled as `cryptographic-asset` components — **these do not have purls**, so do not treat a missing purl as a defect
- `cdx:container:unpackagedExecutableCount` and `cdx:container:unpackagedSharedLibraryCount` metadata properties

Those last two matter: they count native files that could not be traced to any
OS package. A high count means the image ships binaries outside package
management, which is worth surfacing to the user.

In `cdxi`, isolate them with `.unpackagedbins` and `.unpackagedlibs`
(see `bom-explore`).

## Enrichment from optional binaries

When `@cdxgen/cdxgen-plugins-bin` is installed, container and rootfs scans gain
Trivy-powered package metadata, Linux GTFOBins runtime context, platform trust
posture, and — via `trustinspector` — macOS code-signing/notarization and
Windows Authenticode/WDAC properties across large path inventories.

When those binaries are absent the BOM is still valid, just less enriched. Say
that plainly rather than reporting a failure.

## Electron ASAR archives

```bash
cdxgen -t asar /absolute/path/to/app.asar \
  --bom-audit --bom-audit-categories asar-archive \
  -o /absolute/path/to/bom.json
```

Prefer `-t asar` (aliases `electron`, `electron-asar`) for packaged Electron
releases: it adds archive file inventory, integrity verification, and analysis
of the embedded Node manifest, none of which appear if you scan the surrounding
directory as a plain JavaScript project.

## caxa executables

```bash
cdxgen -t caxa /absolute/path/to/dir-with-metadata -o /absolute/path/to/bom.json
```

Reads the `*metadata.json` file that caxa writes next to a binary when it builds
it (`--metadata-file`, default `binary-metadata.json`); the binary itself
carries no BOM, so pointing `-t caxa` at it finds nothing. Add
`--caxa-app-dir <extracted app>` to also record the native tools, the vendored
PHP, Ruby and Java packages, and the npm hashes found in the app the binary
extracts.

## Binaries without a package manager

Several types accept a compiled binary directly rather than a manifest: `go`,
`rust`, `csharp`/`dotnet`, and `jar`/`war`/`ear`. Evidence quality is lower than
a lockfile scan — component identity comes from what is embedded in the binary.

```bash
cdxgen -t go /absolute/path/to/compiled-binary -o /absolute/path/to/bom.json
```

Cache-scanning types inventory a build cache rather than one project:
`maven-cache`, `gradle-cache`, `sbt-cache`, `cargo-cache`, `helm-index`.

## Container and orchestration manifests

For declared images rather than built ones:

```bash
cdxgen -t containerfile /absolute/path/to/project -o /absolute/path/to/bom.json
```

Covers `dockerfile`, `containerfile`, `docker-compose`, `kubernetes`,
`openshift`, `kustomize`, `skaffold`, `swarm`, `tekton`, `operator`,
`yaml-manifest`, and `universal`. These describe intended images, so the BOM
records references, not resolved layer contents. Use an image scan when the
user needs what actually shipped.

## Container-specific audit categories

```bash
cdxgen -t oci myimage:latest \
  --bom-audit --bom-audit-categories container-risk \
  -o /absolute/path/to/bom.json
```

Relevant categories here: `container-risk`, `rootfs-hardening`,
`asar-archive`, `package-integrity`, `dependency-source`. See `bom-audit`.

## Practical notes

- `--deep` improves OS and OCI parsing but costs time; enable it when the user cares about completeness over speed.
- Image scans need the image present locally or pullable. Confirm registry access before blaming cdxgen.
- The cdxgen container image is often the easier path for scanning images, since the helper binaries are preinstalled: `docker run --rm -v $(pwd):/app:rw -t ghcr.io/cdxgen/cdxgen:master /app`.
- For golden-image and offline host review, prefer the `rootfs` + `rootfs-hardening` combination over attempting live collection.

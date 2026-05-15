# Troubleshooting Common Issues

This page collects the most frequently reported problems, organised by symptom. Each entry describes what causes the issue, how to confirm it, and how to fix it.

## General diagnostics

Enable debug output to see the exact commands cdxgen runs and why decisions are made:

```bash
CDXGEN_DEBUG_MODE=debug cdxgen -t java -o bom.json .
```

For verbose HTTP and spawn tracing:

```bash
CDXGEN_DEBUG_MODE=verbose cdxgen -t java -o bom.json .
```

---

## Empty BOM or missing components

**Possible cause: wrong or missing project type**

cdxgen auto-detects project types by looking for manifest files. If detection fails, pass the type explicitly:

```bash
cdxgen -t java -o bom.json .
```

Check that the manifest file (`pom.xml`, `package.json`, `Cargo.toml`, etc.) is present in the directory you passed.

**Possible cause: all components were filtered out**

If you used `--required-only`, `--filter`, or `--min-confidence`, those filters may have removed everything. Try without filters first to confirm the raw BOM is non-empty.

**Possible cause: excluded patterns matched everything**

Check your `--exclude` and `--exclude-type` arguments. A broad glob such as `**/*` would exclude all files.

---

## Build tool or SDK not found

**Symptom:** cdxgen prints "mvn not found", "dotnet not found", or similar, and returns an empty or incomplete BOM.

**Fix:** Install the missing tool, or use the container image that bundles it. The official image `ghcr.io/cyclonedx/cdxgen:master` includes Java 25, Node, Python, and Go. For other versions, see [Advanced Usage](ADVANCED.md) and the container image table.

```bash
docker run --rm -v $(pwd):/app ghcr.io/cyclonedx/cdxgen -r /app -t java -o bom.json
```

For Java legacy projects needing JDK 11 or 17, use the matching image:

```bash
docker run --rm -v $(pwd):/app ghcr.io/cyclonedx/cdxgen-java17:v12 -r /app -t java -o bom.json
```

---

## Slow or hanging scans

**Possible cause: registry metadata fetching**

cdxgen optionally contacts package registries (Maven Central, npm, PyPI) to enrich component metadata. On a slow or firewalled network, this can cause long timeouts.

Reduce the timeout or disable fetching:

```bash
CDXGEN_TIMEOUT_MS=5000 cdxgen -t java -o bom.json .
# or skip license fetching
FETCH_LICENSE=false cdxgen -t java -o bom.json .
```

**Possible cause: slow container image pull**

When scanning a container image for the first time, Trivy downloads and caches vulnerability data. Subsequent scans are much faster. Set `TRIVY_CACHE_DIR` to a persistent path to avoid re-downloading.

**Possible cause: large project with deep mode enabled**

Deep mode (`--deep`) triggers atom-based analysis which requires more time for large projects. Disable deep mode for a quick first pass or use `--technique manifest-analysis` to limit analysis to manifests only.

---

## npm install failures

**Symptom:** cdxgen runs `npm install` but it fails because of network restrictions, missing tokens, or incompatible Node versions.

**Fix:** Run `npm install` manually first, then run cdxgen with `--no-install-deps` so it reads the already-installed `node_modules`:

```bash
npm install
cdxgen -t js --no-install-deps -o bom.json .
```

Alternatively, commit a lock file (`package-lock.json` or `pnpm-lock.yaml`) to the repository. cdxgen can build the dependency tree from the lock file without running an install.

---

## osquery permission errors

**Symptom on Linux:** `Permission denied` when osquery tries to create `/var/osquery`.

cdxgen runs osquery in shell mode (`--S`) which does not require daemon initialisation. If you still see this error, you are likely running osquery directly rather than through cdxgen.

**Symptom on macOS:** Some OBOM categories return empty results.

This is usually a macOS Full Disk Access (FDA) permission issue. See [macOS OBOM troubleshooting](OBOM_MACOS_TROUBLESHOOTING.md) for step-by-step resolution.

**Symptom on Windows:** osquery tables return no rows.

Ensure you are running as Administrator, or that the service account has the required privileges. Some tables such as `drivers` and `registry` require elevated access.

---

## Container scan produces an incomplete inventory

**Possible cause: Trivy is not installed or not on PATH**

cdxgen uses the Trivy plugin from `cdxgen-plugins-bin` for container scanning. Install it:

```bash
npm install -g @cdxgen/cdxgen-plugins-bin
```

**Possible cause: image is not pulled locally**

Run `docker pull <image>` before scanning, or provide the full image reference with a digest to ensure Trivy can locate it.

---

## BOM validation errors

**Symptom:** `cdx-validate` reports schema violations.

Common causes and fixes:

- A `bom-ref` value is not unique. cdxgen usually generates unique refs, but external tools that merge BOMs may introduce duplicates.
- A `cryptographic-asset` component is missing the required `cryptoProperties` field. cdxgen handles this internally; if you see it in your output it means a custom parser or merge step dropped the field.
- An `oid` value is not a valid OID string. Source-derived algorithm components without a known OID are now silently skipped by cdxgen.

Run validation with verbose output to see the exact failing path:

```bash
cdx-validate -i bom.json
```

---

## Configuration file not picked up

cdxgen looks for `.cdxgenrc`, `.cdxgen.json`, `.cdxgen.yml`, or `.cdxgen.yaml` in the current working directory. Environment variables override config file values, and command-line arguments override environment variables.

If your config is not applied, confirm the file is in the directory where you run cdxgen, not the project root (they may differ).

---

## Getting more help

- Run `cdxgen --help` for a full list of options.
- Enable `CDXGEN_DEBUG_MODE=debug` for verbose diagnostic output.
- Check [GitHub Discussions](https://github.com/cdxgen/cdxgen/discussions) for community answers.
- For enterprise support options, see [Support](SUPPORT.md).

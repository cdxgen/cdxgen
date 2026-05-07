# Tutorials - Cataloging Electron ASAR archives

This lesson shows how to inventory packaged Electron `.asar` archives, review the shipped file contents, and gate on built-in ASAR BOM-audit findings.

## 1) Generate an ASAR-aware BOM

```bash
cdxgen -t asar \
  --bom-audit \
  --bom-audit-categories asar-archive \
  -o bom.json \
  /absolute/path/to/app.asar
```

What this adds on top of a normal package-only BOM:

- native ASAR header parsing without requiring the Electron `asar` package
- `type=file` components for archived entries with archive-relative paths
- nested archive identities such as `outer.asar#/nested/core.asar#/src/main.js`
- SHA-256 hashes and evidence locations for each archived file entry
- declared-versus-computed ASAR integrity verification
- Electron `Info.plist` signing metadata verification for the ASAR header hash scope
- JavaScript capability summaries for file I/O, network, hardware, child-process, eval/code generation, dynamic fetch, and dynamic import
- embedded Node.js package inventory from `package.json` and lockfiles shipped inside the archive
- ASAR-specific BOM-audit findings

## 2) Review the packaged file inventory

Useful pivots with `jq`:

```bash
jq '.components[] | select(.type == "file" and any((.properties // [])[]; .name == "cdx:file:kind" and .value == "asar-entry")) | {name, properties, hashes}' bom.json
jq '.components[] | select(any((.properties // [])[]; .name == "cdx:asar:js:hasEval" and .value == "true"))' bom.json
jq '.metadata.component.properties // []' bom.json
```

High-signal questions:

1. Which archived source files combine network reach with file or hardware access?
2. Did any declared ASAR integrity hash fail verification?
3. Did any Electron signing metadata fail header verification?
4. Does the package ship native `.node` binaries or `.asar.unpacked` entries?
5. Which embedded npm packages still declare install-time lifecycle scripts?

## 3) Understand dry-run behavior

`cdxgen --dry-run -t asar` still parses the archive header and can catalog file contents, hashes, and most JS capability signals because those reads are native and in-memory.

Dry-run still blocks temp extraction, so the embedded package-manager reuse step is intentionally limited:

- archive inventory and integrity checks continue to work
- per-file JS capability summaries continue to work
- embedded npm install-script findings are only partial because cdxgen will not extract the archive to reuse the normal Node.js manifest pipeline

Example:

```bash
cdxgen --dry-run -t asar --bom-audit --bom-audit-categories asar-archive /absolute/path/to/app.asar
```

## 4) Understand the built-in ASAR audit rules

The `asar-archive` BOM-audit category currently focuses on:

- `ASAR-001` — archived JavaScript with eval-like or dynamic loading behavior
- `ASAR-002` — archived JavaScript combining network capability with file or hardware access
- `ASAR-003` — declared ASAR integrity mismatch
- `ASAR-004` — embedded npm package with install-time scripts inside the archive
- `ASAR-005` — Electron signing metadata present but failing ASAR header verification

These rules are designed to be review-friendly:

- archive/file rules are driven from the generated BOM itself
- integrity mismatches compare declared ASAR metadata against computed file hashes
- signing checks verify the Electron-declared ASAR header hash scope, not every packed file payload byte
- embedded npm lifecycle findings reuse the same `cdx:npm:*` signals used elsewhere in cdxgen

## 5) Suggested release-gate command

```bash
cdxgen -t asar \
  --bom-audit \
  --bom-audit-categories asar-archive \
  --bom-audit-fail-severity high \
  -o bom.json \
  /absolute/path/to/app.asar
```

This blocks clearly risky packaged behaviors while still preserving lower-severity context for manual triage.

## 6) Practical lessons learned

- Treat packaged desktop artifacts as reviewable release surfaces, not just dependency bundles.
- `asar.unpacked` content and native `.node` addons deserve the same scrutiny as installer payloads.
- Distinguish entry/file integrity from Electron signing metadata: `cdx:asar:signingScope=header-only` verifies the ASAR header hash, not the full payload.
- Nested archive evidence paths remain reviewable because cdxgen rewrites them as chained archive identities such as `outer.asar#/nested/core.asar#/src/main.js`.
- Archive-internal paths are normalized to forward slashes even on Windows so policies and `jq` pivots stay portable.
- Dynamic fetch, eval, and embedded install scripts are especially important in Electron applications because they blur the line between package-time and runtime trust.

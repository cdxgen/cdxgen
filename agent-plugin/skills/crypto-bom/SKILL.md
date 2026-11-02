---
name: crypto-bom
description: Generates a CycloneDX Cryptographic Bill of Materials (CBOM) with the cdxgen cbom command, inventorying cryptographic algorithms, certificates, keys, and protocol usage from source code and hosts, and auditing them for weak or deprecated primitives. Use when asked for a CBOM, a cryptographic inventory, post-quantum readiness assessment, crypto algorithm discovery, or a review of certificates and key material in a codebase.
---

# Cryptographic BOM

Use this skill when the user wants to know what cryptography a codebase or host
actually uses — for post-quantum migration planning, crypto policy compliance,
or finding weak primitives.

Read [reference/safety.md](../../reference/safety.md) first. CBOM source
analysis uses the atom companion, which needs **no JDK on the native-binary
platforms** (linux-amd64, linux-arm64 glibc, linux-amd64-musl, darwin-arm64,
windows-amd64). Only the jar-based triples (darwin-amd64, windows-arm64,
linux-arm64-musl) require **Java >= 23** and fail silently below it, so verify
`java -version` there before interpreting a thin CBOM.

## Generate

```bash
cbom -o /absolute/path/to/cbom.json /absolute/path/to/project
```

The `cbom` command is not merely an alias with a flag. Invoking it sets:

| Setting          | Value                             |
| ---------------- | --------------------------------- |
| `--include-crypto` | on                              |
| `--evidence`     | on                                |
| `--deep`         | on                                |
| `--spec-version` | `1.7`, unless you pass one yourself |

Two combinations are **rejected**, not silently ignored:

- `cbom --component-type <t>` — use `cdxgen --include-crypto` instead when you need component-type filtering.
- `cbom -t os` — crypto evidence collection analyses source with atom, which is meaningless and extremely slow against an OS inventory. Use `obom` for operating-system installations (see `os-hardware-inventory`).

The equivalent explicit invocation, when you want to vary one part:

```bash
cdxgen --include-crypto --evidence --deep \
  -o /absolute/path/to/cbom.json /absolute/path/to/project
```

## What gets inventoried

- `cryptographic-asset` components for algorithms, certificates, keys, and protocols
- certificates and trusted key material discovered in the tree or host
- source-derived algorithm inventory from **JavaScript and TypeScript** via lightweight AST analysis

Note two modelling facts that surprise people:

1. Cryptographic assets **do not carry purls**. That is correct; they are not packages. Do not treat a missing purl as a gap, and never invent one.
2. Source-derived algorithm components are constrained to stay validator-safe: cdxgen emits only algorithms it can map to a known OID. An algorithm you can see in the source but not in the CBOM was most likely unmappable, not missed.

## Auditing the CBOM

```bash
cbom -o /absolute/path/to/cbom.json /absolute/path/to/project \
  --bom-audit --bom-audit-categories cbom
```

The `cbom` category alias enables both rule sets:

| Category          | Checks                                                                              |
| ----------------- | ----------------------------------------------------------------------------------- |
| `cbom-security`   | Weak or deprecated algorithms, insecure cipher modes, insufficient key sizes, outdated protocol versions |
| `cbom-compliance` | Policy and standards conformance of the crypto inventory                            |

`crypto-bom` works as an alias for the same pair.

Audit an existing CBOM after the fact:

```bash
cdx-audit --bom /absolute/path/to/cbom.json --direct-bom-audit --categories cbom
```

## Exploring the result

In `cdxi` (see `bom-explore`):

- `.cryptos` — the full cryptographic asset list
- `.sourcecryptos` — only the JavaScript/TypeScript source-derived algorithm components
- `.trusted` — trusted keys and certificates

Reach for `.sourcecryptos` when the user's question is about code-level
algorithm usage rather than the certificates and keys shipped alongside it.

## Crypto usage in Go, with data flow

For Go projects, `evinse` can trace crypto **data flow** rather than just
presence — which values reach a cryptographic operation:

```bash
cdxgen -t go -o /absolute/path/to/bom.json /absolute/path/to/project
evinse -i /absolute/path/to/bom.json -o /absolute/path/to/bom.crypto.json \
  -l go --with-data-flow \
  --golem-dataflow crypto --golem-dataflow-pattern-packs crypto \
  /absolute/path/to/project
```

Prioritize components carrying `cdx:golem:cryptoDataFlow=true` and
`cdx:golem:cryptoDataFlowCount`, then pivot on the rendered
`cryptographic-asset` algorithms. See `bom-evidence` for the full Golem surface.

**Never surface raw plaintext, ciphertext, key material, or embedded file
contents from Golem output.** Review through the emitted `cdx:golem:*` counts,
categories, taint kinds, and algorithm/OID pivots.

## Runtime crypto observation

To see crypto actually exercised at runtime rather than inferred from source,
`tracebom` has dedicated probes:

```bash
tracebom --cmd "node app.js" --trace-crypto --crypto-probe-mode <mode> \
  -o /absolute/path/to/trace-cbom.json
```

See `runtime-trace-bom`.

## Reference

- CBOM audit rules: <https://cdxgen.github.io/cdxgen/#/BOM_AUDIT>
- Custom properties: <https://cdxgen.github.io/cdxgen/#/CUSTOM_PROPERTIES>
- Go Evinse and Golem: <https://cdxgen.github.io/cdxgen/#/GO_EVINSE_GOLEM>

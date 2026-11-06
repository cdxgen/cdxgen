# cdx-convert - CycloneDX converter

`cdx-convert` converts an existing CycloneDX BOM into SPDX 3.0.1 JSON-LD, or
into a different CycloneDX specification version.

It is distributed with `@cdxgen/cdxgen` alongside `cdxgen`, `cdx-sign`,
`cdx-verify`, and `cdx-validate`. It is also published as a standalone binary
via the `binary-builds` workflow.

## Scope and supported versions

`cdx-convert` supports two conversion paths, selected with `--to`:

| `--to`                    | Input spec versions   | Output                             |
| ------------------------- | --------------------- | ---------------------------------- |
| `spdx` (default)          | `1.6`, `1.7`, `2.0`   | SPDX `3.0.1` JSON-LD               |
| `2.0`                     | `1.6`, `1.7`, `2.0`   | CycloneDX `2.0`                    |
| another CycloneDX version | any cdxgen supports   | CycloneDX at the requested version |

Input is CycloneDX JSON or protobuf (`.cdx`, `.cdx.bin`, `.proto`) with
`bomFormat: "CycloneDX"`, or a CycloneDX 2.0 JSON document (`specFormat`). If
the input is not CycloneDX, the command fails with a clear error. For the SPDX
path and for `--to 2.0`, a `specVersion` other than `1.6`, `1.7` or `2.0` also
fails; convert an older BOM with `--to 1.7` first.

## Quick start

```shell
# Convert bom.json (CycloneDX 1.6 or 1.7) to SPDX 3.0.1 JSON-LD
cdx-convert -i bom.json -o bom.spdx.json

# Convert a protobuf BOM exported by cdxgen
cdx-convert -i bom.cdx -o bom.spdx.json

# Pretty-print output JSON
cdx-convert -i bom.json -o bom.spdx.json --json-pretty

# Skip SPDX validation (enabled by default)
cdx-convert -i bom.json -o bom.spdx.json --no-validate

# Downgrade a 1.7 BOM to 1.6, reporting the fields 1.6 does not define
cdx-convert -i bom.json --to 1.6

# Downgrade and write protobuf, chosen by the output extension
cdx-convert -i bom.json --to 1.6 -o bom-1_6.cdx
```

## CLI reference

| Flag                           | Default    | Description                                |
| ------------------------------ | ---------- | ------------------------------------------ |
| `-i, --input`                  | `bom.json` | Input CycloneDX BOM JSON or protobuf file. |
| `-o, --output`                 | see below  | Output file path.                          |
| `--to`                         | `spdx`     | `spdx`, or a CycloneDX spec version.       |
| `--validate` / `--no-validate` | on         | Validate the converted output.             |
| `--fail-on-loss`               | off        | Exit 2 without writing when data is lost.  |
| `--json-pretty`                | off        | Pretty-print JSON output.                  |

`-o` defaults to `<input>.spdx.json` for the SPDX path, and to
`<input>-<version>.<ext>` for a CycloneDX version conversion — so
`bom.json --to 1.6` writes `bom-1_6.json` and never overwrites its input. An
explicit `-o` naming a protobuf extension writes protobuf instead of JSON.

## CycloneDX version conversion

The reshaping is done by `applySpecVersionCompatibility()` in
`lib/stages/postgen/specVersionCompat.js` — the same normalizer the postgen
stage applies to freshly generated BOMs. `cdx-convert -i bom.json --to 1.6` and
`cdxgen --spec-version 1.6` therefore agree on the result.

Conversion is not purely subtractive. Beyond removing elements the target
version does not define, it reshapes fields the versions model differently:

- `evidence.identity` is a single object up to 1.5 and an array from 1.6, so a
  downgrade past that boundary keeps the first identity and drops
  `concludedValue`
- `metadata.tools` flips from a `tools` object to component and service arrays
  at 2.0
- component types the target version does not define are filtered out, and
  dependencies pointing at pruned components are removed so the graph never
  references a missing `bom-ref`
- license and license-expression attributes are trimmed per version, since
  CycloneDX forbids additional properties

Every field path that did not survive is listed on stderr before the file is
written, so a lossy downgrade is never silent:

```text
Converting to CycloneDX 1.6 dropped 5 field path(s) that version does not define:
  - citations
  - citations.attributedTo
  ...
```

### CycloneDX 2.0

A 2.0 input is read into cdxgen's 1.x-shaped internal model first. Every loss
of that read is printed on stderr with a JSON pointer into the input, whatever
the target:

A document with a `specFormat`, or a `specVersion` of 2.0 or later, is read
as 2.0, so a stray 1.x member such as `components` next to `inventories` is a
loss rather than a reason to treat the input as 1.x. Objects nested deeper
than 256 levels are cut, each with a loss. cdxgen keeps 2.0-only sections on its internal model
under a `cdx20Sections` member; that member of a 1.x input is ignored, so it
never reaches a `--to 2.0` output.

```text
Reading the CycloneDX 2.0 input into cdxgen's 1.x model reported 2 loss(es); the CycloneDX 1.7 output lacks what they name:
  - /risks: 2.0-only section with no 1.x field: dropped from 1.x and SPDX output (a 2.0 render of the read model keeps it)
  - /inventories/0/components/0/quantity: component.quantity has no 1.x field
```

`--to 2.0` renders the document with the renderer `cdxgen --spec-version 2.0`
uses. A 1.6 or 1.7 input is sorted first, so both commands write the same
order; values the 2.0 format has no place for are printed with their counts.
A 2.0 input keeps its own order, and its 2.0-only sections and unchanged
objects come back as they were; any value of the input the output still lacks
(member order ignored) is printed, once for each missing occurrence, so a
dropped duplicate counts.

A 2.0 formula has no member for its components, so the renderer declares
them in `definitions.components`. In a document with an inventory subject the
reader tells them apart from the SBOM by where they are referenced. A
subject-less document keeps its SBOM components in `definitions.components`
too, so each formula there names its own components in the
`cdx:formulation:componentRefs` property, a JSON array of refIds, and the
reader puts each listed component back into every formula that lists it. A
formula component without a refId, or whose refId is also an SBOM component,
cannot be told apart and stays only in the SBOM; both are counted.

At 2.0, cdxgen claims only analysis it did. When the BOM's `metadata.tools`
lists cdxgen with a `bom-ref`, each identity evidence entry it renders
(`evidence.identity[]`) is attributed to the `party-cdxgen` party with the
`asserter` role, `tools` names the helper recorded on the entry or else the
cdxgen tool, and a method that names its matched value gets
`result: "detected"`. For another tool's BOM, such as a syft 1.x BOM, the
entry gets none of these; its own `tools` are kept. Either way `timestamp` is
the BOM's own, and no confidence is added.

Every 2.0 identifier group (`identifiers[]`) needs an asserting party. It is
`party-cdxgen` when cdxgen is the listed tool. When `metadata.tools` lists
other tools but not cdxgen, it is a party for the first tool component with a
`bom-ref`: refId `party-tool-<tool bom-ref>`, the `asserter` role, and a system
identity of kind `automation` labelled with the tool name and pointing at the
tool. When the BOM lists no tool, cdxgen, as the converting tool, asserts the
identifiers it wrote. Each such party is declared once, and only when the
document references it.

1.x has none of these members, so reading a 2.0 document strips them. When
they are what the 2.0 render derives again from the read model, the read
reports no loss and the derived party is not kept in the model. An identity
entry or identifier another party asserts is reported as a loss for 1.x
output. A `--to 2.0` conversion restores it unchanged as long as its 1.x
fields are unchanged. If those fields change, the entry is rendered again from
the 1.x model.

#### Sections cdxgen derives at 2.0

Three 2.0 sections are derived from the 1.x model by
`cdxgen --spec-version 2.0`, `cdx-convert --to 2.0` and `tracebom`:
post-quantum migration risks, the parties and blueprint of declared coding
agents, and the 2.0 members of hardware components. The risks and the agent
sections are cdxgen's own assessment, so they are derived only when the
document lists cdxgen in `metadata.tools`, the same rule identity claims
follow. Converting another tool's document adds neither. Derived entries have
fixed refIds (`risk-pqc-<asset bom-ref>`, `party-agent-<agent bom-ref>`,
`blueprint-declared-agents`). Reading a 2.0 document drops the derived entries
that match what the render derives again from the read model, with no loss; a
derived entry that no longer matches is reported as a loss and replaced. Every
other risk, blueprint and party is kept and comes first, so a round trip never
declares a party or blueprint twice. A cdxgen 2.0 document whose crypto assets
have no risks yet gains them on `--to 2.0`; that is an addition, not a loss.

##### Post-quantum migration risks

`risks.risks[]` gets one entry per cryptographic asset with a `bom-ref` that
falls into a class of `data/pqc-migration.json`. The classes and their members
come from NIST IR 8547 (final, October 2026) and, for DSA, FIPS 186-5:

| Class                                  | Source                                                         | Transition the source states                                                                 | Likelihood | Impact   |
| -------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------- | -------- |
| `quantum-vulnerable-signature`         | IR 8547 Table 2: ECDSA, EdDSA, RSA [FIPS186]                   | Deprecated after 2030; disallowed after 2035                                                 | high       | major    |
| `quantum-vulnerable-key-establishment` | IR 8547 Table 4: finite-field and EC DH and MQV, RSA [SP80056B] | Deprecated after 2030; disallowed after 2035                                                 | high       | major    |
| `quantum-vulnerable-public-key`        | IR 8547 Tables 2 and 4 (rsaEncryption, id-ecPublicKey)         | Deprecated after 2030; disallowed after 2035                                                 | high       | major    |
| `below-minimum-strength`               | IR 8547 Tables 2 and 4 list only >= 112-bit parameters         | Below the minimum strength of the currently approved parameters                              | very-high  | major    |
| `hash-sha1`                            | IR 8547 Table 8, footnote 4                                    | Currently deprecated; disallowed in FIPS-validated modules after 2030                       | high       | moderate |
| `symmetric-112-bit`                    | IR 8547 Section 4.1.3 and Table 8 (SHA-224, SHA-512/224, SHA3-224) | Disallowed in 2030                                                                       | medium     | moderate |
| `dsa-generation-not-approved`          | FIPS 186-5 Section 4                                           | No longer approved for signature generation; may verify signatures generated before FIPS 186-5 | high       | moderate |

An algorithm asset is classified by `algorithmFamily`, then by OID
(rsaEncryption, id-ecPublicKey, the RSA, ECDSA, EdDSA and DSA signature OIDs,
X25519 and X448, X9.42 and PKCS #3 DH, SHA-1, SHA-224, SHA-512/224, SHA3-224),
then by its name in lower case with only letters and digits kept. A
quantum-safe family (ML-DSA, SLH-DSA, LMS, XMSS, ML-KEM, AES, Ascon, SHA-2 and
SHA-3 at 128 bits and more, HMAC, HKDF, KMAC) gets no entry, and neither does a
hybrid combiner (IR 8547 Section 3.2.1) or a scheme the IR does not list
(RSAES-PKCS1, X3DH). A signature name such as `SHA256withDSA` or
`dsa-with-sha256` is classified by its signature algorithm, not its digest. An
RSA or finite-field key under 2048 bits and an elliptic-curve key under 224 bits
(112 bits of strength, SP 800-57 Part 1 Table 2) is `below-minimum-strength`:
an algorithm whose name, RFC 7919 group (`ffdhe2048` and up), parameter set or
curve gives the key size, and a public or private key asset whose own `size` is
smaller. A number that follows a digest name, as in `RSASSA-PSS-SHA-512`, is the
digest size, not the key size.

Each entry has `refId`, `name`, the class `statement`, `domains`
`[{type: "security"}]`, `affects` (the asset), `inherentRisk` with the
likelihood and impact levels above and the class rationale, the `cdx:crypto:pqc:*`
properties (see [CUSTOM_PROPERTIES.md](CUSTOM_PROPERTIES.md)) and the source
document as an external reference. The levels are cdxgen's fixed rating per
class. No `confidence`, owner, status or response is emitted.

##### Declared coding agents

See [AI_BOM.md](AI_BOM.md#declared-coding-agents-at-cyclonedx-20).

##### Hardware components

See [HBOM.md](HBOM.md#cyclonedx-20-output).

`--fail-on-loss` exits 2, before writing, when a 1.x or SPDX target lacks
something the read losses name, when the 2.0 render drops a value or a 2.0
to 2.0 conversion lacks one, or when a CycloneDX version conversion drops a
field path.

Output is schema-validated unless `--no-validate` is passed. cdxgen bundles
CycloneDX schemas for `1.6`, `1.7`, and `2.0`; converting to any other version
skips the schema check and says so.

## SPDX conversion algorithm

The conversion logic uses `convertCycloneDxToSpdx()` in
`lib/stages/postgen/spdxConverter.js`.

High-level flow:

```text
read input file
  -> parse JSON or decode protobuf
  -> validate input shape and CycloneDX specVersion (1.6 or 1.7)
  -> convert CycloneDX object to SPDX 3.0.1 JSON-LD graph
  -> validate SPDX output (unless --no-validate)
  -> write output file
```

SPDX mapping behavior includes:

- document-level creation info and root element mapping
- component mapping to SPDX packages/files
- dependency mapping to SPDX relationships
- retention of CycloneDX-specific data in `cdxgen:cyclonedx` extension fields
  when there is no direct SPDX 3.0.1 field

## Features

- deterministic field mapping for CycloneDX 1.6/1.7 to SPDX 3.0.1 conversion
  when the input BOM includes stable `serialNumber` and `metadata.timestamp`
- optional SPDX validation after conversion
- predictable output naming (`<input>.spdx.json` when `-o` is omitted)
- directory auto-creation for output paths
- preservation of key compliance metadata in extension fields, including
  authors, publisher, maintainers, tags, and licenses

## Limitations

- input must be CycloneDX JSON or protobuf, not XML
- the SPDX path accepts only CycloneDX `1.6`, `1.7` and `2.0` input, and its
  output target is fixed to SPDX `3.0.1`
- a CycloneDX downgrade is lossy by nature; keep the source BOM if you need the
  dropped fields
- protobuf output requires the optional `@cdxgen/cdx-proto` dependency
- CycloneDX fields without equivalent SPDX core fields are retained via
  extension fields, not promoted to standard SPDX core fields

## When to use cdx-convert vs cdxgen --format spdx

Use `cdx-convert` when you already have a CycloneDX JSON or protobuf file and
need SPDX, or need it at a different CycloneDX version.

Use `cdxgen --format spdx` or `cdxgen --format cyclonedx,spdx` when you are
generating a new BOM and want SPDX output during the same run, and
`cdxgen --spec-version` when you are generating a new BOM at an older version.

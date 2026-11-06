# cdx-sign — Sign a CycloneDX BOM

`cdx-sign` adds a JavaScript Signature Format (JSF) signature to an existing CycloneDX JSON BOM.

Use it when you need to prove who produced a BOM, preserve an approval trail, or attach multiple signatures from different stages in your pipeline.

## Who should use this

- **Build and release teams** — sign BOMs at build time before publishing artifacts
- **Security teams** — append review or approval signatures without replacing the builder's signature
- **Compliance teams** — preserve signing evidence for downstream validation and attestation workflows

## Quick start

```shell
# Replace or create the root signature in-place
cdx-sign -i bom.json -k builder_private.pem

# Write a signed copy to a new file
cdx-sign -i bom.json -o bom.signed.json -k builder_private.pem -a RS512

# Append a second signature after checking the builder's signature
cdx-sign -i bom.json -k auditor_private.pem -a ES256 --mode signers --verify-existing-with builder_public.pem

# Create a chained signature history after checking the builder's signature
cdx-sign -i bom.json -k approver_private.pem -a Ed25519 --mode chain --verify-existing-with builder_public.pem
```

## CLI reference

| Flag                                           | Default         | Description                                                                                                    |
| ---------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `-i, --input`                                  | `bom.json`      | Input CycloneDX JSON BOM to sign                                                                               |
| `-o, --output`                                 | overwrite input | Output file path                                                                                               |
| `-k, --private-key`                            | —               | PEM-encoded private key file path, or the shared secret file for `HS*` algorithms. Optional if loaded from env |
| `-a, --algorithm`                              | `RS512`         | JSF signature algorithm. It must match the key type. Defaults to `SBOM_SIGN_ALGORITHM` if set                  |
| `-m, --mode`                                   | `replace`       | Signature mode: `replace`, `signers`, or `chain`. Defaults to `SBOM_SIGN_MODE` if set                          |
| `--key-id`                                     | —               | Optional `keyId` embedded in the signature                                                                     |
| `--verify-existing-with`                       | —               | Earlier signer's public key (PEM), repeatable. Chain appends need every entry to verify, signers appends one   |
| `--allow-unverified-history`                   | off             | With `--mode chain` or `signers`, append even when existing entries cannot be verified                         |
| `--embed-public-key` / `--no-embed-public-key` | on              | Embed the signer's public key (JWK) in the root signature. Not used for `HS*` algorithms                       |
| `--sign-components` / `--no-sign-components`   | see below       | Sign nested components                                                                                         |
| `--sign-services` / `--no-sign-services`       | see below       | Sign nested services                                                                                           |
| `--sign-annotations` / `--no-sign-annotations` | see below       | Sign nested annotations                                                                                        |
| `--attach`                                     | —               | OCI image tag reference to natively attach the signed SBOM to                                                  |

Nested components, services, and annotations are signed by default. When `--mode signers` or `--mode chain` appends a signature to a BOM that already has a root signature, they are skipped by default, because re-signing them would change content covered by the existing root signature. Passing `--sign-components`, `--sign-services`, or `--sign-annotations` in that case is refused.

Note: A private key is not required if the input BOM is already signed and you only use the `--attach` feature to upload it to an OCI registry.

`cdx-sign` refuses input that `cdx-verify` would reject:

- Bytes that are not UTF-8, JSON that repeats a member name within one object, a number an IEEE 754 double cannot represent exactly, or an unpaired UTF-16 surrogate escape.
- A BOM whose root lacks `bomFormat` (or `specFormat`) `"CycloneDX"` and `specVersion`, or holds members that CycloneDX does not define at the root of a BOM.
- A component, service, or annotation that carries `bomFormat`, `specFormat`, or `specVersion`, when nested elements are signed. Such an element signed on its own would carry a signature over exactly the bytes a BOM signature covers.
- A signature that already holds 32 `signers` or `chain` entries.

## Environment variables

Instead of passing CLI options, `cdx-sign` can read key configurations from environment variables:

- `SBOM_SIGN_PRIVATE_KEY` — File path to the PEM-encoded private key, or to the shared secret for `HS*` algorithms
- `SBOM_SIGN_PRIVATE_KEY_BASE64` — Base64-encoded content of the PEM private key or shared secret
- `SBOM_SIGN_ALGORITHM` — JSF signature algorithm
- `SBOM_SIGN_MODE` — Signature mode

## Algorithms and keys

Each JSF algorithm accepts only the key type listed below. `cdx-sign` refuses a key that does not match the requested algorithm, and `cdx-verify` rejects a signature whose declared algorithm does not match the verification key.

| Algorithm                 | Key                                                       |
| ------------------------- | --------------------------------------------------------- |
| `RS256`, `RS384`, `RS512` | RSA                                                       |
| `PS256`, `PS384`, `PS512` | RSA or RSA-PSS (the PSS salt length is the digest length) |
| `ES256`                   | EC P-256                                                  |
| `ES384`                   | EC P-384                                                  |
| `ES512`                   | EC P-521                                                  |
| `Ed25519`                 | Ed25519                                                   |
| `Ed448`                   | Ed448                                                     |
| `HS256`, `HS384`, `HS512` | A shared secret file, never a PEM or JWK key              |

Algorithms without a JSF identifier, such as ML-DSA, are refused.

## What a signature covers

Following JSF, every signature covers the signed object (the whole BOM for the root signature) together with its own signature metadata, such as `algorithm`, `keyId`, and `publicKey`. Only the `value` is excluded. Changing any of them after signing invalidates the signature.

When `--key-id` is used, the key ID is part of the signed data. `cdx-sign` embeds the signer's public key in the root signature by default. Because the embedded key is part of the signed data, the signature then names the key that made it: RSA and ECDSA signatures do not do that by themselves, and a different key can sometimes be constructed under which an existing RSA signature verifies. `cdxgen` embeds the key when `SBOM_SIGN_PUBLIC_KEY` is set. An embedded key must belong to the signing key, and `cdx-verify` rejects a signature whose embedded key differs from the verification key.

Keys without a JWK form, such as `rsa-pss` keys, cannot be embedded; `cdx-sign` signs without the embedded key and prints a warning.

ECDSA (`ES*`) signatures are written in their low-`s` form, so `cdx-sign` never produces two encodings of the same signature. Verification still accepts both forms, which other JSF implementations produce.

## Signature modes

### `replace`

Use when the BOM should have a single authoritative root signature. Existing root and nested signatures are replaced.

### `signers`

Use when multiple parties sign the same BOM independently. This is the best fit for builder + reviewer or builder + security-team workflows. Each entry in `signers` covers the BOM and its own metadata only, so every signer verifies independently of the others.

Before appending, `cdx-sign --mode signers` checks the existing entries against the public keys given with `--verify-existing-with` and refuses to append unless at least one of them verifies. That shows the content is still what an earlier signer signed, so a co-signer never adds a signature next to entries that the content no longer matches. Pass `--allow-unverified-history` only when you deliberately co-sign content you cannot check.

### `chain`

Use when each signer is expected to sign the result of the previous signer, creating an ordered approval trail. Each entry in `chain` also covers every earlier entry, including its value, so reordering the chain or removing or replacing an earlier entry is detected.

Because a new chain entry vouches for every entry before it, `cdx-sign --mode chain` first checks the existing entries against the public keys given with `--verify-existing-with` (one per earlier signer) and refuses to append when any entry does not verify. Pass `--allow-unverified-history` only when you deliberately countersign history you cannot check.

Removing the last entries of a chain leaves the earlier entries valid, so a chain proves who signed up to a point, not that nobody signed later. To confirm an approval, verify with `cdx-verify --require-all` and the public key of every expected signer: it fails when any of those keys verifies no entry, so a stripped approval is detected.

When a `signers` or `chain` entry is appended to a BOM that has a single `replace` signature, that signature becomes the first entry of the new array. It keeps verifying at any position of a `signers` list, and at the first position of a `chain`. To keep a document strictly JSF-conformant from the start, use the same `--mode` for the first signature too.

## CycloneDX 2.0 documents (JSS)

A CycloneDX 2.0 document (`specVersion` 2.0 or later, or a `specFormat` member) is signed with the JSON Signature Scheme, ITU-T X.590, instead of JSF. `cdx-sign` detects the version from the input; `cdxgen --spec-version 2.0` signs the same way when signing is configured.

- **Algorithms.** RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512, Ed25519 and Ed448, each bound to its key type and curve as in the table above, with RSA keys of at least 2048 bits. HS256, HS384 and HS512 are refused (X.590 clause 6.2.2 says they should not be used), and so are the XMSS and LMS names of X.590 Table 1, which `node:crypto` does not implement. Without `-a`, `cdx-sign` picks the algorithm from the key. `cdxgen --generate-key-and-sign` uses Ed25519 unless `SBOM_SIGN_ALGORITHM` names another. Ed448 is not available under Bun, whose crypto library has no Ed448.
- **What is covered.** Each entry covers the document, without the other entries, plus its own members except `value`, including `public_key`, `signee` and `valid_until`. The `hash_algorithm` must be an IANA-registered SHA-2 or SHA-3 name (`sha-256`, `sha-384`, `sha-512`, `sha3-256`, `sha3-384`, `sha3-512`).
- **Public key.** Every entry carries the signer's `public_key`, so `--no-embed-public-key` is refused and `--key-id` is not used.
- **Modes.** `replace` removes every existing JSS signature, then signs the root, the inventories, their components, the compositions and the annotations. `signers` appends a root entry, and the existing entries stay valid. Before it appends, the existing signatures must pass `cdx-verify` with the keys given in `--verify-existing-with`: at least one entry verifies, no entry that names one of those keys fails, and every countersignature verifies. `chain` adds an X.590 clause 7.2 countersignature to the only root entry. A JSS countersignature covers only the entry it countersigns, so `chain` is refused when the document has several root entries.
- **Input.** A value that canonical JSON (JCS, IETF RFC 8785) cannot represent, such as a non-finite number or an unpaired UTF-16 surrogate, is refused.

## Operational guidance

- Use **separate keys per trust domain** such as build, release, and audit.
- Prefer writing to a **new output file** when you need to preserve the unsigned original.
- When appending a `signers` or `chain` entry, only the root is signed. Nested signatures stay with the party that created them.
- Verify a multi-signed BOM with `cdx-verify --require-all` and one `--public-key` per expected signer.
- Keep shared secrets for `HS*` algorithms out of the trust stores used for public keys. They are verified with `cdx-verify --secret-key`, never with `--public-key`.
- Pair `cdx-sign` with [`cdx-verify`](CDX_VERIFY.md) in CI so signing failures or mismatched public keys are caught immediately.

## Re-signing BOMs from earlier releases

cdxgen 13.2.0 and earlier left the signature metadata out of the signed data, and their chain entries did not cover earlier entries. Those signatures no longer verify. Re-sign such BOMs with the current `cdx-sign` in the default `replace` mode, then let any co-signers or approvers append their entries again:

```shell
cdx-sign -i bom.json -k builder_private.pem -a RS512 --key-id builder-ci
cdx-sign -i bom.json -k auditor_private.pem -a ES256 --key-id auditor --mode signers --verify-existing-with builder_public.pem
```

## Examples

### Local signing

```shell
cdxgen -o bom.json .
cdx-sign -i bom.json -k builder_private.pem --key-id builder-ci
cdx-verify -i bom.json --public-key builder_public.pem
```

### Native container SBOM attestation

Generate a signed SBOM, attach it natively to an OCI registry tag, and verify the registry reference natively:

```shell
# Generate and sign automatically via cdxgen using base64 env secret
export SBOM_SIGN_PRIVATE_KEY_BASE64="LS0tLS1CRUdJTi..."
cdxgen -t docker -o bom.json my-app:latest

# Attach the signed SBOM to the registry tag natively
cdx-sign -i bom.json --attach my-app:latest

# Verify the attached SBOM in the registry natively
cdx-verify -i my-app:latest --public-key public.pem
```

## Related docs

- [CLI Usage](CLI.md)
- [cdx-verify — Verify BOM signatures](CDX_VERIFY.md)
- [Tutorials - Sign & Attach](LESSON3.md)
- [Tutorials - Multi-Signing and Signature Chaining for SBOMs](LESSON6.md)

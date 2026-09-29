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

# Append a second signature without replacing the existing one
cdx-sign -i bom.json -k auditor_private.pem -a ES256 --mode signers

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
| `--verify-existing-with`                       | —               | Earlier signer's public key (PEM), repeatable. Chain appends need every entry to verify                        |
| `--allow-unverified-history`                   | off             | With `--mode chain`, append even when existing entries cannot be verified                                      |
| `--sign-components` / `--no-sign-components`   | see below       | Sign nested components                                                                                         |
| `--sign-services` / `--no-sign-services`       | see below       | Sign nested services                                                                                           |
| `--sign-annotations` / `--no-sign-annotations` | see below       | Sign nested annotations                                                                                        |
| `--attach`                                     | —               | OCI image tag reference to natively attach the signed SBOM to                                                  |

Nested components, services, and annotations are signed by default. When `--mode signers` or `--mode chain` appends a signature to a BOM that already has a root signature, they are skipped by default, because re-signing them would change content covered by the existing root signature. Passing `--sign-components`, `--sign-services`, or `--sign-annotations` in that case is refused.

Note: A private key is not required if the input BOM is already signed and you only use the `--attach` feature to upload it to an OCI registry.

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

When `--key-id` is used, the key ID is part of the signed data. When a public key is embedded (for example through `SBOM_SIGN_PUBLIC_KEY`), it must belong to the signing key, and `cdx-verify` rejects a signature whose embedded key differs from the verification key.

## Signature modes

### `replace`

Use when the BOM should have a single authoritative root signature. Existing root and nested signatures are replaced.

### `signers`

Use when multiple parties sign the same BOM independently. This is the best fit for builder + reviewer or builder + security-team workflows. Each entry in `signers` covers the BOM and its own metadata only, so every signer verifies independently of the others.

### `chain`

Use when each signer is expected to sign the result of the previous signer, creating an ordered approval trail. Each entry in `chain` also covers every earlier entry, including its value, so reordering the chain or removing or replacing an earlier entry is detected.

Because a new chain entry vouches for every entry before it, `cdx-sign --mode chain` first checks the existing entries against the public keys given with `--verify-existing-with` (one per earlier signer) and refuses to append when any entry does not verify. Pass `--allow-unverified-history` only when you deliberately countersign history you cannot check.

Removing the last entries of a chain leaves the earlier entries valid, so a chain proves who signed up to a point, not that nobody signed later or that an approval was not stripped. To confirm an approval, verify with that approver's public key; `cdx-verify` reports the entry that key matched, wherever it is in the chain.

When a `signers` or `chain` entry is appended to a BOM that has a single `replace` signature, that signature becomes the first entry of the new array. It keeps verifying at any position of a `signers` list, and at the first position of a `chain`. To keep a document strictly JSF-conformant from the start, use the same `--mode` for the first signature too.

## Operational guidance

- Use **separate keys per trust domain** such as build, release, and audit.
- Prefer writing to a **new output file** when you need to preserve the unsigned original.
- When appending a `signers` or `chain` entry, only the root is signed. Nested signatures stay with the party that created them.
- Keep shared secrets for `HS*` algorithms out of the trust stores used for public keys. They are verified with `cdx-verify --secret-key`, never with `--public-key`.
- Pair `cdx-sign` with [`cdx-verify`](CDX_VERIFY.md) in CI so signing failures or mismatched public keys are caught immediately.

## Re-signing BOMs from earlier releases

cdxgen 12.8.4, 13.2.0, and earlier releases left the signature metadata out of the signed data, and their chain entries did not cover earlier entries. Those signatures no longer verify. Re-sign such BOMs with the current `cdx-sign` in the default `replace` mode, then let any co-signers or approvers append their entries again:

```shell
cdx-sign -i bom.json -k builder_private.pem -a RS512 --key-id builder-ci
cdx-sign -i bom.json -k auditor_private.pem -a ES256 --key-id auditor --mode signers
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

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
cdx-sign -i bom.json -k auditor_private.pem --mode signers --no-sign-components --no-sign-services --no-sign-annotations

# Create a chained signature history
cdx-sign -i bom.json -k approver_private.pem --mode chain
```

## CLI reference

| Flag                                           | Default         | Description                                                                                              |
| ---------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `-i, --input`                                  | `bom.json`      | Input CycloneDX JSON BOM to sign                                                                         |
| `-o, --output`                                 | overwrite input | Output file path                                                                                         |
| `-k, --private-key`                            | —               | PEM-encoded private key file path. Optional if loaded from env                                           |
| `-a, --algorithm`                              | `RS512`         | JSF signature algorithm such as `RS512`, `ES256`, or `Ed25519`. Defaults to `SBOM_SIGN_ALGORITHM` if set |
| `-m, --mode`                                   | `replace`       | Signature mode: `replace`, `signers`, or `chain`. Defaults to `SBOM_SIGN_MODE` if set                    |
| `--key-id`                                     | —               | Optional `keyId` embedded in the signature                                                               |
| `--sign-components` / `--no-sign-components`   | on              | Sign nested components                                                                                   |
| `--sign-services` / `--no-sign-services`       | on              | Sign nested services                                                                                     |
| `--sign-annotations` / `--no-sign-annotations` | on              | Sign nested annotations                                                                                  |
| `--attach`                                     | —               | OCI image tag reference to natively attach the signed SBOM to                                            |

Note: A private key is not required if the input BOM is already signed and you only use the `--attach` feature to upload it to an OCI registry.

## Environment variables

Instead of passing CLI options, `cdx-sign` can read key configurations from environment variables:

- `SBOM_SIGN_PRIVATE_KEY` — File path to the PEM-encoded private key
- `SBOM_SIGN_PRIVATE_KEY_BASE64` — Base64-encoded content of the PEM private key
- `SBOM_SIGN_ALGORITHM` — JSF signature algorithm
- `SBOM_SIGN_MODE` — Signature mode

## Signature modes

### `replace`

Use when the BOM should have a single authoritative root signature.

### `signers`

Use when multiple parties sign the same BOM independently. This is the best fit for builder + reviewer or builder + security-team workflows.

### `chain`

Use when each signer is expected to sign the result of the previous signer, creating an ordered approval trail.

## Operational guidance

- Use **separate keys per trust domain** such as build, release, and audit.
- Prefer writing to a **new output file** when you need to preserve the unsigned original.
- When appending multi-signatures with `--mode signers`, disable nested signing unless every participant is expected to resign nested objects too.
- Pair `cdx-sign` with [`cdx-verify`](CDX_VERIFY.md) in CI so signing failures or mismatched public keys are caught immediately.

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

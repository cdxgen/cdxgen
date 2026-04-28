# cdx-verify — Verify CycloneDX BOM signatures

`cdx-verify` validates JSF signatures on CycloneDX BOMs.

It can verify:

- a root BOM signature
- nested component signatures
- nested service signatures
- nested annotation signatures
- BOMs loaded from a local file or an OCI reference

## Who should use this

- **CI/CD maintainers** — fail a pipeline when a signed BOM no longer verifies
- **Artifact consumers** — verify the signer before trusting a BOM from another team
- **Compliance teams** — confirm the published BOM still matches the signed payload

## Quick start

```shell
# Verify a BOM on disk
cdx-verify -i bom.json --public-key public.pem

# Verify only the root BOM signature
cdx-verify -i bom.json --public-key public.pem --no-deep

# Verify a BOM attached to an OCI image
cdx-verify -i ghcr.io/cyclonedx/cdxgen:master --public-key public.pem
```

## CLI reference

| Flag                   | Default      | Description                                                     |
| ---------------------- | ------------ | --------------------------------------------------------------- |
| `-i, --input`          | `bom.json`   | Local BOM path or OCI reference                                 |
| `--platform`           | —            | OCI platform override when verifying an attached BOM            |
| `--public-key`         | `public.key` | PEM-encoded public key                                          |
| `--deep` / `--no-deep` | on           | Verify nested component, service, and annotation signatures too |
| `-h, --help`           | off          | Show help                                                       |

## Verification behavior

- If the BOM contains a root `signature`, `cdx-verify` validates it first.
- With `--deep` enabled, nested signatures are also verified.
- If there is no root signature but nested signatures exist, the command validates those nested signatures and succeeds only when all of them are valid.
- If no valid signatures are present, the command exits with a failure.

## Exit behavior

- exit code `0` — the requested signatures verified successfully
- exit code `1` — invalid input, missing key, failed verification, or no valid signatures found

## Practical guidance

- Use `--no-deep` when the trust decision is only about the published root BOM.
- Keep `--deep` enabled when nested signatures are part of your release policy.
- Store public keys in version-controlled trust stores or your CI secret manager rather than downloading them ad hoc.

## Example CI step

```yaml
- name: Verify BOM signature
  run: cdx-verify -i bom.json --public-key builder_public.pem
```

## Related docs

- [cdx-sign — Sign a CycloneDX BOM](CDX_SIGN.md)
- [cdx-validate — Supply-Chain Compliance Validator](CDX_VALIDATE.md)
- [Tutorials - Sign & Attach](LESSON3.md)
- [Tutorials - Multi-Signing and Signature Chaining for SBOMs](LESSON6.md)

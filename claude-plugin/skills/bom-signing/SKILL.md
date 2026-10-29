---
name: bom-signing
description: Signs and verifies CycloneDX BOMs using cdxgen's native JSON Signature Format (JSF) implementation via cdx-sign and cdx-verify, supporting granular component, service, and annotation signatures, parallel multi-signatures, and sequential signature chains. Use when asked to sign an SBOM, verify a BOM signature, establish BOM authenticity or non-repudiation, build an approval trail across pipeline stages, or generate signing keys.
disable-model-invocation: true
---

# Sign and verify BOMs

cdxgen ships a native JSON Signature Format (JSF) implementation that goes
beyond a single document-level signature. It supports granular signatures over
individual components, services, and annotations; parallel multi-signatures via
`signers`; and sequential signature chains via `chain`.

Read [reference/safety.md](../../reference/safety.md) first.

## Key handling boundary

**Never generate, read, paste, or transcribe private key material yourself, and
never enter a passphrase on the user's behalf.** Run the signing commands with
paths the user provides, and if a key does not exist yet, give the user the
command to create it and let them run it.

For a throwaway demo or test BOM, cdxgen can generate a keypair and sign in one
step:

```bash
cdxgen -o /absolute/path/to/bom.json --generate-key-and-sign /absolute/path/to/project
```

This is appropriate for testing signing workflows. It is not appropriate for
release signing, where the key should come from the user's key management.

## Sign

```bash
# Replace or create the root signature in place
cdx-sign -i /absolute/path/to/bom.json -k /absolute/path/to/builder_private.pem

# Write a signed copy to a new file, with an explicit algorithm
cdx-sign -i /absolute/path/to/bom.json -o /absolute/path/to/bom.signed.json \
  -k /absolute/path/to/builder_private.pem -a RS512
```

| Flag                         | Purpose                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `-i, --input`                | BOM to sign                                             |
| `-o, --output`               | Signed copy; omit to sign in place                      |
| `-k, --private-key`          | Private key, PEM format                                 |
| `-a, --algorithm`            | JSF algorithm; default `RS512`. Also `ES256`, `Ed25519` |
| `-m, --mode`                 | `replace` (default), `signers`, `chain`                 |
| `--key-id`                   | Key identifier recorded in the signature                |
| `--sign-components`          | Sign individual components                              |
| `--sign-services`            | Sign individual services                                |
| `--sign-annotations`         | Sign annotations                                        |
| `--verify-existing-with`     | Earlier signer's public key, checked before appending   |
| `--allow-unverified-history` | Append even when existing entries do not verify         |
| `--no-embed-public-key`      | Leave the signer's public key out of the root signature |
| `--attach`                   | Attach the signed BOM to an OCI image reference         |

Defaults can come from `SBOM_SIGN_ALGORITHM` and `SBOM_SIGN_MODE`.

## Choosing a signature mode

| Mode      | Semantics                                                                  | Use for                                                   |
| --------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `replace` | Replaces or creates the root signature                                     | Build-time signing by the producer                        |
| `signers` | Appends a parallel signature without replacing existing ones               | Independent approvals from different teams                |
| `chain`   | Appends to a sequential signature history                                  | An ordered approval trail through pipeline stages         |

Append a security review signature without destroying the builder's:

```bash
cdx-sign -i /absolute/path/to/bom.json -k /absolute/path/to/auditor_private.pem \
  --mode signers --no-sign-components --no-sign-services --no-sign-annotations \
  --verify-existing-with /absolute/path/to/builder_public.pem
```

`cdx-sign` refuses to append a `signers` entry unless at least one existing entry
verifies with a `--verify-existing-with` key, and a `chain` entry unless every
existing entry does.

Note the `--no-` prefixes: the reviewer signs the document, not every component,
which keeps the second signature cheap and its scope clear.

Build a chained history:

```bash
cdx-sign -i /absolute/path/to/bom.json -k /absolute/path/to/approver_private.pem --mode chain \
  --verify-existing-with /absolute/path/to/builder_public.pem
```

Use `signers` when approvals are independent and order does not matter. Use
`chain` when the order is itself the evidence.

## Verify

```bash
cdx-verify -i /absolute/path/to/bom.json --public-key /absolute/path/to/public.pem
cdx-verify -i /absolute/path/to/bom.json --public-key /absolute/path/to/public.pem --deep
cdx-verify -i /absolute/path/to/bom.json --public-key /absolute/path/to/builder.pem \
  --public-key /absolute/path/to/auditor.pem --require-all
```

`--public-key` is required and repeatable; `cdx-verify` never reads a key from the
working directory. A BOM without a root signature fails unless
`--allow-nested-only` is passed and every component, service, and annotation is
signed. For `signers` and `chain` signatures, one verified entry is enough by
default and the others are listed as warnings. `--require-all` requires every entry
to verify and every given key to verify an entry of the root signature, so a removed
co-signature or truncated chain fails; pass one `--public-key` per expected signer.
BOM bytes that are not UTF-8, repeat a member name, or hold a number an IEEE 754
double cannot represent exactly are refused.

`--deep` verifies granular component, service, and annotation signatures rather
than only the document signature. Use it whenever the BOM was signed with
`--sign-components` or `--sign-services` — a passing shallow check on such a BOM
does not establish that the component signatures are intact.

`--platform` targets platform-specific verification behaviour.

## Verify structure and signature together

`cdx-validate` folds signature verification into full validation (JSON input
only):

```bash
cdx-validate -i /absolute/path/to/bom.json \
  --public-key /absolute/path/to/public.pem --require-signature
```

Giving a key turns on `--require-signature`, which makes an unsigned or
unverifiable BOM a validation failure (exit 4) rather than a silent pass. Pass
`--no-require-signature` only to report the result. See `bom-convert-validate`.

## Reporting verification results

Be precise about what a result does and does not establish:

- A valid signature proves the BOM was signed by the holder of that key and has not been altered since. It says nothing about whether the BOM's contents are accurate.
- A shallow pass on a granularly signed BOM is not a full verification. Say when you did not run `--deep`.
- An unsigned BOM is not a failed signature. Distinguish "no signature present" from "signature invalid".

## Reference

- Signing: <https://cdxgen.github.io/cdxgen/#/CDX_SIGN>
- Verification: <https://cdxgen.github.io/cdxgen/#/CDX_VERIFY>
- Validation: <https://cdxgen.github.io/cdxgen/#/CDX_VALIDATE>

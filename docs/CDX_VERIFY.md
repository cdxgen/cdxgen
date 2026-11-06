# cdx-verify — Verify CycloneDX BOM signatures

`cdx-verify` validates JSF signatures on CycloneDX BOMs.

It can verify:

- a root BOM signature
- nested component signatures
- nested service signatures
- nested annotation signatures
- JSON BOMs loaded from a local file or an OCI reference

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
cdx-verify -i ghcr.io/cdxgen/cdxgen:master --public-key public.pem

# Verify an HMAC (HS256, HS384, HS512) signature with a shared secret
cdx-verify -i bom.json --secret-key shared.secret

# Require every co-signer of a multi-signed BOM
cdx-verify -i bom.json --public-key builder.pem --public-key auditor.pem --require-all
```

## CLI reference

| Flag                   | Default    | Description                                                                                                                                      |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-i, --input`          | `bom.json` | Local BOM path or OCI reference                                                                                                                  |
| `--platform`           | —          | OCI platform override when verifying an attached BOM                                                                                             |
| `--public-key`         | —          | Trusted PEM-encoded public key. Repeatable: a signature entry verifies when one of the keys verifies it. Required unless `--secret-key` is given |
| `--secret-key`         | —          | Shared secret file for `HS256`, `HS384`, and `HS512` signatures. Cannot be combined with `--public-key`                                          |
| `--deep` / `--no-deep` | on         | Verify nested component, service, and annotation signatures too                                                                                  |
| `--require-all`        | off        | Require every signature entry to verify with one of the keys, and every key to verify an entry of the root signature                             |
| `--allow-nested-only`  | off        | Accept a BOM without a root signature when every component, service, and annotation carries a signature that verifies                            |
| `-h, --help`           | off        | Show help                                                                                                                                        |

## Verification behavior

- Local protobuf BOM input (`.cdx`, `.cdx.bin`, `.proto`) is detected and decoded, but verification intentionally fails with a clear message because `cdx-proto` does not currently preserve JSF signature blocks in protobuf form.
- The trusted key is never taken from the current directory or from the BOM. Pass it with `--public-key` (or `--secret-key`); without one, `cdx-verify` exits with status 1.
- The BOM must be unambiguous JSON: bytes that are not UTF-8, a member name repeated within one object, a number that an IEEE 754 double cannot hold exactly (such as `9007199254740993` or `1e999`), or an unpaired UTF-16 surrogate escape make `cdx-verify` refuse the document, because other JSON parsers would read different values than the ones the signature covers. The same check applies to BOMs pulled from an OCI registry.
- A root signature is required. The signed root must carry `bomFormat` (or `specFormat`) `"CycloneDX"` and `specVersion`, and only members that CycloneDX defines at the root of a BOM, so a signed component, service, or annotation cannot be presented as a signed BOM.
- A `signers` or `chain` signature may hold nothing but its array, as the CycloneDX JSF schema requires.
- A signature only verifies when its declared `algorithm` matches the key type (see [Algorithms and keys](CDX_SIGN.md#algorithms-and-keys)). A key given with `--public-key` is always treated as a public key, so HMAC signatures are only accepted with `--secret-key`.
- The signature metadata (`algorithm`, `keyId`, `publicKey`) is part of the signed data, so changing it invalidates the signature. An embedded `publicKey` must be the verification key.
- For `signers`, each entry verifies on its own. For `chain`, each entry also covers the entries before it, so reordering the chain or removing an earlier entry is detected. Removing a whole entry, such as the last entries of a chain or a co-signer's entry, leaves the other entries valid, so it is only detected with `--require-all`.
- By default the root signature verifies when at least one entry verifies with one of the keys. `cdx-verify` then lists every root and nested entry that did not verify, with its `keyId` and the reason, so an entry nobody can verify is never silently accepted alongside a valid one.
- `--require-all` fails instead: every signature entry must verify with one of the keys, and every key must verify at least one entry of the root signature. Pass one `--public-key` per expected signer, so a missing signature from any of them is detected.
- A `signers` or `chain` signature may hold at most 32 entries.
- Nested signatures belong to the party that created them, usually the first signer. When verifying a co-signer's or approver's key, pass `--no-deep`; `cdx-verify` suggests this when the root signature matches but nested ones do not.
- When a signature fails, `cdx-verify` prints the reason for each signature entry it tried.
- BOMs signed with cdxgen 13.2.0 or earlier do not verify and must be [re-signed](CDX_SIGN.md#re-signing-boms-from-earlier-releases).
- With `--deep` enabled, nested signatures are also verified. A signed nested element that carries `bomFormat`, `specFormat`, or `specVersion` is rejected.
- A BOM without a root signature fails, because removing the root signature would otherwise leave unsigned content looking verified. `--allow-nested-only` accepts such a BOM only when every component, service, and annotation carries a signature that verifies; `cdx-verify` then names the members that no signature covers, such as `metadata` and `dependencies`. Nothing then protects which components, services, and annotations the BOM lists: signed elements can be removed, repeated, reordered, or copied in from another BOM signed by the same key.
- If no valid signatures are present, the command exits with a failure.
- ECDSA (`ES*`) signatures verify in both of their equivalent forms, `(r, s)` and `(r, n - s)`, as JSF and JWS allow; `cdx-sign` writes only the low-`s` form. Do not use a signature `value` as a unique identifier for a BOM.

## CycloneDX 2.0 documents (JSS)

A document whose `specVersion` is 2.0 or later, or that carries `specFormat`, holds JSON Signature Scheme signatures (ITU-T X.590) in `signatures` arrays instead of JSF. `cdx-verify` detects this and applies the following rules.

- Only `--public-key` is accepted. X.590 clause 6.2.2 says HMAC algorithms should not be used, so `--secret-key` is refused, and so are XMSS and LMS signatures, which `node:crypto` cannot verify. Ed448 is not available under Bun.
- The trusted keys come only from `--public-key`. An entry whose `public_key` decodes to one of those keys (whatever its base64 padding or line breaks) must verify with it, otherwise the document fails. An entry that names no given key, or whose `public_key` is not a key at all, such as the placeholder signer in the X.590 clause 7.1.6 example, is reported as untrusted and does not by itself fail the document.
- A countersignature (the `signature` member of an entry, X.590 clause 7.2) vouches for the entry it is attached to, so it must verify with one of the given keys. A countersignature that no given key verifies fails the document, whatever `signee`, `thumbprint`, `public_cert_chain` or `cert_url` it shows; those members are not trust claims. Pass the countersigner's public key to accept it.
- `--deep` also verifies the signatures on inventories, their components, compositions and annotations, and `--require-all` and `--allow-nested-only` work as for JSF.
- A value that canonical JSON (JCS, IETF RFC 8785) cannot represent, such as a non-finite number or an unpaired UTF-16 surrogate, fails verification.

## Exit behavior

- exit code `0` — the requested signatures verified successfully
- exit code `1` — invalid input, missing key, failed verification, or no valid signatures found

## Practical guidance

- Use `--no-deep` when the trust decision is only about the published root BOM.
- Keep `--deep` enabled when nested signatures are part of your release policy.
- If you export a protobuf sidecar (`bom.cdx`), keep the original signed JSON BOM alongside it for verification workflows.
- Store public keys in version-controlled trust stores or your CI secret manager rather than downloading them ad hoc. Never read the trusted key from the same place as the BOM, such as the checked-out pull request being verified.
- When an approval matters, verify with `--require-all` and the public key of every expected signer, so that a removed or missing approval fails.

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

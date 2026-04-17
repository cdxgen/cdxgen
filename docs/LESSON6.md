# Multi-Signing and Signature Chaining for SBOMs

## Learning Objective

In this lesson, we will learn how to apply multiple signatures (co-signing) and signature chains (sequential signing) to a CycloneDX SBOM.

- **Multi-Signature (`signers`)**: Parallel signatures. For example, a build system and a QA system both independently assert the integrity of the SBOM.
- **Signature Chain (`chain`)**: Sequential signatures. For example, a downstream consumer signs the SBOM _and_ the original vendor's signature to create an unbroken chain of custody.

## Pre-requisites

Ensure the following tools are installed:

- Node.js > 20
- OpenSSL (to generate cryptographic keys)
- `@cyclonedx/cdxgen` installed globally (provides `cdxgen`, `cdx-sign`, and `cdx-verify`)

## Getting started

In a real-world supply chain, multiple entities touch an artifact. Let's represent them as **Builder** and **Auditor**.

### Step 1: Generate cryptographic keys

We will create two sets of private/public keys.

```shell
# 1. Keys for the Builder (RSA)
openssl genpkey -algorithm RSA -out builder_private.pem -pkeyopt rsa_keygen_bits:4096
openssl rsa -pubout -in builder_private.pem -out builder_public.pem

# 2. Keys for the Auditor (EC / P-256)
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out auditor_private.pem
openssl pkey -pubout -in auditor_private.pem -out auditor_public.pem
```

### Step 2: Generate and Sign the initial SBOM (Builder)

The **Builder** generates the SBOM from the source code and explicitly signs it using the new `cdx-sign` utility.

```shell
# Generate the raw SBOM
cdxgen -t nodejs -o bom.json .

# Builder signs the SBOM (signs both root and granular components)
cdx-sign -i bom.json -k builder_private.pem -a RS512 --key-id "builder-system"

# Successfully signed BOM and saved to 'bom.json'
# Mode: replace | Algorithm: RS512 | KeyId: builder-system
```

Verify that the Builder's signature is valid:

```shell
cdx-verify -i bom.json --public-key builder_public.pem
# ✓ Signature is valid! (Matched KeyId: 'builder-system')
```

### Step 3: Append a Multi-Signature or Chain (Auditor)

The **Auditor** receives the SBOM, verifies it, and wants to co-sign it.

To append a signature to an _existing_ BOM without wiping out the Builder's signature, the Auditor uses `cdx-sign` with the `--mode signers` flag.

> **Crucial Concept:** The Auditor _must_ pass `--no-sign-components`. If the Auditor re-signed the inner components, it would alter the cryptographic payload of the document, instantly invalidating the Builder's original signature!

```shell
# Auditor appends their signature
cdx-sign -i bom.json \
  -k auditor_private.pem \
  -a ES256 \
  --key-id "auditor-system" \
  --mode signers \
  --no-sign-components \
  --no-sign-services \
  --no-sign-annotations

# Successfully signed BOM and saved to 'bom.json'
# Mode: signers | Algorithm: ES256 | KeyId: auditor-system
```

If you open `bom.json` now, you will see the `signature` object has changed from a flat object into a `"signers": [ ... ]` array containing both the Builder and Auditor signatures.

_(Note: To create a sequence chain where the Auditor explicitly signs the Builder's signature, you would simply change `--mode signers` to `--mode chain`)_.

### Step 4: Verify the Multi-Signed SBOM

Because JSF Multi-Signatures are strictly standards-compliant, `cdx-verify` can independently verify either party's signature without them interfering with one another.

```shell
# Verify Builder's signature
cdx-verify -i bom.json --public-key builder_public.pem
# ✓ Signature is valid! (Matched KeyId: 'builder-system')

# Verify Auditor's signature
cdx-verify -i bom.json --public-key auditor_public.pem --no-deep
# ✓ Signature is valid! (Matched KeyId: 'auditor-system')
```

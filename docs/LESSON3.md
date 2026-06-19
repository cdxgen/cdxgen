# Attach signed SBOM to a container image

## Learning Objective

In this lesson, we will learn about signing and attaching a signed SBOM to a container image.

## Pre-requisites

Ensure the following tools are installed.

- Node.js > 20
- docker or podman

Additionally, you need to have access to a container registry to push the image.

## Getting started

Install cdxgen

```shell
sudo npm install -g @cyclonedx/cdxgen
```

### Create and Build a container image

Paste the below contents to a file named `Dockerfile`

```
FROM ubuntu:latest
```

Build and push the image to the registry

```shell
docker build -t docker.io/<repo>/sign-test:latest -f Dockerfile .
docker push docker.io/<repo>/sign-test:latest
```

### Create an SBOM with cdxgen

```shell
# Generate an SBOM
cdxgen -t docker -o bom.json docker.io/<repo>/sign-test:latest

# Generate a private key for signing
openssl genpkey -algorithm RSA -out private.key -pkeyopt rsa_keygen_bits:2048

# Sign the SBOM and attach it natively to the OCI image
cdx-sign --input bom.json --private-key private.key --attach docker.io/<repo>/sign-test:latest
```

To download and validate the SBOM attachment from the OCI image natively, use the `cdx-validate` or `cdx-verify` command directly with the image reference. `cdxgen` handles the OCI referrers API and fallback tags automatically.

```shell
# Pull the attached SBOM and validate it
cdx-validate -i docker.io/<repo>/sign-test:latest
```

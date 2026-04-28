![logo](_media/cdxgen.png)

# CycloneDX Generator (cdxgen)

> Universal CycloneDX BOM workflows for developers, AppSec, and compliance teams.

[Get Started](README.md) · [CLI Usage](CLI.md) · [cdx-audit](CDX_AUDIT.md) · [REPL](REPL.md)

Generate and analyze **SBOM**, **CBOM**, **OBOM**, **SaaSBOM**, **CDXA**, and **VDR** documents from **local paths**, **containers**, **archives**, **git URLs**, and **package URLs** — then validate, sign, convert, and audit them in one toolchain.

## What cdxgen helps you do

- Generate BOMs across polyglot applications, containers, operating systems, and cryptographic inventory
- Export **CycloneDX JSON** or **SPDX 3.0.1 JSON-LD** and integrate with CI/CD and Dependency-Track
- Run as a **CLI**, **library**, **server**, **container image**, or **standalone binary**

## Choose your path

### Developers

- Start fast from a local project, git repository, or purl with the [CLI](CLI.md)
- Check ecosystem coverage in [Supported Project Types](PROJECT_TYPES.md)

### AppSec teams

- Validate structure and compliance with [cdx-validate](CDX_VALIDATE.md)
- Analyze generated BOMs with [BOM Audit](BOM_AUDIT.md)
- Prioritize upstream dependency review with [cdx-audit](CDX_AUDIT.md)

### Compliance and platform teams

- Convert BOMs to SPDX with [cdx-convert](CDX_CONVERT.md)
- Sign and verify BOMs with [cdx-sign](CDX_SIGN.md) and [cdx-verify](CDX_VERIFY.md)
- Review [Permissions](PERMISSIONS.md) and [Configuring Allowlists](ALLOWED_HOSTS_AND_COMMANDS.md) for hardened environments

## Start here

- [Getting Started](README.md)
- [CLI Usage](CLI.md)
- [Server Usage](SERVER.md)
- [Supported Project Types](PROJECT_TYPES.md)

## Learn and go deeper

- [Advanced Usage](ADVANCED.md)
- [Threat Model](THREAT_MODEL.md)
- [AI/ML Usage](ml_profiles.md)
- [Tutorials - Scanning Git URLs and purls with BOM Audit](LESSON8.md)
- [Tutorials - Auditing container escape and privilege risks](LESSON9.md)
- [Support (Enterprise & Community)](SUPPORT.md)

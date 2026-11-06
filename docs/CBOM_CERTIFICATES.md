# Certificates in the CBOM

A CBOM can answer three questions about the certificate estate that no SBOM
could:

- **Q1 — Go exposure:** which Go binaries still trust the intermediates Go
  1.27.3/1.26.10 distrust (CVE-2026-111943)?
- **Q2 — presence:** where do those keys, or certificates issued under them,
  exist?
- **Q3 — impact:** which servers present chains through them?

Generate the BOM with:

```bash
cdxgen -t docker <image> --include-crypto --bom-audit --bom-audit-categories cbom -o bom.json
cdxi bom.json   # then: .certs   .certchain <spki-prefix>
```

## The model

- One **certificate** is one component, wherever it appears: the bom-ref is
  `crypto/certificate/<name>@sha256:<whole-DER SHA-256>` and every location
  (CA bundle, server chain file, Java truststore, Kubernetes secret) is an
  `evidence.occurrences` entry.
- One **public key** is one component keyed by the SHA-256 of the DER
  `SubjectPublicKeyInfo` (`crypto/public-key/<alg-bits>@spki-sha256:<hash>`).
  Cross-signed and re-issued copies of one key share it — and Go's distrust
  list matches on exactly this hash.
- **Issuer edges** are `dependsOn` entries, and only exist where the
  signature actually verifies. A leaf issued under a cross-signed key depends
  on both twins.
- **Algorithm components** carry the OID, primitive, parameter set and
  `nistQuantumSecurityLevel` (0 for classical algorithms, which is a fact,
  not a policy).

Roles (`cdx:crypto:certRole`) are `root`, `intermediate` and `leaf`.
Self-signed means the signature was verified; when the runtime cannot check
the algorithm, a self-issued certificate still counts and carries
`cdx:crypto:selfSignedUnverified`.

Private keys are classified from their PEM header only and never decoded.
Keystore passwords are never tried beyond the JDK defaults, and unreadable
keystores appear as `cdx:crypto:keystoreReadable=false`/`partial`.

## Q2: where is a key?

```bash
# every certificate and pin carrying a distrusted SPKI
jq -r '.components[]
  | select((.properties // [])[] | select(.name=="cdx:crypto:spkiSha256" and .value=="<spki-hex>"))
  | ."bom-ref"' bom.json

# cross-signed twins: certificates sharing one SPKI
jq -r '[.components[] | select(.cryptoProperties.assetType=="certificate")
  | {spki: ([.properties[] | select(.name=="cdx:crypto:spkiSha256")][0].value // ""), ref: ."bom-ref"}]
  | group_by(.spki) | .[] | select(length > 1)' bom.json

# certificates issued under a given SPKI (one hop over the verified edges;
# .certchain <spki-prefix> walks the whole chain interactively)
jq -r --arg spki "<spki-hex>" '.components[]
  | select((.properties // [])[] | select(.name=="cdx:crypto:issuerSpkiSha256" and .value==$spki))
  | ."bom-ref"' bom.json
```

Simpler with cdxi: `.certs` lists every certificate with its role, issuer,
expiry and SPKI prefix; `.certchain <spki-prefix>` walks the chain above a
certificate and lists the certificates issued under it.

## Q1: which Go binaries are exposed?

Each executable `file` component carries `cdx:go:buildVersion` read from the
binary's buildinfo header, and depends on its
`pkg:golang/stdlib@v<toolchain>` component.

```bash
jq -r '.components[] | select((.properties // [])[] | select(.name=="cdx:go:buildVersion"))
  | [.name, ([.properties[] | select(.name=="cdx:go:buildVersion")][0].value)] | @tsv' bom.json
```

Flag anything below `go1.26.10`, any `go1.27.0`–`go1.27.2`, and every older
line (`go1.25.x` and earlier never receive the fix). The `GO-TLS-001` audit
rule does this comparison for you (see `docs/BOM_AUDIT.md`).

## Q3: observed chains

`tracebom` records the certificate chain each server presents (TLS ≤ 1.2);
those certificates enter the same model with
`cdx:crypto:sourceType=observed-tls` and an occurrence of
`tls://<host>:<port>`. TLS 1.3 encrypts its Certificate message, so those
connections record no chain — see the limitations below.

```bash
node bin/tracebom.js --cmd 'curl -sk https://api.example.test/' \
  --proxy-egress --allow-host api.example.test --trace-crypto -o cbom.json
```

What the run records, and what it deliberately does not:

- **TLS ≤ 1.2 only.** The observer reads the cleartext handshake; a TLS 1.3
  Certificate message is encrypted and yields nothing.
- **A presented chain is untrusted server input.** The certificates and their
  order are the server's own claim. cdxgen records each certificate's
  identity (hashes, subject, validity, key) and where it was presented, but
  never turns the order into issuer edges: no `dependsOn` and no
  `issuerSpkiSha256` come from an observed chain alone. `CBC-004` therefore
  needs the same certificate found on disk (whose issuer signature a producer
  could verify) merged with the observation — then the flagged leaf carries
  both the file path and the `tls://` server.
- **The proxy must see the connection.** The egress proxy sets `NO_PROXY` to
  cover loopback, so a loopback fixture server must be reached with
  `curl --noproxy ""` (or an equivalent override), and by a host name listed
  in `--allow-host`, not an IP literal — the proxy pins hostnames.
- **Identity is the certificate hash, but the name is the server's too.** The
  bom-ref embeds the certificate's name (PLAN §2.1). A server that presents a
  certificate under a different subject than the copy on disk therefore
  produces two components with the same `@sha256:` and different names; this
  is the contract, and it never hides a certificate from the `spkiSha256`
  deny-list queries above.

Each TLS protocol component `provides` the certificates and keys presented
under it, so the graph leads from `crypto/protocol/tls@<version>` to the
chain a server used.

Which servers presented a denylisted SPKI:

```bash
jq -r --arg spki "<spki-hex>" '.components[]
  | select((.properties // [])[] | select(.name=="cdx:crypto:spkiSha256" and .value==$spki))
  | ."bom-ref", (.evidence.occurrences // [] | map(.location) | .[])' bom.json
```

or with cdxi: `.certs` lists every certificate with its occurrence count;
`.certchain <spki-prefix>` walks the verified chain above a certificate.

## Where certificates are found

| Producer                                         | Covers                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source scan (`createCryptoCertsBom`)             | certificate, key and keystore files under the scanned paths, Kubernetes TLS secrets, Android `network_security_config.xml` pins | With the trustinspector plugin (report-2) it parses the files; otherwise cdxgen's own parser does                                                                                                                                                                                                                                         |
| trustinspector `rootfs`                          | CA stores, blocklists, server configs, Java truststores, language bundles of a rootfs or container                              | Plugin only                                                                                                                                                                                                                                                                                                                               |
| Rootfs fallback (`lib/inventory/rootfsCerts.js`) | the same locations as the plugin, plus Kubernetes secrets and Android pins                                                      | Runs for `-t rootfs` and container scans **only when no plugin is available**, so nothing is counted twice. Symlinks are skipped, only regular files are opened, files over 16 MiB are skipped, and a walk stops at 20,000 files, 500,000 entries or depth 12. Does not read `etc/ca-certificates.conf` (`ca-deselected`) or GPG keyrings |
| Observed TLS (tracebom)                          | chains a server presented                                                                                                       | see Q3                                                                                                                                                                                                                                                                                                                                    |

**Container layers.** Whiteouts are applied while the layers are extracted:
`.wh.<name>` removes `<name>` and `.wh..wh..opq` empties a directory, both for
content from earlier layers only. A CA removed in a later layer is therefore
not inventoried. A whiteout path with `..` segments is ignored, and a symlink
in the way stops a removal, so a hostile layer cannot delete anything outside
the extraction directory. Package databases follow the same rule: a replaced
`var/lib/dpkg/status` is read at its final content and a removed one is absent.

**Keystores.** A keystore (JKS, PKCS#12, JCEKS) always gets a
`related-crypto-material` component, wherever it is read. One the plugin could
read carries no `cdx:crypto:keystoreReadable` property and depends on the
certificates it holds; one that cannot be read is `keystoreReadable=false` with
no certificates. Passwords and keystore contents are never written to the BOM.

**Kubernetes secrets.** `kubernetes.io/tls` secrets are read from `data`
(base64) and `stringData` (plain PEM); `stringData` wins when both define a
key, as in Kubernetes. Each key has its own occurrence
(`<file>#data.tls.crt`, `<file>#stringData.ca.crt`); `internal:SrcFile` keeps
the file path and `cdx:crypto:k8sSecretName` the secret's name. `tls.key` is
never read. A malformed document in a multi-document file does not hide the
others.

**One certificate, several producers.** A certificate found by more than one
producer (disk, observed TLS, container) is one component whose
`cdx:crypto:sourceType` property is repeated, one entry per producer, sorted
and deduplicated. `$hasProp($, 'cdx:crypto:sourceType', 'observed-tls')` and
`$propValues($, 'cdx:crypto:sourceType')` see every value; `$prop` returns the
first.

## Audit rules

`--bom-audit --bom-audit-categories cbom` runs:

| Rule                | Fires when                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CBC-001`/`CBC-002` | a certificate expired, or expires within 30 days. A date-only `notValidAfter` (`2026-01-31`) is valid through the end of that day in UTC; values that do not parse are skipped |
| `CBC-003`           | a certificate or key's SPKI SHA-256 is one of the eight Go-distrusted hashes                                                                                                   |
| `CBC-004`           | a certificate was issued under a Go-distrusted key (`issuerSpkiSha256` or `authorityKeyId` match)                                                                              |
| `CBC-005`           | a CA certificate whose key and signature are both classical stays valid past 2035-01-01 (NIST IR 8547 final, Tables 2 and 4)                                                   |
| `CBC-006`           | a post-quantum key certified with a classical signature                                                                                                                        |
| `CBC-007`           | an algorithm named only by its dotted OID (composite or pre-standard)                                                                                                          |

`GO-TLS-001` (category `go-security`) flags Go binaries built with unpatched
toolchains. Bring your own deny list with
`--bom-audit-rules-dir <dir>`: copy `data/rules/cbom-security.yaml`, append
your SPKI hashes to the `$deny` arrays, and see
`docs/cbom-custom-spki-denylist.yaml` for a documented example.

At `--spec-version 2.0` the certificate, key and signature algorithms of these
scans also get post-quantum migration risks in `risks.risks[]` (NIST IR 8547
Tables 2, 4 and 8), and an RSA key under 2048 bits or an EC key under 224 bits
gets a `below-minimum-strength` risk; see
[CDX_CONVERT.md](CDX_CONVERT.md#post-quantum-migration-risks).

The PHP counterpart is `PHP-RCE-001`/`PHP-RCE-002` (category
`php-security`). Each source-built `php`, `php-fpm`, `php-cgi`, `phpdbg`,
`libphp*.so` or `frankenphp` file component that no package manager owns
carries `cdx:php:buildVersion`, `cdx:php:buildVersionSource` and
`cdx:php:sapi` in container, rootfs and OS (`obom`) scans, and depends on a
`pkg:generic/php@<version>` platform component with a CPE. PHP that a package
manager owns is identified by its package and carries none of these:

```bash
jq -r '.components[] | select((.properties // [])[] | select(.name=="cdx:php:buildVersion"))
  | [.name, ([.properties[] | select(.name=="cdx:php:buildVersion")][0].value)] | @tsv' bom.json
```

See `docs/BOM_AUDIT.md` for the fixed releases and the CLI/web split.

## Post-quantum certificates

ML-DSA (RFC 9881), SLH-DSA (RFC 9909) and ML-KEM (RFC 9935) keys and
signatures are named from their OIDs — `ML-DSA-65`, `SLH-DSA-SHA2-128s`,
`ML-KEM-768` — never from what the local toolchain happens to print for an
algorithm it may not know. Unknown algorithms (composite ML-DSA,
pre-standard OQS OIDs) keep their dotted OID as the name, and CBC-007 reports
them.

## Limitations

- **TLS 1.3 chains cannot be observed passively.** The Certificate message is
  encrypted. Observed chains come from TLS ≤ 1.2 connections only.
- **DER-embedded certificates are out of scope.** PEM blocks embedded in
  binaries are found by trustinspector's opt-in `--embedded` scan; raw DER
  blobs are not.
- **The Node fallback parser** (used when the trustinspector plugin is absent
  or predates report-2) derives subject, issuer, validity, serial, SPKI hash,
  signature/key OIDs and SKI/AKI from a bounded DER walk, but does not emit
  key-usage bits, path length or EKU names, and cannot read PKCS#7, JKS or
  PKCS#12 containers (they appear as `keystoreReadable=false`).
- **JKS integrity is not verified.** trustinspector reads trusted-certificate
  entries without checking the store digest; the docs of the helper say so.

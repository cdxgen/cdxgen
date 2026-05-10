# Trust enrichment BOM diff examples

This page shows compact **before → after** excerpts for the new trust-oriented enrichments added by the `trivy-cdxgen-*` and `trustinspector-cdxgen-*` helpers.

Use it when you want a quick visual answer to: **what materially changes in the BOM once the new helpers are present?**

## 1) Container / rootfs example

### Before

A conventional rootfs SBOM already contains OS packages, but it typically does **not** expose package trust state, repository trust anchors, or helper provenance.

```json
{
  "metadata": {
    "tools": {
      "components": [
        {
          "name": "trivy",
          "version": "0.67.2"
        }
      ]
    }
  },
  "components": [
    {
      "type": "library",
      "name": "bash",
      "purl": "pkg:deb/debian/bash@5.2.15-2+b9?distro=debian-12"
    }
  ]
}
```

### After

```diff
@@ metadata.tools.components
   {
     "name": "trivy",
     "version": "0.67.2"
   },
+  {
+    "type": "application",
+    "name": "trustinspector",
+    "version": "2.1.0",
+    "purl": "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
+    "hashes": [
+      {
+        "alg": "SHA-256",
+        "content": "<helper sha256>"
+      }
+    ]
+  }
@@ components[name=bash].properties
+  { "name": "PackageArchitecture", "value": "amd64" },
+  { "name": "PackageSource", "value": "bash-src" },
+  { "name": "PackageStatus", "value": "install ok installed" }
@@ components[name=bash]
+  "supplier": { "name": "Debian Bash Maintainers <bash@example.test>" },
+  "authors": [
+    { "name": "Debian Bash Maintainers", "email": "bash@example.test" }
+  ]
@@ components
+  {
+    "type": "data",
+    "name": "deb.debian.org/debian",
+    "purl": "pkg:generic/os-repository/deb.debian.org%2Fdebian@bookworm?...",
+    "properties": [
+      { "name": "SrcFile", "value": "/etc/apt/sources.list.d/debian.sources" },
+      { "name": "cdx:os:repo:type", "value": "apt" },
+      { "name": "cdx:os:repo:url", "value": "https://deb.debian.org/debian" },
+      { "name": "cdx:os:repo:enabled", "value": "true" },
+      { "name": "cdx:os:repo:signedBy", "value": "/usr/share/keyrings/debian-archive-keyring.gpg" }
+    ]
+  },
+  {
+    "type": "cryptographic-asset",
+    "name": "debian-archive-keyring.gpg",
+    "cryptoProperties": {
+      "assetType": "related-crypto-material",
+      "relatedCryptoMaterialProperties": {
+        "type": "public-key",
+        "state": "active"
+      }
+    },
+    "properties": [
+      { "name": "SrcFile", "value": "/usr/share/keyrings/debian-archive-keyring.gpg" },
+      { "name": "cdx:crypto:trustDomain", "value": "apt" },
+      { "name": "cdx:crypto:fingerprint", "value": "<fingerprint>" },
+      { "name": "cdx:crypto:algorithm", "value": "RSA" },
+      { "name": "cdx:crypto:keyStrength", "value": "4096" },
+      { "name": "cdx:crypto:keyId", "value": "<key id>" },
+      { "name": "cdx:crypto:userId", "value": "Debian Archive Automatic Signing Key <ftpmaster@debian.org>" }
+    ]
+  },
+  {
+    "type": "cryptographic-asset",
+    "name": "ca-certificates.crt",
+    "cryptoProperties": {
+      "assetType": "certificate"
+    },
+    "properties": [
+      { "name": "cdx:crypto:trustDomain", "value": "ca-store" },
+      { "name": "cdx:crypto:isCA", "value": "true" },
+      { "name": "cdx:crypto:expiresAt", "value": "2034-06-28T12:00:00Z" }
+    ]
+  }
```

### What changed?

- `metadata.tools` now records **which packaged helper binary** supplied trust metadata.
- OS package components gain package-manager trust context such as maintainer, source package, vendor, architecture, and status.
- Repo source components become explicit `type: data` entries.
- Keyrings and CA bundles become first-class `cryptographic-asset` components instead of remaining opaque files.

## 2) macOS OBOM example

```diff
@@ components[name=Calculator].properties
+{ "name": "cdx:darwin:codesign:identifier", "value": "com.apple.calculator" }
+{ "name": "cdx:darwin:codesign:teamIdentifier", "value": "Software Signing" }
+{ "name": "cdx:darwin:codesign:authority", "value": "Software Signing" }
+{ "name": "cdx:darwin:notarization:assessment", "value": "accepted" }
+{ "name": "cdx:darwin:notarization:source", "value": "Notarized Developer ID" }
@@ components
+{
+  "type": "data",
+  "name": "gatekeeper-system-policy",
+  "purl": "pkg:generic/host-trust/gatekeeper-system-policy@observed?kind=darwin-gatekeeper-status",
+  "properties": [
+    { "name": "cdx:darwin:gatekeeper:status", "value": "assessments enabled" }
+  ]
+}
```

## 3) Windows OBOM example

```diff
@@ components[name=powershell.exe].properties
+{ "name": "cdx:windows:authenticode:status", "value": "Valid" }
+{ "name": "cdx:windows:authenticode:isOSBinary", "value": "true" }
+{ "name": "cdx:windows:authenticode:signerSubject", "value": "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" }
+{ "name": "cdx:windows:authenticode:signerThumbprint", "value": "<thumbprint>" }
@@ components
+{
+  "type": "data",
+  "name": "wdac-active-policies",
+  "purl": "pkg:generic/host-trust/wdac-active-policies@0?kind=windows-wdac-status",
+  "properties": [
+    { "name": "cdx:windows:wdac:activePolicyCount", "value": "0" }
+  ]
+}
```

## 4) Quick review checklist

When diffing BOMs before/after the new enrichments, look for these high-signal additions:

- `metadata.tools.components[*].name == "trustinspector"`
- `PackageArchitecture`, `PackageSource`, `PackageStatus`
- native component origin fields such as `supplier`, `manufacturer`, and `authors`
- `cdx:os:repo:*` repository provenance keys
- `cdx:crypto:*` trust-anchor and certificate properties
- `cdx:darwin:codesign:*`, `cdx:darwin:notarization:*`, `cdx:darwin:gatekeeper:*`
- `cdx:windows:authenticode:*`, `cdx:windows:wdac:*`

## 5) Suggested local diff workflow

Generate a current BOM, then compare it against an older BOM or an earlier cdxgen release to isolate the new trust signals.

```bash
jq -S . old-bom.json > /tmp/old-bom.sorted.json
jq -S . new-bom.json > /tmp/new-bom.sorted.json
diff -u /tmp/old-bom.sorted.json /tmp/new-bom.sorted.json | less
```

For Windows PowerShell:

```powershell
Get-Content old-bom.json | ConvertFrom-Json | ConvertTo-Json -Depth 100 | Set-Content $env:TEMP\old-bom.sorted.json
Get-Content new-bom.json | ConvertFrom-Json | ConvertTo-Json -Depth 100 | Set-Content $env:TEMP\new-bom.sorted.json
Compare-Object (Get-Content $env:TEMP\old-bom.sorted.json) (Get-Content $env:TEMP\new-bom.sorted.json)
```

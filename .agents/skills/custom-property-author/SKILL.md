---
name: custom-property-author
description: "Guides defining and emitting new CycloneDX cdx: custom properties in cdxgen output, enforcing namespacing, safe value shapes (booleans, counts, categories instead of raw secrets, URLs, or commands), and the mandatory docs/CUSTOM_PROPERTIES.md documentation gate. Use when adding, changing, or reviewing cdx: or internal: properties on components, metadata, services, or evidence."
---

# Custom property author

Use this skill when adding or changing any `cdx:*` (or `internal:*`) property emitted into BOM output. The full property inventory and policy guidance is [docs/CUSTOM_PROPERTIES.md](../../../docs/CUSTOM_PROPERTIES.md).

## Gate 0: prefer standard CycloneDX fields first

A custom property is a last resort. Before adding one, check whether the data fits a standard field:

- `supplier`, `manufacturer`, `authors`, `publisher` — entity data
- `externalReferences` — URLs
- `evidence.identity`, `evidence.occurrences` — where a component was found
- `pedigree` — lineage
- `hashes` — digests (never a property)
- `licenses`, `scope` — licensing and dependency scope
- `modelCard`, `formulation`, `component.data` — AI/ML data

If a standard field works, use it. If a custom property is still necessary, it needs a clear namespace and a narrow purpose.

## Gate 1: naming

- New properties use the `cdx:<ecosystem-or-context>:<field>` convention (e.g. `cdx:npm:hasInstallScript`, `cdx:github:workflow:triggers`).
- Legacy unnamespaced properties were migrated to the `internal:` prefix; do not add new unnamespaced properties, and treat `internal:*` as unstable implementation detail.
- `oci:` and `java:modules` keep their existing namespaces for historical reasons.

## Gate 2: value hygiene

Treat every value as potentially secret-bearing. CycloneDX serializes all property values as strings.

| Emit | Do NOT emit |
|---|---|
| Booleans: `credentialExposure=true` | Raw tokens, passwords, API keys, cookies, session IDs, private keys |
| Counts: `credentialIndicatorCount=3` | Raw environment variable values or command-line arguments |
| Categories/field labels: `header:Authorization` | The actual header/parameter values |
| Safe URL derivatives: scheme, host, basename | URLs with query strings, fragments, userinfo, or signature params (`token`, `sig`, `X-Amz-Signature`, `api_key`, …) |
| Redacted markers or executable name only | Full command lines, generated source contents, embedded file contents |

Value shapes already in use (keep consistent): booleans as `"true"`/`"false"`, numbers as decimal strings, component-level lists comma-separated, BOM-level metadata lists newline-separated, timestamps as ISO 8601, structured payloads as JSON-serialized strings.

## Gate 3: documentation (build-breaking)

`lib/customProperties.poku.js` scans every string literal matching `cdx:...` in non-test `lib/**/*.js` and fails the build if the property is absent from `docs/CUSTOM_PROPERTIES.md`. When adding a property:

1. Add it to the appropriate property-family table (or inventory section) in `docs/CUSTOM_PROPERTIES.md`, with the value shape and a policy-readiness label (hard deny / warning / context only).
2. Add or extend a test asserting the new property is emitted as expected **and** that secrets are not copied into it.
3. If the property creates an analyst pivot, check companion surfaces that stay aligned: BOM audit rules in `data/rules/*.yaml`, `docs/BOM_AUDIT.md`, and `bin/repl.js` commands.

## Review quick-check

- Unnamespaced or new `internal:` property? Reject.
- Duplicates a standard CycloneDX field? Move to the standard field.
- Host-specific, non-reproducible, absolute local paths? Reject or redact.
- Structured data packed into CSV when a structured field exists? Reject.
- Secret-bearing value (even namespaced)? Replace with a count, boolean, host, or enum.

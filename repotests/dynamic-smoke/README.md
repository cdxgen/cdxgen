# dynamic-smoke

Minimal smoke test for dynamic SBOM generation via `tracebom`.

## Manual test

```bash
tracebom --cmd "node --version" -o /tmp/dynamic-smoke.json
```

This should produce a valid CycloneDX JSON file with loaded shared library
components. The exact component list varies by OS and platform.

## What to expect

- A valid CycloneDX 1.6 JSON BOM file
- `metadata.component.name` is derived from the working directory
- `components` array may be empty when the `@cdxgen/safer-exec` binary is not
  installed (graceful fallback)
- When `@cdxgen/safer-exec` is available, loaded shared libraries appear as
  `type: "library"` components with `scope: "required"` and
  `technique: "instrumentation"` evidence

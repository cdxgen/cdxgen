# AI Prompt for New Ecosystem Contributions

This guide helps contributors write a high-signal prompt for an AI agent that is adding support for a new language, package manager, or build ecosystem to cdxgen.

## Objective

A good prompt should make the agent produce a small, reviewable change that follows cdxgen conventions instead of guessing its way through the repository.

## What the prompt should include

| Include this | Why it matters |
|---|---|
| the canonical ecosystem name and any aliases | the agent needs to update `PROJECT_TYPE_ALIASES` and related dispatch code correctly |
| the manifests and lockfiles to detect | helps the agent place parser and discovery logic in the right files |
| whether a native toolchain is required | affects `safeSpawnSync`, container images, secure mode, and CI expectations |
| whether a dependency graph is available | tells the agent whether to wire `dependencies` immediately or start with a flat package list |
| expected purl type and notable qualifiers | avoids incorrect hand-built purls |
| representative real fixtures | keeps the change grounded and testable |
| user-facing limits or prerequisites | ensures docs are honest from the first PR |

## Prompt template

```text
Add support for the <ecosystem> ecosystem in cdxgen.

Requirements:
- Use pure ESM and existing cdxgen conventions.
- Add or update aliases in lib/helpers/utils.js.
- Add parser support in lib/helpers/utils.js or a focused helper module if the logic is large enough.
- Add create<Language>Bom() wiring in lib/cli/index.js.
- Use PackageURL rather than manual purl concatenation.
- Use safeExistsSync / safeSpawnSync instead of raw fs or child-process helpers.
- Thread behavior through the existing options object.
- Add realistic fixtures under test/.
- Add poku coverage for both parser behavior and generator behavior.
- Update docs/PROJECT_TYPES.md and any directly related contributor docs.

Ecosystem details:
- Canonical type: <type>
- Accepted aliases: <aliases>
- Detection files: <manifest and lockfile list>
- Purl type: <purl type>
- Native tool requirement: <yes/no and tool name>
- Graph availability: <full graph / flat list / partial>
- Known limitations: <limitations>

Representative fixtures:
- <fixture 1>
- <fixture 2>
- <fixture 3>

Validation:
- Run the relevant lint and tests after the change.
- Keep the change as small as possible.
```

## Extra instructions that improve results

1. Tell the agent which existing ecosystem is the closest reference implementation.
2. Provide one or two public repositories or lockfiles as concrete examples.
3. Say explicitly whether lockfile-only support is acceptable for the first version.
4. Ask the agent to keep once-per-BOM logic out of `buildBomNSData()`.
5. Ask for docs and tests in the same PR so the review is complete.

## Good prompt example

```text
Add support for the fictional acme ecosystem. Use Cargo support as the closest design reference for lockfile parsing plus generator wiring. Detect acme.lock and acme.toml. Use purl type acme. Start with lockfile-only support if a full dependency graph is not available. Add fixtures under test/, add poku coverage, and document the project type in docs/PROJECT_TYPES.md. Keep the change small and avoid reading process.argv directly.
```

## Related pages

- [Adding Support for a New Language or Ecosystem](ADD_ECOSYSTEM.md)
- [Architecture Overview](ARCHITECTURE.md)
- [Testing Guide](TESTING.md)

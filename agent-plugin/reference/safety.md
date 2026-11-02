# cdxgen safety constraints for agents

These constraints apply to every cdxgen skill in this plugin. They exist because
cdxgen executes real package-manager and container tooling against a user's
project, and several failure modes are silent rather than loud.

## Dry-run first

For any agent-driven run, preview before executing:

```bash
cdxgen /absolute/path/to/project --dry-run --activity-report json
```

The activity report records pending reads plus **blocked** writes, command
execution, temp-directory creation, network access, and BOM submissions. Use
`--activity-report jsonl` for line-oriented automation.

Workflow:

1. Run with `--dry-run`.
2. Summarize the planned reads, writes, commands, and network calls for the user.
3. Ask for permission before rerunning without `--dry-run`.
4. Only execute for real after explicit approval.

## Absolute paths, always

Use absolute paths for both `[path]` and `-o`. Relative paths and paths
containing spaces cause failures in the external build tools cdxgen invokes.

## Dependency installation

`--install-deps` defaults to `true`, which means cdxgen may run the project's
package manager. Never auto-enable it in CI, containers, or air-gapped
environments. Use `--no-install-deps` or `--lifecycle pre-build` instead, and
tell the user when a scan would otherwise install packages.

## Java is only needed on jar-based atom platforms

C, C++, Python, and CBOM source analysis uses the atom companion, which ships
as a native binary needing no JDK on linux-amd64, linux-arm64 (glibc),
linux-amd64-musl, darwin-arm64, and windows-amd64. Only the jar-based triples
(darwin-amd64, windows-arm64, linux-arm64-musl) require Java >= 23, and lower
versions cause **silent freezes or incomplete BOMs**, not error messages. Check
`java -version` on those platforms before blaming cdxgen for a hang or a thin
BOM.

## Secure mode

Under `CDXGEN_SECURE_MODE=true`, cdxgen runs with Node.js permission flags.

- Never run as `root` in secure mode; wildcard FS and child-process grants are rejected.
- Do not grant `--allow-fs-read="*"` or `--allow-fs-write="*"`.
- See <https://cdxgen.github.io/cdxgen/#/PERMISSIONS>.

## Never hand-write purls

Do not construct PackageURL strings in prompts, scripts, or edits. Let cdxgen
resolve component identity. A hand-written purl that looks plausible is worse
than no purl, because it silently poisons downstream matching.

## Configuration precedence

`CLI args` > `CDXGEN_*` env vars > `.cdxgenrc` / `.cdxgen.json` / `.cdxgen.yml` /
`.cdxgen.yaml`. Environment variables must use the `CDXGEN_` prefix, for example
`CDXGEN_TYPE=java`, `CDXGEN_FETCH_LICENSE=true`. Full list:
<https://cdxgen.github.io/cdxgen/#/ENV>.

## Do not mix hardware with software types

Never combine `hbom` / `hardware` with software project types such as `js`,
`java`, `python`, `os`, or `oci` in one run. Generate the HBOM separately.

## Keep host allowlists narrow

For server mode and BOM upload, keep `CDXGEN_ALLOWED_HOSTS` tight. Prefer exact
hosts. Server-side Dependency-Track submission treats a wildcard entry such as
`*.example.com` as real subdomains only, never as a suffix match.

## Review emitted properties before sharing

cdxgen redacts common secret-bearing URL and token patterns, but that is a
mitigation, not a guarantee. Before sharing a BOM externally, inspect emitted
properties, especially on BOMs containing AI/MCP inventory, Chrome extension
metadata, or OS trust inventory.

For Go Evinse/Golem evidence specifically, never surface raw `go:generate`
commands, environment values, HTTP parameter values, key material, plaintext,
ciphertext, embedded file contents, generated source, or secrets. Review through
the emitted `cdx:golem:*` counts, categories, rule IDs, taint kinds, scopes,
call-stack frames, and crypto algorithm/OID pivots instead.

## Output expectations

- Primary output is CycloneDX JSON at the `-o` path. Never assume stdout holds the BOM unless `-o` is omitted.
- Schema validation runs by default; `--no-validate` skips it.
- Exit code `0` means success and validation passed. Non-zero means parse, validation, or execution failure.
- `cdx-audit` exit code `3` means at least one audited target met or exceeded `--fail-severity`.
- Use `-p` for a human-readable table or tree; parse the JSON file programmatically.

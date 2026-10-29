# OWASP cdxgen plugin for Claude Code

Brings the [OWASP cdxgen](https://cdxgen.github.io/cdxgen) toolkit into Claude
Code as a set of Agent Skills. Claude picks the right skill from your request,
then drives the correct cdxgen command with the right flags — including the
safety constraints that keep an agent from installing packages or leaking
secrets on your behalf.

## Install

```bash
claude plugin marketplace add cdxgen/cdxgen
claude plugin install cdxgen@cdxgen-plugins
```

Then run `/reload-plugins` if the install summary asks you to.

## Prerequisites

The plugin ships instructions, not the tool. Install cdxgen itself:

```bash
npm i -g @cdxgen/cdxgen
```

| Requirement | Detail                                                            |
| ----------- | ----------------------------------------------------------------- |
| Node.js     | >= 24                                                             |
| Java        | Only on jar-based atom triples (darwin-amd64, windows-arm64, linux-arm64-musl): >= 23 |
| Container   | `ghcr.io/cdxgen/cdxgen:master` — build tools preinstalled         |

Optional enrichment: `@cdxgen/cdxgen-plugins-bin` (Trivy, osquery, `golem`,
`trustinspector`) and `@cdxgen/cdx-hbom` (hardware collection).

## Skills

| Skill                      | Covers                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `sbom-generate`            | SBOMs from source across 30+ ecosystems; types, profiles, lifecycles, filtering     |
| `container-sbom`           | Container images, OCI archives, rootfs, ASAR, caxa, binaries, k8s/Dockerfiles       |
| `os-hardware-inventory`    | Live OS inventory (`obom`) and host hardware (`hbom`)                               |
| `crypto-bom`               | CBOM: algorithms, certificates, keys, weak-primitive audit                          |
| `ai-bom`                   | AI-BOM, MCP inventory, AI skill files, AI authorship provenance                     |
| `bom-audit`                | `cdx-audit` predictive audit and `--bom-audit` rules; SARIF, license policy         |
| `bom-signing`              | JSF signing and verification; multi-signature and chain modes                       |
| `bom-convert-validate`     | SPDX and cross-version conversion; schema, SCVS, and CRA validation                 |
| `bom-evidence`             | `evinse` occurrence, callstack, reachability, data-flow; Golem (Go), Rusi (Rust)     |
| `runtime-trace-bom`        | `tracebom` dynamic tracing under the safer-exec sandbox                             |
| `bom-explore`              | `cdxi` REPL triage and BOM querying                                                 |
| `dependency-track-upload`  | Dependency-Track and TEA publishing; cdxgen HTTP server mode                        |
| `sbom-fidelity-loop`       | Raise a shallow SBOM to a fully resolved one via `--profile introspect`             |
| `bom-slimmer`              | Shrink dependency footprint using SBOM evidence and license risk                    |

Invoke one directly as `/cdxgen:sbom-generate`, or just describe what you want
and let Claude select.

## Safety posture

Every skill loads [reference/safety.md](reference/safety.md), which encodes the
constraints that matter when an agent runs cdxgen:

- **Dry-run first.** `--dry-run --activity-report json`, summarize, then ask before executing for real.
- **Never auto-install dependencies.** `--install-deps` defaults on; the skills steer to `--no-install-deps` or `--lifecycle pre-build` in CI and containers.
- **Absolute paths only.** Relative paths break the external build tools cdxgen invokes.
- **Never hand-write purls.** A plausible-looking invented purl silently poisons downstream matching.
- **Never surface raw Golem values.** Data-flow output can contain the secrets it found; review through `cdx:golem:*` counts and categories instead.
- **Confirm before publishing.** Uploads to Dependency-Track or TEA are outward-facing actions.
- **Credentials stay out of the transcript.** API keys and signing keys go through the environment, never a pasted value.

Atom's Java failure mode is called out wherever it applies: on the jar-based
triples (darwin-amd64, windows-arm64, linux-arm64-musl), Java below 23 makes
C/C++/Python/CBOM scans freeze or return thin BOMs rather than erroring.
Native-binary platforms need no JDK at all.

## Development

```bash
claude --plugin-dir ./claude-plugin
claude plugin validate ./claude-plugin
```

Run `/reload-plugins` after edits rather than restarting.

The `sbom-fidelity-loop` and `bom-slimmer` skills are copies; `.agents/skills/`
in the repository root is their source of truth. Update them there first, then
copy them here, with `../../../docs/<Name>.md` links rewritten to
`https://cdxgen.github.io/cdxgen/#/<Name>`. A test fails when a copy drifts.

## Links

- Docs: <https://cdxgen.github.io/cdxgen>
- Repository: <https://github.com/cdxgen/cdxgen>
- Issues: <https://github.com/cdxgen/cdxgen/issues>
- OWASP sponsorship: <https://owasp.org/donate/?reponame=www-project-cdxgen&title=OWASP+cdxgen>

## License

Apache-2.0. Copyright OWASP cdxgen contributors.

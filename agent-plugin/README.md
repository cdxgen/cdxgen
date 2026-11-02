# OWASP cdxgen plugin for coding agents

Brings the [OWASP cdxgen](https://cdxgen.github.io/cdxgen) toolkit into a
coding agent as a set of Agent Skills. The agent picks the right skill from your
request, then drives the correct cdxgen command with the right flags, including
the safety constraints that keep an agent from installing packages or leaking
secrets on your behalf.

The folder is an [Agent Plugins](https://agent-plugins.org) package (`plugin.json`,
`skills/`) that also carries a Claude Code manifest. It is meant for Claude Code,
OpenAI Codex, the GitHub Copilot CLI and app, Cursor, Gemini CLI, Kiro and
opencode. Only Claude Code and Codex have been tried so far; the
[installation guide](https://cdxgen.github.io/cdxgen/#/AGENT_PLUGINS) says what
was tested in each client.

## Install

In Claude Code:

```bash
claude plugin marketplace add cdxgen/cdxgen
claude plugin install cdxgen@cdxgen-plugins
```

Then run `/reload-plugins` if the install summary asks you to.

In Codex:

```bash
codex plugin marketplace add cdxgen/cdxgen
codex plugin add cdxgen@cdxgen-plugins
```

For Copilot, Cursor, Gemini CLI, Kiro and opencode, and for how to update and
invoke a skill in each client, see the
[installation guide](https://cdxgen.github.io/cdxgen/#/AGENT_PLUGINS) (in this
repository, [docs/AGENT_PLUGINS.md](../docs/AGENT_PLUGINS.md)).

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

Describe what you want and let the agent select a skill, or invoke one by name.
In Claude Code that is `/cdxgen:sbom-generate`; the guide lists the form for each
client.

`bom-signing` and `dependency-track-upload` are the exceptions: they handle
signing keys and publish to servers, so Claude Code never picks them on its own.
Run them as `/cdxgen:bom-signing` and `/cdxgen:dependency-track-upload`. Other
clients may not honor that setting, so the skills also ask before any upload.

## Agents (Claude Code only)

| Agent                  | Does                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `cdxgen:bom-reviewer`  | Reviews an existing BOM with `cdx-validate`, `cdx-audit --direct-bom-audit` and `cdxi`, without editing files, and returns a short report |

Ask for a review ("have the bom-reviewer check /abs/path/bom.json") and Claude
delegates to it, so the validator and audit output stays out of your
conversation.

## Hooks (Claude Code only)

| Event          | Does                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| `SessionStart` | Warns once if `cdxgen` is not on `PATH`, or is older than the plugin. Never installs anything |
| `PostToolUse`  | Off by default. When enabled, reminds Claude that the SBOM is stale after it edits a lockfile or manifest |

Turn the lockfile reminder on with the plugin's `Lockfile reminder` option in
`/config`. Neither hook sends anything over the network.

## Settings (Claude Code only)

Claude Code asks for these options when the plugin is enabled, and lists them
in `/config`. All of them are optional and none is secret.

| Option                | Used by                                      | Effect                                                              |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `dependency_track_url` | `dependency-track-upload`                   | Suggested `--server-url`; the skill still asks before uploading     |
| `tea_endpoint`        | `dependency-track-upload`                    | Suggested `--tea-publish` endpoint                                  |
| `spec_version`        | `sbom-generate`, `container-sbom`            | Adds `--spec-version` to real runs                                  |
| `runtime`             | `sbom-generate`, `container-sbom`            | `local` for the CLI on `PATH`, `container` for `ghcr.io/cdxgen/cdxgen` |
| `lockfile_reminder`   | Hook                                         | Turns the stale-SBOM reminder on                                    |

The Dependency-Track API key and the TEA token are not options. Claude Code does
not pass sensitive option values to the commands an agent runs, so an upload
could not use them. Set `CDXGEN_*` and `TEA_TOKEN` style variables in your own
shell, as the skills already tell you to.

The skills refer to the options as `${user_config.KEY}`. Only Claude Code
substitutes them; other clients show the text as written, and the skills then
fall back to their defaults.

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
claude --plugin-dir ./agent-plugin
claude plugin validate ./agent-plugin
```

Run `/reload-plugins` after edits rather than restarting.

The shared fields of every manifest (version, description, author, homepage,
repository, license and keywords) are written by
`node contrib/gen-agent-manifests.js` from `package.json` and
`contrib/agent-manifests.template.json`. Edit those, run the script, and commit
the result. `pnpm run check:agent-plugin` fails when a manifest has drifted and
validates `plugin.json` against the vendored Agent Plugins schema. Claude-only
settings such as `userConfig` stay in `.claude-plugin/plugin.json`, which the
script preserves.

The `sbom-fidelity-loop` and `bom-slimmer` skills are copies; `.agents/skills/`
in the repository root is their source of truth. Update them there first, then
copy them here, with `../../../docs/<Name>.md` links rewritten to
`https://cdxgen.github.io/cdxgen/#/<Name>`. A test fails when a copy drifts.

## Evals

`evals/` holds 26 cases for `claude plugin eval`. They check that a plain
request picks the right skill (one case for each skill that Claude may start by
itself except `bom-slimmer`, plus one case each showing that `bom-signing` and
`dependency-track-upload` do not start without their slash command) and that the
rules in [reference/safety.md](reference/safety.md) hold: dry run first, absolute
paths, no installs in CI, no hand-written purls, no secrets or Golem values in
the reply, and a question before any upload.

Run the suite on your own machine, with your own Claude Code login, before a
release and after a skill changes:

```bash
claude plugin eval ./agent-plugin --threshold 0.8 --no-publish
```

There is no selection case for `bom-slimmer`. Asked which small packages could
become built-in code, Sonnet answers with cdxgen commands from its own knowledge
and does not load the skill, whatever its description says.

Every case runs three times with the plugin and three times without it, and
each `llm` grader adds three judge calls, so a full run makes several hundred
model calls on your account. Add `--ablation none` to skip the runs without the
plugin, `--case 'safety-*'` or `--tag selection` to run part of the suite, and
`--max-cost-usd` to cap the spend. Nothing runs in the repository's CI, and no
model API key is stored in its secrets.

The cases do not grant `Bash`, so no cdxgen command runs and no scan happens.
Each prompt asks for the command lines, and the graders read the reply. Under
the default `with-without` mode, the `tool_used: Skill` graders only show that
the plugin fired; the regex and `llm` graders carry the score. Reports go to
`evals/results/`, which git ignores.

## Links

- Docs: <https://cdxgen.github.io/cdxgen>
- Repository: <https://github.com/cdxgen/cdxgen>
- Issues: <https://github.com/cdxgen/cdxgen/issues>
- OWASP sponsorship: <https://owasp.org/donate/?reponame=www-project-cdxgen&title=OWASP+cdxgen>

## License

Apache-2.0. Copyright OWASP cdxgen contributors.

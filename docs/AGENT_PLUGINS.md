# Installing the cdxgen plugin in coding agents

The cdxgen plugin gives a coding agent the 14 cdxgen skills: SBOM generation, container and rootfs scans, OBOM and HBOM, CBOM, AI-BOM, auditing, signing, validation, conversion, evidence, runtime tracing, Dependency-Track upload and more. The skills tell the agent which command and flags to use, and they carry the safety rules in [`reference/safety.md`](https://github.com/cdxgen/cdxgen/blob/master/agent-plugin/reference/safety.md): a dry run first, absolute paths, no package installs in CI, and no secrets in the transcript.

The plugin lives in [`agent-plugin/`](https://github.com/cdxgen/cdxgen/tree/master/agent-plugin). It ships instructions, not the tool, so install cdxgen too (`npm install -g @cdxgen/cdxgen`, or one of the other methods in the README). The skills are plain [Agent Skills](https://agentskills.io/specification), and the plugin has a root `plugin.json` in the [Agent Plugins](https://agent-plugins.org) format, so one folder serves every client below.

## How far each client has been tested

A client marked "not yet tested" should load the plugin according to its own documentation, but the project has not confirmed it. Please open an issue if you try one, whether it works or not.

| Client              | Status                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code         | Loads the plugin from a directory and passes `claude plugin validate --strict`. Installing from the GitHub marketplace is not yet tested. |
| Codex               | Adds the marketplace and installs the plugin from a local checkout (Codex 0.137.0). Skill invocation is not yet tested.      |
| Copilot CLI and app | Not yet tested                                                                                                                 |
| Cursor              | Not yet tested                                                                                                                 |
| Gemini CLI          | Not yet tested                                                                                                                 |
| Kiro                | Not yet tested                                                                                                                 |
| opencode            | Lists all 14 skills when its `skills` setting points at the skills folder (opencode 1.19.0). Skill invocation is not yet tested. |

## Claude Code

Install:

```shell
claude plugin marketplace add cdxgen/cdxgen
claude plugin install cdxgen@cdxgen-plugins
```

Run `/reload-plugins` if the install summary asks for it. Update with `claude plugin marketplace update cdxgen-plugins` followed by `claude plugin update cdxgen@cdxgen-plugins`.

Invoke a skill by describing the task, or by name as `/cdxgen:sbom-generate`. `bom-signing` and `dependency-track-upload` run only when you type their slash command, `/cdxgen:bom-signing` and `/cdxgen:dependency-track-upload`.

Only Claude Code has these parts of the plugin:

- the `cdxgen:bom-reviewer` agent, a read-only reviewer for an existing BOM
- the `SessionStart` hook that warns when `cdxgen` is missing or older than the plugin, and the optional lockfile reminder hook
- the `userConfig` options (Dependency-Track URL, TEA endpoint, default spec version, preferred runtime), which Claude Code asks for when the plugin is enabled and substitutes into the skills as `${user_config.KEY}`

## Codex

Install from the terminal:

```shell
codex plugin marketplace add cdxgen/cdxgen
codex plugin add cdxgen@cdxgen-plugins
```

Codex reads `.agents/plugins/marketplace.json` in the repository. The Codex app lists the same marketplace in its Plugins Directory. Update with `codex plugin marketplace upgrade cdxgen-plugins`.

Invoke a skill by naming it with a dollar sign, for example `$sbom-generate`, or describe the task and let Codex choose. The `$name` form is from the Codex documentation and has not been tried with this plugin.

Codex ignores the hooks, the `bom-reviewer` agent and `userConfig`. The skills then read `${user_config.KEY}` as plain text and fall back to their defaults. The plugin directory still contains a `hooks/` folder, and OpenAI's public plugin directory does not accept plugins with lifecycle hooks, so the project has not submitted the plugin there.

## GitHub Copilot CLI and app

Copilot CLI reads the Agent Plugins `plugin.json` at the plugin root first, and it also reads Claude marketplaces. According to the [plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference), either of these installs the plugin:

```shell
copilot plugin marketplace add cdxgen/cdxgen
copilot plugin install cdxgen@cdxgen-plugins
```

```shell
copilot plugin install cdxgen/cdxgen:agent-plugin
```

Update with `copilot plugin update cdxgen`. In a session, name a skill after a slash, as in "Use the /sbom-generate skill to ...", and check what loaded with `/skills list`. The Copilot app installs plugins the same way, but the project has not tried it.

Not yet tested. The plugin's hooks, `bom-reviewer` agent and `userConfig` are Claude Code only.

## Cursor

Cursor loads plugins that follow the Agent Plugins format, and its [plugins reference](https://cursor.com/docs/reference/plugins.md) describes a multi-plugin repository with `.cursor-plugin/marketplace.json` at its root, which this repository has. Plugins are installed and managed from Cursor's Customize page. The project has not yet worked out the exact steps for importing this repository, or for updating it, and the plugin is not listed in the Cursor Marketplace.

Describe the task in the agent chat. Not yet tested. The hooks, the `bom-reviewer` agent and `userConfig` do not apply.

## Gemini CLI

Gemini CLI installs an extension from a directory that holds `gemini-extension.json` and a `skills/` folder, which is `agent-plugin/` here. From a checkout of the repository:

```shell
gemini extensions install ./agent-plugin
```

Update with `gemini extensions update cdxgen` after you pull. Installing the repository by its GitHub URL does not work yet, because Gemini CLI looks for `gemini-extension.json` in the repository root and the skills are one folder down. Gemini CLI documents `skills/` in an extension as the place for skills; describe the task or name the skill. Not yet tested. The hooks, the `bom-reviewer` agent and `userConfig` do not apply.

## Kiro

Kiro installs plugins as powers and reads the Agent Plugins `plugin.json`. In the IDE, open the Powers panel and import the power from a local path to `agent-plugin` in a checkout of the repository. In Kiro CLI, the local-path form is `kiro-cli powers install /absolute/path/to/agent-plugin`. According to the [Kiro documentation](https://kiro.dev/docs/powers/installation/), update a power from the Powers panel with Check for updates, and Kiro activates an installed power when a prompt matches its keywords.

Not yet tested. Importing by the repository's GitHub URL does not work, because the repository root has no `plugin.json`. The hooks, the `bom-reviewer` agent and `userConfig` do not apply.

## opencode

opencode does not look inside plugin folders. It reads skills from `.opencode/skills/`, `.claude/skills/` and `.agents/skills/`, in the project and in your home directory, and from the paths in its `skills` setting. Point that setting at the plugin's skills folder in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "skills": ["/absolute/path/to/cdxgen/agent-plugin/skills"]
}
```

`opencode debug skill` then lists all 14 skills. Update by pulling the checkout. opencode loads skills on demand through its skill tool, so describe the task or ask for the skill by name. The skills link to `../../reference/safety.md`, so keep the `reference/` folder beside `skills/`. The hooks, the `bom-reviewer` agent and `userConfig` do not apply.

## Differences between clients

| Part of the plugin            | Claude Code | Other clients                                              |
| ----------------------------- | ----------- | ---------------------------------------------------------- |
| 14 skills                     | yes         | yes                                                        |
| `reference/safety.md`         | yes         | yes, as a file the skills link to                          |
| `bom-signing` and `dependency-track-upload` only on request | yes, through `disable-model-invocation` | not known; a client that ignores the setting may let the agent choose them itself |
| `bom-reviewer` agent          | yes         | no                                                         |
| `SessionStart` and lockfile hooks | yes     | no                                                         |
| `userConfig` options          | yes         | no, the skills fall back to their defaults                 |

Where a client does not honor the user-only setting, the skills still tell the agent to confirm the destination before any upload and never to ask for, print or write a key.

## Keeping the manifests in step

`node contrib/gen-agent-manifests.js` writes the shared fields of every manifest from `package.json` and one template, and `pnpm run check:agent-plugin` fails when a file has drifted. The files are `agent-plugin/.claude-plugin/plugin.json`, `agent-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.cursor-plugin/marketplace.json` and `agent-plugin/gemini-extension.json`.

To run the plugin from a CI job, see [Running cdxgen through coding agents in CI](AGENT_CI.md).

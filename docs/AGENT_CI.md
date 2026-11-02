# Running cdxgen through coding agents in CI

A coding agent can run cdxgen unattended in GitHub Actions. This page explains four example workflows that you copy into your own repository, and why each setting in them is there. The workflows are in [`docs/agent-ci/`](https://github.com/cdxgen/cdxgen/tree/master/docs/agent-ci). They are examples, not part of cdxgen's own CI: the cdxgen project does not run them and keeps no model API keys in its repository secrets.

If you only need a BOM, run `cdxgen` directly in your workflow. An agent is worth the cost when you want it to choose the project type, read the dry-run report, or write a summary, and you accept that a model call is part of the job.

| Recipe                                                                                                                          | Agent       | How it runs                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| [`claude-code-action.yml`](https://github.com/cdxgen/cdxgen/blob/master/docs/agent-ci/claude-code-action.yml)                   | Claude Code | `anthropics/claude-code-action`, plugin installed from the marketplace |
| [`claude-headless.yml`](https://github.com/cdxgen/cdxgen/blob/master/docs/agent-ci/claude-headless.yml)                         | Claude Code | `claude -p` with `--plugin-dir`, fails when the plugin did not load  |
| [`codex-action.yml`](https://github.com/cdxgen/cdxgen/blob/master/docs/agent-ci/codex-action.yml)                               | OpenAI Codex | `openai/codex-action`, skills copied into the Codex home directory   |
| [`codex-exec.yml`](https://github.com/cdxgen/cdxgen/blob/master/docs/agent-ci/codex-exec.yml)                                   | OpenAI Codex | `codex exec --json`                                                  |

## Status

None of these recipes has been run by the cdxgen project yet. They were checked with `actionlint` and against the documentation and `action.yml` files cited below, and the `plugin_errors` check in the `claude -p` recipe was tried locally against a deliberately broken plugin. Treat the first run in your repository as a test, with a small `timeout-minutes` and a spending limit on the API key.

| Recipe                  | Last run by hand | Action or CLI version | Date |
| ----------------------- | ---------------- | --------------------- | ---- |
| `claude-code-action.yml` | not yet run      | claude-code-action v1.0.266 | none |
| `claude-headless.yml`    | not yet run      | Claude Code 2.1.299   | none |
| `codex-action.yml`       | not yet run      | codex-action v1.13    | none |
| `codex-exec.yml`         | not yet run      | Codex CLI 0.137.0     | none |

The recipes install cdxgen 13.7.0 and fetch the plugin from the `v13.7.0` tag, the release that moves the plugin to the `agent-plugin/` folder. If that release is not out when you read this, use the newest release and a matching tag, and check that the tag has `agent-plugin/` in it.

## What every recipe does

**Permissions.** The workflow sets `permissions: {}` and the job asks for `contents: read` only. The agent cannot push, comment or open pull requests with that token. The workflows start only on `workflow_dispatch`, so the prompt is fixed and nobody can inject text into it through a pull request, an issue or a comment. Do not move the key into a `pull_request_target` workflow or a workflow that a fork can start.

**A pinned cdxgen.** The `npm install` step names an exact version in `CDXGEN_VERSION` and passes `--ignore-scripts`. Never write `latest`: a scan whose tool changed between two runs is hard to compare. The same holds for the agent: each action is pinned by commit SHA with its tag in a comment, and the CLI-based recipes pin the npm version of the agent as well. If you prefer a binary over npm, download a release asset and check its `.sha256` file as the [README](https://github.com/cdxgen/cdxgen#standalone-executables-recommended) describes.

**No installs, absolute paths.** The prompt tells the agent to run `cdxgen --dry-run --activity-report json` first and to scan only with `--no-install-deps` and absolute paths. These are rules from the plugin's `reference/safety.md`. An agent that is allowed to install packages on a runner can run a project's install scripts with the runner's credentials. Use `--lifecycle pre-build` instead of `--no-install-deps` if you want cdxgen to read manifests only.

**Approval in advance.** The safety rules tell an agent to ask before it runs a real scan. Nobody answers in CI, so the prompt gives the approval for one scan and sets the condition: stop if the dry-run report shows installs, network access beyond package registries, or writes outside the workspace. Change that text to fit your policy. The tool allowlist (`Bash(cdxgen:*)` for Claude Code, the `:workspace` permission profile for Codex) limits what the agent can run even if it ignores the prompt.

**Credentials.** The only credential is your own model key, read from a repository secret (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) and passed to the step that needs it, never as a job-wide variable. The prompt tells the agent not to print environment variables. Leave `show_full_output` off in the Claude action, because full output includes tool results. No Dependency-Track or TEA key appears in any recipe, and none of them uploads a BOM to a server.

**Outputs.** Each workflow uploads `bom.json` as an artifact for seven days and writes the agent's final message to the job summary. Look at the BOM before you share it: it can contain configuration and host details.

## Claude Code with claude-code-action

`claude-code-action.yml` uses these inputs. They come from the `action.yml` of [anthropics/claude-code-action v1.0.266](https://github.com/anthropics/claude-code-action/blob/d535f5172dec02b204866b393d6b20b9b2aaf98d/action.yml), pinned to that commit. The `v1` tag pointed at the same commit when the recipe was written.

| Input                                 | Value                                         | Why                                                                                                |
| ------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `anthropic_api_key`                   | `secrets.ANTHROPIC_API_KEY`                   | Your own key. The action also accepts an OAuth token or cloud provider settings.                   |
| `github_token`                        | `github.token`                                | Uses the job's read-only token instead of asking the action for an app token, so the job asks for no `id-token: write`. Whether the action works with that token in your repository has not been tested. |
| `plugin_marketplaces`                 | `https://github.com/cdxgen/cdxgen.git`        | Newline-separated marketplace Git URLs. The marketplace is `cdxgen-plugins`.                       |
| `plugins`                             | `cdxgen@cdxgen-plugins`                       | Newline-separated plugin names to install.                                                         |
| `prompt`                              | the text in the workflow                      | Makes the action run the prompt directly instead of waiting for an `@claude` mention.              |
| `claude_args`                         | `--max-turns 20`, `--allowedTools "..."`      | Passed to the Claude CLI. The tool list allows the Skill tool, read-only file tools and `cdxgen` commands, and nothing else. |
| `display_report`                      | `"true"`                                      | Writes the Claude report to the job summary. The action warns that this puts model-written text in the summary, so keep it to workflows you trigger yourself. |

The marketplace URL has no ref, so the action installs the plugin from the default branch of the cdxgen repository. If you need the plugin pinned as well, use `claude-headless.yml`, which fetches a tag.

## claude -p

`claude-headless.yml` installs a pinned Claude Code and runs it with `--plugin-dir` pointing at a checkout of the plugin. Three details matter:

- `claude plugin validate --strict` runs first. It reads files only and needs no API key, so a broken plugin fails before any model call.
- The run uses `--output-format stream-json --verbose`, not `--output-format json`. Only the stream carries the `system/init` event, which lists `plugins` and, when something failed to load, `plugin_errors`. With `--output-format json` the job gets only the final result and cannot see a plugin that failed to load. Anthropic documents `-p` in the [headless guide](https://code.claude.com/docs/en/headless.md).
- The check step fails the job when `plugin_errors` is non-empty or `cdxgen` is not in `plugins`. It runs even when the agent step failed, so the cause shows up in the log.

## OpenAI Codex with codex-action

`codex-action.yml` uses these inputs from [openai/codex-action v1.13](https://github.com/openai/codex-action/blob/bdf19a4a223ec2549a3e2274a0cf61556bc07675/action.yml), pinned to that commit. Its [README](https://github.com/openai/codex-action/blob/bdf19a4a223ec2549a3e2274a0cf61556bc07675/README.md) describes the safety strategy and the permission profiles.

| Input                | Value                         | Why                                                                                                         |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `openai-api-key`     | `secrets.OPENAI_API_KEY`      | Your own key. The action keeps it in a local proxy, so Codex does not hold it.                              |
| `codex-version`      | `0.137.0`                     | Installs an exact `@openai/codex`.                                                                          |
| `codex-home`         | `$RUNNER_TEMP/codex-home`     | A trusted Codex home. A previous step puts the cdxgen `skills/` and `reference/` folders there, because the skills link to `../../reference/safety.md`. |
| `permission-profile` | `:workspace`                  | Allows writes inside the workspace and temporary directories only. Use `:read-only` if cdxgen should only print to the log. Mutually exclusive with `sandbox`. See [Codex permissions](https://developers.openai.com/codex/permissions). |
| `safety-strategy`    | `drop-sudo` (the default)     | Removes `sudo` from the runner user before Codex starts. The README says to run the action as the last step that needs privileges, and to use disposable runners. The steps after it only upload files and write the summary. |
| `prompt`             | the text in the workflow      | The task, as for Claude.                                                                                    |

The action returns the agent's last message as the `final-message` output. The recipe passes it to the summary step through an environment variable, so a message with shell syntax in it is written as text and not run.

Whether sandboxed commands can reach the network is set by the profile's network settings, which the Codex permissions page describes. With `--no-install-deps` cdxgen reads the lock files and manifests in the checkout, but if it also needs registry lookups, define a named profile in `codex-home/config.toml` that allows them and select it instead of `:workspace`.

## OpenAI Codex with codex exec

`codex-exec.yml` installs `@openai/codex` at a pinned version and runs `codex exec --json --ephemeral` with `-c 'default_permissions=":workspace"'`. The JSON Lines stream has `error` and `turn.failed` events, and the next step fails the job when it finds one. `--output-last-message` writes the final message to a file that goes to the job summary. The `default_permissions` override follows the permissions page and has not been tried with this CLI version. The [non-interactive guide](https://developers.openai.com/codex/noninteractive.md) lists the events and the flags.

Prefer the action on GitHub-hosted runners. The Codex documentation says the action reduces API key exposure by starting a proxy, and that a key set for `codex exec` can be read by any code that runs in the same environment. The `codex exec` recipe sets `CODEX_API_KEY` on the single step that runs Codex, as that guide advises, and it does not call `codex login`, so no `auth.json` is written to the runner. It does not apply the action's `drop-sudo` protections. Use it where you cannot use the action, for example on another CI system after you adapt the syntax.

## Not covered

The GitHub Copilot cloud agent has no recipe yet. It needs the cdxgen MCP server that [#4656](https://github.com/cdxgen/cdxgen/issues/4656) tracks, and a recipe will follow that work.

## Adapting a recipe

Before you copy one, change these values:

- Set `CDXGEN_VERSION`, and the agent version, to releases you have chosen. Keep the plugin tag or commit in step with the cdxgen version.
- Replace `workflow_dispatch` with another trigger only if the prompt stays fixed and only people you trust can start it.
- Add a Dependency-Track or other upload step in your own job, with its own secret, if you want one. The recipes leave it out on purpose.
- Keep `timeout-minutes` and `--max-turns` low, and put a spending limit on the model key.

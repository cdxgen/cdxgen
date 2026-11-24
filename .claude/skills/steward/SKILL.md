---
name: steward
description: House rules for PR Steward and /steward watches in the cdxgen repository
user-invocable: false
disable-model-invocation: true
---

# Looking after a cdxgen pull request

Read `AGENTS.md` at the repository root first. Its rules apply to every
commit you push, and the commit hooks that enforce them on a maintainer's
machine do not run where you work.

## What to work on

- Failing required checks: `lint`, `boundaries`, `unit-tests`,
  `quick-tests`, `golden-tests`, `rust-fetch-tests`,
  `cli-tests-quick-amd64`, `cli-tests-quick-arm64` and the two CodeQL
  `Analyze` jobs.
- Merge conflicts with `master`.
- Important findings from Code Review, and small review requests that say
  which change to make.
- Leave design-level review comments to the author. Reply with what you
  would change, and do not push or resolve the thread.

## How to check your work

- Install with
  `pnpm install --config.strict-dep-builds=true --frozen-lockfile --package-import-method copy`.
  Never use `npm` or `yarn`.
- Run `pnpm run lint` before each push. It formats and fixes in place.
- Run `node contrib/check-boundaries.js --strict`. It must report zero
  cycles and zero violations.
- Run the poku file next to the module you changed, for example
  `pnpm exec poku lib/helpers/utils.poku.js`, before the full `pnpm test`.
- When an exported function or its JSDoc changes, run `pnpm run gen-types`
  and commit the regenerated `types/` with the change.

## What not to do

- Do not edit files under `types/` by hand.
- Do not change `pnpm-lock.yaml` unless the pull request changes
  dependencies in `package.json`. Do not bump dependency versions.
- Do not regenerate the expected BOMs under `test/repotests/*/expected/` to
  make `golden-tests` pass. A golden diff means the output changed: fix the
  code, or say in a comment that the output change needs the author's
  decision.
- Do not edit `.github/`, `contrib/check-*.js`, `contrib/golden-runner.js`,
  `biome.json`, `.claude/` or `AGENTS.md` to make a check pass.
- Do not skip, delete or loosen a test to make it pass. A flaky test gets
  one re-run; after that, report it.

## Commit messages and comments

- Write the subject as a plain sentence in the imperative or present tense,
  in the style of `git log`, with no `type:` prefix.
- Do not use em-dashes, emojis or words from the banned list in
  `AGENTS.md`, and do not write "I", "me" or "my".
- Say what changed and why, and name the file, check or command.
- Code comments describe the code as it is now, never the review or the
  fix that led to it.
- Do not add `Reported-by` or `Helped-by` trailers. The author adds credit
  lines.

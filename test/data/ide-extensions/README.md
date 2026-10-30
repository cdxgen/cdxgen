# IDE extension fixtures

These folders are home directories and extension folders laid out the way VS
Code-family editors write them. The tests in `lib/helpers/vsixutils.ide.poku.js`,
`lib/helpers/agenticToolutils.poku.js` and `lib/stages/postgen/auditBom.poku.js`,
and the "installed IDE extension folders" step of `repotests.yml`, read them.

No extension code is included. Every `main` and `browser` entry file is a
one-line stub, and each `package.json` keeps only the fields cdxgen reads.
The `.vsixmanifest`, `extensions.json` and `.obsolete` files are kept as the
editors wrote them.

## `linux-ide-lab-home`

Real installs on an Ubuntu 24.04 x86_64 host in October 2026. Each product was
downloaded from its vendor, and its own CLI (`--install-extension`) installed
`anthropic.claude-code`, `redhat.vscode-yaml`, `ms-python.python`,
`ms-python.debugpy` and their dependencies from its own marketplace:

| Folder                                  | Product                | Release                     |
| --------------------------------------- | ---------------------- | --------------------------- |
| `.cursor/extensions`                    | Cursor                 | 3.27.22 (VS Code 1.128.0)   |
| `.vscode/extensions`                    | VS Code                | 1.144.0                     |
| `.vscode-server/extensions`             | VS Code Server         | 1.144.0                     |
| `.vscode-oss/extensions`                | VSCodium               | 1.143.17232                 |
| `.devin/extensions`                     | Devin Desktop (Windsurf) | 3.11.234 (VS Code 1.126.0) |
| `.kiro/extensions`                      | Kiro                   | 1.4.62                      |
| `.positron/extensions`                  | Positron               | 2026.10.2                   |
| `.trae/extensions`                      | Trae                   | 3.6.4 (VS Code 1.107.1)     |
| `.local/share/code-server/extensions`   | code-server            | 4.144.0                     |
| `.openvscode-server/extensions`         | OpenVSCode Server      | 1.109.5                     |

In Cursor and VS Code, `redhat.vscode-yaml@1.15.0` was installed first and then
updated, which left the old folder on disk and listed in `.obsolete`. Home paths
in `extensions.json` were changed to `/home/dev`.

The layout shows the differences between editors that the parser has to handle:
VS Code names a universal build `redhat.vscode-yaml-2.0.0` while Cursor and the
Open VSX editors name it `redhat.vscode-yaml-2.0.0-universal`, Devin Desktop and
Trae install older `claude-code` builds from their own marketplaces, and the
marketplace `publisherId` of one publisher differs between galleries.

## `products`

The identity fields of `resources/app/product.json` and the `name` and
`version` of `package.json` from the same ten releases. They show where each
fork keeps its own version: `version`, `windsurfVersion`, `positronVersion`,
`appVersion` or `codeServerVersion`.

## `cursor-macos-home`

A macOS developer home with Cursor and VS Code, written to match the layout of
the Cursor installs above and of the October 29, 2026 Cursor marketplace notice
about `anthropic.claude-code` 2.1.313. Cursor has 2.1.313 for `darwin-arm64`,
installed at 09:40 UTC on that day; VS Code has 2.1.312, installed from a
`.vsix`. It also has an extension folder missing from `extensions.json`
(`acme.sideloaded`), an update left in `.obsolete`, a `~/.cursor/mcp.json` with a
placeholder token that must never reach a BOM, Cursor CLI permissions, a rule and
a skill, and the `Library/Application Support/Cursor/User` settings folder, which
holds no extensions.

## `remote-linux-home`

A host that Cursor and VS Code reach over Remote SSH: `~/.cursor-server` and
`~/.vscode-server`, each with its extensions and the `product.json` of the
server release under `cli/servers/Stable-<commit>/server`.

## `vsix`

`Anthropic.claude-code-2.1.313@darwin-arm64.vsix` is a stub package built with
fixed timestamps, so its SHA-256 does not change between checkouts.

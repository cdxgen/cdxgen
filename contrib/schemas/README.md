# Vendored schemas

These files are copies of published JSON schemas, kept here so that the checks
in `contrib/` run offline. Do not edit them. To update one, fetch it again,
replace the file and the digest below, and run `pnpm run check:agent-plugin`.

| File                                    | Source                                                          | SHA-256                                                            |
| --------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `agent-plugins-1.0.0.plugin.schema.json` | https://agent-plugins.org/schemas/1.0.0/plugin.schema.json | `0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883` |

The Agent Plugins schema (specification 1.0.0) is closed: `plugin.json` may
hold only `$schema`, `name`, `version`, `description`, `author`, `homepage`,
`repository`, `license`, `keywords` and `extensions`. It was fetched on
2026-11-02. `contrib/check-agent-plugin.js` validates `agent-plugin/plugin.json`
against it.

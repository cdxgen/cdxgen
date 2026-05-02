# Tutorials - Cataloging and auditing MCP servers

This lesson shows how to inventory JavaScript MCP servers, shipped MCP configs, and AI instruction/skill files, then gate on the resulting BOM-audit findings.

## 1) Generate an MCP-aware SBOM

```bash
cdxgen -t js \
  --bom-audit \
  --bom-audit-categories mcp-server \
  -o bom.json \
  /path/to/mcp-server
```

What this adds on top of a normal JavaScript SBOM:

- official and non-official MCP SDK package tagging
- MCP server services in `.services`
- shipped MCP config files in `.components`
- shipped AI instruction / skill files in `.components`
- synthetic components for tools, prompts, resources, and resource templates
- dependency `provides` links from the server service to the primitives it exposes
- MCP-specific BOM-audit findings
- AI-agent governance findings for shipped instruction files

## 2) Review the MCP server surfaces

Useful pivots with `jq`:

```bash
jq '.services' bom.json
jq '.components[] | select(any((.properties // [])[]; .name == "cdx:mcp:role"))' bom.json
jq '.dependencies[] | select(.ref | startswith("urn:service:mcp:"))' bom.json
```

High-signal questions:

1. Which MCP services are HTTP-exposed versus stdio-only?
2. Which services expose tools?
3. Which services are unauthenticated?
4. Which services rely on non-official MCP SDKs or wrappers?

## 3) Look for auth and provenance posture

The current rollout emits these especially useful properties:

- `cdx:mcp:transport`
- `cdx:mcp:officialSdk`
- `cdx:mcp:sdkImports`
- `cdx:mcp:capabilities:tools`
- `cdx:mcp:toolCount`
- `cdx:mcp:auth:*`

Recommended checks:

```bash
jq '.services[] | {name, authenticated, endpoints, properties}' bom.json
jq '.annotations[]? | select((.text // "") | contains("MCP-"))' bom.json
jq '.components[] | select(any((.properties // [])[]; .name == "cdx:file:kind" and (.value == "mcp-config" or .value == "skill-file" or .value == "agent-instructions")))' bom.json
```

## 4) Understand the built-in MCP audit rules

The `mcp-server` BOM-audit category currently focuses on:

- `MCP-001` — unauthenticated MCP tool exposure over Streamable HTTP
- `MCP-002` — unauthenticated MCP HTTP server endpoint
- `MCP-003` — network-exposed non-official MCP server
- `MCP-008` — build/post-build SBOM contains an MCP config file
- `AGT-007` — build/post-build SBOM contains an AI instruction or skill file

These rules are designed to be conservative and review-friendly:

- stdio-only servers are not flagged for missing HTTP auth
- explicit auth helpers suppress the unauthenticated findings
- non-official wrappers are surfaced for human review, not automatically treated as compromise

## 5) Suggested release-gate command

```bash
cdxgen -t js \
  --bom-audit \
  --bom-audit-categories mcp-server,ai-agent \
  --tlp-classification AMBER \
  --bom-audit-fail-severity high \
  -o bom.json \
  /path/to/mcp-server
```

This blocks serious MCP exposure while still preserving lower-severity shipped-config / shipped-skill findings for triage. If you only want package inventory, rerun with `--exclude-type ai-skill --exclude-type mcp`.

## 6) Practical lessons learned

- Treat MCP HTTP endpoints like any other remote control plane.
- Tool-capable servers deserve stricter review than prompt/resource-only servers.
- Official SDK usage improves confidence, but it does not replace authentication and authorization.
- Relative MCP routes such as `/mcp` are still important inventory signals even when the final host binding is supplied elsewhere.
- If a release artifact should not ship `CLAUDE.md`, `AGENTS.md`, `SKILL.md`, or MCP client configs, use `--exclude-type ai-skill --exclude-type mcp`.

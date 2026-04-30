# MCP inventory for JavaScript projects

cdxgen can now catalog Model Context Protocol (MCP) server surfaces from JavaScript and TypeScript source trees during normal `-t js` analysis.

## What cdxgen detects

For high-confidence JavaScript MCP patterns, cdxgen emits:

- **components** for well-known MCP SDK packages such as `@modelcontextprotocol/*`
- **services** for discovered MCP servers
- **synthetic components** for MCP primitives exposed by those servers:
  - tools
  - prompts
  - resources
  - resource templates
- **dependency/provides links** from the server service to the primitive components it exposes

## Current detection scope

The current rollout focuses on phase 1 and phase 2 signals:

- official and non-official MCP SDK imports
- `McpServer`-style server construction
- stdio and Streamable HTTP transports
- MCP tool / prompt / resource registration calls
- explicit capability declarations
- authentication helpers for HTTP MCP servers
- OAuth metadata literals and MCP auth-discovery wiring
- explicit provider and model literals such as `provider`, `providerName`, `model`, and `modelName`

The analysis is intentionally conservative. cdxgen prefers literal, explainable signals over speculative reconstruction.

## Key emitted properties

### MCP package components

- `cdx:mcp:package=true`
- `cdx:mcp:official=true|false`
- `cdx:mcp:role=server-sdk|client-sdk|transport-sdk|sdk|integration`
- `cdx:mcp:catalogSource=official-sdk|known-integration|heuristic`

### MCP server services

- `cdx:mcp:serviceType=server`
- `cdx:mcp:transport=stdio|streamable-http`
- `cdx:mcp:officialSdk=true|false`
- `cdx:mcp:capabilities:*`
- `cdx:mcp:toolCount`
- `cdx:mcp:promptCount`
- `cdx:mcp:resourceCount`
- `cdx:mcp:sdkImports`
- `cdx:mcp:modelNames`
- `cdx:mcp:providerNames`
- `cdx:mcp:auth:*`

### MCP primitive components

- `cdx:mcp:role=tool|prompt|resource|resource-template`
- `cdx:mcp:serviceRef=<service bom-ref>`
- `cdx:mcp:description`
- `cdx:mcp:resourceUri`
- `cdx:mcp:toolAnnotations`

## Example

```bash
cdxgen -t js /path/to/mcp-server -o bom.json --bom-audit --bom-audit-categories mcp-server
```

Things to inspect in the resulting BOM:

- `.services[]` for discovered MCP servers
- `.components[] | select(.properties[]?.name == "cdx:mcp:role")` for tools/prompts/resources
- `.dependencies[] | select(.ref | startswith("urn:service:mcp:"))` for service-to-primitive links
- `.annotations[]` for MCP BOM-audit findings

## Security notes

The most important current security checks are:

- unauthenticated Streamable HTTP MCP servers
- unauthenticated MCP tool exposure
- network-exposed servers built on non-official MCP SDKs or wrappers

HTTP MCP endpoints should be authenticated, Origin-validated, and pinned to trusted SDK provenance before external exposure.

## Known limits

- the current implementation is strongest for literal ESM/CJS patterns and explicit object literals
- dynamically generated tool names, endpoints, or capability objects may be missed
- provider/model detection is best-effort and only records explicit literals
- stdio servers are inventoried, but HTTP-centric auth rules intentionally focus on network-exposed servers

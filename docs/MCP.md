# MCP inventory for JavaScript and dedicated MCP project scans

cdxgen can catalog Model Context Protocol (MCP) server surfaces from JavaScript and TypeScript source trees during normal `-t js` analysis, or via the dedicated `-t mcp` project type.

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

- official and non-official MCP SDK imports
- `McpServer`-style server construction
- `Client`-style MCP client construction
- stdio and Streamable HTTP transports
- MCP tool / prompt / resource registration calls
- prompt / tool / resource client usage call sites
- explicit capability declarations
- authentication helpers for HTTP MCP servers
- OAuth metadata literals and MCP auth-discovery wiring
- explicit provider and model literals such as `provider`, `providerName`, `model`, and `modelName`
- provider SDK imports, outbound provider hosts, and MCP gateway patterns
- AI agent instruction files that reference hidden MCP endpoints or wrappers
- MCP client configuration files such as `.vscode/mcp.json`, `.mcp.json`, `claude_desktop_config.json`, and `opencode.json`
- community agent tooling layouts such as OpenCode (`opencode.json`, `.opencode/agents`, `.opencode/tools`, `.opencode/skills`), Nanocoder (`.mcp.json`, `.nanocoder/agents`, `.nanocoder/commands`), LangGraph (`langgraph.json`), and common CrewAI project files (`agents.py`, `tasks.py`, `config/agents.yaml`, `config/tasks.yaml`)
- config-derived auth posture, trust profile, dynamic client registration, and inline credential exposure

The analysis is intentionally conservative. cdxgen prefers literal, explainable signals over speculative reconstruction.

## Key emitted properties

### MCP package components

- `cdx:mcp:package=true`
- `cdx:mcp:official=true|false`
- `cdx:mcp:role=server-sdk|client-sdk|transport-sdk|sdk|integration`
- `cdx:mcp:catalogSource=official-sdk|known-integration|heuristic`

### MCP server and configured services

- `cdx:mcp:serviceType=server|client|gateway|endpoint|inferred-endpoint|configured-server`
- `cdx:mcp:transport=stdio|streamable-http|sse`
- `cdx:mcp:officialSdk=true|false`
- `cdx:mcp:capabilities:*`
- `cdx:mcp:toolCount`
- `cdx:mcp:promptCount`
- `cdx:mcp:resourceCount`
- `cdx:mcp:sdkImports`
- `cdx:mcp:modelNames`
- `cdx:mcp:modelFamilies`
- `cdx:mcp:providerNames`
- `cdx:mcp:providerFamilies`
- `cdx:mcp:outboundHosts`
- `cdx:mcp:usageSignals`
- `cdx:mcp:usageConfidence`
- `cdx:mcp:inventorySource`
- `cdx:mcp:exposureType`
- `cdx:mcp:configFormat`
- `cdx:mcp:configKey`
- `cdx:mcp:command`
- `cdx:mcp:packageRefs`
- `cdx:mcp:authPosture`
- `cdx:mcp:trustProfile`
- `cdx:mcp:credentialExposure`
- `cdx:mcp:credentialExposureFields`
- `cdx:mcp:credentialRiskIndicators`
- `cdx:mcp:credentialRefs`
- `cdx:mcp:security:confusedDeputyRisk`
- `cdx:mcp:security:tokenPassthroughRisk`
- `cdx:mcp:reviewNeeded`
- `cdx:mcp:auth:*`

### MCP primitive components

- `cdx:mcp:role=tool|prompt|resource|resource-template`
- `cdx:mcp:serviceRef=<service bom-ref>`
- `cdx:mcp:description`
- `cdx:mcp:resourceUri`
- `cdx:mcp:toolAnnotations`

### Community agent/tool/skill components

- `cdx:agent:framework=opencode|nanocoder|langgraph|crewai`
- `cdx:agent:inventorySource=community-config`
- `cdx:agent:description`
- `cdx:agent:mode`
- `cdx:agent:model`
- `cdx:tool:description`
- `cdx:tool:category`
- `cdx:tool:tags`
- `cdx:tool:triggers`
- `cdx:skill:name`
- `cdx:skill:description`
- `cdx:skill:license`
- `cdx:langgraph:graphEntryPoint`
- `cdx:crewai:*`

## Example

```bash
cdxgen -t mcp /path/to/mcp-server -o bom.json --bom-audit --bom-audit-categories mcp-server
```

Things to inspect in the resulting BOM:

- `.services[]` for discovered MCP servers
- `.formulation[].components[] | select(.properties[]?.name == "cdx:file:kind" and .properties[]?.value == "mcp-config")` for MCP config files
- `.components[] | select(.properties[]?.name == "cdx:mcp:role")` for tools/prompts/resources
- `.dependencies[] | select(.ref | startswith("urn:service:mcp:"))` for service-to-primitive links
- `.annotations[]` for MCP BOM-audit findings

## Security notes

The most important current security checks are:

- unauthenticated Streamable HTTP MCP servers
- unauthenticated MCP tool exposure
- network-exposed servers built on non-official MCP SDKs or wrappers
- networked MCP endpoints discovered only from configuration files
- inline credentials or token-forwarding settings in MCP configs
- dynamic client registration paired with static client identities in MCP configs
- public or tunneled MCP endpoints referenced only from AI agent files
- hidden Unicode in AI agent instruction and skill files
- agent-file MCP references that are not otherwise declared in package or source inventory

HTTP MCP endpoints should be authenticated, Origin-validated, and pinned to trusted SDK provenance before external exposure.

## Known limits

- the current implementation is strongest for literal ESM/CJS patterns and explicit object literals
- dynamically generated tool names, endpoints, or capability objects may be missed
- provider/model detection is best-effort and only records explicit literals
- stdio servers are inventoried, but HTTP-centric auth rules intentionally focus on network-exposed servers

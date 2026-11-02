---
name: ai-bom
description: Generates AI-BOM, MCP inventory, AI skill inventory, and AI authorship provenance documents with cdxgen, cataloging models, inference services, Hugging Face purls, MCP servers and their tools/prompts/resources, agent instruction files, and cdx:ai:codegen provenance signals, then audits them with AI-focused rule packs. Use when asked to inventory AI or ML usage, catalog MCP servers, audit agent instruction or skill files, assess AI supply-chain risk, or detect AI-generated code authorship.
---

# AI-BOM, MCP inventory, and AI provenance

Four related but distinct concerns. Pick the right one before reaching for
flags — conflating them produces a document that answers the wrong question.

| Question                                              | Project type                          |
| ----------------------------------------------------- | ------------------------------------- |
| What models and inference services does this use?     | `ai` / `aibom` / `ai-bom`             |
| What MCP servers, tools, and configs does this ship?  | `mcp`                                 |
| What agent instruction and skill files does it ship?  | `ai-skill` / `skill` / `skills`       |
| Was this code written with AI assistance?             | `ai-provenance` / `ai-authorship` / `aicode` / `ai-codegen` |

Read [reference/safety.md](../../reference/safety.md) first. The
review-before-sharing rule is especially relevant here: AI and MCP inventory is
one of the categories most likely to contain credential-bearing configuration.

## AI-BOM: models and inference services

```bash
aibom /absolute/path/to/project
```

Or explicitly, with the audit pack:

```bash
cdxgen -r --include-formulation \
  -o /absolute/path/to/aibom.json \
  --bom-audit --bom-audit-categories ai-bom \
  /absolute/path/to/project
```

`--include-formulation` matters here: it moves the AI and agentic inventory into
the standard CycloneDX `formulation[]` section so downstream tools consume it as
formal formulation data rather than ad-hoc top-level enrichment. Prefer it.

### Direct model targets

`aibom` accepts a model reference rather than a project directory:

```bash
aibom pkg:huggingface/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B
aibom https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B
aibom /absolute/path/to/Modelfile
aibom /absolute/path/to/model.gguf
```

Hugging Face model repositories get proper
`pkg:huggingface/<namespace>/<name>@<revision>` purls when a compliant
repository reference is available. When remote resolution is enabled, cdxgen
follows the revision-aware Hub endpoints, so explicit purl revisions, remote
popularity/runtime hints, and Space-linked model/dataset relationships are
preserved instead of collapsing to an unversioned HEAD lookup. Datasets
referenced by model cards get reusable dataset component references with their
own Hugging Face purls.

### ML depth profiles

```bash
cdxgen --profile ml-tiny -o /absolute/path/to/bom.json /absolute/path/to/project
```

`ml` / `machine-learning`, `ml-deep` / `deep-learning`, and `ml-tiny` trade
depth against runtime. Start with `ml` and escalate only if the inventory is
thin.

### AI audit categories

| Category         | Checks                                                        |
| ---------------- | ------------------------------------------------------------- |
| `ai-bom`         | Umbrella pack for AI-BOM review                               |
| `ai-security`    | Security posture of AI services and model usage               |
| `ai-governance`  | Governance and policy conformance                             |
| `ai-performance` | Performance-relevant model and runtime findings               |
| `ai-inventory`   | Alias enabling both `ai-agent` and `mcp-server`               |

## MCP inventory

```bash
cdxgen -t mcp /absolute/path/to/project \
  -o /absolute/path/to/bom.json \
  --bom-audit --bom-audit-categories mcp-server
```

By default a plain `-t js` scan **also** reports shipped MCP configuration files
and AI instruction/skill files, because both can influence build and post-build
lifecycles. Control that overlay:

- `--exclude-type mcp` drops MCP config components, discovered services, and MCP primitives. Genuine MCP **SDK dependency packages** (`@modelcontextprotocol/*`, PyPI `mcp`, `io.modelcontextprotocol.sdk`) are real supply-chain components and are **always retained**.
- `--exclude-type ai-skill` drops AI skill and instruction inventory.
- `-t mcp` produces an exact MCP-focused BOM: SDK packages, discovered services, primitives, and config files such as `.vscode/mcp.json`.

### What the MCP inventory contains

- `components` for MCP SDK packages
- `services` for discovered MCP servers
- synthetic components for MCP primitives: tools, prompts, resources, resource templates
- `dependencies` links from a server service to the primitives it exposes

Config formats recognised include `.vscode/mcp.json`, `.mcp.json`,
`claude_desktop_config.json`, and `opencode.json`. Community agent layouts are
covered too: OpenCode, Nanocoder, LangGraph, and common CrewAI project files.

### Inspecting an MCP BOM

```bash
# discovered servers
jq '.services[]' /absolute/path/to/bom.json

# MCP primitives
jq '.components[] | select(.properties[]?.name == "cdx:mcp:role")' /absolute/path/to/bom.json

# shipped MCP config files
jq '.components[] | select(.properties[]?.value == "mcp-config")' /absolute/path/to/bom.json

# service-to-primitive links
jq '.dependencies[] | select(.ref | startswith("urn:service:mcp:"))' /absolute/path/to/bom.json

# audit findings
jq '.annotations[]' /absolute/path/to/bom.json
```

Key property namespaces: `cdx:mcp:serviceType`, `cdx:mcp:transport`,
`cdx:mcp:exposureType`, `cdx:mcp:authPosture`, `cdx:mcp:trustProfile`,
`cdx:mcp:credentialExposure`, `cdx:mcp:reviewNeeded`,
`cdx:mcp:security:confusedDeputyRisk`, `cdx:mcp:security:tokenPassthroughRisk`.

### The MCP findings that matter most

Escalate these:

- unauthenticated Streamable HTTP MCP servers, and unauthenticated tool exposure
- network-exposed servers built on non-official SDKs or wrappers
- networked endpoints discovered **only** from configuration files
- inline credentials or token-forwarding settings in MCP configs
- dynamic client registration paired with static client identities
- public or tunneled endpoints referenced only from AI agent files
- hidden Unicode in agent instruction and skill files
- agent-file MCP references not otherwise declared in package or source inventory

The analysis is deliberately conservative — it prefers literal, explainable
signals over speculative reconstruction. So a clean result is not proof of
absence. Dynamically generated tool names, endpoints, and capability objects can
be missed, and provider/model detection only records explicit literals.

### Release-review pattern

Keep and flag the files:

```bash
cdxgen -t js --bom-audit \
  --bom-audit-categories mcp-server,ai-agent \
  --tlp-classification AMBER \
  -o /absolute/path/to/bom.json /absolute/path/to/repo
```

Drop them for a package-only SBOM:

```bash
cdxgen -t js --exclude-type ai-skill --exclude-type mcp \
  -o /absolute/path/to/bom.json /absolute/path/to/repo
```

### Experimental MCP pinning

`--experimental-mcp-pinning` (or `CDXGEN_EXPERIMENTAL_MCP_PINNING=true`), off by
default, records an explicit `cdx:mcp:pinning` state — `pinned`, `unpinned`, or
`unhashable` — plus `cdx:mcp:composition=unknown` for remote servers with no
local package. The point is that absence is labelled rather than implied.

These property names are **subject to change** until the CycloneDX agent-BOM
proposal is ratified. Do not build durable tooling on them; tell the user they
are experimental if you enable the flag.

## AI skill and instruction inventory

```bash
cdxgen -t ai-skill /absolute/path/to/project -o /absolute/path/to/bom.json \
  --bom-audit --bom-audit-categories ai-agent
```

Covers `CLAUDE.md`, `AGENTS.md`, `SKILL.md`,
`.github/copilot-instructions.md`, `.github/workflows/copilot-setup-steps.yml`,
`.opencode/**`, `.nanocoder/**`, `langgraph.json`, and CrewAI files. Properties
land under `cdx:agent:*`, `cdx:tool:*`, `cdx:skill:*`, `cdx:langgraph:*`, and
`cdx:crewai:*`.

## AI authorship provenance

A different concern entirely: this is a **generation-time property injector**
over git history and CI configuration. It does not inventory MCP servers or
models.

```bash
cdxgen -t ai-provenance -o /absolute/path/to/bom.json /absolute/path/to/project
```

Signals land in the BOM document root `properties` as `cdx:ai:codegen:*` and
`cdx:ai:oversight:*`.

Detection is **enabled by default** in `cdx-audit`, since all rule categories
run by default:

```bash
cdx-audit --bom /absolute/path/to/bom.json --direct-bom-audit
cdx-audit --bom /absolute/path/to/bom.json --direct-bom-audit --categories ai-provenance
cdx-audit --bom /absolute/path/to/bom.json --direct-bom-audit --no-ai-provenance
```

If the BOM already carries `cdx:ai:codegen:*` properties, `cdx-audit` reuses
them; otherwise it scans the working directory and injects them before
evaluating rules.

The `ai-provenance` category enables both `ai-provenance` and `ai-oversight`.
The oversight rules evaluate whether AI-assisted code was merged with adequate
independent human review, and detect rubber-stamping or quality-gate bypassing.

Treat the output as a signal for a conversation, not a verdict about a person.

## Exploring the result

In `cdxi` (see `bom-explore`): `.aibom`, `.services`, `.formulation`,
`.provenance`, `.auditfindings`.

## Reference

- AI-BOM guide: <https://cdxgen.github.io/cdxgen/#/AI_BOM>
- MCP inventory: <https://cdxgen.github.io/cdxgen/#/MCP>
- AI provenance: <https://cdxgen.github.io/cdxgen/#/AI_PROVENANCE>
- Audit rules: <https://cdxgen.github.io/cdxgen/#/BOM_AUDIT>

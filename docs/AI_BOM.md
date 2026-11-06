# AI-BOM Guide

AI-BOM in cdxgen is the CycloneDX-first workflow for cataloging AI usage, model references, prompt/config artifacts, MCP surfaces, and AI-specific BOM audit findings from one scan.

When `--include-formulation` is enabled, cdxgen emits this AI and agentic inventory in the standard CycloneDX `formulation[]` section, so downstream tools can consume it as formal CycloneDX formulation data instead of only as ad-hoc top-level enrichment.

## What AI-BOM covers

cdxgen can already emit AI-related evidence in standard CycloneDX documents, including:

- AI inference services discovered from source or config
- model components and local model artifacts, including GGUF, safetensors, ONNX, and
  PyTorch pickle (`.bin`/`.pt`/`.pth`/`.ckpt`) checkpoints
- agent frameworks and SDKs such as LangChain/LangGraph, LlamaIndex, the Vercel AI SDK,
  the Claude Agent SDK, Google ADK, Pydantic AI, AWS Strands, Agno, the Microsoft Agent
  Framework, Semantic Kernel, smolagents, DSPy, and CrewAI
- inference providers spanning OpenAI, Anthropic, Google, Azure OpenAI, Mistral, Cohere,
  DeepSeek, Groq, xAI/Grok, AWS Bedrock, OpenRouter, Cerebras, DashScope/Qwen, NVIDIA NIM,
  and local runtimes
- prompt and model-routing config files
- AI agent instruction files and skill files, including the open Agent Skills standard
- MCP configs, discovered MCP services, MCP Registry `server.json` manifests, and
  MCPB/DXT bundles

### Kiro project artifacts

`-t ai` inventories the project-level artifacts of Kiro CLI V3 under `.kiro/`,
alongside the same coverage that `.cursor/rules` and friends get:

| Files                                          | Component                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `.kiro/steering/**/*.md`                       | `file` component with `cdx:file:kind=agent-instructions`                                         |
| `.kiro/specs/**/*.md`                          | `file` component with `cdx:file:kind=agent-spec`                                                 |
| `.kiro/skills/*/SKILL.md`                      | skill-file component, modeled like the other Agent Skills                                        |
| `.kiro/agents/*.json`                          | `agent-definition` component with the model, MCP server/tool counts, permission posture, and upgrade revision |
| `.kiro/agents/*.md`                            | `agent-definition` component from the frontmatter                                                |
| `.kiro/settings/permissions.yaml`              | `permission-policy` component with the summarized rule counts and capability names                |
| `.kiro/settings/cli.json`                      | `settings` component with the default agent and a boolean feature-flag count                      |
| `.kiro/hooks/*.{json,sh,bash,zsh,ps1}`         | `hook-file` component; JSON manifests add allowlisted lifecycle events, action types, and a count |
| `.kiro/workflows/*.{yaml,yml,json}`            | `workflow-file` component                                                                        |

The permission posture uses the same suffixes as the host scan, under the
`cdx:agent:` namespace: rule counts per effect, capability names, the
unrestricted-allow booleans, the allowlisted policy presets, and the integer
`kiroUpgrade` revision of an agent. Match patterns, excludes, prompts,
resource values, tool settings, fingerprints, hook commands, and workflow
contents are never copied. A planted credential in a hook script still sets
`cdx:agent:credentialExposure=true` through the indicator labels, never
through its content.

Repositories that keep this content outside `.kiro`, such as
aws-samples/sample-kiro-cli-multiagent-development, are covered too, but not
by a bare `steering/*.md` glob, which would fire on every documentation
repository. A directory counts as a Kiro configuration root only when its
`settings/permissions.yaml` holds rules with `capability` and `effect`, or its
`settings/cli.json` carries a `chat.`-prefixed key. Only a validated root
contributes its `steering/*.md`, `settings/cli.json`,
`settings/permissions.yaml`, and `hooks/*.json`; a plain documentation
`steering/` folder yields nothing.

For Hugging Face model repositories, cdxgen uses Hugging Face Package-URL `pkg:huggingface/<namespace>/<name>@<revision>` identifiers when a compliant model repository reference is available.

When model cards reference Hugging Face datasets, cdxgen also keeps those dataset links stable by emitting reusable dataset component references with explicit Hugging Face purls alongside inline dataset summaries where appropriate.

When remote resolution is enabled for a Hugging Face URL or purl, cdxgen now follows the revision-aware Hub endpoints used by the official `huggingface.js` client. This lets AI-BOM preserve explicit purl revisions, remote popularity/runtime hints, and Space-linked model/dataset relationships instead of treating every remote reference as an unversioned HEAD lookup.

You can then audit that BOM with AI-focused rule packs.

## Quick start

```bash
# Generate an AI/ML BOM and run the preferred AI-BOM audit alias
cdxgen -r --include-formulation -o aibom.json --bom-audit --bom-audit-categories ai-bom .

# Same flow via the dedicated AI-BOM CLI
aibom .

# Explicit project type form when combining AI inventory with other cdxgen options
cdxgen -t ai --include-formulation .

# Generate a direct AI-BOM from a Hugging Face purl, URL, Modelfile, or GGUF file
aibom pkg:huggingface/rohitnagareddy/Qwen3-0.6B-Coding-Finetuned-v1
aibom https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B
aibom /absolute/path/to/Modelfile
aibom /absolute/path/to/model.gguf

# Re-audit a saved AI BOM later
cdx-audit --bom aibom.json --direct-bom-audit --categories ai-bom

# Focus only on governance findings
cdx-audit --bom aibom.json --direct-bom-audit --categories ai-governance
```

## Command and project-type aliases

The dedicated `aibom` command is the focused AI-BOM entry point. Internally it defaults to:

- `--type ai`
- `--include-formulation`
- `--bom-audit-categories ai-bom`

The accepted project-type aliases for this mode are:

- `ai`
- `aibom`
- `ai-bom`

An AI-BOM scan also includes the community agent-configuration files that
`-t ai-skill` models: the Kiro project artifacts described above, Cursor and
Windsurf rules, Claude Code subagents, commands and skills, OpenCode and
Nanocoder configurations, LangGraph and CrewAI definitions. The top-level
instruction files (`CLAUDE.md`, `.github/copilot-instructions.md`, and
similar) stay with `-t ai-skill`. Pass `--exclude-type ai-skill` to keep only
the models, services, and prompt-config artifacts.

Use `aibom <input>` when you want the dedicated AI-oriented defaults for a single scan. Use `cdxgen -t ai ...` when you want to combine AI inventory with other `cdxgen` project types or flags explicitly.

## AI-BOM categories

`ai-bom` is the preferred umbrella alias. It expands to:

- `ai-governance`
- `ai-security`
- `ai-performance`
- `ai-agent`
- `mcp-server`

The older `ai-inventory` alias still works for `ai-agent,mcp-server` compatibility.

## Formal CycloneDX output

For AI/ML scans, the primary AI and agentic evidence is emitted under:

- `formulation[].components`
- `formulation[].services`
- `formulation[].workflows`

and any discovered formulation services are also merged into top-level `services` for normal BOM consumers.

### Declared coding agents at CycloneDX 2.0

At `--spec-version 2.0` the declared side of coding-agent behaviour becomes
2.0 parties and a behavioral blueprint. Only real agent definitions count: a
component with `cdx:agent:role` (Kiro agents, Claude subagents), or whose
`cdx:file:kind` is `agent-definition` or `claude-subagent`. Instruction files
(`AGENTS.md`, steering), specs, agent configs and plugins are not agents.

- Each agent with a `bom-ref` becomes a party `party-agent-<bom-ref>` in
  `definitions.parties` with the role `agent` and a `system` of kind `agent`
  whose `ref` is the agent component, `label` its name, and `permissions` the
  tool names its config allows (`cdx:agent:tools`,
  `cdx:agent:permissionCapabilities`). Each permission is cut to the tool name
  before any `(`, so `Bash(git status:*)` is `Bash`; names with other
  characters are dropped; the list is unique and sorted.
- One blueprint, `blueprint-declared-agents`, with `modelTypes: ["behavioral"]`,
  lists the agent parties as actors. Its `behaviors.instances` have
  `acknowledgment: ["declared"]` and a behavior from
  `data/behavior-taxonomy.schema.json`: `ai:agent:invokesTool` for an agent
  that declares tools or MCP servers, and `ai:agent:requestsUserApproval` for
  one whose permission policy has ask rules. The inventory records how many
  MCP servers an agent's own config names but not which, so instances have no
  `targets`.

Nothing is copied from instruction, skill or MCP files: no descriptions,
prompts, commands, arguments, environment values or URLs. Business objectives,
use cases and observed behaviour are out of scope. The 1.7 output is unchanged.
Reading a 2.0 AI-BOM back and rendering it again declares each agent party and
the blueprint once (see
[CDX_CONVERT.md](CDX_CONVERT.md#sections-cdxgen-derives-at-20)).

`-t ai` runs the community agent parsers; add `-t mcp` to also read MCP client
configurations such as `mcp.json`.

## GGUF model inventory behavior

When AI-BOM scans a local `.gguf` artifact, cdxgen now tries to model the result in three layers:

1. a `type: "file"` component for the GGUF artifact itself
2. a `type: "machine-learning-model"` component for the model represented by that artifact
3. standard CycloneDX ML metadata under `modelCard` and `pedigree`, with GGUF-specific details preserved as namespaced custom properties

### Standard CycloneDX fields populated from GGUF

- `modelCard.modelParameters.architectureFamily` from `general.architecture`
- `modelCard.modelParameters.modelArchitecture` from `general.basename`
- `modelCard.modelParameters.task` when GGUF metadata strongly suggests a text-generation or embedding task
- `modelCard.modelParameters.datasets[]` from `general.datasets`
- `modelCard.modelParameters.inputs[]` / `outputs[]` when tokenizer metadata indicates text I/O
- `pedigree.ancestors[]` from `general.base_model.*`
- `externalReferences[]` from `general.url`, `general.repo_url`, `general.source.*`, `general.license.link`, and DOI fields

### GGUF-specific custom properties

GGUF still carries artifact-level details that do not have a direct CycloneDX core field. cdxgen keeps those under namespaced properties such as:

- `cdx:gguf:sizeLabel`
- `cdx:gguf:sidecar`
- `cdx:gguf:shard`, `cdx:gguf:shardIndex`, `cdx:gguf:shardCount`
- `cdx:gguf:tokenizerModel`
- `cdx:gguf:tokenizerTokenCount`
- `cdx:gguf:chatTemplateDetected`
- `cdx:gguf:huggingFaceTokenizer`

The raw tokenizer vocabulary, merge rules, Hugging Face tokenizer JSON, and raw chat template text are **not** copied into the BOM as properties. Instead, cdxgen emits safe derivatives such as counts, booleans, and bounded IDs so the resulting BOM stays useful for policy and review without duplicating large or potentially sensitive payloads.

### Practical review guidance for GGUF

- Review `cdx:ai:quantization` together with `cdx:gguf:quantizationVersion` for local-runtime fit.
- Review `cdx:ai:contextWindow` for governance and performance pressure.
- Review `modelCard.modelParameters.datasets[]` and `pedigree.ancestors[]` to understand training/evaluation lineage.
- Review `cdx:gguf:chatTemplateDetected` and tokenizer properties when prompt packaging or serving behavior matters.
- Review shard metadata on the file component when a deployment expects a multi-file GGUF layout.

## Hugging Face parser behavior

### Remote models, datasets, and Spaces

For direct Hugging Face URLs or `pkg:huggingface/...` inputs, cdxgen resolves the Hub metadata into standard CycloneDX components:

- model repos → `type: "machine-learning-model"`
- dataset repos → `type: "data"`
- Spaces → `type: "application"`

The remote parser now preserves several important relationships:

- explicit purl or `/revision/<rev>` inputs keep that revision in the lookup path
- model-card datasets become reusable `type: "data"` components plus dependency edges
- Space `models[]` and `datasets[]` metadata become related components plus dependency edges from the Space application
- model lineage from `base_model`, `base_models`, and `finetuned_from` is normalized into `pedigree.ancestors[]`

### Standard Hugging Face → CycloneDX mappings

cdxgen prefers standard CycloneDX fields where the Hub metadata maps cleanly:

- `modelCard.modelParameters.task` from `pipeline_tag` or `model-index`
- `modelCard.modelParameters.datasets[]` from model-card dataset references
- `modelCard.modelParameters.inputs[]` / `outputs[]` from task and widget metadata when I/O shape is clear
- `modelCard.considerations.useCases[]` from the primary task and selected model tags
- `modelCard.considerations.environmentalConsiderations.properties[]` for bounded CO2 metadata derivatives
- `externalReferences[]` for repo distribution URLs, DOI links, arXiv citations, and selected related Spaces

### Hugging Face-specific bounded properties

Some useful Hub metadata still does not fit a stable CycloneDX core field, so cdxgen emits narrow namespaced properties such as:

- `cdx:huggingface:downloads`, `cdx:huggingface:downloadsAllTime`
- `cdx:huggingface:likes`, `cdx:huggingface:likesRecent`
- `cdx:huggingface:gated`, `cdx:huggingface:gatedFieldCount`
- `cdx:huggingface:inferenceProvider`, `cdx:huggingface:inferenceStatus`
- `cdx:huggingface:sdk`, `cdx:huggingface:runtimeStage`, `cdx:huggingface:modelCount`, `cdx:huggingface:datasetCount`

As with GGUF, cdxgen intentionally avoids copying raw high-entropy or reviewer-hostile payloads such as widget conversations, raw gated-access form prompts, or other unbounded metadata blobs directly into top-level BOM properties. Instead it emits stable URLs, counts, enums, booleans, and bounded identifiers.

## What the new AI-BOM rules look for

### Governance

- prompt or model-routing config files shipped in build/post-build BOMs
- AI services used without explicit model identifiers

### Security

- remote AI endpoints using insecure HTTP transport
- model artifacts that load via unsafe pickle deserialization (`.bin`/`.pt`/`.pth`/`.ckpt`)

### Performance

- local AI models with very large context windows
- large local AI models missing quantization metadata

## Local model artifact formats

When AI-BOM scans local model files, cdxgen recognizes several formats and records
format-appropriate metadata without loading tensors or executing model code:

- **GGUF** — full metadata parse (architecture, quantization, tokenizer signals, base-model
  pedigree). See the GGUF section below.
- **safetensors** — reads the JSON header to summarize tensor count, dtypes, and parameter
  totals (`cdx:safetensors:*`), and derives a quantization method when present.
- **ONNX** — the protobuf header is read by offset (without loading the graph) to record the exporter, its version, the IR version, and the operator sets as `cdx:onnx:*` properties.
- **PyTorch pickle** (`.bin`/`.pt`/`.pth`/`.ckpt`) — inventoried and flagged with
  `cdx:ai:unsafeDeserialization=true` because loading a pickle checkpoint executes code.

Non-GGUF quantization methods (GPTQ, AWQ, EXL2, bitsandbytes, and similar) are recorded as
`cdx:ai:quantizationMethod`, separate from the container format and the GGUF encoding.

## Recommended workflow

1. Generate the BOM with `--bom-audit --bom-audit-categories ai-bom`
2. Review high and medium findings first
3. Inspect the affected service, file, or model in `cdxi`
4. Re-run the audit after governance or deployment changes

`cdxi` now includes an `.aibom` command that renders an operator-friendly AI view with pedigree trees, fine-tune/distillation lineage, quantization explanations, licenses, and dataset summaries.

## CISA and G7 minimum elements for AI SBOMs

On 12 May 2026 the G7 Cybersecurity Working Group (BSI, ACN, ANSSI, CSE, CISA,
NCSC and NCO, with the European Commission) published [Software Bill of
Materials for AI: Minimum Elements](https://www.cisa.gov/resources-tools/resources/software-bill-materials-si-minimum-elements)
([PDF](https://www.bsi.bund.de/SharedDocs/Downloads/EN/BSI/KI/SBOM-for-AI_minimum-elements.pdf?__blob=publicationFile&v=4)),
a voluntary baseline organised in seven clusters. Its elements are in
addition to the general SBOM minimum elements, so `cdx-validate --benchmark
cisa` checks the general elements, and the AI-specific elements that a BOM can
show are rules under `cdx-validate --benchmark cisa-ai` (rule ids
`CISA-AI-001` to `CISA-AI-016`). Every AI rule, the system rules included,
passes with a note on a BOM that holds no model or dataset components.

The tables below list all 50 elements under the names the guidance uses: 10
in the Metadata cluster, 9 System Level Properties, 13 Models, 10 Datasets, 2
Infrastructure, 4 Security Properties and 2 Key Performance Indicators. The
test suite checks that the rules cite every element outside the Metadata
cluster, apart from System components and Infrastructure software, which are
the component inventory itself.

### Metadata cluster

| Element | Where it lands in a cdxgen AI-BOM | Rule |
| --- | --- | --- |
| SBOM author | `metadata.authors[]`, from `--author` | `CISA-MIN-001` |
| SBOM version | `version` and `serialNumber` | `CISA-MIN-006` |
| SBOM data format name | `bomFormat` (`specFormat` in 2.0) | `CISA-MIN-003` |
| SBOM data format version | `specVersion` | `CISA-MIN-003` |
| SBOM author signature | the JSF `signature` written by `cdx-sign` | `CISA-MIN-002` |
| SBOM tool name | `metadata.tools.components[].name` | `CISA-MIN-005` |
| SBOM tool version | `metadata.tools.components[].version` | `CISA-MIN-005` |
| SBOM generation context | `metadata.lifecycles[].phase` | `CISA-MIN-004` |
| SBOM timestamp | `metadata.timestamp` | `CISA-MIN-007` |
| SBOM dependency relationship | `dependencies[]` for inclusion; a model fine-tuned, adapted, distilled, merged or quantised from another records it in `pedigree.ancestors[]`, and other relations in `pedigree.variants[]` | `CISA-MIN-014` (inclusion only) |

These rules belong to the `cisa` benchmark and are documented in
[CDX_VALIDATE.md](CDX_VALIDATE.md).

### System Level Properties cluster

| Element | Where it lands in a cdxgen AI-BOM | Rule |
| --- | --- | --- |
| System name | `metadata.component.name` | `CISA-AI-001` |
| System components | `components[]` (models, datasets, software) and `services[]` (inference endpoints) | none; the `cisa-ai` rules apply only when such components exist |
| System producer | `metadata.supplier.name`, the deprecated `metadata.manufacture.name`, or the `manufacturer`, `supplier` or `authors` of `metadata.component`; cdxgen does not populate any of them, so add the producer after generation | `CISA-AI-002` |
| System version | `metadata.component.version` | `CISA-AI-001` |
| System timestamp | not emitted; `metadata.timestamp` records when the BOM was generated, not when the system last changed | `CISA-AI-011` |
| System data flow | `services[].endpoints` for inference and MCP services; a data-flow graph between components is not emitted | `CISA-AI-011` |
| System data usage | not emitted; needs the producer's technical documentation | `CISA-AI-011` |
| System input/output properties | not emitted at system level; per-model inputs and outputs are in `modelCard.modelParameters` | `CISA-AI-011` |
| Intended application area | not emitted at system level; models with a Hub model card carry `modelCard.considerations.useCases[]` | `CISA-AI-011` |

### Models cluster

| Element | Where it lands in a cdxgen AI-BOM | Rule |
| --- | --- | --- |
| Model name | `components[type=machine-learning-model].name` | `CISA-AI-003` |
| Model identifier | `purl` (`pkg:huggingface/<namespace>/<name>@<revision>`) | `CISA-AI-005` |
| Model version | `version` (repository sha or revision) | `CISA-AI-003` |
| Model timestamp | the `cdx:huggingface:lastModified` property on Hub models; CycloneDX has no standard component timestamp, and local-only artifacts have none | `CISA-AI-011` |
| Model producer | The organisation that created the model is recorded as `manufacturer.name` (CycloneDX 1.6 and later) under its full name: OpenAI, Anthropic, Google, Meta, Mistral AI, Cohere, DeepSeek, xAI, Zhipu AI or Alibaba Cloud. The Hugging Face account that published the repository is recorded separately as `supplier.name`, with `supplier.url` set to `https://huggingface.co/<namespace>` when the model comes from the Hub, because a namespace such as TheBloke, unsloth or mlx-community supplies a re-packaged model it did not create. The manufacturer is taken from the first source that applies: the `general.organization` field of a GGUF file (trimmed, dropped above 128 characters, written with the full name when it names a known creator); a Hub namespace that is the creator's own organisation, such as meta-llama, mistralai, google or Qwen; or, for a model that source code or dosai names, a model name prefix only one creator uses, such as `claude`, `gpt-4`, `o3`, `gemini`, `gemma`, `mixtral`, `command-r`, `llama`, `grok`, `qwen` or `glm`. A name-based creator is kept when the code uses no SDK or host, uses that creator's own SDK or host or a hosting or routing service, or also uses the creator's SDK elsewhere in the file. Another creator's SDK leaves it unset, as does the openai SDK alone, since an OpenAI-compatible client can point at any server. An unrecognised name is credited only to an API that serves nothing but its creator's models (Anthropic, Cohere, DeepSeek, Mistral AI, xAI, Zhipu AI). Local runtimes such as ollama, vLLM, LM Studio and llama.cpp name no creator. litellm routes such as `groq/llama3-8b-8192` and Google resource names such as `models/gemini-1.5-flash` are not treated as Hub repositories. Hosting and routing providers stay in `cdx:ai:provider` and are never the manufacturer or supplier. | `CISA-AI-004` |
| Model description | `description` and the CycloneDX `modelCard` for capabilities and limitations; lineage in `pedigree.ancestors[]` from the card's `base_model` | `CISA-AI-008` |
| Model hash value | `hashes[].content` (dosai computes SHA-256 for artifacts) | `CISA-AI-006` |
| Model hash algorithm | `hashes[].alg` | `CISA-AI-006` |
| Model properties | `modelCard.modelParameters.architectureFamily` and `modelArchitecture`, from a Hub `config.json` or the GGUF header, plus the `cdx:ai:quantization`, `cdx:ai:parameterCount` and `cdx:ai:contextWindow` properties | `CISA-AI-012` |
| Model input-output properties | `modelCard.modelParameters.inputs[]` / `outputs[]`, from the Hub pipeline tag or the GGUF tokenizer | `CISA-AI-013` |
| Model training properties | not emitted; CycloneDX `modelCard.modelParameters.approach.type` holds the learning type, and the post-training techniques need the producer's model card | `CISA-AI-011` |
| Model license | `licenses[]` from the model card | `CISA-AI-007` |
| Model external references | `externalReferences[]` (repository, DOI, arXiv, license link) | `CISA-AI-014` |

### Datasets cluster

| Element | Where it lands in a cdxgen AI-BOM | Rule |
| --- | --- | --- |
| Dataset name | `components[type=data].name` and `data[].name` | `CISA-AI-009` |
| Dataset description | `description` / `data[].description` from the dataset card | `CISA-AI-015` |
| Dataset content | `data[].contents.url`; a description of the content and its format is not emitted | `CISA-AI-011` |
| Dataset identifier | `purl` with the datasets repository URL, or `data[].contents.url` | `CISA-AI-009` |
| Dataset hash | not emitted; Hub datasets are referenced by repository, not hashed | `CISA-AI-016` |
| Dataset provenance | `supplier.name` and `supplier.url` (the namespace and its Hub page) plus the repository URL; the collection, processing and labelling methods are not emitted | `CISA-AI-011` |
| Dataset statistical properties | the Hub row count and size, folded into the description; distribution statistics are not emitted | `CISA-AI-011` |
| Dataset sensitivity | not emitted; CycloneDX `data[].classification` and `sensitiveData` can carry the producer's declaration | `CISA-AI-011` |
| Dataset dependency relationship | not emitted; the element lists the software used to create and maintain the dataset and the datasets it derives from, which the dataset card does not provide. The `dependencies[]` edges from a model to its datasets record the model's use of them, not this relationship | `CISA-AI-011` |
| Dataset license | `licenses[]` from the dataset card | `CISA-AI-010` |

### Infrastructure, Security Properties and KPI clusters

Infrastructure software is the regular dependency inventory cdxgen already
emits. The other elements need producer documentation a BOM alone cannot
carry, so `CISA-AI-011` reports them for manual review.

| Element | Where it lands in a cdxgen AI-BOM | Rule |
| --- | --- | --- |
| Infrastructure software | `components[]`, the regular dependency inventory | `cisa` benchmark |
| Infrastructure hardware | not emitted; link an HBOM generated separately with the `hbom` command | `CISA-AI-011` |
| Security controls | not emitted; `cdx:ai:unsafeDeserialization` flags a risk in a model file, which is not a control | `CISA-AI-011` |
| Security compliance | not emitted; needs the producer's documentation | `CISA-AI-011` |
| Cybersecurity policy information | not emitted; a link to the producer's `security.txt` | `CISA-AI-011` |
| Vulnerability referencing | not emitted; needs the producer's documentation | `CISA-AI-011` |
| Security metrics | not emitted; needs the producer's documentation | `CISA-AI-011` |
| Operational performance KPIs | not emitted; needs the producer's documentation | `CISA-AI-011` |

## Standards mappings

The AI, agent, and MCP rule packs now include guidance mappings for:

- **OWASP AI Top 10**
- **OWASP Top 10 for Agentic Applications (2026)**
- **EU AI Act**
- **EU Cyber Resilience Act**
- **NIST AI RMF**
- **NIST SSDF**

## Related docs

- [BOM Audit](BOM_AUDIT.md)
- [cdx-audit](CDX_AUDIT.md)
- [MCP Inventory](MCP.md)
- [Agentic CLI tool inventory](AGENTIC_INVENTORY.md)
- [Tutorial: AI-BOM governance and audit](LESSON15.md)

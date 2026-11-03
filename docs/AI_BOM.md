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

On 12 May 2026 CISA and its G7 partners published [Software Bill of Materials
for AI: Minimum Elements](https://www.cisa.gov/resources-tools/resources/software-bill-materials-si-minimum-elements),
a voluntary baseline organised in seven clusters. Its Metadata cluster repeats
the 2026 SBOM minimum elements, so `cdx-validate --benchmark cisa` already
checks those. The AI-specific clusters map onto a cdxgen AI-BOM as follows,
and the checkable elements are rules under `cdx-validate --benchmark cisa-ai`
(rule ids `CISA-AI-001` to `CISA-AI-011`). AI rules pass with a note on a BOM
that holds no AI components.

### Metadata cluster

Checked by the `cisa` benchmark: SBOM author, version, data format name and
version, author signature, tool name and version, generation context,
timestamp and dependency relationship map to `metadata.authors`, `version`,
`bomFormat`/`specVersion`, the JSF `signature` written by `cdx-sign`,
`metadata.tools`, `metadata.lifecycles`, `metadata.timestamp` and
`dependencies[]`, as documented in [CDX_VALIDATE.md](CDX_VALIDATE.md).

### System Level Properties cluster

| Element | Where it lands in a cdxgen AI-BOM | Rule |
| --- | --- | --- |
| System name | `metadata.component.name` | `CISA-AI-001` |
| System components | `components[]` (models, datasets, software) and `services[]` (inference endpoints) | - |
| System producer | `metadata.supplier.name` or `metadata.component.supplier.name` | `CISA-AI-002` |
| System version | `metadata.component.version` | `CISA-AI-001` |
| System timestamp | `metadata.timestamp` records BOM generation; the system's own update time is not recorded separately | - |
| System data flow | `services[].endpoints` for inference and MCP services; a full data-flow graph is not emitted | - |
| System data usage | not emitted; needs the producer's technical documentation | - |
| System input/output properties | `modelCard.modelParameters.inputs[]` / `outputs[]` per model; system-level I/O is not emitted | - |
| Intended application area | `modelCard.considerations.useCases[]` for models with a Hub model card; system-level area is not emitted | - |

### Models cluster

| Element | Where it lands in a cdxgen AI-BOM | Rule |
| --- | --- | --- |
| Model name | `components[type=machine-learning-model].name` | `CISA-AI-003` |
| Model identifier | `purl` (`pkg:huggingface/<namespace>/<name>@<revision>`) | `CISA-AI-005` |
| Model version | `version` (repository sha or revision) | `CISA-AI-003` |
| Model timestamp | `cdx:huggingface:lastModified` property; local-only artifacts have none | - |
| Model producer | `supplier.name`, filled from the Hugging Face namespace or the dosai provider | `CISA-AI-004` |
| Model description | `description` and the CycloneDX `modelCard` | `CISA-AI-008` |
| Model hash value | `hashes[].content` (dosai computes SHA-256 for artifacts) | `CISA-AI-006` |
| Model hash algorithm | `hashes[].alg` | `CISA-AI-006` |
| Model properties | `modelCard.modelParameters` (architecture, task) plus `cdx:ai:*` properties (quantization, parameter count, context window) | - |
| Model input-output properties | `modelCard.modelParameters.inputs[]` / `outputs[]`, including tokenizer-derived I/O for GGUF | - |
| Model training properties | `pedigree.ancestors[]` for lineage; training-technique documentation links ride on `externalReferences` | - |
| Model license | `licenses[]` from the model card | `CISA-AI-007` |
| Model external references | `externalReferences[]` (repository, DOI, arXiv, license link) | - |

### Datasets cluster

| Element | Where it lands in a cdxgen AI-BOM | Rule |
| --- | --- | --- |
| Dataset name | `components[type=data].name` and `data[].name` | `CISA-AI-009` |
| Dataset description | `description` / `data[].description`, including Hub dataset statistics | - |
| Dataset content | `data[].contents` (url); a content description is only kept when the Hub provides one | - |
| Dataset identifier | `purl` with the datasets repository URL, or `data[].contents.url` | `CISA-AI-009` |
| Dataset hash | not emitted | - |
| Dataset provenance | `supplier.name` (the namespace) plus the repository URL; collection and processing methods are not emitted | - |
| Dataset statistical properties | Hub statistics folded into the description | - |
| Dataset sensitivity | not emitted; needs the producer's declaration | - |
| Dataset dependency relationship | `dependencies[]` edges from the model to its datasets | - |
| Dataset license | `licenses[]` from the dataset card | `CISA-AI-010` |

### Infrastructure, Security Properties and KPI clusters

Infrastructure software is the regular dependency inventory cdxgen already
emits. The remaining elements need producer documentation a BOM alone cannot
carry, so `CISA-AI-011` reports them as one manual-review item: infrastructure
hardware (link an HBOM generated separately), security controls (cdxgen only
flags unsafe pickle deserialization through `cdx:ai:unsafeDeserialization`),
security compliance, the producer's `security.txt`, vulnerability referencing,
security metrics and operational KPIs.

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

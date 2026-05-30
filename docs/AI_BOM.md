# AI-BOM Guide

AI-BOM in cdxgen is the CycloneDX-first workflow for cataloging AI usage, model references, prompt/config artifacts, MCP surfaces, and AI-specific BOM audit findings from one scan.

When `--include-formulation` is enabled, cdxgen emits this AI and agentic inventory in the standard CycloneDX `formulation[]` section, so downstream tools can consume it as formal CycloneDX formulation data instead of only as ad-hoc top-level enrichment.

## What AI-BOM covers

cdxgen can already emit AI-related evidence in standard CycloneDX documents, including:

- AI inference services discovered from source or config
- model components and local model artifacts
- prompt and model-routing config files
- AI agent instruction files and skill files
- MCP configs and discovered MCP services

For Hugging Face model repositories, cdxgen now prefers `pkg:huggingface/<namespace>/<name>@<revision>` identifiers when a compliant model repository reference is available.

When model cards reference Hugging Face datasets, cdxgen also keeps those dataset links stable by emitting reusable dataset component references with explicit Hugging Face purls alongside inline dataset summaries where appropriate.

When remote resolution is enabled for a Hugging Face URL or purl, cdxgen now follows the revision-aware Hub endpoints used by the official `huggingface.js` client. This lets AI-BOM preserve explicit purl revisions, remote popularity/runtime hints, and Space-linked model/dataset relationships instead of treating every remote reference as an unversioned HEAD lookup.

You can then audit that BOM with AI-focused rule packs.

## Quick start

```bash
# Generate an AI/ML BOM and run the preferred AI-BOM audit alias
cdxgen -r --include-formulation -o aibom.json --bom-audit --bom-audit-categories ai-bom .

# Same flow via the dedicated AI-BOM CLI
aibom .

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

### Performance

- local AI models with very large context windows
- large local AI models missing quantization metadata

## Recommended workflow

1. Generate the BOM with `--bom-audit --bom-audit-categories ai-bom`
2. Review high and medium findings first
3. Inspect the affected service, file, or model in `cdxi`
4. Re-run the audit after governance or deployment changes

`cdxi` now includes an `.aibom` command that renders an operator-friendly AI view with pedigree trees, fine-tune/distillation lineage, quantization explanations, licenses, and dataset summaries.

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
- [Tutorial: AI-BOM governance and audit](LESSON15.md)

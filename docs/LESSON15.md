# Tutorial: AI-BOM governance and audit

This lesson shows how to generate an AI/ML CycloneDX BOM, audit it with the new `ai-bom` alias, and review the most useful governance, security, and performance signals.

## Goal

By the end of this lesson you should be able to answer:

1. Which AI services and models are in the repository?
2. Which prompt or routing files would ship in a release BOM?
3. Which AI endpoints need transport or governance review?
4. Which local models may be too expensive to run or size correctly?
5. Which Hugging Face models, datasets, or Spaces carry lineage, runtime, or gated-access review signals?

## Step 1: Generate an AI/ML BOM

```bash
cdxgen -r --include-formulation -o aibom.json .
```

Use `-r` for monorepos or mixed-language repositories so cdxgen can collect AI config, model, and service signals from more than one subproject.

## Step 2: Run the AI-BOM audit pack

```bash
cdxgen -r --include-formulation -o aibom.json \
  --bom-audit \
  --bom-audit-categories ai-bom .
```

This single alias enables:

- `ai-governance`
- `ai-security`
- `ai-performance`
- `ai-agent`
- `mcp-server`

## Step 3: Re-audit a saved BOM

```bash
cdx-audit --bom aibom.json --direct-bom-audit --categories ai-bom
```

Use narrower categories when you only need one review track:

```bash
cdx-audit --bom aibom.json --direct-bom-audit --categories ai-governance
cdx-audit --bom aibom.json --direct-bom-audit --categories ai-security
cdx-audit --bom aibom.json --direct-bom-audit --categories ai-performance
```

## Step 3b: Review a direct Hugging Face model or Space

You can also generate an AI-BOM directly from a Hugging Face purl or URL.

```bash
aibom pkg:huggingface/HuggingFaceH4/zephyr-7b-beta@892b3d7a7b1cf10c7a701c60881cd93df615734c
aibom https://huggingface.co/spaces/team/demo-space
```

cdxgen now follows the revision-aware Hugging Face endpoints used by the official client, so explicit purl revisions and `/revision/<rev>` links are preserved during remote metadata lookup.

## Step 4: Review the findings

The current AI-BOM rules are organized around three practical review questions:

| Category         | What to review                                                                       |
| ---------------- | ------------------------------------------------------------------------------------ |
| `ai-governance`  | shipped prompt/config artifacts and services without explicit model IDs              |
| `ai-security`    | remote AI services using insecure HTTP transport                                     |
| `ai-performance` | oversized local context windows and large local models without quantization metadata |

## Step 5: Inspect the BOM in `cdxi`

```bash
cdxi aibom.json
```

Useful follow-up commands:

```text
.auditfindings
.services
.formulation
.inspect <service name or model name>
```

When reviewing a Hugging Face-derived component, pay special attention to:

- `pedigree.ancestors[]` for `base_model` / `finetuned_from` lineage
- `modelCard.modelParameters.datasets[]` and dependency edges for linked datasets
- `modelCard.properties[]` and `cdx:huggingface:*` properties for languages, gated-review posture, downloads, or hosted inference indicators
- Space application dependencies when a Hub Space declares linked models or datasets

## Step 6: Decide what to change

- Pin explicit model identifiers when the code or config leaves routing implicit
- keep prompt and routing files out of shipped build artifacts unless they are intentional release inputs
- require HTTPS for remote AI endpoints
- record quantization and context-window sizing for large local models before rollout
- verify whether gated-access prompts, Hub popularity, or hosted-inference hints change your release review or approval path

## Related docs

- [AI-BOM Guide](AI_BOM.md)
- [BOM Audit](BOM_AUDIT.md)
- [cdx-audit](CDX_AUDIT.md)

#!/usr/bin/env bash
set -e
export HF_HUB_ENABLE_HF_TRANSFER=0
export HF_HUB_DISABLE_TELEMETRY=1
export HF_HUB_DISABLE_PROGRESS_BARS=1
HF_ORG=CycloneDX
TUNING_TOOL=mlx
TOOL_BASE_MODEL=${1:-cdx1}
FUSED_MODEL=${HF_ORG}/${TOOL_BASE_MODEL}-${TUNING_TOOL}
QUANT_MODEL_8BIT=${HF_ORG}/${TOOL_BASE_MODEL}-${TUNING_TOOL}-8bit
QUANT_MODEL_6BIT=${HF_ORG}/${TOOL_BASE_MODEL}-${TUNING_TOOL}-6bit
QUANT_MODEL_4BIT=${HF_ORG}/${TOOL_BASE_MODEL}-${TUNING_TOOL}-4bit
QUANT_MODEL_MXFP4=${HF_ORG}/${TOOL_BASE_MODEL}-${TUNING_TOOL}-MXFP4
DWQ_QUANT_MODEL_4BIT=${HF_ORG}/${TOOL_BASE_MODEL}-${TUNING_TOOL}-4bit-DWQ

hf auth whoami

echo "Uploading datasets"
hf upload --quiet --repo-type dataset CycloneDX/cdx-docs ./cdxgen-docs cdxgen-docs
hf upload --quiet --repo-type dataset CycloneDX/cdx-docs ./guides guides
hf upload --quiet --repo-type dataset CycloneDX/cdx-docs ./semantics semantics

echo "Uploading models. Please wait ..."
hf upload --quiet --exclude "**/README.md" --repo-type model ${QUANT_MODEL_8BIT} ./${QUANT_MODEL_8BIT} --delete "*.safetensors" .
hf upload --quiet --exclude "**/README.md" --repo-type model ${QUANT_MODEL_MXFP4} ./${QUANT_MODEL_MXFP4} --delete "*.safetensors" .
hf upload --quiet --exclude "**/README.md" --repo-type model ${QUANT_MODEL_6BIT} ./${QUANT_MODEL_6BIT} --delete "*.safetensors" .
if [ "$TOOL_BASE_MODEL" != "cdx1-mini" ] && [ "$TOOL_BASE_MODEL" != "cdx1-nano" ]; then
  hf upload --quiet --exclude "**/README.md" --repo-type model ${QUANT_MODEL_4BIT} ./${QUANT_MODEL_4BIT} --delete "*.safetensors" .
fi
#if [ "$TOOL_BASE_MODEL" != "cdx1-mini" ]; then
#  hf upload --quiet --exclude "**/README.md" --repo-type model ${DWQ_QUANT_MODEL_4BIT} ./${DWQ_QUANT_MODEL_4BIT} .
#fi
hf upload --quiet --exclude "**/README.md" --repo-type model ${FUSED_MODEL} ./${FUSED_MODEL} --delete "*.safetensors" .

#!/usr/bin/env bash
set -e
# Path to the latest llama.cpp compiled with all packages installed under conda
# git clone https://github.com/ggerganov/llama.cpp.git
# cd llama.cpp
# conda create --name llama.cpp python=3.12
# conda activate llama.cpp
# python -m pip install -r requirements.txt
# cmake -B build
# cmake --build build --config Release -j $(sysctl -n hw.logicalcpu)

# For uv
# uv venv -p 3.12
# source .venv/bin/activate
# uv pip install -r requirements.txt --index-strategy unsafe-best-match
# cmake -B build
# cmake --build build --config Release -j $(sysctl -n hw.logicalcpu)

# Run 'ollama serve' in a separate terminal

export TOKENIZERS_PARALLELISM=false
LLAMA_CPP_PATH=/Users/appthreat/work/llama.cpp
cd $LLAMA_CPP_PATH
source .venv/bin/activate
CDXGEN_FT_PATH=/Users/appthreat/work/cdxgen/contrib/fine-tuning

TUNING_TOOL=mlx
FORMAT=GGUF
HF_ORG=CycloneDX
TOOL_BASE_MODEL=${1:-cdx1}
MODEL_FILE_PATH=${CDXGEN_FT_PATH}/Modelfile
case "$TOOL_BASE_MODEL" in
  cdx1-nano)
    PARAM_SIZE="1.7B"
    MODEL_FILE_PATH=${CDXGEN_FT_PATH}/Modelfile-nano
    ;;
  cdx1-mini)
    PARAM_SIZE="4B"
    MODEL_FILE_PATH=${CDXGEN_FT_PATH}/Modelfile-mini
    ;;
  cdx1-pro)
    PARAM_SIZE="30B"
    MODEL_FILE_PATH=${CDXGEN_FT_PATH}/Modelfile-pro
    ;;
  cdx1)
    PARAM_SIZE="14B"
    ;;
  *)
    PARAM_SIZE="gguf"
    ;;
esac

GGUF_MODEL_Q8_0_NAME=${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q8_0-${FORMAT}
GGUF_MODEL_Q8_0_PATH=${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q8_0-${FORMAT}
FUSED_MODEL=${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${TUNING_TOOL}

# Direct conversion to 8-bit from the fused BF16 version
rm -rf ${GGUF_MODEL_Q8_0_PATH}
mkdir -p ${GGUF_MODEL_Q8_0_PATH}
python convert_hf_to_gguf.py --outtype q8_0 --outfile ${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q8_0-${FORMAT}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-q8_0.gguf --model-name ${GGUF_MODEL_Q8_0_NAME} ${FUSED_MODEL}
cp ${MODEL_FILE_PATH} ${GGUF_MODEL_Q8_0_PATH}/Modelfile
cp ${FUSED_MODEL}/*.json ${FUSED_MODEL}/merges.txt ${GGUF_MODEL_Q8_0_PATH}/

# BF16
GGUF_MODEL_BF16_NAME=${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-BF16-${FORMAT}
GGUF_MODEL_BF16_PATH=${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-BF16-${FORMAT}
rm -rf ${GGUF_MODEL_BF16_PATH}
mkdir -p ${GGUF_MODEL_BF16_PATH}
python convert_hf_to_gguf.py --outtype bf16 --outfile ${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-BF16-${FORMAT}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-bf16.gguf --model-name ${GGUF_MODEL_BF16_NAME} ${FUSED_MODEL}
cp ${MODEL_FILE_PATH} ${GGUF_MODEL_BF16_PATH}/Modelfile
sed -i '' 's|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-q8_0.gguf|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-bf16.gguf|g' ${GGUF_MODEL_BF16_PATH}/Modelfile
cp ${FUSED_MODEL}/*.json ${FUSED_MODEL}/merges.txt ${GGUF_MODEL_BF16_PATH}/

# MXFP4 - MOE only
GGUF_MODEL_MXFP4_NAME=${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-MXFP4-${FORMAT}
GGUF_MODEL_MXFP4_PATH=${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-MXFP4-${FORMAT}
rm -rf ${GGUF_MODEL_MXFP4_PATH}
mkdir -p ${GGUF_MODEL_MXFP4_PATH}
llama-quantize ${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-BF16-${FORMAT}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-bf16.gguf ${GGUF_MODEL_MXFP4_PATH}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-MXFP4.gguf MXFP4_MOE
cp ${MODEL_FILE_PATH} ${GGUF_MODEL_MXFP4_PATH}/Modelfile
sed -i '' 's|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-q8_0.gguf|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-MXFP4.gguf|g' ${GGUF_MODEL_MXFP4_PATH}/Modelfile
cp ${FUSED_MODEL}/*.json ${FUSED_MODEL}/merges.txt ${GGUF_MODEL_MXFP4_PATH}/

if [ "$TOOL_BASE_MODEL" == "cdx1-mini" ] || [ "$TOOL_BASE_MODEL" == "cdx1-nano" ]; then
  GGUF_MODEL_Q6_K_NAME=${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q6_K-${FORMAT}
  GGUF_MODEL_Q6_K_PATH=${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q6_K-${FORMAT}
  rm -rf ${GGUF_MODEL_Q6_K_PATH}
  mkdir -p ${GGUF_MODEL_Q6_K_PATH}
  llama-quantize ${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-BF16-${FORMAT}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-bf16.gguf ${GGUF_MODEL_Q6_K_PATH}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q6_K.gguf Q6_K
  cp ${MODEL_FILE_PATH} ${GGUF_MODEL_Q6_K_PATH}/Modelfile
  sed -i '' 's|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-q8_0.gguf|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q6_K.gguf|g' ${GGUF_MODEL_Q6_K_PATH}/Modelfile
  cp ${FUSED_MODEL}/*.json ${FUSED_MODEL}/merges.txt ${GGUF_MODEL_Q6_K_PATH}/
else
  GGUF_MODEL_Q4_K_M_NAME=${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q4_K_M-${FORMAT}
  GGUF_MODEL_Q4_K_M_PATH=${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q4_K_M-${FORMAT}
  rm -rf ${GGUF_MODEL_Q4_K_M_PATH}
  mkdir -p ${GGUF_MODEL_Q4_K_M_PATH}
  llama-quantize ${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-BF16-${FORMAT}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-bf16.gguf ${GGUF_MODEL_Q4_K_M_PATH}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q4_K_M.gguf Q4_K_M
  cp ${MODEL_FILE_PATH} ${GGUF_MODEL_Q4_K_M_PATH}/Modelfile
  sed -i '' 's|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-q8_0.gguf|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q4_K_M.gguf|g' ${GGUF_MODEL_Q4_K_M_PATH}/Modelfile
  cp ${FUSED_MODEL}/*.json ${FUSED_MODEL}/merges.txt ${GGUF_MODEL_Q4_K_M_PATH}/

  GGUF_MODEL_IQ4_NL_NAME=${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-IQ4_NL-${FORMAT}
  GGUF_MODEL_IQ4_NL_PATH=${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-IQ4_NL-${FORMAT}
  rm -rf ${GGUF_MODEL_IQ4_NL_PATH}
  mkdir -p ${GGUF_MODEL_IQ4_NL_PATH}
  llama-quantize ${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-BF16-${FORMAT}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-bf16.gguf ${GGUF_MODEL_IQ4_NL_PATH}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-IQ4_NL.gguf IQ4_NL
  cp ${MODEL_FILE_PATH} ${GGUF_MODEL_IQ4_NL_PATH}/Modelfile
  sed -i '' 's|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-q8_0.gguf|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-IQ4_NL.gguf|g' ${GGUF_MODEL_IQ4_NL_PATH}/Modelfile
  cp ${FUSED_MODEL}/*.json ${FUSED_MODEL}/merges.txt ${GGUF_MODEL_IQ4_NL_PATH}/

  GGUF_MODEL_Q2_K_NAME=${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q2_K-${FORMAT}
  GGUF_MODEL_Q2_K_PATH=${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q2_K-${FORMAT}
  rm -rf ${GGUF_MODEL_Q2_K_PATH}
  mkdir -p ${GGUF_MODEL_Q2_K_PATH}
  llama-quantize ${CDXGEN_FT_PATH}/${HF_ORG}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-BF16-${FORMAT}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-bf16.gguf ${GGUF_MODEL_Q2_K_PATH}/${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q2_K.gguf Q2_K
  cp ${MODEL_FILE_PATH} ${GGUF_MODEL_Q2_K_PATH}/Modelfile
  sed -i '' 's|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-q8_0.gguf|./${TOOL_BASE_MODEL}-${PARAM_SIZE}-Q2_K.gguf|g' ${GGUF_MODEL_Q2_K_PATH}/Modelfile
  cp ${FUSED_MODEL}/*.json ${FUSED_MODEL}/merges.txt ${GGUF_MODEL_Q2_K_PATH}/
fi

### Testing with ollama
# cd ${GGUF_MODEL_Q8_0_PATH}
# ollama create cdx1-${FORMAT} -f Modelfile
# ollama show cdx1-${FORMAT}
# ollama run cdx1-${FORMAT} "tell me about cdxgen"

export HF_HUB_ENABLE_HF_TRANSFER=0
hf auth whoami
hf upload --quiet --exclude "**/README.md" --repo-type model ${GGUF_MODEL_Q8_0_NAME} ${GGUF_MODEL_Q8_0_PATH} .
hf upload --quiet --exclude "**/README.md" --repo-type model ${GGUF_MODEL_MXFP4_NAME} ${GGUF_MODEL_MXFP4_PATH} .
if [ "$TOOL_BASE_MODEL" == "cdx1-mini" ] || [ "$TOOL_BASE_MODEL" == "cdx1-nano" ]; then
  hf upload --quiet --exclude "**/README.md" --repo-type model ${GGUF_MODEL_Q6_K_NAME} ${GGUF_MODEL_Q6_K_PATH} .
else
  hf upload --quiet --exclude "**/README.md" --repo-type model ${GGUF_MODEL_Q4_K_M_NAME} ${GGUF_MODEL_Q4_K_M_PATH} .
  hf upload --quiet --exclude "**/README.md" --repo-type model ${GGUF_MODEL_IQ4_NL_NAME} ${GGUF_MODEL_IQ4_NL_PATH} .
  hf upload --quiet --exclude "**/README.md" --repo-type model ${GGUF_MODEL_Q2_K_NAME} ${GGUF_MODEL_Q2_K_PATH} .
fi
hf upload --quiet --exclude "**/README.md" --repo-type model ${GGUF_MODEL_BF16_NAME} ${GGUF_MODEL_BF16_PATH} .

### upload to ollama registry. Move this to a separate script in the future.

ollama pull hf.co/${GGUF_MODEL_Q8_0_NAME}
ollama cp hf.co/${GGUF_MODEL_Q8_0_NAME} ${GGUF_MODEL_Q8_0_NAME}
ollama push ${GGUF_MODEL_Q8_0_NAME}
ollama rm hf.co/${GGUF_MODEL_Q8_0_NAME}

ollama pull hf.co/${GGUF_MODEL_MXFP4_NAME}
ollama cp hf.co/${GGUF_MODEL_MXFP4_NAME} ${GGUF_MODEL_MXFP4_NAME}
ollama push ${GGUF_MODEL_MXFP4_NAME}
ollama rm hf.co/${GGUF_MODEL_MXFP4_NAME}

if [ "$TOOL_BASE_MODEL" == "cdx1-mini" ] || [ "$TOOL_BASE_MODEL" == "cdx1-nano" ]; then
  ollama pull hf.co/${GGUF_MODEL_Q6_K_NAME}
  ollama cp hf.co/${GGUF_MODEL_Q6_K_NAME} ${GGUF_MODEL_Q6_K_NAME}
  ollama push ${GGUF_MODEL_Q6_K_NAME}
  ollama rm hf.co/${GGUF_MODEL_Q6_K_NAME}
else
  ollama pull hf.co/${GGUF_MODEL_Q4_K_M_NAME}
  ollama cp hf.co/${GGUF_MODEL_Q4_K_M_NAME} ${GGUF_MODEL_Q4_K_M_NAME}
  ollama push ${GGUF_MODEL_Q4_K_M_NAME}
  ollama rm hf.co/${GGUF_MODEL_Q4_K_M_NAME}

  ollama pull hf.co/${GGUF_MODEL_IQ4_NL_NAME}
  ollama cp hf.co/${GGUF_MODEL_IQ4_NL_NAME} ${GGUF_MODEL_IQ4_NL_NAME}
  ollama push ${GGUF_MODEL_IQ4_NL_NAME}
  ollama rm hf.co/${GGUF_MODEL_IQ4_NL_NAME}

  ollama pull hf.co/${GGUF_MODEL_Q2_K_NAME}
  ollama cp hf.co/${GGUF_MODEL_Q2_K_NAME} ${GGUF_MODEL_Q2_K_NAME}
  ollama push ${GGUF_MODEL_Q2_K_NAME}
  ollama rm hf.co/${GGUF_MODEL_Q2_K_NAME}
fi

ollama pull hf.co/${GGUF_MODEL_BF16_NAME}
ollama cp hf.co/${GGUF_MODEL_BF16_NAME} ${GGUF_MODEL_BF16_NAME}
ollama push ${GGUF_MODEL_BF16_NAME}
ollama rm hf.co/${GGUF_MODEL_BF16_NAME}

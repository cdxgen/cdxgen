# Introduction

This directory contains numerous knowledge files about CycloneDX and cdxgen in jsonlines chat format. The data is useful for training and fine-tuning (LoRA and QLoRA) LLM models.

## Data Generation

We used Google Gemini 2.0 Flash Experimental via aistudio and used the below prompts to convert markdown and json schema files to the chat format.

```text
you are an expert in converting markdown files to plain text jsonlines format based on the my template. {"messages": [{"role": "user", "content": "<user_question>"}, {"role": "assistant", "content": "<detailed_explanation>"}]}. Understand the contents of the markdown file. Generate 500 possible questions a user might and a detailed explanation to answer the question. Substitute "user_question" with your generated question and "detailed_explanation" with your generated explanation. Escape double quotes and new lines with a backslash \ to make each line a valid json. Generate a plain text response of json line by line without any commas or list. I will start uploading the markdown files in the rest of the chat session.
```

```text
you are an expert in converting json schema files to a single plain text jsonlines format based on the my template. {"messages": [{"role": "user", "content": "<user_question>"}, {"role": "assistant", "content": "<detailed_explanation>"}]}. Understand the contents of the json schema file by reading attributes such as title, description, examples. Generate all possible questions a user might ask about a given property and a long explanation to answer the question. Substitute "user_question" with your generated question and "detailed_explanation" with your generated explanation. Escape double quotes with a backslash \ to make each line a valid json. Generate a plain text response of json line by line without any commas or list. I will start uploading the json files in the rest of the chat session. generate a single plain text response without any markdown formatting for the entire response.
```

```text
you are an expert in converting jsdoc comments to a single plain text jsonlines format based on the my template. {"messages": [{"role": "user", "content": "<user_question>"}, {"role": "assistant", "content": "<detailed_explanation>"}]}. Understand the contents of the jsdoc comments like a javascript developer. Generate at least 200 possible questions a junior engineer might ask about a given function and a long explanation to answer the question based entirely on the jsdoc comment. Substitute "user_question" with your generated question and "detailed_explanation" with your generated explanation. Escape double quotes with a backslash \ to make each line a valid json. Generate a plain text response of json line by line without any commas or list. I will start uploading the js files with cmments in the rest of the chat session. generate a single plain text response without any markdown formatting for the entire response. Do not show your thinking. Do not include any answers guessed.
```

The data was then validated and reviewed manually for accuracy.

## Fine-tuning

### mlx backend

```shell
bash fine-tune-mlx.sh
```

### Testing with LM Studio.

```shell
cp -rf prabhuat ~/.lmstudio/models/
lms ls
lms server status
lms load CycloneDX/cdx1-mlx-8bit --exact --gpu max --identifier cdx1-test --context-length 16000
```

System prompt:

```text
You are a helpful assistant to the user.
```

### Testing with ollama

Create a Modelfile as shown:

```text
FROM hf.co/CycloneDX/cdx1-14B-Q8_0-GGUF

PARAMETER temperature 0.7
PARAMETER min_p 0.0
PARAMETER top_p 0.8
PARAMETER top_k 20
PARAMETER repeat_penalty 1.05

SYSTEM """You are a helpful assistant to the user."""
```

```shell
ollama create cdx1 -f ./Modelfile
```

```text
ollama show cdx1
```

```shell
ollama run cdx1 "Tell me about cdxgen"
```

Use `hf.co/CycloneDX/cdx1-gguf-BF16-GGUF` for higher precision needs.

### Validating jsonlines files

```shell
node bomValidator.js
```

## Citation

### For datasets

```
@misc{cdx-docs,
  author = {OWASP CycloneDX Generator Team},
  month = Feb,
  title = {{CycloneDX and cdxgen}},
  howpublished = {{https://huggingface.co/datasets/CycloneDX/cdx-docs}},
  year = {2025}
}
```

### For the models

```
@misc{cdx1,
  author = {OWASP CycloneDX Generator Team},
  month = Feb,
  title = {{CycloneDX and cdxgen}},
  howpublished = {{https://huggingface.co/models/CycloneDX}},
  year = {2025}
}
```

## Datasets License

CC-0

## Models License

Apache-2.0

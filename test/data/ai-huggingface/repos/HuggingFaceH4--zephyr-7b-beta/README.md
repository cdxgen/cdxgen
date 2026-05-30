---
base_model: mistralai/Mistral-7B-v0.1
base_model_relation: adapter
co2_eq_emissions:
  emissions: 123.4
  hardware_used: 1x A100
  source: AutoTrain
  training_type: fine-tuning
datasets:
  - HuggingFaceH4/ultrachat_200k
extra_gated_fields:
  company: text
extra_gated_prompt: Research access request
finetuned_from: mistralai/Mistral-7B-v0.1
language:
  - en
language_bcp47:
  - en-US
library_name: transformers
license: mit
mask_token: <mask>
pipeline_tag: text-generation
model-index:
  - name: zephyr-7b-beta
    results:
      - task:
          type: text-generation
        dataset:
          name: mt-bench
          split: test
        metrics:
          - type: MT-Bench
            value: 7.34
          - type: AlpacaEval
            value: 90.6
tags:
  - chat
  - summarization
widget:
  - messages:
      - role: user
        content: Hello
    output:
      text: Hi
---

# Zephyr 7B Beta

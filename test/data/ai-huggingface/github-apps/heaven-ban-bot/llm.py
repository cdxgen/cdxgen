import torch
import requests
from transformers import pipeline, AutoTokenizer
from accelerate import Accelerator

class LLM:
  def __init__(self, model_name="meta-llama/Llama-2-7b-chat-hf", llm_api=None):
    self.llm_api = llm_api

    if self.llm_api is None:
      tokenizer = AutoTokenizer.from_pretrained(model_name)
      pipeline = pipeline(
          "text-generation",
          model=model_name,
          torch_dtype=torch.float16,
          device_map="auto",
          trust_remote_code=True
      )
      self.pipeline = pipeline
      self.tokenizer = tokenizer

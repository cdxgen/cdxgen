import { HfInference } from '@huggingface/inference';

export const createChatCompletion = (client: HfInference, payload, instance) => {
  return client.chatCompletionStream({
    endpointUrl: instance.baseURL,
    max_tokens: payload.max_tokens ?? 4096,
    messages: payload.messages,
    model: payload.model,
    stream: true,
    temperature: payload.temperature,
  });
};

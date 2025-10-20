import fetch from 'node-fetch';
export class OpenAIClient {
    constructor(config) {
        this.config = config;
    }
    async createEmbeddings(inputs, signal) {
        if (!inputs.length) {
            return { vectors: [] };
        }
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.config.openaiApiKey}`,
            },
            body: JSON.stringify({
                model: this.config.openaiEmbeddingModel,
                input: inputs,
            }),
            signal,
        });
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`OpenAI embeddings failed (${response.status}): ${detail}`);
        }
        const payload = await response.json();
        const vectors = Array.isArray(payload?.data)
            ? payload.data.map((item) => item?.embedding).filter(Array.isArray)
            : [];
        if (!vectors.length) {
            throw new Error('OpenAI embedding response did not include vectors.');
        }
        return { vectors };
    }
    async chatCompletion(messages, options = {}, signal) {
        const { model, temperature, maxTokens, responseFormat } = options;
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.config.openaiApiKey}`,
            },
            body: JSON.stringify({
                model: model ?? this.config.openaiChatModel,
                temperature: temperature ?? 0.2,
                messages,
                ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
                ...(responseFormat ? { response_format: responseFormat } : {}),
            }),
            signal,
        });
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`OpenAI chat completion failed (${response.status}): ${detail}`);
        }
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
            throw new Error('OpenAI chat completion returned empty content.');
        }
        const usage = payload?.usage;
        return {
            content,
            usage: usage
                ? {
                    promptTokens: usage.prompt_tokens ?? 0,
                    completionTokens: usage.completion_tokens ?? 0,
                    totalTokens: usage.total_tokens ?? 0,
                }
                : undefined,
        };
    }
}

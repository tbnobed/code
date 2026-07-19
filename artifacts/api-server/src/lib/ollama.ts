import OpenAI from "openai";

export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "qwen3-coder-next";

export const ollama = new OpenAI({
  baseURL: `${OLLAMA_BASE_URL}/v1`,
  apiKey: "ollama", // Ollama ignores the key but the SDK requires one
});

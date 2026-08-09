/**
 * Ollama connection settings.
 *
 * Read from env (see `.env.example`) with documented fallbacks, so a fresh
 * clone runs against a stock local Ollama without editing code. Nothing here
 * is a secret — v1 talks only to localhost — but it stays configurable so a
 * user with Ollama on another port or machine never has to touch source.
 */
export const OLLAMA_HOST: string =
  import.meta.env.VITE_OLLAMA_HOST || "http://localhost:11434";

export const OLLAMA_MODEL: string =
  import.meta.env.VITE_OLLAMA_MODEL || "qwen2.5:7b";

/**
 * Typed wrapper over the Rust Ollama commands.
 *
 * Its only job is transport + turning error codes into sentences a user can
 * act on. It knows nothing about narration.
 */
import { invoke } from "@tauri-apps/api/core";

export interface OllamaErrorShape {
  code: string;
  message: string;
}

export class OllamaError extends Error {
  code: string;
  detail: string;

  constructor(shape: OllamaErrorShape) {
    super(friendlyMessage(shape));
    this.name = "OllamaError";
    this.code = shape.code;
    this.detail = shape.message;
  }
}

function friendlyMessage({ code, message }: OllamaErrorShape): string {
  switch (code) {
    case "OLLAMA_UNREACHABLE":
      return "Can't reach Ollama. Start it with `ollama serve` (or `brew services start ollama`), then try again.";
    case "MODEL_NOT_FOUND":
      return "That model isn't installed. Pull it first with `ollama pull <model>`, then try again.";
    case "TIMEOUT":
      return "Ollama took too long to respond. It may still be loading the model — try again in a moment.";
    case "BAD_RESPONSE":
      return "Ollama sent a response this app couldn't read.";
    default:
      return message || "Something went wrong talking to Ollama.";
  }
}

/** Narrow an unknown thrown value into an OllamaError where possible. */
export function asOllamaError(err: unknown): OllamaError {
  if (err instanceof OllamaError) return err;
  if (typeof err === "object" && err !== null && "code" in err) {
    return new OllamaError(err as OllamaErrorShape);
  }
  return new OllamaError({
    code: "UNKNOWN",
    message: err instanceof Error ? err.message : String(err),
  });
}

export interface GenerateArgs {
  host: string;
  model: string;
  prompt: string;
  system?: string;
  /** JSON Schema for constrained decoding, when structured output is wanted. */
  format?: unknown;
  temperature?: number;
  seed?: number;
}

export async function generate(args: GenerateArgs): Promise<string> {
  try {
    return await invoke<string>("ollama_generate", {
      host: args.host,
      model: args.model,
      prompt: args.prompt,
      system: args.system ?? null,
      format: args.format ?? null,
      temperature: args.temperature ?? null,
      seed: args.seed ?? null,
    });
  } catch (err) {
    throw asOllamaError(err);
  }
}

/** Installed model tags, used to distinguish "server down" from "model missing". */
export async function listModels(host: string): Promise<string[]> {
  try {
    return await invoke<string[]>("ollama_health", { host });
  } catch (err) {
    throw asOllamaError(err);
  }
}

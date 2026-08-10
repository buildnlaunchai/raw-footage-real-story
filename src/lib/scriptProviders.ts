/**
 * Where scripts get written.
 *
 * Local Ollama (free) and OpenAI (paid), following the same capability-flag
 * shape as the voice providers. The composer already takes an injected
 * `GenerateFn` carrying a `tier` hint, so a whole new provider slots in without
 * `scriptComposerCore.ts` changing at all.
 */
import { invoke } from "@tauri-apps/api/core";
import { OLLAMA_HOST, OLLAMA_MODEL, OLLAMA_MODEL_QUALITY } from "../config/ollama";
import { generate as ollamaGenerate } from "./ollama";

export type ScriptProviderId = "local" | "openai";

/** Named tiers rather than raw model ids, which age badly and ask users to
 *  have opinions about model names. */
export type QualityTier = "balanced" | "best";

export const OPENAI_MODELS = {
  fast: "gpt-5.6-luna",
  balanced: "gpt-5.6-terra",
  best: "gpt-5.6-sol",
} as const;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ScriptProviderCapabilities {
  isCloud: boolean;
  needsApiKey: boolean;
  billing: "free-local" | "per-token";
  /** Ollama constrains decoding; OpenAI enforces a strict schema. */
  structuredOutput: "constrained" | "strict-schema";
  /** Only OpenAI can decline a request as a distinct outcome. */
  refusalsDetectable: boolean;
  /**
   * Whether non-English output has been checked. Deliberately not set to
   * "strong" for OpenAI until the Bengali comparison actually passes — the
   * point of running it is that we don't know yet.
   */
  nonEnglishQuality: "unverified" | "poor" | "strong";
}

export interface GenerateArgs {
  system?: string;
  prompt: string;
  format?: unknown;
  temperature?: number;
  seed?: number;
  numCtx?: number;
  tier?: "fast" | "quality";
}

export interface ScriptProvider {
  id: ScriptProviderId;
  label: string;
  blurb: string;
  capabilities: ScriptProviderCapabilities;
}

export const SCRIPT_PROVIDERS: Record<ScriptProviderId, ScriptProvider> = {
  local: {
    id: "local",
    label: "Local (Ollama)",
    blurb: "Runs on this machine. Free, offline.",
    capabilities: {
      isCloud: false,
      needsApiKey: false,
      billing: "free-local",
      structuredOutput: "constrained",
      refusalsDetectable: false,
      // Measured: qwen2.5's Bengali was not usable.
      nonEnglishQuality: "poor",
    },
  },
  openai: {
    id: "openai",
    label: "OpenAI (cloud)",
    blurb: "Your OpenAI account. Billed per token.",
    capabilities: {
      isCloud: true,
      needsApiKey: true,
      billing: "per-token",
      structuredOutput: "strict-schema",
      refusalsDetectable: true,
      nonEnglishQuality: "unverified",
    },
  },
};

/** Tokens consumed by one run, accumulated across its many calls. */
export class UsageMeter {
  input = 0;
  output = 0;
  calls = 0;

  add(u: TokenUsage) {
    this.input += u.inputTokens;
    this.output += u.outputTokens;
    this.calls += 1;
  }

  get total(): number {
    return this.input + this.output;
  }
}

/**
 * Rough prompt size before spending anything.
 *
 * Deliberately approximate and labelled as such: real tokenisation depends on
 * the model, and the exact figure arrives with the response anyway.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build the transport the composer injects.
 *
 * `meter` accumulates the measured token counts that come back with each
 * response, which is the only cost signal available — a normal API key cannot
 * read account spend, since OpenAI's usage endpoints require an admin key.
 */
export function makeGenerateFn(
  providerId: ScriptProviderId,
  tier: QualityTier,
  meter?: UsageMeter,
): (args: GenerateArgs) => Promise<string> {
  if (providerId === "local") {
    return ({ tier: t, ...args }) =>
      ollamaGenerate({
        host: OLLAMA_HOST,
        model: t === "quality" ? OLLAMA_MODEL_QUALITY : OLLAMA_MODEL,
        ...args,
      });
  }

  return async ({ tier: t, numCtx: _numCtx, ...args }) => {
    const model = t === "quality" ? OPENAI_MODELS[tier] : OPENAI_MODELS.fast;
    const result = await invoke<{ text: string; usage: TokenUsage }>("openai_generate", {
      model,
      prompt: args.prompt,
      system: args.system ?? null,
      format: args.format ?? null,
      temperature: args.temperature ?? null,
      seed: args.seed ?? null,
    });
    meter?.add(result.usage);
    return result.text;
  };
}

export async function testOpenAiKey(apiKey: string): Promise<TokenUsage> {
  return invoke<TokenUsage>("openai_test_key", { apiKey, model: OPENAI_MODELS.fast });
}

/** Does this model honour temperature and seed? Reported, never assumed. */
export async function probeSampling(model: string): Promise<{
  model: string;
  rejectedParameters: string | null;
  answers: string[];
  deterministic: boolean;
}> {
  return invoke("openai_probe_sampling", { model });
}

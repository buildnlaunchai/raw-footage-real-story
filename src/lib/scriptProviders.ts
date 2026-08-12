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
import { asScriptProviderError } from "./providerErrors";

export { ScriptProviderError, asScriptProviderError } from "./providerErrors";

/** Named tiers rather than raw model ids, which age badly and ask users to
 *  have opinions about model names. */
export type QualityTier = "balanced" | "best";

export const OPENAI_MODELS = {
  fast: "gpt-5.6-luna",
  balanced: "gpt-5.6-terra",
  best: "gpt-5.6-sol",
} as const;


export type ScriptProviderId = "local" | "openai";

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
   * Whether temperature and seed can be sent at all.
   *
   * The GPT-5.6 family rejects both outright with a 400 — temperature as
   * "unsupported", seed as "unknown" — so this is not a quality knob but a
   * hard constraint. Measured, not assumed.
   */
  supportsSampling: boolean;
  /**
   * Whether non-English output has been checked, and how it did.
   *
   * Each value is a claim someone ran a comparison to earn, on Bengali, which
   * is the language this app was actually asked about. "unverified" is the
   * honest default for a provider nobody has tested — it is not a soft "poor".
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
      supportsSampling: true,
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
      supportsSampling: false,
      // Measured on Hajj/Umrah descriptions against the qwen2.5 baseline:
      // none of the failures that made the local model unusable recurred.
      nonEnglishQuality: "strong",
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
    return async ({ tier: t, ...args }) => {
      try {
        return await ollamaGenerate({
          host: OLLAMA_HOST,
          model: t === "quality" ? OLLAMA_MODEL_QUALITY : OLLAMA_MODEL,
          ...args,
        });
      } catch (err) {
        throw asScriptProviderError(err);
      }
    };
  }

  return async ({ tier: t, numCtx: _numCtx, ...args }) => {
    const model = t === "quality" ? OPENAI_MODELS[tier] : OPENAI_MODELS.fast;
    try {
      const result = await invoke<{ text: string; usage: TokenUsage }>("openai_generate", {
        model,
        prompt: args.prompt,
        system: args.system ?? null,
        format: args.format ?? null,
        // Deliberately dropped: this model family rejects both with a 400
        // rather than ignoring them. See supportsSampling.
        temperature: null,
        seed: null,
      });
      meter?.add(result.usage);
      return result.text;
    } catch (err) {
      // Converted here rather than at the top level so every caller — including
      // the composer's own internal catches — sees a real Error.
      throw asScriptProviderError(err);
    }
  };
}

export async function testOpenAiKey(apiKey: string): Promise<TokenUsage> {
  try {
    return await invoke<TokenUsage>("openai_test_key", { apiKey, model: OPENAI_MODELS.fast });
  } catch (err) {
    throw asScriptProviderError(err);
  }
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

// --- writing instructions ---------------------------------------------------
//
// The instruction given to the script writer, editable without a rebuild. The
// Bengali register work was a code change for what is really a piece of
// writing, and the person best placed to tune it is whoever speaks the
// language — not whoever can rebuild the app.

/** The stored override, or null when the built-in wording is in use. */
export async function getWritingInstructions(): Promise<string | null> {
  try {
    return (await invoke<string | null>("writing_instructions_get")) ?? null;
  } catch {
    return null;
  }
}

export async function setWritingInstructions(text: string | null): Promise<void> {
  await invoke("writing_instructions_set", { instructions: text });
}

/** Whether new scripts get an opening line. On unless the user turned it off. */
export async function getIntroEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>("intro_enabled_get");
  } catch {
    return true;
  }
}

export async function setIntroEnabled(enabled: boolean): Promise<void> {
  await invoke("intro_enabled_set", { enabled });
}

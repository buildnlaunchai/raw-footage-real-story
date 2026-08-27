/**
 * Where scripts get written.
 *
 * OpenAI (paid, recommended) and local Ollama (free, offline), following the
 * same capability-flag shape as the voice providers. The composer already
 * takes an injected `GenerateFn` carrying a `tier` hint, so a whole new
 * provider slots in without `scriptComposerCore.ts` changing at all.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  /**
   * Roughly how many words are being asked for.
   *
   * Only used to decide how long to wait — now as the budget for the whole
   * poll loop rather than as one request's timeout. A long script needs a
   * longer one than a title does.
   */
  words?: number;
  /**
   * Called while a cloud generation is still running.
   *
   * There is nothing to report for a local model, which streams nothing and
   * blocks. For OpenAI the request is made in background mode and polled, so
   * there is now a real status to show — and, when the platform is paying,
   * which is worth saying out loud rather than leaving a member to wonder
   * whose bill this is.
   *
   * NOT a percentage, and there will not be one: the Responses API reports a
   * state, not progress. "Still writing" is the honest thing to show.
   */
  onProgress?: (p: GenerateProgress) => void;
}

/** What the backend emits while a cloud generation is in flight. */
export interface GenerateProgress {
  /** OpenAI's own word: `queued` or `in_progress`. */
  status: string;
  elapsedSecs: number;
  /** `byok` when it is the member's key, `credit` when the platform is paying. */
  mode: string;
}

export interface ScriptProvider {
  id: ScriptProviderId;
  label: string;
  blurb: string;
  /**
   * The one we tell a new user to start with.
   *
   * Exactly one provider carries this. It is a product recommendation and so
   * it is fixed, unlike `recommendedScriptRoute` in `readiness.ts`, which
   * answers the different question of what *this* machine should be set to
   * right now — a machine with working local models and no key is better off
   * on Ollama whatever the badge says.
   */
  recommended?: boolean;
  capabilities: ScriptProviderCapabilities;
}

/**
 * Listed cloud-first, and the order is load-bearing: this record is what the
 * picker iterates, so whichever key comes first is the chip a new user reads
 * first. Local ran first until the download it implies — about fourteen
 * gigabytes before a single word gets written — turned out to be the thing
 * standing between a fresh install and a first script.
 */
export const SCRIPT_PROVIDERS: Record<ScriptProviderId, ScriptProvider> = {
  openai: {
    id: "openai",
    label: "OpenAI (cloud)",
    blurb: "Recommended. Nothing to download; billed per token to your own OpenAI account.",
    recommended: true,
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
  local: {
    id: "local",
    label: "Local (Ollama)",
    blurb: "Runs fully offline and costs nothing, after a one-time download of about 14 GB.",
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

  return async ({ tier: t, numCtx: _numCtx, words, onProgress, ...args }) => {
    const model = t === "quality" ? OPENAI_MODELS[tier] : OPENAI_MODELS.fast;
    // Subscribed before the call and dropped in `finally`, the same shape the
    // voice providers use. Without a listener the backend's emit goes nowhere,
    // which is a working app that looks frozen for two minutes.
    const unlisten = onProgress
      ? await listen<GenerateProgress>("openai:progress", (e) => onProgress(e.payload))
      : undefined;
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
        words: words ?? null,
      });
      meter?.add(result.usage);
      return result.text;
    } catch (err) {
      // Converted here rather than at the top level so every caller — including
      // the composer's own internal catches — sees a real Error.
      throw asScriptProviderError(err);
    } finally {
      unlisten?.();
    }
  };
}

// `testOpenAiKey` was here. It validated a key before the app saved it, which
// was worth doing while there was a field to paste one into. There is not: the
// key comes from the account, so there is nothing to validate ahead of time and
// nothing to save. See `accountKeys.ts`.

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

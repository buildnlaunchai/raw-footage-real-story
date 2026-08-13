/**
 * Stage C bound to the Tauri transport. All logic lives in
 * `scriptComposerCore`, which is dependency-free so selection, ordering and
 * word-count targeting can be tested against a real Ollama without a webview.
 */
import type { ProjectClip } from "./project";
import { languageFor } from "./languages";
import {
  makeGenerateFn,
  UsageMeter,
  type QualityTier,
  type ScriptProviderId,
} from "./scriptProviders";
import {
  composeScript,
  shortenToFit,
  writeHook,
  type ComposeOptions,
  type ScriptDraft,
  type ScriptStyle,
} from "./scriptComposerCore";

export {
  SCRIPT_STYLES,
  ScriptComposeError,
  flattenCandidates as candidatesOf,
  overBudget,
  unitBudget,
  HOOK_MIN_WORDS,
  HOOK_MAX_WORDS,
  hookLengthOk,
  introducedNames,
  properNouns,
  targetSegmentCount,
  countWords,
  flattenCandidates,
} from "./scriptComposerCore";
export type {
  ScriptStyle,
  ScriptDraft,
  ScriptLineDraft,
  ComposeProgress,
  Candidate,
} from "./scriptComposerCore";

export interface ScriptRunResult extends ScriptDraft {
  /** Populated for paid providers; the only cost signal a normal key can read. */
  usage?: { inputTokens: number; outputTokens: number; calls: number };
}

export async function generateScriptForTitle(
  clips: ProjectClip[],
  options: ComposeOptions & {
    provider?: ScriptProviderId;
    qualityTier?: QualityTier;
  },
): Promise<ScriptRunResult> {
  const provider = options.provider ?? "local";
  const meter = new UsageMeter();
  const draft = await composeScript(
    makeGenerateFn(provider, options.qualityTier ?? "balanced", meter),
    // Mapped by hand rather than passed through. The two types name the same
    // thing differently — `sourceDurationMs` here, `durationMs` there — and
    // the field is optional, so handing the project's clips straight over
    // bound nothing and silently turned every per-clip word budget off.
    clips.map((c) => ({
      id: c.id,
      durationMs: c.sourceDurationMs,
      segments: c.segments,
    })),
    options,
  );
  return provider === "openai"
    ? { ...draft, usage: { inputTokens: meter.input, outputTokens: meter.output, calls: meter.calls } }
    : draft;
}

/**
 * Rewrite only the opening line.
 *
 * The hook is the one line most likely to be tried a few times — it is short,
 * it is the first thing anyone hears, and taste decides it. Regenerating the
 * whole script to change it would throw away narration the user has already
 * approved and, on a paid provider, bill for it again.
 */
export async function generateHookForScript(
  material: { title: string; moments: string[]; lines: string[] },
  options: {
    language?: string;
    style?: ScriptStyle;
    seed?: number;
    provider?: ScriptProviderId;
    qualityTier?: QualityTier;
  } = {},
): Promise<string | null> {
  const provider = options.provider ?? "local";
  return await writeHook(
    makeGenerateFn(provider, options.qualityTier ?? "balanced", new UsageMeter()),
    material,
    options,
  );
}

/**
 * Shorten one line so it fits the clip it is spoken over.
 *
 * Offered as a button rather than run automatically once a script exists. The
 * pass during generation is welcome to rewrite a machine's own draft; silently
 * replacing a sentence somebody typed by hand is a different thing entirely.
 */
export async function shortenLineToFit(
  text: string,
  budget: number,
  language: string,
  opts: { provider?: ScriptProviderId; qualityTier?: QualityTier; instructions?: string } = {},
): Promise<string | null> {
  return await shortenToFit(
    makeGenerateFn(opts.provider ?? "local", opts.qualityTier ?? "balanced", new UsageMeter()),
    text,
    budget,
    languageFor(language),
    { instructions: opts.instructions },
  );
}

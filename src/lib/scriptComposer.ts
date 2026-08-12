/**
 * Stage C bound to the Tauri transport. All logic lives in
 * `scriptComposerCore`, which is dependency-free so selection, ordering and
 * word-count targeting can be tested against a real Ollama without a webview.
 */
import type { ProjectClip } from "./project";
import {
  makeGenerateFn,
  UsageMeter,
  type QualityTier,
  type ScriptProviderId,
} from "./scriptProviders";
import {
  composeScript,
  writeHook,
  type ComposeOptions,
  type ScriptDraft,
  type ScriptStyle,
} from "./scriptComposerCore";

export {
  SCRIPT_STYLES,
  ScriptComposeError,
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
    clips,
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

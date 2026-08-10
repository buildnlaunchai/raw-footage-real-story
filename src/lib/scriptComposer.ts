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
import { composeScript, type ComposeOptions, type ScriptDraft } from "./scriptComposerCore";

export {
  SCRIPT_STYLES,
  ScriptComposeError,
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

/**
 * Stage C bound to the Tauri transport. All logic lives in
 * `scriptComposerCore`, which is dependency-free so selection, ordering and
 * word-count targeting can be tested against a real Ollama without a webview.
 */
import { OLLAMA_HOST, OLLAMA_MODEL, OLLAMA_MODEL_QUALITY } from "../config/ollama";
import { generate } from "./ollama";
import type { ProjectClip } from "./project";
import { composeScript, type ComposeOptions, type ScriptDraft } from "./scriptComposerCore";

export {
  SCRIPT_STYLES,
  ScriptComposeError,
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

export async function generateScriptForTitle(
  clips: ProjectClip[],
  options: ComposeOptions & { host?: string; model?: string; qualityModel?: string },
): Promise<ScriptDraft> {
  const host = options.host ?? OLLAMA_HOST;
  const fast = options.model ?? OLLAMA_MODEL;
  const quality = options.qualityModel ?? OLLAMA_MODEL_QUALITY;
  return composeScript(
    ({ tier, ...args }) =>
      generate({ host, model: tier === "quality" ? quality : fast, ...args }),
    clips,
    options,
  );
}

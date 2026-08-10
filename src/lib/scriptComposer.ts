/**
 * Stage C bound to the Tauri transport. All logic lives in
 * `scriptComposerCore`, which is dependency-free so selection, ordering and
 * word-count targeting can be tested against a real Ollama without a webview.
 */
import { OLLAMA_HOST, OLLAMA_MODEL } from "../config/ollama";
import { generate } from "./ollama";
import type { ProjectClip } from "./project";
import { composeScript, type ComposeOptions, type ScriptDraft } from "./scriptComposerCore";

export {
  ScriptComposeError,
  targetSegmentCount,
  countWords,
  flattenCandidates,
} from "./scriptComposerCore";
export type {
  ScriptDraft,
  ScriptLineDraft,
  ComposeProgress,
  Candidate,
} from "./scriptComposerCore";

export async function generateScriptForTitle(
  clips: ProjectClip[],
  options: ComposeOptions & { host?: string; model?: string },
): Promise<ScriptDraft> {
  const host = options.host ?? OLLAMA_HOST;
  const model = options.model ?? OLLAMA_MODEL;
  return composeScript((args) => generate({ host, model, ...args }), clips, options);
}

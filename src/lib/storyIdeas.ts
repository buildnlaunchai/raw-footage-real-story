/**
 * Stage B bound to the Tauri transport. All logic lives in `storyIdeasCore`,
 * which is dependency-free so the map-reduce orchestration can be tested
 * against a real Ollama without a webview.
 */
import { OLLAMA_HOST, OLLAMA_MODEL } from "../config/ollama";
import { generate } from "./ollama";
import type { ProjectClip } from "./project";
import {
  suggestStoryIdeasWith,
  type StoryIdea,
  type StoryIdeaOptions,
} from "./storyIdeasCore";

export {
  StoryIdeaError,
  NUM_CTX,
  BATCH_SIZE,
  flattenSegments,
  chunk,
  dedupe,
} from "./storyIdeasCore";
export type { StoryIdea, IdeaProgress, FlatSegment } from "./storyIdeasCore";

export async function suggestStoryIdeas(
  clips: ProjectClip[],
  options: StoryIdeaOptions & { host?: string; model?: string } = {},
): Promise<StoryIdea[]> {
  const host = options.host ?? OLLAMA_HOST;
  const model = options.model ?? OLLAMA_MODEL;
  return suggestStoryIdeasWith(
    (args) => generate({ host, model, ...args }),
    clips,
    options,
  );
}

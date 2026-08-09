/**
 * Pipeline stage 1 — clip descriptions in, narration script out.
 *
 * Self-contained on purpose: the prompt, the output contract, and the parsing
 * all live here, so this stage can be swapped (different model, different
 * provider, different narration style) without touching the UI or Rust.
 *
 * Output strategy: constrained JSON first, numbered lines as a fallback.
 * Both were measured at 5/5 on qwen2.5:7b across seeds, but JSON mode was
 * observed returning a schema-valid empty array when the system prompt was
 * weak — so the fallback earns its keep rather than being defensive padding.
 */
import { OLLAMA_HOST, OLLAMA_MODEL } from "../config/ollama";
import { generate } from "./ollama";
import { parseJsonSentences, parseNumbered } from "./scriptParsing";
import type { Clip, ScriptLine } from "./types";

export class ScriptGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptGenerationError";
  }
}

const SYSTEM_PROMPT = [
  "You write concise documentary voiceover narration for travel footage.",
  "You write exactly one sentence per clip, in the order given.",
  "Each sentence describes only what that clip shows.",
  "Never invent details that are not in the description.",
  "Keep each sentence under 25 words and easy to read aloud.",
].join(" ");

const responseSchema = (count: number) => ({
  type: "object",
  properties: {
    sentences: {
      type: "array",
      minItems: count,
      maxItems: count,
      items: { type: "string" },
    },
  },
  required: ["sentences"],
});

function clipBlock(clips: Clip[]): string {
  return clips.map((c, i) => `${i + 1}. ${c.description.trim()}`).join("\n");
}

export interface GenerateScriptOptions {
  host?: string;
  model?: string;
  temperature?: number;
  /** Fixed seed makes a run reproducible; omit for variety between runs. */
  seed?: number;
}

export async function generateScript(
  clips: Clip[],
  options: GenerateScriptOptions = {},
): Promise<ScriptLine[]> {
  const usable = clips.filter((c) => c.description.trim().length > 0);
  if (usable.length === 0) {
    throw new ScriptGenerationError(
      "Add a description to at least one clip before generating a script.",
    );
  }

  const host = options.host ?? OLLAMA_HOST;
  const model = options.model ?? OLLAMA_MODEL;
  const temperature = options.temperature ?? 0.7;
  const base = { host, model, system: SYSTEM_PROMPT, temperature, seed: options.seed };
  const block = clipBlock(usable);

  // Attempt 1 — constrained JSON.
  const jsonText = await generate({
    ...base,
    prompt:
      `Clips:\n${block}\n\n` +
      `Return JSON with a "sentences" array containing exactly ${usable.length} ` +
      `narration sentences, one per clip, in order.`,
    format: responseSchema(usable.length),
  });
  let sentences = parseJsonSentences(jsonText);

  // Attempt 2 — plain numbered lines.
  if (sentences.length !== usable.length) {
    const plainText = await generate({
      ...base,
      prompt:
        `Clips:\n${block}\n\n` +
        `Write ${usable.length} sentences of narration, one per clip, in order. ` +
        `Output only the numbered sentences, nothing else.`,
    });
    sentences = parseNumbered(plainText);
  }

  if (sentences.length !== usable.length) {
    // Better to fail loudly than to pair sentences with the wrong clips.
    throw new ScriptGenerationError(
      `Expected ${usable.length} sentences but the model returned ${sentences.length}. Try generating again.`,
    );
  }

  return usable.map((clip, i) => ({ clipId: clip.id, text: sentences[i].trim() }));
}

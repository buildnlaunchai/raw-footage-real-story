/**
 * Pipeline stage B — what stories does this footage support?
 *
 * Input is every described segment in the project, which at the scale this
 * targets (300 clips x ~6 segments) is far more text than a 7B model can read
 * in one pass. So this is map-reduce: summarise batches of segments into
 * themes, then propose titles from the themes.
 *
 * Two things make that necessary rather than cautious:
 *
 *  - Ollama defaults `num_ctx` to 2048 tokens whatever the model advertises,
 *    and **silently truncates** beyond it. A single-pass prompt would not fail;
 *    it would quietly ignore most of the trip.
 *  - Even with the context raised, 1800 segments is roughly 27k words, which
 *    exceeds qwen2.5's 32k window once the prompt and answer are counted.
 *
 * Titles are derived only from what is in the clips. Nothing here knows
 * anything about the user.
 */
/** Minimal shape of a described clip; avoids importing the Tauri-bound types. */
export interface DescribedClip {
  id: string;
  segments: { startSec: number; endSec: number; text: string }[];
}

/** Injected so the orchestration can be exercised without the Tauri runtime. */
export type GenerateFn = (args: {
  system?: string;
  prompt: string;
  format?: unknown;
  temperature?: number;
  seed?: number;
  numCtx?: number;
}) => Promise<string>;

/** Comfortably inside qwen2.5's window, with room for the answer. */
export const NUM_CTX = 8192;

/**
 * Segments per summarisation batch. ~120 segments is roughly 1.8k words, well
 * inside the context above, and keeps a 1800-segment library to ~15 calls
 * rather than the ~45 a smaller batch would need.
 */
export const BATCH_SIZE = 120;

export interface StoryIdea {
  title: string;
  angle: string;
}

export interface IdeaProgress {
  stage: "reading" | "thinking";
  done: number;
  total: number;
}

export class StoryIdeaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryIdeaError";
  }
}

/** One described moment, flattened out of the clip library. */
export interface FlatSegment {
  clipId: string;
  segmentIndex: number;
  text: string;
  durationSec: number;
}

export function flattenSegments(clips: DescribedClip[]): FlatSegment[] {
  const out: FlatSegment[] = [];
  for (const clip of clips) {
    clip.segments.forEach((s, i) => {
      const text = s.text.trim();
      if (!text) return;
      out.push({
        clipId: clip.id,
        segmentIndex: i,
        text,
        durationSec: Math.max(0, s.endSec - s.startSec),
      });
    });
  }
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const THEME_SYSTEM =
  "You catalogue what is present in raw video footage. " +
  "You list only what the descriptions actually mention. " +
  "You never invent people, places, feelings or events that are not stated.";

const TITLE_SYSTEM =
  "You propose short documentary video titles for a set of travel footage. " +
  "Every title must be supported by the material you are given. " +
  "Titles are concrete and specific, never generic marketing phrases. " +
  "You never invent locations or events that are not present in the material.";

const THEMES_SCHEMA = {
  type: "object",
  properties: {
    themes: { type: "array", items: { type: "string" } },
  },
  required: ["themes"],
};

const IDEAS_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, angle: { type: "string" } },
        required: ["title", "angle"],
      },
    },
  },
  required: ["ideas"],
};

function parseThemes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { themes?: unknown };
    if (!Array.isArray(parsed.themes)) return [];
    return parsed.themes
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter(Boolean);
  } catch {
    // Fall back to line parsing: a themes list is the kind of thing a model
    // will happily return as prose if constrained decoding slips.
    return raw
      .split("\n")
      .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim())
      .filter((l) => l.length > 2 && l.length < 200);
  }
}

function parseIdeas(raw: string): StoryIdea[] {
  try {
    const parsed = JSON.parse(raw) as { ideas?: unknown };
    if (!Array.isArray(parsed.ideas)) return [];
    return parsed.ideas
      .filter(
        (i): i is { title: string; angle: string } =>
          typeof i === "object" &&
          i !== null &&
          typeof (i as StoryIdea).title === "string",
      )
      .map((i) => ({ title: i.title.trim(), angle: (i.angle ?? "").trim() }))
      .filter((i) => i.title.length > 0);
  } catch {
    return [];
  }
}

/** De-duplicate case-insensitively while preserving order. */
export function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().replace(/\s+/g, " ").trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

export interface StoryIdeaOptions {
  count?: number;
  seed?: number;
  onProgress?: (p: IdeaProgress) => void;
}

/**
 * Propose story angles the footage can actually support.
 *
 * Small libraries skip the map phase entirely — summarising six segments into
 * themes and then reading the themes back loses detail for no benefit.
 */
export async function suggestStoryIdeasWith(
  generate: GenerateFn,
  clips: DescribedClip[],
  options: StoryIdeaOptions = {},
): Promise<StoryIdea[]> {
  const segments = flattenSegments(clips);
  if (segments.length === 0) {
    throw new StoryIdeaError(
      "Describe at least one clip before asking for story ideas.",
    );
  }

  const count = options.count ?? 5;
  const base = { temperature: 0.8, seed: options.seed, numCtx: NUM_CTX };

  const batches = chunk(segments, BATCH_SIZE);
  let material: string;

  if (batches.length === 1) {
    // Small enough to reason over directly; keep the detail.
    material = segments.map((s) => `- ${s.text}`).join("\n");
  } else {
    const themes: string[] = [];
    for (let i = 0; i < batches.length; i++) {
      options.onProgress?.({ stage: "reading", done: i, total: batches.length });
      const list = batches[i].map((s) => `- ${s.text}`).join("\n");
      const raw = await generate({
        ...base,
        system: THEME_SYSTEM,
        prompt:
          `Footage descriptions:\n${list}\n\n` +
          `List the distinct subjects, places and recurring visual motifs present above. ` +
          `Return JSON with a "themes" array of short phrases. Do not invent anything.`,
        format: THEMES_SCHEMA,
      });
      themes.push(...parseThemes(raw));
    }
    options.onProgress?.({ stage: "reading", done: batches.length, total: batches.length });

    const merged = dedupe(themes);
    if (merged.length === 0) {
      throw new StoryIdeaError(
        "Couldn't make sense of the clip descriptions. Try adding more detail to them.",
      );
    }
    material = merged.map((t) => `- ${t}`).join("\n");
  }

  options.onProgress?.({ stage: "thinking", done: 0, total: 1 });
  const raw = await generate({
    ...base,
    system: TITLE_SYSTEM,
    prompt:
      `Material available in this footage:\n${material}\n\n` +
      `Propose ${count} genuinely different videos that could be cut from this ` +
      `footage. They should differ in angle, not just wording — a place, a ` +
      `journey, a single day, a recurring detail. Return JSON with an "ideas" ` +
      `array; each item has a "title" (under 8 words) and an "angle" (one ` +
      `sentence on what that video would be about).`,
    format: IDEAS_SCHEMA,
  });
  options.onProgress?.({ stage: "thinking", done: 1, total: 1 });

  const ideas = parseIdeas(raw);
  if (ideas.length === 0) {
    throw new StoryIdeaError("The model didn't return any usable story ideas. Try again.");
  }

  // Distinct titles only; a list with the same idea twice is worse than a
  // shorter list.
  const seen = new Set<string>();
  return ideas.filter((i) => {
    const key = i.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

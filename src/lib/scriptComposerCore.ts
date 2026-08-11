/**
 * Pipeline stage C — turn a chosen title into a selected, ordered script.
 *
 * This supersedes the original stage 1, which assumed "every clip, in upload
 * order, exactly one sentence each". That assumption cannot survive a 300-clip
 * library: a story is a *subset* in *story order*, and some moments deserve two
 * sentences while others deserve none.
 *
 * The old flow is not kept as a parallel mode. Its behaviour is a special case
 * of this one — select everything, keep upload order, one line each — and
 * maintaining two code paths to preserve a shape nothing needs would be
 * carrying cost for its own sake.
 *
 * Selection is map-reduce for the same reason story ideas are: the whole
 * library does not fit in a 7B model's context, and Ollama truncates silently
 * rather than complaining.
 *
 * Dependency-free and transport-injected, so the whole flow is testable
 * against a real Ollama without a webview.
 */

import {
  countUnits,
  languageFor,
  lengthInstruction,
  type ScriptLanguage,
} from "./languages";

export interface DescribedClip {
  id: string;
  segments: { startSec: number; endSec: number; text: string }[];
}

export type GenerateFn = (args: {
  system?: string;
  prompt: string;
  format?: unknown;
  temperature?: number;
  seed?: number;
  numCtx?: number;
  /**
   * Which model tier to use. Selection is a mechanical filtering job that a 7B
   * does well and is run many times over; the final write happens once and is
   * the thing the viewer actually hears, so it earns the slower model.
   */
  tier?: "fast" | "quality";
}) => Promise<string>;

export const NUM_CTX = 8192;
export const BATCH_SIZE = 120;

/** Roughly how many words of narration one segment tends to carry. */
export const WORDS_PER_SEGMENT = 18;

/** Narration styles the user can pick before generating. */
export type ScriptStyle = "cinematic" | "casual" | "emotional" | "fast";

export const SCRIPT_STYLES: { id: ScriptStyle; label: string; hint: string }[] = [
  { id: "cinematic", label: "Cinematic", hint: "measured, observational, documentary" },
  { id: "casual", label: "Casual / vlog", hint: "spoken, warm, first person" },
  { id: "emotional", label: "Emotional", hint: "reflective, personal, unhurried" },
  { id: "fast", label: "Fast-paced / reel", hint: "short punchy lines, present tense" },
];

const STYLE_DIRECTION: Record<ScriptStyle, string> = {
  cinematic:
    "Style: cinematic documentary. Measured and observational. Let the images carry the " +
    "weight; state what is there and trust it. Third person, present or past tense, " +
    "sentences of varying length.",
  casual:
    "Style: casual vlog. Spoken, warm, first person plural (\"we\"). Contractions are fine. " +
    "It should sound like someone talking over their own footage, not reading an essay.",
  emotional:
    "Style: reflective and personal. Unhurried. Allow one moment to land before moving to " +
    "the next. Feeling is conveyed through what is noticed, never by naming the emotion.",
  fast: "Style: fast-paced reel. Short punchy lines, present tense, minimal connective " +
    "tissue. Every line earns its place. No line longer than about twelve words.",
};

/**
 * Few-shot examples of narration that works.
 *
 * These exist because the default failure mode of a small model asked for
 * "vivid" writing is a pile of interchangeable adjectives — stunning, breathtaking,
 * beautiful — that would fit any footage anywhere. Showing what specificity
 * looks like moves the output far more reliably than adjectives in an
 * instruction ever does.
 */
const FEW_SHOT = `Examples of the standard expected.

Moments: harbour at dawn, boats iced in / fisherman scraping a deck / gulls on a piling
Narration:
1. The harbour did not so much freeze as stop, boats caught mid-turn where the water took them.
2. One man was out early, scraping his deck clear with the back of a shovel.
3. The gulls had the pilings to themselves and seemed to know it.

Moments: mountain road empty / rain crossing the valley / sheep on the tarmac
Narration:
1. The road ran forty miles without meeting another car.
2. Rain moved across the valley in a single sheet, arriving long after we watched it start.
3. The sheep had no opinion about the road being ours.

Moments: plane descending at sunrise / frost on the cabin window / first light on the wing
Narration:
1. We came down through cloud into a morning that had already been going for hours.
2. Frost had drawn itself across the inside of the window overnight.
3. The light caught the wing first, then everything else at once.

Note what these do: name specific things, prefer a concrete verb to an adjective,
and never describe a scene as beautiful, stunning or breathtaking. Those words
describe the writer's reaction, not the footage, and would fit any clip anywhere.`;

export interface Candidate {
  ref: number;
  clipId: string;
  segmentIndex: number;
  text: string;
}

export interface ScriptLineDraft {
  clipId: string;
  segmentIndex: number;
  text: string;
}

export interface ScriptDraft {
  title: string;
  lines: ScriptLineDraft[];
  words: number;
  /** How many segments were considered before narrowing. */
  consideredSegments: number;
}

export interface ComposeProgress {
  stage: "selecting" | "writing" | "critiquing" | "adjusting";
  done: number;
  total: number;
}

export class ScriptComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptComposeError";
  }
}

export function flattenCandidates(clips: DescribedClip[]): Candidate[] {
  const out: Candidate[] = [];
  for (const clip of clips) {
    clip.segments.forEach((s, i) => {
      const text = s.text.trim();
      if (text) {
        out.push({ ref: out.length, clipId: clip.id, segmentIndex: i, text });
      }
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

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** How many segments a script of this length wants. */
export function targetSegmentCount(wordCount: number): number {
  return Math.max(3, Math.min(40, Math.round(wordCount / WORDS_PER_SEGMENT)));
}

/**
 * How many moments to ask for, given how many actually exist.
 *
 * The word target implies a segment count, but footage is the hard limit: a
 * library of three clips cannot supply six distinct moments. Asking anyway is
 * what produced scripts that returned to the same clip twice in a row, because
 * the only way to satisfy the request was to reuse footage. Fewer, longer lines
 * over real moments is the honest reading of "110 words".
 */
export function momentsToRequest(wordCount: number, available: number): number {
  return Math.max(1, Math.min(targetSegmentCount(wordCount), available));
}

const SELECT_SYSTEM =
  "You choose which moments of raw footage belong in a specific video. " +
  "You only ever choose from the numbered moments you are given. " +
  "You never invent moments, and you never choose one that does not fit the title.";

const WRITE_SYSTEM_BASE =
  "You write documentary voiceover narration for travel footage. " +
  "You write only about what the given moments actually show. " +
  "You never invent places, people or events. " +
  "You prefer a specific noun or a concrete verb to any adjective. " +
  "The narration reads aloud naturally and carries the viewer from one moment to the next.";

/// The banned words are English; naming them when writing Bengali would be
/// noise at best and a nudge toward English at worst.
const WRITE_SYSTEM_EN =
  `${WRITE_SYSTEM_BASE} ` +
  "You never use the words beautiful, stunning, breathtaking, amazing or incredible; " +
  "they describe a reaction rather than the footage.";

function writeSystemFor(lang: ScriptLanguage): string {
  if (lang.code === "en") return WRITE_SYSTEM_EN;
  return (
    `${WRITE_SYSTEM_BASE} ` +
    `You write entirely in ${lang.label} (${lang.nativeLabel}), in natural idiomatic ` +
    `${lang.label} — not translated English. Never include English words or ` +
    `transliteration unless they are proper nouns with no ${lang.label} form. ` +
    `Avoid vague praise words; describe what is there. ` +
    // Asked only for "natural and idiomatic", a model writes the register it
    // has read most of, which is books. This narration is going to be spoken
    // aloud over someone's holiday footage, so it has to sound like speech.
    `This script will be read aloud, so write speech: the contemporary spoken ` +
    `register, plain modern vocabulary, sentences a person could say in one ` +
    `breath. Not literary, not archaic, not formal written prose. ` +
    (lang.registerHint ? `${lang.registerHint} ` : "")
  );
}

/**
 * Capitalised tokens: the candidates for invention.
 *
 * A model asked to be more vivid will add a fisherman, a village name, a
 * mountain — things the footage never showed. Proper nouns are the detectable
 * form of that, and the one that misleads a viewer most directly.
 */
export function properNouns(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z'’-]+\b/g)) {
    out.add(m[0].toLowerCase());
  }
  return out;
}

/** Every word in a text, lowercased. */
function allWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z'’-]+/)
      .filter(Boolean),
  );
}

/**
 * Names the revision introduced that appear nowhere in the source material.
 *
 * Candidates are capitalised words, but they are checked against **every** word
 * of the source regardless of case. That distinction is the whole guard: a
 * sentence starting "Frost had etched…" capitalises an ordinary word that the
 * footage description already contains in lower case, and comparing only
 * capitalised forms would flag it as invented. Doing that would reject nearly
 * every honest revision and quietly disable the feature.
 *
 * The residual gap: a genuinely invented name that only ever appears at the
 * start of a sentence, and happens to match a source word. Rare enough to
 * accept, and it fails safe — the worst case is a revision that gets through,
 * not one wrongly rejected.
 */
export function introducedNames(revision: string, allowed: string): string[] {
  const permitted = allWords(allowed);
  return [...properNouns(revision)].filter((n) => !permitted.has(n));
}

const CRITIQUE_SYSTEM =
  "You improve documentary narration by first diagnosing what is weak about it. " +
  "You work only with what the footage already shows. " +
  "You never add a person, place, object or event that is not in the source material — " +
  "making writing vivid means being more specific about what is there, never inventing " +
  "something new. " +
  "You never use the words beautiful, stunning, breathtaking, amazing or incredible.";

const CRITIQUE_SCHEMA = (count: number) => ({
  type: "object",
  properties: {
    // Diagnosis first, in the same response: naming the weakness before
    // rewriting is what makes this a critique rather than another attempt.
    weaknesses: { type: "array", items: { type: "string" } },
    lines: {
      type: "array",
      minItems: count,
      maxItems: count,
      items: { type: "string" },
    },
  },
  required: ["weaknesses", "lines"],
});

const REFS_SCHEMA = {
  type: "object",
  properties: { refs: { type: "array", items: { type: "integer" } } },
  required: ["refs"],
};

const SCRIPT_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { ref: { type: "integer" }, text: { type: "string" } },
        required: ["ref", "text"],
      },
    },
  },
  required: ["lines"],
};

function parseRefs(raw: string, valid: Set<number>): number[] {
  let refs: number[] = [];
  try {
    const parsed = JSON.parse(raw) as { refs?: unknown };
    if (Array.isArray(parsed.refs)) {
      refs = parsed.refs.filter((r): r is number => Number.isInteger(r));
    }
  } catch {
    refs = [...raw.matchAll(/\b\d+\b/g)].map((m) => Number(m[0]));
  }
  // A hallucinated ref is silently dropped rather than allowed to index into
  // the wrong footage.
  const seen = new Set<number>();
  return refs.filter((r) => valid.has(r) && !seen.has(r) && (seen.add(r), true));
}

function listFor(candidates: Candidate[]): string {
  return candidates.map((c) => `${c.ref}. ${c.text}`).join("\n");
}

export interface ComposeOptions {
  title: string;
  wordCount: number;
  style?: ScriptStyle;
  /** BCP-47-ish code from `languages.ts`. Defaults to English. */
  language?: string;
  /** Self-critique and revise pass. On by default; costs one extra call. */
  critique?: boolean;
  seed?: number;
  onProgress?: (p: ComposeProgress) => void;
}

/**
 * Choose the moments this story needs, in the order it needs them.
 *
 * Large libraries are shortlisted batch by batch first, so no single prompt has
 * to hold the whole trip.
 */
export async function selectSegments(
  generate: GenerateFn,
  candidates: Candidate[],
  options: ComposeOptions,
): Promise<Candidate[]> {
  const want = momentsToRequest(options.wordCount, candidates.length);
  // Selection is mechanical filtering run many times over: the fast model.
  const base = {
    temperature: 0.4,
    seed: options.seed,
    numCtx: NUM_CTX,
    tier: "fast" as const,
  };
  const byRef = new Map(candidates.map((c) => [c.ref, c]));

  let pool = candidates;
  if (candidates.length > want * 4) {
    const batches = chunk(candidates, BATCH_SIZE);
    // Keep enough per batch that the final pass has real choice, without
    // letting the shortlist grow back to the size of the library.
    const perBatch = Math.max(2, Math.ceil((want * 3) / batches.length));
    const shortlist: Candidate[] = [];

    for (let i = 0; i < batches.length; i++) {
      options.onProgress?.({ stage: "selecting", done: i, total: batches.length });
      const batch = batches[i];
      const raw = await generate({
        ...base,
        system: SELECT_SYSTEM,
        format: REFS_SCHEMA,
        prompt:
          `Video title: "${options.title}"\n\nMoments:\n${listFor(batch)}\n\n` +
          `Choose up to ${perBatch} moments above that best serve this video. ` +
          `If none fit, return an empty list. Return JSON with a "refs" array of ` +
          `the numbers you chose.`,
      });
      const picked = parseRefs(raw, new Set(batch.map((c) => c.ref)));
      shortlist.push(...picked.map((r) => byRef.get(r)!).filter(Boolean));
    }
    options.onProgress?.({ stage: "selecting", done: batches.length, total: batches.length });

    // If shortlisting found nothing usable, fall back to the whole library
    // rather than producing an empty video.
    pool = shortlist.length >= Math.min(want, 3) ? shortlist : candidates;
  }

  // Final pass: pick and order.
  const raw = await generate({
    ...base,
    system: SELECT_SYSTEM,
    format: REFS_SCHEMA,
    prompt:
      `Video title: "${options.title}"\n\nMoments:\n${listFor(pool)}\n\n` +
      `Choose about ${want} moments for this video and put them in the order ` +
      `the story should tell them — which is not necessarily the order above. ` +
      `Return JSON with a "refs" array of the numbers, in your chosen order.`,
  });

  const ordered = parseRefs(raw, new Set(pool.map((c) => c.ref)))
    .map((r) => byRef.get(r)!)
    .filter(Boolean);

  if (ordered.length === 0) {
    // Better a sensible default than an empty script.
    return pool.slice(0, want);
  }
  return ordered;
}

/** Write narration over the chosen moments, aiming at the word target. */
export async function writeScript(
  generate: GenerateFn,
  selected: Candidate[],
  options: ComposeOptions,
): Promise<ScriptLineDraft[]> {
  // The final write happens once and is what the viewer hears: the better model.
  const base = {
    temperature: 0.7,
    seed: options.seed,
    numCtx: NUM_CTX,
    tier: "quality" as const,
  };
  const style = STYLE_DIRECTION[options.style ?? "cinematic"];
  const lang = languageFor(options.language ?? "en");

  // The few-shot examples are English prose. Shown to a model writing Bengali
  // they would teach the rhythm of translated English, which is precisely the
  // failure they exist to prevent — so non-English relies on the style
  // direction alone. Native examples per language are a real improvement, but
  // they need a fluent writer, not a machine translation of these.
  const preamble = lang.code === "en" ? `${FEW_SHOT}\n\n---\n\n` : "";
  const inLanguage =
    lang.code === "en" ? "" : `Write every line in ${lang.label} (${lang.nativeLabel}).\n\n`;

  const raw = await generate({
    ...base,
    system: writeSystemFor(lang),
    format: SCRIPT_SCHEMA,
    prompt:
      preamble +
      `Video title: "${options.title}"\n\n${style}\n\n${inLanguage}` +
      `Moments, in order:\n${listFor(selected)}\n\n` +
      `Write the narration for this video. The whole script should be ` +
      `${lengthInstruction(options.wordCount, lang)}. Write exactly one line per ` +
      `moment, using each moment number once; a moment that carries more of the ` +
      `story may have a longer line. ` +
      `Return JSON with a "lines" array, each item having "ref" (the moment ` +
      `number) and "text".`,
  });

  const byRef = new Map(selected.map((c) => [c.ref, c]));
  let lines: ScriptLineDraft[] = [];
  try {
    const parsed = JSON.parse(raw) as { lines?: { ref: number; text: string }[] };
    if (Array.isArray(parsed.lines)) {
      lines = collapseByMoment(
        parsed.lines.filter(
          (l) => byRef.has(l.ref) && typeof l.text === "string" && l.text.trim(),
        ),
        byRef,
      );
    }
  } catch {
    lines = [];
  }
  return lines;
}

/**
 * Fold every line about one moment into a single line.
 *
 * A moment is a piece of footage, and the timeline shows it once, for as long
 * as its narration takes. Asked for 110 words over three clips the model
 * reasonably writes two sentences per clip — but emitted as separate lines they
 * become separate timeline items, so the same footage plays twice in a row, and
 * both claim the identity `clipId#segmentIndex` that the timeline addresses
 * lines by. Joining them keeps every word and restores the invariant: one line
 * per moment, each with an identity of its own.
 *
 * Order follows each moment's first mention, so the story keeps the sequence
 * the model chose.
 */
function collapseByMoment(
  written: { ref: number; text: string }[],
  byRef: Map<number, Candidate>,
): ScriptLineDraft[] {
  const order: number[] = [];
  const textsByRef = new Map<number, string[]>();
  for (const l of written) {
    if (!textsByRef.has(l.ref)) {
      textsByRef.set(l.ref, []);
      order.push(l.ref);
    }
    textsByRef.get(l.ref)!.push(l.text.trim());
  }
  return order.map((ref) => ({
    clipId: byRef.get(ref)!.clipId,
    segmentIndex: byRef.get(ref)!.segmentIndex,
    text: textsByRef.get(ref)!.join(" "),
  }));
}

/**
 * Full stage C: select, order, write, and correct the length if it lands wide.
 *
 * A single length-correction pass is worth it because word count is a stated
 * user requirement; more than one is not, because the model tends to oscillate
 * rather than converge.
 */
export async function composeScript(
  generate: GenerateFn,
  clips: DescribedClip[],
  options: ComposeOptions,
): Promise<ScriptDraft> {
  if (!options.title.trim()) {
    throw new ScriptComposeError("Choose or write a title first.");
  }
  const candidates = flattenCandidates(clips);
  if (candidates.length === 0) {
    throw new ScriptComposeError("Describe at least one clip before generating a script.");
  }
  const lang = languageFor(options.language ?? "en");

  const selected = await selectSegments(generate, candidates, options);

  options.onProgress?.({ stage: "writing", done: 0, total: 1 });
  let lines = await writeScript(generate, selected, options);
  options.onProgress?.({ stage: "writing", done: 1, total: 1 });

  if (lines.length === 0) {
    throw new ScriptComposeError(
      "The model didn't return a usable script. Try again, or pick a different title.",
    );
  }

  // --- self-critique and revise ------------------------------------------
  //
  // One call, not two: a separate critique then revise costs double and reads
  // worse, because the model treats a handed-over critique as a checklist to
  // acknowledge rather than a thing to act on. Forcing the diagnosis to precede
  // the rewrite *in the same response* is what makes it bite.
  if (options.critique !== false) {
    options.onProgress?.({ stage: "critiquing", done: 0, total: 1 });
    const sourceMaterial = selected.map((c) => c.text).join(" ");
    const draftText = lines.map((l) => l.text).join(" ");
    const numbered = lines.map((l, i) => `${i + 1}. ${l.text}`).join("\n");

    try {
      const raw = await generate({
        system: `${CRITIQUE_SYSTEM}${
          lang.code === "en" ? "" : ` You write entirely in ${lang.label} (${lang.nativeLabel}).`
        }`,
        temperature: 0.6,
        seed: options.seed,
        numCtx: NUM_CTX,
        tier: "quality",
        format: CRITIQUE_SCHEMA(lines.length),
        prompt:
          `The footage shows only this:\n${selected.map((c) => `- ${c.text}`).join("\n")}\n\n` +
          `Draft narration for "${options.title}":\n${numbered}\n\n` +
          `First, list what is weak about this draft. Look for: lines that would fit ` +
          `any footage anywhere; adjectives doing work a concrete noun or verb should ` +
          `do; every line having the same length and rhythm; anything claimed that the ` +
          `footage above does not show.\n\n` +
          `Then rewrite it, fixing what you found. Keep exactly ${lines.length} lines in ` +
          `the same order, each about the same moment, totalling ` +
          `${lengthInstruction(options.wordCount, lang)}. Do not introduce any person, ` +
          `place or thing that is not in the footage above.\n\n` +
          `Return JSON with "weaknesses" (your diagnosis) and "lines" ` +
          `(${lines.length} rewritten strings).`,
      });

      const parsed = JSON.parse(raw) as { weaknesses?: unknown; lines?: unknown };
      const revised = Array.isArray(parsed.lines)
        ? parsed.lines.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        : [];

      if (revised.length === lines.length) {
        // Hard gate: a revision that invents is rejected outright, however
        // well it reads. Asking for vividness invites invention, so this is
        // the guard that makes the whole pass safe to run by default.
        // The guard keys on capitalisation, which only exists in some scripts.
        // Bengali, Arabic, Chinese and others have no case, so it would find
        // nothing and wave everything through — better to say so here than to
        // imply a check that is not happening.
        const guardApplies = lang.direction === "ltr" && /[A-Za-z]/.test(revised.join(" "));
        const invented = guardApplies
          ? introducedNames(revised.join(" "), `${sourceMaterial} ${draftText} ${options.title}`)
          : [];
        if (invented.length === 0) {
          lines = lines.map((l, i) => ({ ...l, text: revised[i].trim() }));
        }
      }
    } catch {
      // A malformed critique keeps the draft. A failed improvement is not a
      // failed script.
    }
    options.onProgress?.({ stage: "critiquing", done: 1, total: 1 });
  }

  // Measured in this language's own unit; whitespace words are meaningless
  // for Chinese, Japanese and Thai.
  let words = lines.reduce((n, l) => n + countUnits(l.text, lang), 0);
  const target = lang.counting === "characters"
    ? Math.round(options.wordCount * (lang.code === "th" ? 4.0 : lang.code === "ja" ? 2.0 : 1.6))
    : options.wordCount;
  const low = target * 0.7;
  const high = target * 1.3;

  if (words < low || words > high) {
    options.onProgress?.({ stage: "adjusting", done: 0, total: 1 });
    const direction = words < low ? "longer" : "shorter";
    const current = lines
      .map((l, i) => `${i + 1}. ${l.text}`)
      .join("\n");
    const raw = await generate({
      system: writeSystemFor(lang),
      temperature: 0.5,
      seed: options.seed,
      numCtx: NUM_CTX,
      tier: "quality",
      format: {
        type: "object",
        properties: {
          lines: {
            type: "array",
            minItems: lines.length,
            maxItems: lines.length,
            items: { type: "string" },
          },
        },
        required: ["lines"],
      },
      prompt:
        `This narration is ${words} ${lang.counting === "characters" ? "characters" : "words"}; ` +
        `it needs to be ${lengthInstruction(options.wordCount, lang)}.\n\n` +
        `${current}\n\n` +
        `Rewrite it ${direction}, keeping exactly ${lines.length} lines in the same ` +
        `order and each line about the same moment. Return JSON with a "lines" ` +
        `array of ${lines.length} strings.`,
    });
    try {
      const parsed = JSON.parse(raw) as { lines?: unknown };
      if (Array.isArray(parsed.lines) && parsed.lines.length === lines.length) {
        const revised = parsed.lines.filter((t): t is string => typeof t === "string");
        if (revised.length === lines.length) {
          // Only accept the rewrite if it actually moved toward the target.
          const revisedWords = revised.reduce((n, t) => n + countUnits(t, lang), 0);
          if (Math.abs(revisedWords - target) < Math.abs(words - target)) {
            lines = lines.map((l, i) => ({ ...l, text: revised[i].trim() }));
            words = revisedWords;
          }
        }
      }
    } catch {
      // Keep the original script; a failed correction is not a failed script.
    }
    options.onProgress?.({ stage: "adjusting", done: 1, total: 1 });
  }

  return {
    title: options.title,
    lines,
    words,
    consideredSegments: candidates.length,
  };
}

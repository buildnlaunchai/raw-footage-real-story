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
/**
 * How many words one moment carries.
 *
 * Lowered from 18: at 18 a 110-word script used six moments however much
 * footage existed, so a forty-clip library got fifteen percent of an airing.
 * Fourteen cuts about a third more often, which still reads as pacing rather
 * than a slideshow — below roughly ten it starts to strobe.
 */
export const WORDS_PER_SEGMENT = 14;

/**
 * A length that would actually use the footage.
 *
 * The mismatch this fixes is not that the app picks too few moments — it is
 * that nobody told you 110 words could only ever be six of them. Offered, never
 * imposed: a short film from a large library is a legitimate choice, just not
 * one anybody should make by accident.
 */
export function suggestedWordCount(availableMoments: number): number {
  const raw = Math.max(1, availableMoments) * WORDS_PER_SEGMENT;
  // Rounded to something a person would have typed, and capped: past about six
  // minutes of narration this stops being a rough cut.
  const capped = Math.min(raw, 900);
  return Math.max(60, Math.round(capped / 10) * 10);
}

export interface Coverage {
  /** Moments this length can carry. */
  used: number;
  /** Moments the library could offer. */
  available: number;
  percent: number;
}

/** What a given length does with the footage on hand. */
export function coverageFor(wordCount: number, availableMoments: number): Coverage {
  const used = momentsToRequest(wordCount, availableMoments);
  return {
    used,
    available: availableMoments,
    percent: availableMoments === 0 ? 0 : Math.round((used / availableMoments) * 100),
  };
}

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
  /**
   * The opening line, spoken over the montage before the film starts.
   *
   * Null when it was turned off, or when the model could not write one the
   * right length — an opening is an addition, never a precondition.
   */
  hook?: string | null;
}

export interface ComposeProgress {
  stage: "selecting" | "writing" | "critiquing" | "adjusting" | "hook";
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
  "The narration reads aloud naturally and carries the viewer from one moment to the next. " +
  // The lines are read in sequence, and the model writes each one as though it
  // were the first. That produced consecutive lines that both introduced the
  // same subject — one line about a tiger followed by another announcing "the
  // royal bengal tiger" — which reads as though the video restarted.
  "Each line follows the one before it, so you introduce a subject once and " +
  "afterwards refer back to it: 'it', 'they', 'the same path'. You never " +
  "re-announce something the previous line already named, and you never begin " +
  "consecutive lines the same way. " +
  // The register complaint, generalised: the output was correct and stiff.
  "You write the way a person talks, not the way a brochure is written. Short " +
  "sentences. No throat-clearing, no 'welcome to', no 'join us as we', no " +
  "summing up at the end of a line what the line just said.";

/// The banned words are English; naming them when writing Bengali would be
/// noise at best and a nudge toward English at worst.
const WRITE_SYSTEM_EN =
  `${WRITE_SYSTEM_BASE} ` +
  "You never use the words beautiful, stunning, breathtaking, amazing or incredible; " +
  "they describe a reaction rather than the footage.";

/**
 * The instruction the writer is given.
 *
 * Exported so Settings can show exactly what will be sent. An override
 * replaces it wholesale rather than being appended: a box that silently adds
 * to hidden text cannot be reasoned about, and the point of exposing this is
 * that what you read is what the model gets.
 */
export function defaultWritingInstructions(lang: ScriptLanguage): string {
  return writeSystemFor(lang);
}

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

// --- the opening hook -----------------------------------------------------
//
// One spoken line that runs over the opening montage, before the film proper
// begins. It is not part of the script the rest of the app reasons about: it
// maps to no moment, it is written after the body rather than with it, and it
// is left out of the word target and the critique pass.
//
// Left out on purpose. The word target is a promise about how long the film
// is, and twenty words of opening would silently eat into it. The critique
// pass judges lines against the moment they narrate, and the hook narrates
// none — asked to check it, the model reliably "fixes" it into a description
// of the first clip, which is exactly what an opening must not be.

/**
 * The length a hook is asked for. A montage is short and cuts fast, so this is
 * what the prompt names and what the UI describes.
 */
export const HOOK_MIN_WORDS = 12;
export const HOOK_MAX_WORDS = 25;

/**
 * The length a hook is *refused* below — which is not the same number.
 *
 * Measured against a live 7B writing Bengali: natural openings came back at
 * five to nine words, because Bengali carries in one whitespace token what
 * English spreads over three. Enforcing the English floor rejected two hooks
 * in three and left the feature effectively broken outside English.
 *
 * The ceiling is the one that protects anything — a paragraph read over a
 * montage is a paragraph read over a montage in any language. A short opening
 * is just a short opening, and "The road ran forty miles" is a fine one.
 */
export const HOOK_FLOOR_WORDS = 5;

const HOOK_SYSTEM_BASE =
  "You write the opening line of a short travel film — the sentence that plays " +
  "over the first few seconds before the film proper starts. " +
  "One or two sentences, spoken aloud, and nothing else. " +
  // Every failure mode here is a form of announcing rather than opening.
  "You never say the title, never say 'welcome to', 'join us', 'in this video', " +
  "'today we', or name the film. You do not summarise what is coming. " +
  "You do not describe the first shot; the pictures are doing that already. " +
  "You say the thing that makes someone stay — a fact, a contradiction, a " +
  "question the footage answers — and you take it only from the trip below.";

/**
 * Openings that work, and the ones a small model reaches for instead.
 *
 * Measured: with the instruction alone, a 7B returned "the harbour held its
 * breath", "ice sealing the dreams of boats still dreaming" and "frost clung
 * like forgotten dreams" — the same interchangeable-poetry failure the body's
 * examples exist to prevent, concentrated into the one line everybody hears.
 * Showing the standard moves output far more than describing it does.
 *
 * English only, for the same reason the body's are: shown to a model writing
 * Bengali they would teach the rhythm of translated English.
 */
const HOOK_FEW_SHOT = `Openings that work:

- The road ran forty miles without meeting another car, and we met the sheep instead.
- Nobody told us the harbour freezes with the boats still in it.
- We came for the lights and spent four nights looking at cloud.
- It is minus eleven and a man is scraping his deck with a shovel.

What they have in common: one concrete fact, said plainly, that the footage
then delivers on. None of them says beautiful, stunning or breathtaking, none
of them personifies the weather, and none of them could be the opening of a
film about somewhere else.

Openings to avoid, and why:
- "The harbour held its breath, frozen in time." — personification and a cliché; says nothing.
- "Join us as we journey through the frozen north." — announces the film instead of starting it.
- "A breathtaking landscape of ice and beauty awaits." — could open any travel film ever made.`;

function hookSystemFor(lang: ScriptLanguage): string {
  if (lang.code === "en") {
    return (
      `${HOOK_SYSTEM_BASE} ` +
      "You never use the words beautiful, stunning, breathtaking, amazing or incredible."
    );
  }
  return (
    `${HOOK_SYSTEM_BASE} ` +
    `You write entirely in ${lang.label} (${lang.nativeLabel}), in the contemporary ` +
    `spoken register — this is said aloud, not read. Not literary, not archaic. ` +
    (lang.registerHint ? `${lang.registerHint} ` : "")
  );
}

/**
 * The band in this language's own counting unit.
 *
 * The same ratios the length correction uses: a Chinese character carries more
 * than an English word, a Thai one far less.
 */
function hookBand(lang: ScriptLanguage): { min: number; max: number; floor: number } {
  const scale =
    lang.counting !== "characters"
      ? 1
      : lang.code === "th"
        ? 4.0
        : lang.code === "ja"
          ? 2.0
          : 1.6;
  return {
    min: Math.round(HOOK_MIN_WORDS * scale),
    max: Math.round(HOOK_MAX_WORDS * scale),
    floor: Math.round(HOOK_FLOOR_WORDS * scale),
  };
}

/**
 * Whether a hook can run under a montage.
 *
 * Judged against the floor, not against what the prompt asked for: the ask
 * shapes the writing, this refuses the unusable. Anything under the floor is
 * not a sentence, and anything over the cap is not an opening.
 */
export function hookLengthOk(text: string, language = "en"): boolean {
  const lang = languageFor(language);
  const { max, floor } = hookBand(lang);
  const n = countUnits(text, lang);
  return n >= floor && n <= max;
}

/**
 * Whether the hook is really the film's first line wearing a hat.
 *
 * Measured against a live 7B: asked for an opening and shown the lines it
 * comes before, two of five attempts returned line one *verbatim*. The
 * instruction not to is in the prompt and the model agrees with it and then
 * does it anyway — a hook that repeats the first line makes the film start
 * twice, which is worse than having no opening at all.
 *
 * Six consecutive words is the threshold: long enough that ordinary shared
 * phrasing about the same trip ("across the valley", "the only road") passes,
 * short enough that a rewritten copy of a line does not.
 */
export function echoesScript(hook: string, lines: string[], language = "en"): boolean {
  const lang = languageFor(language);
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

  const h = norm(hook);
  if (!h) return false;

  for (const raw of lines) {
    const l = norm(raw);
    if (!l) continue;
    if (h.includes(l) || l.includes(h)) return true;

    if (lang.counting === "characters") {
      // No word boundaries to count, so a run of characters stands in.
      const run = 12;
      const bare = h.replace(/\s/g, "");
      const other = l.replace(/\s/g, "");
      for (let i = 0; i + run <= bare.length; i++) {
        if (other.includes(bare.slice(i, i + run))) return true;
      }
      continue;
    }

    const words = h.split(" ");
    const run = 6;
    for (let i = 0; i + run <= words.length; i++) {
      if (l.includes(words.slice(i, i + run).join(" "))) return true;
    }
  }
  return false;
}

/**
 * Strip what a model adds when asked for one line: quotes, a leading number,
 * a stray "Narration:" label. Cheaper and more reliable than another call.
 */
function cleanHook(raw: string): string {
  let text = raw.trim();
  try {
    const parsed = JSON.parse(text) as { hook?: unknown };
    if (typeof parsed.hook === "string") text = parsed.hook;
  } catch {
    /* not JSON; the model answered in plain text, which is also fine */
  }
  return text
    .trim()
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/^["“”'']+|["“”'']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HOOK_SCHEMA = {
  type: "object",
  properties: { hook: { type: "string" } },
  required: ["hook"],
};

/**
 * Write the opening line for a finished script.
 *
 * The fast model, deliberately: this is one short sentence chosen from material
 * already written, not the piece of writing the film rests on, and it is the
 * thing most likely to be regenerated a few times until it sounds right.
 *
 * Returns null rather than something unusable — a film with no opening is a
 * normal film, and a twelve-second hook over a three-shot montage is not.
 */
export async function writeHook(
  generate: GenerateFn,
  material: { title: string; moments: string[]; lines: string[] },
  options: { language?: string; style?: ScriptStyle; seed?: number } = {},
): Promise<string | null> {
  const lang = languageFor(options.language ?? "en");
  const { min, max, floor } = hookBand(lang);
  const unit = lang.counting === "characters" ? "characters" : "words";
  const style = STYLE_DIRECTION[options.style ?? "cinematic"];

  const trip = material.moments.slice(0, 40).map((m) => `- ${m}`).join("\n");
  const opening = material.lines.slice(0, 3).join(" ");

  const ask = (extra: string) =>
    generate({
      system: hookSystemFor(lang),
      temperature: 0.9, // one short line; the safe answer here is the dull one
      seed: options.seed,
      numCtx: NUM_CTX,
      tier: "fast",
      format: HOOK_SCHEMA,
      prompt:
        (lang.code === "en" ? `${HOOK_FEW_SHOT}\n\n---\n\n` : "") +
        `The film is called "${material.title}".\n\n${style}\n\n` +
        `What the trip contains:\n${trip}\n\n` +
        (opening ? `The film's first lines, which yours comes before:\n${opening}\n\n` : "") +
        `Write the opening line. Between ${min} and ${max} ${unit}. ` +
        `It must not repeat or paraphrase the first lines above — it comes ` +
        `before them and the viewer hears both. ${extra}` +
        `Return JSON with a "hook" string.`,
    });

  // Up to three attempts, each told exactly what was wrong with the last.
  // Naming the specific miss works far better than rerolling the same prompt,
  // and both failures are cheap: this is the fast model writing one sentence.
  let extra = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let text: string;
    try {
      text = cleanHook(await ask(extra));
    } catch {
      return null; // the model or the network failed; the caller has no hook
    }
    if (!text) {
      extra = "";
      continue;
    }
    if (!hookLengthOk(text, lang.code)) {
      // Named against what is actually refused, so a model that keeps landing
      // just under the ask is not told to fix something that is already fine.
      extra =
        countUnits(text, lang) > max
          ? `Your last attempt was too long. Hard limit: ${max} ${unit}. `
          : `Your last attempt was too short — under ${floor} ${unit} is not a sentence. `;
      continue;
    }
    if (echoesScript(text, material.lines, lang.code)) {
      extra =
        "Your last attempt repeated a line the film already has. Say something " +
        "those lines do not say — a different moment, or the thing they leave out. ";
      continue;
    }
    return text;
  }
  return null;
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
  /** Replaces the built-in writing instruction, from Settings. */
  instructions?: string;
  /**
   * Write an opening line for the montage. On unless turned off in settings.
   * Its own extra call, and its own failure — a hook that does not come back
   * leaves the rest of the script untouched.
   */
  hook?: boolean;
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

  // Final pass: pick, but do not order.
  //
  // The running order of the footage is the user's, set by dragging the
  // footage list, and the film is cut in it. A model that reorders on top of
  // that is overruling a decision somebody made deliberately — and the
  // reorder was invisible, because nothing in the UI showed that the script
  // had rearranged the trip.
  const raw = await generate({
    ...base,
    system: SELECT_SYSTEM,
    format: REFS_SCHEMA,
    prompt:
      `Video title: "${options.title}"\n\nMoments:\n${listFor(pool)}\n\n` +
      `Choose about ${want} moments for this video. They will be shown in the ` +
      `order they are listed above, which is the order the footage is in, so ` +
      `choose on merit and not on sequence. ` +
      `Return JSON with a "refs" array of the numbers you chose.`,
  });

  const ordered = parseRefs(raw, new Set(pool.map((c) => c.ref)))
    .map((r) => byRef.get(r)!)
    .filter(Boolean)
    // Footage order, whatever order the model answered in. `ref` is assigned
    // by walking the clips in the order the project stores them, so sorting by
    // it restores exactly the sequence shown in the footage list.
    .sort((a, b) => a.ref - b.ref);

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
    system: options.instructions?.trim() || writeSystemFor(lang),
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
 * Order follows the footage, not the order the model happened to answer in.
 * It used to follow first mention, which handed the model a second chance to
 * rearrange the trip after selection had already been pinned to the footage
 * list — a model that writes moment 7 before moment 3 would have cut the film
 * that way.
 */
function collapseByMoment(
  written: { ref: number; text: string }[],
  byRef: Map<number, Candidate>,
): ScriptLineDraft[] {
  const textsByRef = new Map<number, string[]>();
  for (const l of written) {
    const texts = textsByRef.get(l.ref) ?? [];
    texts.push(l.text.trim());
    textsByRef.set(l.ref, texts);
  }
  return [...textsByRef.keys()]
    .sort((a, b) => a - b)
    .map((ref) => ({
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
      system: options.instructions?.trim() || writeSystemFor(lang),
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

  // Last, and after the word count is settled, so the hook cannot be counted
  // against a target it was never part of.
  let hook: string | null = null;
  if (options.hook !== false) {
    options.onProgress?.({ stage: "hook", done: 0, total: 1 });
    hook = await writeHook(
      generate,
      {
        title: options.title,
        moments: selected.map((c) => c.text),
        lines: lines.map((l) => l.text),
      },
      { language: options.language, style: options.style, seed: options.seed },
    );
    options.onProgress?.({ stage: "hook", done: 1, total: 1 });
  }

  return {
    title: options.title,
    lines,
    words,
    consideredSegments: candidates.length,
    hook,
  };
}

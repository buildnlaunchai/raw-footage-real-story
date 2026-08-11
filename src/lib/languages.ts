/**
 * Languages the script can be written in.
 *
 * A curated list, not a free-text field. The model will attempt anything it is
 * asked for, and quality falls off a cliff outside what it was trained on —
 * offering a text box would be promising something nobody has checked.
 *
 * `documented` records whether Qwen2.5 *names* the language in its model card.
 * Chinese, English, French, Spanish, Portuguese, German, Italian, Russian,
 * Japanese, Korean, Vietnamese, Thai and Arabic are named. Bengali is not — it
 * falls under "over 29 languages… and more", so it is exposed on request but
 * marked, because "the vendor lists it" and "we assume it works" are different
 * claims and the UI should not blur them.
 */

export type CountingMode = "words" | "characters";

export interface ScriptLanguage {
  code: string;
  label: string;
  nativeLabel: string;
  /**
   * How to measure script length.
   *
   * Whitespace word counting is meaningless for languages that do not put
   * spaces between words — a 150-"word" Chinese script measured that way could
   * be one enormous token or a whole page. Those use characters instead.
   */
  counting: CountingMode;
  direction: "ltr" | "rtl";
  /** Kokoro plus an English lexicon is English-only. */
  localVoiceSupported: boolean;
  /** Whether Qwen2.5's model card names this language explicitly. */
  documented: boolean;
  /**
   * What register to write in, where the default lands wrong.
   *
   * "Natural and idiomatic" is not enough guidance for a language with a real
   * literary/spoken split. Asked for good Bengali, a model reaches for the
   * prose it saw most of — which is books — and produces something correct and
   * unspeakable. Naming the split, and the forms to avoid, is the fix; it has
   * to be per language because the trap is different in each.
   */
  registerHint?: string;
}

export const LANGUAGES: ScriptLanguage[] = [
  { code: "en", label: "English", nativeLabel: "English", counting: "words", direction: "ltr", localVoiceSupported: true, documented: true },
  {
    code: "bn",
    label: "Bengali",
    nativeLabel: "বাংলা",
    counting: "words",
    direction: "ltr",
    localVoiceSupported: false,
    documented: false,
    registerHint:
      "Write in modern spoken Bengali — চলিত ভাষা, the register of today's " +
      "television and online narration. Never write সাধু ভাষা: no করিয়া, হইয়া, " +
      "তাহার, কহিল, রহিয়াছে or any other archaic verb or pronoun form. Prefer " +
      "everyday words over heavy তৎসম vocabulary — বাড়ি not গৃহ, রাস্তা not " +
      "পথপ্রান্ত, মানুষ not জনসাধারণ. Use ordinary present and past forms: হচ্ছে, " +
      "করছে, দাঁড়িয়ে আছে. Write the way a thoughtful person speaks now, not the " +
      "way a book is written. For Hajj and Umrah footage use the vocabulary " +
      "Bengali Muslims use — হাজি or হজযাত্রী rather than তীর্থযাত্রী, and never " +
      "Hindu religious terms.",
  },
  { code: "ar", label: "Arabic", nativeLabel: "العربية", counting: "words", direction: "rtl", localVoiceSupported: false, documented: true },
  { code: "es", label: "Spanish", nativeLabel: "Español", counting: "words", direction: "ltr", localVoiceSupported: false, documented: true },
  { code: "fr", label: "French", nativeLabel: "Français", counting: "words", direction: "ltr", localVoiceSupported: false, documented: true },
  { code: "de", label: "German", nativeLabel: "Deutsch", counting: "words", direction: "ltr", localVoiceSupported: false, documented: true },
  { code: "it", label: "Italian", nativeLabel: "Italiano", counting: "words", direction: "ltr", localVoiceSupported: false, documented: true },
  { code: "pt", label: "Portuguese", nativeLabel: "Português", counting: "words", direction: "ltr", localVoiceSupported: false, documented: true },
  { code: "ru", label: "Russian", nativeLabel: "Русский", counting: "words", direction: "ltr", localVoiceSupported: false, documented: true },
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt", counting: "words", direction: "ltr", localVoiceSupported: false, documented: true },
  { code: "ko", label: "Korean", nativeLabel: "한국어", counting: "words", direction: "ltr", localVoiceSupported: false, documented: true },
  // No spaces between words: whitespace counting would be nonsense.
  { code: "zh", label: "Chinese", nativeLabel: "中文", counting: "characters", direction: "ltr", localVoiceSupported: false, documented: true },
  { code: "ja", label: "Japanese", nativeLabel: "日本語", counting: "characters", direction: "ltr", localVoiceSupported: false, documented: true },
  { code: "th", label: "Thai", nativeLabel: "ไทย", counting: "characters", direction: "ltr", localVoiceSupported: false, documented: true },
];

export const DEFAULT_LANGUAGE = "en";

export function languageFor(code: string): ScriptLanguage {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

/**
 * Roughly how many characters correspond to one English word, for translating
 * a word-count target into a character target. Only used for the three
 * space-free languages, where the user's "about 150 words" has to mean
 * something concrete.
 */
const CHARS_PER_WORD: Record<string, number> = { zh: 1.6, ja: 2.0, th: 4.0 };

/** Script length in whichever unit this language is measured in. */
export function countUnits(text: string, lang: ScriptLanguage): number {
  if (lang.counting === "characters") {
    // Ignore whitespace and punctuation; what is billed and read is glyphs.
    return [...text.replace(/\s/g, "")].length;
  }
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The target expressed in this language's own unit. */
export function targetUnits(wordCount: number, lang: ScriptLanguage): number {
  if (lang.counting === "characters") {
    return Math.round(wordCount * (CHARS_PER_WORD[lang.code] ?? 2.0));
  }
  return wordCount;
}

/** How to phrase the length instruction in the prompt. */
export function lengthInstruction(wordCount: number, lang: ScriptLanguage): string {
  const target = targetUnits(wordCount, lang);
  return lang.counting === "characters"
    ? `about ${target} characters`
    : `about ${target} words`;
}

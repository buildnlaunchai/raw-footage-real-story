/**
 * Voice providers.
 *
 * Two today — local Kokoro and cloud ElevenLabs — but the point of the shape is
 * that a third costs almost nothing. Providers declare what they can do through
 * `capabilities`, and the UI reacts to those flags. The alternative, branching
 * on `provider === "elevenlabs"` wherever behaviour differs, means every new
 * provider edits every component that ever cared.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ScriptLine } from "./types";

export type ProviderId = "local" | "elevenlabs";

export interface VoiceOption {
  id: string;
  label: string;
  /** Grouping hint for the picker; free-form per provider. */
  group: string;
  recommended: boolean;
  detail?: string;
}

export interface VoicedLine extends ScriptLine {
  segmentIndex: number;
  audioPath: string;
  durationMs: number;
  /** Kokoro reports words it could not pronounce; cloud providers do not. */
  skipped: string[];
}

export interface SynthProgress {
  done: number;
  total: number;
  clipId: string;
}

/** A line that failed, kept so a partial run is not thrown away. */
export interface LineFailure {
  lineNumber: number;
  clipId: string;
  segmentIndex: number;
  code: string;
  message: string;
}

export interface SynthResult {
  lines: VoicedLine[];
  failures: LineFailure[];
}

export interface ProviderCapabilities {
  /** Drives whether the skipped-word warning and correction dialog appear. */
  reportsUnpronounceableWords: boolean;
  /** Whether per-word respellings mean anything to this provider. */
  pronunciationOverrides: boolean;
  languages: "english-only" | "multilingual";
  billing: "free-local" | "per-character";
  /** Whether script text leaves the machine. */
  isCloud: boolean;
  /** Whether a credential must be present before it can be used. */
  needsApiKey: boolean;
  /**
   * Whether a voice can be addressed by an id this app never fetched.
   *
   * Cloud voices are account-scoped strings, and a cloned voice may not appear
   * in the listing, so pasting one has to stay possible alongside the picker.
   * Local voice packs are a fixed set shipped with the app.
   */
  acceptsManualVoiceId: boolean;
}

export interface SynthOptions {
  voiceId: string;
  projectId: string;
  /**
   * The script's language, as an ISO 639-1 code.
   *
   * Cloud providers choose a model from this. It is not cosmetic: ElevenLabs'
   * multilingual_v2 does not support Bengali at all and does not say so — it
   * accepts the request and reads the script with a model that has never seen
   * the language.
   */
  language?: string;
  speed?: number;
  pronunciations?: Record<string, string>;
  onProgress?: (p: SynthProgress) => void;
}

export interface TtsProvider {
  id: ProviderId;
  label: string;
  /** Shown wherever the user is choosing between providers. */
  blurb: string;
  capabilities: ProviderCapabilities;
  listVoices(): Promise<VoiceOption[]>;
  preview(voiceId: string, text?: string, language?: string): Promise<VoicedLine>;
  synthesize(lines: ScriptLine[], opts: SynthOptions): Promise<SynthResult>;
  synthesizeLine(
    line: { clipId: string; segmentIndex: number; text: string },
    lineNumber: number,
    opts: SynthOptions,
  ): Promise<VoicedLine>;
}

export class TtsError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TtsError";
    this.code = code;
  }
}

const FRIENDLY: Record<string, string> = {
  // Local
  MODEL_LOAD_FAILED:
    "Couldn't load the speech model. The app's bundled resources may be missing or corrupt.",
  VOICES_MISSING: "No voice packs found. The app's bundled resources may be incomplete.",
  EMPTY_PHONEMES: "That line has nothing pronounceable in it.",
  WAV_WRITE_FAILED: "Couldn't write the audio file. Check disk space and permissions.",
  MKDIR_FAILED: "Couldn't write the audio file. Check disk space and permissions.",
  NO_APP_DIR: "Couldn't write the audio file. Check disk space and permissions.",
  // Cloud.
  // The key comes from the signed-in account, so none of these ask anybody to
  // find or paste one.
  //
  // `KEY_NOT_LINKED` is deliberately absent from this map. It arrives carrying
  // a message written against the platform's `reason` — "no key", "not allowed
  // yet" and "that key was rejected" are three different sentences — plus the
  // consent link the button is built from. A generic line here would override
  // all three with the vaguest of them, which is exactly how somebody whose key
  // only needs permission ends up being told they have no key.
  KEYS_SIGNED_OUT: "Sign in to use ElevenLabs — its key comes from your account.",
  KEYS_UNREACHABLE:
    "Couldn't reach your account to fetch the ElevenLabs key. Check your connection and try again.",
  KEYS_NOT_CONFIGURED: "This build has no account to fetch provider keys from.",
  KEYS_MALFORMED: "Your account returned something this app couldn't read.",
  MISSING_API_KEY:
    "Your account has no ElevenLabs key available yet. Open your dashboard to add one.",
  INVALID_API_KEY:
    "The ElevenLabs key on your account was rejected. Check it on your dashboard.",
  VOICE_NOT_FOUND: "That voice no longer exists on the ElevenLabs account this key belongs to.",
  QUOTA_EXCEEDED: "You've used your ElevenLabs character quota for this period.",
  RATE_LIMITED: "ElevenLabs is rate-limiting requests. Try again shortly.",
  SERVICE_ERROR: "ElevenLabs had a server error. Try again shortly.",
  NETWORK: "Couldn't reach ElevenLabs. Check your connection.",
  TIMEOUT: "ElevenLabs took too long to respond.",
  EMPTY_TEXT: "That line has no text to speak.",
  BAD_AUDIO: "ElevenLabs returned audio this app couldn't read.",
};

export function asTtsError(err: unknown): TtsError {
  if (err instanceof TtsError) return err;
  if (typeof err === "object" && err !== null && "code" in err) {
    const e = err as { code: string; message: string };
    return new TtsError(e.code, FRIENDLY[e.code] ?? e.message);
  }
  return new TtsError("UNKNOWN", err instanceof Error ? err.message : String(err));
}

const PREVIEW_TEXT =
  "The harbour was still frozen, and the light came in low across the water.";

// --- local (Kokoro) ---------------------------------------------------------

interface RawVoiceInfo {
  id: string;
  accent: string;
  gender: string;
  label: string;
  recommended: boolean;
}

export const localProvider: TtsProvider = {
  id: "local",
  label: "Local (Kokoro)",
  blurb: "Runs on this machine. Free, offline, English only.",
  capabilities: {
    reportsUnpronounceableWords: true,
    pronunciationOverrides: true,
    languages: "english-only",
    billing: "free-local",
    isCloud: false,
    needsApiKey: false,
    acceptsManualVoiceId: false,
  },

  async listVoices() {
    try {
      const list = await invoke<RawVoiceInfo[]>("tts_list_voices");
      return list.map((v) => ({
        id: v.id,
        label: v.label,
        group: `${v.accent} ${v.gender}`,
        recommended: v.recommended,
      }));
    } catch (err) {
      throw asTtsError(err);
    }
  },

  async preview(voiceId, text = PREVIEW_TEXT) {
    try {
      return await invoke<VoicedLine>("tts_preview", { text, voice: voiceId });
    } catch (err) {
      throw asTtsError(err);
    }
  },

  async synthesize(lines, opts) {
    const unlisten = opts.onProgress
      ? await listen<SynthProgress>("tts:progress", (e) => opts.onProgress!(e.payload))
      : undefined;
    try {
      const out = await invoke<VoicedLine[]>("tts_synthesize", {
        lines: lines.map((l) => ({
          clipId: l.clipId,
          segmentIndex: l.segmentIndex ?? 0,
          text: l.text,
        })),
        voice: opts.voiceId,
        projectId: opts.projectId,
        speed: opts.speed ?? null,
        pronunciations: opts.pronunciations ?? null,
      });
      // Local synthesis is all-or-nothing; a failure throws rather than
      // returning partial results.
      return { lines: out, failures: [] };
    } catch (err) {
      throw asTtsError(err);
    } finally {
      unlisten?.();
    }
  },

  async synthesizeLine(line, lineNumber, opts) {
    try {
      return await invoke<VoicedLine>("tts_synthesize_line", {
        line,
        lineNumber,
        voice: opts.voiceId,
        projectId: opts.projectId,
        speed: opts.speed ?? null,
        pronunciations: opts.pronunciations ?? null,
      });
    } catch (err) {
      throw asTtsError(err);
    }
  },
};

// --- cloud (ElevenLabs) -----------------------------------------------------

interface RawCloudVoice {
  id: string;
  name: string;
  category: string;
  description: string | null;
}

/**
 * What is left, in whichever unit is actually the member's.
 *
 * Two shapes because there are genuinely two answers. On their own key it is
 * ElevenLabs characters; on platform credit it is credits — and the ElevenLabs
 * figure for that call belongs to the PLATFORM's account and is never shown.
 * Tagged, so this branches on `kind` rather than guessing from whether a number
 * happens to be zero.
 */
export type CloudUsage =
  | {
      kind: "provider";
      characterCount: number;
      characterLimit: number;
      tier: string;
      resetsAtUnix: number | null;
    }
  | { kind: "credit"; balance: number; held: number };

export const elevenLabsProvider: TtsProvider = {
  id: "elevenlabs",
  label: "ElevenLabs (cloud)",
  blurb: "Your ElevenLabs account. Many languages, billed per character.",
  capabilities: {
    // No lexicon involved, so nothing can be reported as unpronounceable.
    reportsUnpronounceableWords: false,
    pronunciationOverrides: false,
    languages: "multilingual",
    billing: "per-character",
    isCloud: true,
    needsApiKey: true,
    acceptsManualVoiceId: true,
  },

  async listVoices() {
    try {
      const list = await invoke<RawCloudVoice[]>("elevenlabs_voices");
      return list.map((v) => ({
        id: v.id,
        label: v.name,
        group: v.category ? v.category.replace(/^\w/, (c) => c.toUpperCase()) : "Voices",
        recommended: false,
        detail: v.description ?? undefined,
      }));
    } catch (err) {
      throw asTtsError(err);
    }
  },

  async preview(voiceId, text = PREVIEW_TEXT, language) {
    try {
      return await invoke<VoicedLine>("elevenlabs_synthesize_line", {
        line: { clipId: "preview", segmentIndex: 0, text },
        lineNumber: 0,
        voiceId,
        projectId: "previews",
        modelId: null,
        language: language ?? null,
      });
    } catch (err) {
      throw asTtsError(err);
    }
  },

  async synthesize(lines, opts) {
    const unlisten = opts.onProgress
      ? await listen<SynthProgress>("tts:progress", (e) => opts.onProgress!(e.payload))
      : undefined;
    try {
      // Returns successes and failures together: lines already synthesised are
      // billed, and re-running the batch would bill them again.
      return await invoke<SynthResult>("elevenlabs_synthesize", {
        lines: lines.map((l) => ({
          clipId: l.clipId,
          segmentIndex: l.segmentIndex ?? 0,
          text: l.text,
        })),
        voiceId: opts.voiceId,
        projectId: opts.projectId,
        modelId: null,
        language: opts.language ?? null,
      });
    } catch (err) {
      throw asTtsError(err);
    } finally {
      unlisten?.();
    }
  },

  async synthesizeLine(line, lineNumber, opts) {
    try {
      return await invoke<VoicedLine>("elevenlabs_synthesize_line", {
        line,
        lineNumber,
        voiceId: opts.voiceId,
        projectId: opts.projectId,
        modelId: null,
        language: opts.language ?? null,
      });
    } catch (err) {
      throw asTtsError(err);
    }
  },
};

export const PROVIDERS: Record<ProviderId, TtsProvider> = {
  local: localProvider,
  elevenlabs: elevenLabsProvider,
};

export function providerFor(id: ProviderId): TtsProvider {
  return PROVIDERS[id] ?? localProvider;
}

// --- credentials ------------------------------------------------------------
//
// There is nothing here any more, and that is the point.
//
// `hasApiKey`, `setApiKey`, `clearApiKey` and `testApiKey` lived here and were
// the local-key path: ask the keychain whether a key exists, put one in, take
// one out, try one before saving it. The key comes from the signed-in account
// now and only from there, so there is no local state to inspect and nothing
// for the webview to hand in. See `accountKeys.ts` for what replaced them, and
// `provider_keys.rs` for why.
//
// The key still never crosses into JavaScript. It did not before and it does
// not now — Rust holds it and makes the call.

export async function fetchUsage(): Promise<CloudUsage> {
  try {
    return await invoke<CloudUsage>("elevenlabs_usage");
  } catch (err) {
    throw asTtsError(err);
  }
}

/** Characters this script would cost, which is how ElevenLabs bills. */
export function characterCount(lines: { text: string }[]): number {
  return lines.reduce((n, l) => n + l.text.length, 0);
}

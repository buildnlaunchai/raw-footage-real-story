/**
 * Pipeline stage 2 — narration script in, spoken audio out.
 *
 * Consumes Stage 1's `ScriptLine[]` unchanged and returns the same lines with
 * audio attached. `clipId` is carried straight through, which is what keeps
 * clip -> sentence -> audio aligned all the way to assembly in Stage 3.
 *
 * Synthesis runs locally through Kokoro; nothing is uploaded.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ScriptLine } from "./types";

export interface VoiceInfo {
  id: string;
  accent: string;
  gender: string;
  label: string;
  /** Surfaced first in the picker; chosen by measurement, not taste. */
  recommended: boolean;
}

export interface VoicedLine extends ScriptLine {
  segmentIndex: number;
  audioPath: string;
  durationMs: number;
  /** Words no lexicon could pronounce; surfaced rather than silently dropped. */
  skipped: string[];
}

export interface TtsProgress {
  done: number;
  total: number;
  clipId: string;
}

export class VoiceoverError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VoiceoverError";
    this.code = code;
  }
}

function friendly(code: string, message: string): string {
  switch (code) {
    case "MODEL_LOAD_FAILED":
      return "Couldn't load the speech model. The app's bundled resources may be missing or corrupt.";
    case "VOICES_MISSING":
      return "No voice packs found. The app's bundled resources may be incomplete.";
    case "EMPTY_PHONEMES":
      return "That line has nothing pronounceable in it.";
    case "WAV_WRITE_FAILED":
    case "MKDIR_FAILED":
    case "NO_APP_DIR":
      return "Couldn't write the audio file. Check disk space and permissions.";
    default:
      return message || "Something went wrong generating the voiceover.";
  }
}

function asError(err: unknown): VoiceoverError {
  if (err instanceof VoiceoverError) return err;
  if (typeof err === "object" && err !== null && "code" in err) {
    const e = err as { code: string; message: string };
    return new VoiceoverError(e.code, friendly(e.code, e.message));
  }
  return new VoiceoverError(
    "UNKNOWN",
    err instanceof Error ? err.message : String(err),
  );
}

export async function listVoices(): Promise<VoiceInfo[]> {
  try {
    return await invoke<VoiceInfo[]>("tts_list_voices");
  } catch (err) {
    throw asError(err);
  }
}

/** A file path on disk becomes something an <audio> element can load. */
export function audioUrl(path: string): string {
  return convertFileSrc(path);
}

export interface GenerateVoiceoverOptions {
  voice: string;
  projectId: string;
  speed?: number;
  /** Word -> respelling, for words the phonemiser cannot pronounce. */
  pronunciations?: Record<string, string>;
  onProgress?: (p: TtsProgress) => void;
}

export async function generateVoiceover(
  script: ScriptLine[],
  { voice, projectId, speed, pronunciations, onProgress }: GenerateVoiceoverOptions,
): Promise<VoicedLine[]> {
  if (script.length === 0) {
    throw new VoiceoverError("EMPTY_SCRIPT", "Generate a script first.");
  }

  // Subscribe before invoking, or early lines report no progress.
  const unlisten = onProgress
    ? await listen<TtsProgress>("tts:progress", (e) => onProgress(e.payload))
    : undefined;

  try {
    return await invoke<VoicedLine[]>("tts_synthesize", {
      lines: script.map((l) => ({
        clipId: l.clipId,
        segmentIndex: (l as { segmentIndex?: number }).segmentIndex ?? 0,
        text: l.text,
      })),
      voice,
      projectId,
      speed: speed ?? null,
      pronunciations: pronunciations ?? null,
    });
  } catch (err) {
    throw asError(err);
  } finally {
    unlisten?.();
  }
}

/** Short sample so a voice can be auditioned without a full run. */
export async function previewVoice(
  voice: string,
  text = "The harbour was still frozen, and the light came in low across the water.",
): Promise<VoicedLine> {
  try {
    return await invoke<VoicedLine>("tts_preview", { text, voice });
  } catch (err) {
    throw asError(err);
  }
}

/** Group voices for a picker; 55 flat options is unusable. */
export function groupVoices(voices: VoiceInfo[]): Map<string, VoiceInfo[]> {
  const groups = new Map<string, VoiceInfo[]>();
  for (const v of voices) {
    const key = `${v.accent} ${v.gender}`;
    const list = groups.get(key);
    if (list) list.push(v);
    else groups.set(key, [v]);
  }
  return groups;
}

/**
 * Re-synthesise a single line.
 *
 * Correcting one mispronounced word should not cost a whole voiceover — a
 * twenty-line script is well over a minute of synthesis, and the other lines
 * were already right.
 */
export async function resynthesizeLine(
  line: { clipId: string; segmentIndex: number; text: string },
  lineNumber: number,
  opts: {
    voice: string;
    projectId: string;
    speed?: number;
    pronunciations?: Record<string, string>;
  },
): Promise<VoicedLine> {
  try {
    return await invoke<VoicedLine>("tts_synthesize_line", {
      line,
      lineNumber,
      voice: opts.voice,
      projectId: opts.projectId,
      speed: opts.speed ?? null,
      pronunciations: opts.pronunciations ?? null,
    });
  } catch (err) {
    throw asError(err);
  }
}

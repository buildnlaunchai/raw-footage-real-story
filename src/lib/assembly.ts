/**
 * Pipeline stage 3 — narrated script in, rough-cut video out.
 *
 * Consumes stage 2's `VoicedLine[]` plus the clips. ffmpeg does the work as a
 * separate local process; nothing is uploaded.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Clip } from "./types";
import type { VoicedLine } from "./voiceover";

export interface FfmpegCaps {
  /** libzimg. Without it HDR tone mapping is only approximate. */
  zscale: boolean;
  tonemap: boolean;
}

export interface FfmpegInfo {
  ffmpeg: string;
  ffprobe: string;
  version: string;
  caps: FfmpegCaps;
}

export type Fit = "exact" | "trimmed" | "slowed";

export interface TimelineItem {
  clipId: string;
  /**
   * Which described moment of the clip this item shows.
   *
   * Rust has always sent this; the interface omitted it, so every consumer had
   * only `clipId` to identify a row by — which is not unique when a story
   * returns to the same clip.
   */
  segmentIndex: number;
  sourceInMs: number;
  sourceOutMs: number;
  timelineStartMs: number;
  timelineDurationMs: number;
  /**
   * How much the footage is slowed to cover its line. 1 when it fits.
   *
   * Replaces holdMs: a clip shorter than its narration used to freeze on its
   * last frame, which reads as the video having broken.
   */
  stretch: number;
  fit: Fit;
}

export interface AssembleResult {
  videoPath: string;
  projectPath: string;
  durationMs: number;
  timeline: TimelineItem[];
}

export interface GeneratedClip {
  clipId: string;
  sourcePath: string;
  sourceDurationMs: number;
}

export interface RenderProgress {
  stage: string;
  done: number;
  total: number;
}

export class AssemblyError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AssemblyError";
    this.code = code;
  }
}

function friendly(code: string, message: string): string {
  switch (code) {
    case "FFMPEG_NOT_FOUND":
      return "ffmpeg isn't installed, or this app can't find it.";
    case "FFPROBE_NOT_FOUND":
      return "Found ffmpeg but not ffprobe. Both are needed — they normally install together.";
    case "NOTHING_TO_RENDER":
      return "Generate a voiceover before assembling the rough cut.";
    case "MISSING_AUDIO":
      return "Some lines have no narration audio. Regenerate the voiceover and try again.";
    case "FFMPEG_FAILED":
      return `ffmpeg couldn't finish the render. ${message}`;
    default:
      return message || "Something went wrong assembling the video.";
  }
}

function asError(err: unknown): AssemblyError {
  if (err instanceof AssemblyError) return err;
  if (typeof err === "object" && err !== null && "code" in err) {
    const e = err as { code: string; message: string };
    return new AssemblyError(e.code, friendly(e.code, e.message));
  }
  return new AssemblyError(
    "UNKNOWN",
    err instanceof Error ? err.message : String(err),
  );
}

/** Null rather than throwing: a missing ffmpeg is a setup state, not an error. */
export async function detectFfmpeg(): Promise<FfmpegInfo | null> {
  try {
    return await invoke<FfmpegInfo>("ffmpeg_detect");
  } catch {
    return null;
  }
}

export async function setFfmpegPath(path: string): Promise<FfmpegInfo> {
  try {
    return await invoke<FfmpegInfo>("ffmpeg_set_path", { ffmpegPath: path });
  } catch (err) {
    throw asError(err);
  }
}

function toClipSpecs(clips: Clip[]) {
  return clips.map((c) => ({
    id: c.id,
    description: c.description,
    sourcePath: c.sourcePath ?? null,
    sourceDurationMs: c.sourceDurationMs ?? null,
    isPlaceholder: c.isPlaceholder ?? false,
    isHdr: c.isHdr ?? null,
    sourceStartMs: c.sourceStartMs ?? 0,
  }));
}

/**
 * One spec per narrated line. `sourceStartMs` travels with the line rather than
 * the clip because a story may use two different moments from the same clip,
 * and each needs its own offset.
 */
function toVoicedSpecs(voiced: VoicedLine[], startsByKey?: Map<string, number>) {
  return voiced.map((v) => ({
    clipId: v.clipId,
    segmentIndex: v.segmentIndex ?? 0,
    text: v.text,
    audioPath: v.audioPath,
    durationMs: v.durationMs,
    skipped: v.skipped,
    sourceStartMs: startsByKey?.get(`${v.clipId}#${v.segmentIndex ?? 0}`) ?? 0,
  }));
}

/** Dev-only: stand-in footage so assembly can be exercised before upload exists. */
export async function makePlaceholderClips(
  clips: Clip[],
  voiced: VoicedLine[],
  projectId: string,
): Promise<GeneratedClip[]> {
  try {
    return await invoke<GeneratedClip[]>("assembly_make_placeholders", {
      clips: toClipSpecs(clips),
      voiced: toVoicedSpecs(voiced),
      projectId,
    });
  } catch (err) {
    throw asError(err);
  }
}

export interface RenderOptions {
  projectId: string;
  projectName: string;
  model: string;
  voice: string;
  createdAt: string;
  /** Which video within the project this render belongs to. */
  videoId?: string;
  /** Names the output file, so each render is kept as its own take. */
  takeId?: string;
  videoTitle?: string;
  /** `clipId#segmentIndex` -> where that segment starts in the clip. */
  segmentStarts?: Map<string, number>;
  /** Milliseconds of dissolve between clips. 0 keeps hard cuts. */
  crossfadeMs?: number;
  /** Bundled bed id, or null for silence under the narration. */
  musicId?: string | null;
  onProgress?: (p: RenderProgress) => void;
}

export async function renderRoughCut(
  clips: Clip[],
  voiced: VoicedLine[],
  opts: RenderOptions,
): Promise<AssembleResult> {
  const unlisten = opts.onProgress
    ? await listen<RenderProgress>("render:progress", (e) => opts.onProgress!(e.payload))
    : undefined;
  try {
    return await invoke<AssembleResult>("assembly_render", {
      clips: toClipSpecs(clips),
      voiced: toVoicedSpecs(voiced, opts.segmentStarts),
      projectId: opts.projectId,
      projectName: opts.projectName,
      model: opts.model,
      voice: opts.voice,
      createdAt: opts.createdAt,
      updatedAt: new Date().toISOString(),
      videoId: opts.videoId ?? null,
      takeId: opts.takeId ?? null,
      videoTitle: opts.videoTitle ?? null,
      crossfadeMs: opts.crossfadeMs ?? 0,
      musicId: opts.musicId ?? null,
    });
  } catch (err) {
    throw asError(err);
  } finally {
    unlisten?.();
  }
}

export async function exportBundle(projectId: string, destination: string): Promise<string> {
  try {
    return await invoke<string>("assembly_export_bundle", { projectId, destination });
  } catch (err) {
    throw asError(err);
  }
}

export async function exportProjectOnly(
  projectId: string,
  destination: string,
): Promise<string> {
  try {
    return await invoke<string>("assembly_export_project_only", { projectId, destination });
  } catch (err) {
    throw asError(err);
  }
}

// --- media import ---------------------------------------------------------

export type MediaVerdict = "accepted" | "warning" | "rejected";

export interface MediaInfo {
  durationMs: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
  hasAudio: boolean;
  rotation: number;
  colorTransfer: string;
  isHdr: boolean;
}

export interface ImportedMedia {
  sourcePath: string;
  fileName: string;
  thumbnailPath: string | null;
  verdict: MediaVerdict;
  reasons: string[];
  info: MediaInfo | null;
}

/** Containers offered in the picker. Validation is still by probe, not by this. */
export const VIDEO_EXTENSIONS = [
  "mp4", "mov", "m4v", "avi", "mkv", "webm", "mts", "m2ts", "3gp", "mpg", "mpeg", "wmv", "flv",
];

export async function importMedia(
  paths: string[],
  projectId: string,
  onProgress?: (p: RenderProgress) => void,
): Promise<ImportedMedia[]> {
  const unlisten = onProgress
    ? await listen<RenderProgress>("import:progress", (e) => onProgress(e.payload))
    : undefined;
  try {
    return await invoke<ImportedMedia[]>("assembly_import_media", { paths, projectId });
  } catch (err) {
    throw asError(err);
  } finally {
    unlisten?.();
  }
}

export interface ConsolidatedClip {
  clipId: string;
  sourcePath: string;
}

export async function consolidateMedia(
  clips: Clip[],
  projectId: string,
): Promise<ConsolidatedClip[]> {
  try {
    return await invoke<ConsolidatedClip[]>("assembly_consolidate_media", {
      clips: toClipSpecs(clips),
      projectId,
    });
  } catch (err) {
    throw asError(err);
  }
}

/** Bundled, procedurally generated music beds. See resources/music/LICENSE.md. */
export const MUSIC_BEDS: { id: string; label: string; hint: string }[] = [
  { id: "still-water", label: "Still water", hint: "low, slow, unobtrusive" },
  { id: "open-road", label: "Open road", hint: "brighter, a little movement" },
  { id: "cold-air", label: "Cold air", hint: "airy, textural" },
];


/** Copy the finished cut to a chosen location. */
export async function saveVideoAs(from: string, to: string): Promise<string> {
  return await invoke<string>("save_video_as", { from, to });
}

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

export interface FfmpegInfo {
  ffmpeg: string;
  ffprobe: string;
  version: string;
}

export type Fit = "exact" | "trimmed" | "held";

export interface TimelineItem {
  clipId: string;
  sourceInMs: number;
  sourceOutMs: number;
  timelineStartMs: number;
  timelineDurationMs: number;
  holdMs: number;
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
  }));
}

function toVoicedSpecs(voiced: VoicedLine[]) {
  return voiced.map((v) => ({
    clipId: v.clipId,
    text: v.text,
    audioPath: v.audioPath,
    durationMs: v.durationMs,
    skipped: v.skipped,
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
      voiced: toVoicedSpecs(voiced),
      projectId: opts.projectId,
      projectName: opts.projectName,
      model: opts.model,
      voice: opts.voice,
      createdAt: opts.createdAt,
      updatedAt: new Date().toISOString(),
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

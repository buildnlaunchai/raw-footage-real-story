/**
 * Project persistence — the clip library and the videos cut from it.
 *
 * A project is saved as a whole document. At the scale this targets (300 clips
 * with segment descriptions) that measured 512KB, 25ms to write and 14ms to
 * read, so sharding or lazy-loading segments would be complexity bought for
 * nothing. See `store_tests::measures_manifest_size_at_scale`.
 */
import { invoke } from "@tauri-apps/api/core";

export const SCHEMA_VERSION = 2;

/** A described moment inside a clip. */
export interface Segment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface ProjectClip {
  id: string;
  sourcePath: string | null;
  sha256: string | null;
  sourceDurationMs: number | null;
  isPlaceholder: boolean;
  fileName: string | null;
  thumbnailPath: string | null;
  isHdr: boolean;
  segments: Segment[];
}

export interface SelectedSegment {
  clipId: string;
  segmentIndex: number;
}

export interface ScriptLineRecord {
  clipId: string;
  segmentIndex: number;
  text: string;
  edited: boolean;
}

export interface ScriptSection {
  model: string;
  generatedAt: string;
  lines: ScriptLineRecord[];
  wordCountTarget: number | null;
}

export interface AudioLineRecord {
  clipId: string;
  segmentIndex: number;
  path: string;
  durationMs: number;
  skippedWords: string[];
}

export interface AudioSection {
  voice: string;
  sampleRate: number;
  lines: AudioLineRecord[];
}

export interface VideoProject {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  selection: SelectedSegment[];
  script: ScriptSection | null;
  audio: AudioSection | null;
  timeline: unknown[];
  render: unknown | null;
  pronunciations: Record<string, string>;
}

export interface ProjectFile {
  schemaVersion: number;
  app: { slug: string; version: string };
  project: { id: string; name: string; createdAt: string; updatedAt: string };
  clips: ProjectClip[];
  videos: VideoProject[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  clipCount: number;
  segmentCount: number;
  videoCount: number;
  describedClipCount: number;
}

export class ProjectError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
  }
}

function asError(err: unknown): ProjectError {
  if (err instanceof ProjectError) return err;
  if (typeof err === "object" && err !== null && "code" in err) {
    const e = err as { code: string; message: string };
    const friendly =
      e.code === "NOT_FOUND"
        ? "That project no longer exists on disk."
        : e.code === "LOAD_FAILED"
          ? `Couldn't open the project. ${e.message}`
          : e.code === "SAVE_FAILED"
            ? "Couldn't save the project. Check disk space and permissions."
            : e.message;
    return new ProjectError(e.code, friendly);
  }
  return new ProjectError("UNKNOWN", err instanceof Error ? err.message : String(err));
}

export async function createProject(name: string): Promise<ProjectFile> {
  try {
    return await invoke<ProjectFile>("project_create", {
      id: crypto.randomUUID(),
      name,
      now: new Date().toISOString(),
    });
  } catch (err) {
    throw asError(err);
  }
}

export async function saveProject(manifest: ProjectFile): Promise<ProjectSummary> {
  try {
    return await invoke<ProjectSummary>("project_save", {
      manifest,
      now: new Date().toISOString(),
    });
  } catch (err) {
    throw asError(err);
  }
}

export async function openProject(id: string): Promise<ProjectFile> {
  try {
    return await invoke<ProjectFile>("project_open", { id });
  } catch (err) {
    throw asError(err);
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  try {
    return await invoke<ProjectSummary[]>("project_list");
  } catch (err) {
    throw asError(err);
  }
}

export async function deleteProject(id: string): Promise<void> {
  try {
    await invoke("project_delete", { id });
  } catch (err) {
    throw asError(err);
  }
}

// --- helpers ---------------------------------------------------------------

export function isDescribed(clip: ProjectClip): boolean {
  return clip.segments.some((s) => s.text.trim().length > 0);
}

export function describedCount(clips: ProjectClip[]): number {
  return clips.filter(isDescribed).length;
}

export function totalSegments(clips: ProjectClip[]): number {
  return clips.reduce((n, c) => n + c.segments.length, 0);
}

/** Segments kept sorted by start time; the editor relies on the ordering. */
export function sortSegments(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => a.startSec - b.startSec);
}

export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}

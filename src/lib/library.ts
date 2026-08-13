/**
 * The clip library, across every project.
 *
 * The rest of the app works inside one open project; this view does not, so it
 * reads and writes clips by (project, clip) pair rather than through whatever
 * manifest happens to be loaded.
 */
import { invoke } from "@tauri-apps/api/core";

export interface LibraryClip {
  projectId: string;
  projectName: string;
  clipId: string;
  fileName: string;
  sourcePath: string | null;
  thumbnailPath: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  isPlaceholder: boolean;
  isHdr: boolean;
  favorite: boolean;
  deletedAt: string | null;
  description: string;
  segmentCount: number;
  /**
   * The described moments themselves.
   *
   * The row used to carry only the joined `description`, and anything needing
   * real segments rebuilt one covering the whole clip from that string — which
   * silently flattened a split clip and then wrote the flattened version back.
   */
  segments: { startSec: number; endSec: number; text: string }[];
  addedAt: string;
  /**
   * Where this clip sits in its project's running order, from zero.
   *
   * The order *is* the position in the project file's clip array — the script
   * is written to follow it and the cut is assembled in it. Carried on the row
   * because this view merges projects and re-sorts them, which is exactly
   * where array position would otherwise be lost.
   */
  sequence: number;
}

export interface StorageUsage {
  appBytes: number;
  footageBytes: number;
  /** Absent where the platform's capacity could not be read. */
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
}

export async function listLibrary(): Promise<LibraryClip[]> {
  return await invoke<LibraryClip[]>("library_list");
}

/**
 * Put a project's footage into this order.
 *
 * Ids left out keep their relative order and follow the ones given, so a drag
 * on a filtered or paged view rearranges what was visible without touching —
 * or losing — the rest.
 */
export async function reorderClips(projectId: string, clipIds: string[]): Promise<void> {
  await invoke("clip_reorder", { projectId, clipIds });
}

/**
 * Let the webview read these files.
 *
 * The asset protocol only allows the app's own folder by default, and footage
 * is referenced where the user keeps it. Without this the player gets a black
 * frame while the thumbnail beside it loads fine, which reads as a broken
 * video rather than a permission it was never given.
 *
 * The grant is in-memory, so this runs every time the library is read.
 */
export async function allowMedia(paths: (string | null)[]): Promise<number> {
  const real = paths.filter((p): p is string => Boolean(p));
  if (real.length === 0) return 0;
  try {
    return await invoke<number>("allow_media", { paths: real });
  } catch {
    // A failed grant should not stop the library loading; the player reports
    // the file it could not read.
    return 0;
  }
}

export async function storageUsage(): Promise<StorageUsage> {
  return await invoke<StorageUsage>("storage_usage");
}

export async function setFavorite(
  projectId: string,
  clipId: string,
  favorite: boolean,
): Promise<void> {
  await invoke("clip_set_favorite", { projectId, clipId, favorite });
}

export async function setDeleted(
  projectId: string,
  clipId: string,
  deleted: boolean,
): Promise<void> {
  await invoke("clip_set_deleted", {
    projectId,
    clipId,
    deletedAt: deleted ? new Date().toISOString() : null,
  });
}

export async function purgeClip(projectId: string, clipId: string): Promise<void> {
  await invoke("clip_purge", { projectId, clipId });
}

/** Write a clip's described moments, timings and all. */
export async function setSegments(
  projectId: string,
  clipId: string,
  segments: { startSec: number; endSec: number; text: string }[],
): Promise<void> {
  await invoke("clip_set_segments", { projectId, clipId, segments });
}

/**
 * Rewrite a clip's description as a single moment.
 *
 * Resolves false when the clip has been split, which one text field cannot
 * express. `setSegments` is what the describe view uses; this remains for
 * callers that only ever deal in whole-clip text.
 */
export async function setDescription(
  projectId: string,
  clipId: string,
  text: string,
): Promise<boolean> {
  return await invoke<boolean>("clip_set_description", { projectId, clipId, text });
}

// --- formatting -------------------------------------------------------------

export function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "—";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatWhen(iso: string): { date: string; time: string } {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { date: "—", time: "" };
  const d = new Date(t);
  return {
    date: d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

/** Container from the file name; the codec is a separate thing and reported as one. */
export function containerOf(fileName: string): string {
  const ext = fileName.split(".").pop();
  return ext && ext.length <= 5 ? ext.toUpperCase() : "—";
}

/**
 * A stable colour per project, so the same collection reads the same everywhere.
 *
 * Hashed rather than assigned by position: a list that reorders should not
 * repaint, and deleting a project should not recolour the others.
 */
export function tagHue(projectId: string): number {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) % 360;
  return h;
}

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
  addedAt: string;
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

/**
 * Rewrite a clip's description.
 *
 * Resolves false when the clip has been cut into several segments, which the
 * one-box editor here cannot represent — the caller sends the user to the
 * segment editor rather than flattening timings somebody set on purpose.
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

/**
 * Generations, kept.
 *
 * Regenerating used to overwrite. A take is one attempt — a script, a
 * recording, a render — held so it can be compared, restored or thrown away
 * deliberately rather than by accident.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ScriptLineDraft } from "./scriptComposerCore";
import type { VoicedLine } from "./ttsProviders";

export type TakeKind = "script" | "voice" | "render";

export interface Take {
  id: string;
  kind: TakeKind;
  createdAt: string;
  label: string;
  lines: { clipId: string; segmentIndex: number; text: string }[];
  audio: {
    clipId: string;
    segmentIndex: number;
    text: string;
    audioPath: string;
    durationMs: number;
  }[];
  videoPath: string | null;
  durationMs: number | null;
  detail: string | null;
}

export async function listTakes(projectId: string): Promise<Take[]> {
  return await invoke<Take[]>("take_list", { projectId });
}

export async function addTake(projectId: string, take: Take): Promise<Take[]> {
  return await invoke<Take[]>("take_add", { projectId, take });
}

export async function deleteTake(projectId: string, takeId: string): Promise<Take[]> {
  return await invoke<Take[]>("take_delete", { projectId, takeId });
}

function blank(kind: TakeKind, label: string, detail: string): Take {
  return {
    id: crypto.randomUUID(),
    kind,
    createdAt: new Date().toISOString(),
    label,
    lines: [],
    audio: [],
    videoPath: null,
    durationMs: null,
    detail,
  };
}

export function scriptTake(lines: ScriptLineDraft[], detail: string): Take {
  const words = lines.reduce(
    (n, l) => n + l.text.trim().split(/\s+/).filter(Boolean).length,
    0,
  );
  return {
    ...blank("script", `${lines.length} lines · ${words} words`, detail),
    lines: lines.map((l) => ({
      clipId: l.clipId,
      segmentIndex: l.segmentIndex,
      text: l.text,
    })),
  };
}

export function voiceTake(voiced: VoicedLine[], detail: string): Take {
  const ms = voiced.reduce((n, v) => n + v.durationMs, 0);
  return {
    ...blank("voice", `${voiced.length} lines · ${(ms / 1000).toFixed(1)}s`, detail),
    // Both, because restoring a recording has to restore the words it speaks;
    // audio whose script has moved on is the staleness problem by another route.
    lines: voiced.map((v) => ({
      clipId: v.clipId,
      segmentIndex: v.segmentIndex,
      text: v.text,
    })),
    audio: voiced.map((v) => ({
      clipId: v.clipId,
      segmentIndex: v.segmentIndex,
      text: v.text,
      audioPath: v.audioPath,
      durationMs: v.durationMs,
    })),
  };
}

export function renderTake(
  id: string,
  videoPath: string,
  durationMs: number,
  detail: string,
): Take {
  return {
    ...blank("render", `${(durationMs / 1000).toFixed(1)}s cut`, detail),
    // The id is fixed up front: it names the output file, so the take and the
    // mp4 it owns cannot end up pointing at different things.
    id,
    videoPath,
    durationMs,
  };
}

/** Newest first, which is the order a history is read in. */
export function ofKind(takes: Take[], kind: TakeKind): Take[] {
  return takes.filter((t) => t.kind === kind).slice().reverse();
}

export function whenTaken(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return new Date(t).toLocaleDateString();
}

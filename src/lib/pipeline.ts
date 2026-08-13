/**
 * The pipeline as data, so it can be shown all at once and entered anywhere.
 *
 * The old UI was a column of panels that appeared as their turn came, which
 * made the order self-evident and jumping backwards awkward. Showing every
 * stage at all times removes that guardrail: a script line edited after the
 * voiceover is recorded leaves audio that says something else, and the old flow
 * caught that only because you would naturally have re-recorded on your way
 * back down the page.
 *
 * So the timeline needs to know not just what exists but whether it is still
 * true. Everything here is pure and dependency-free — the same reason the
 * composer core is — so the rules can be tested without a browser.
 */

export type StageId = "footage" | "story" | "script" | "voice" | "assembly";

export const STAGE_ORDER: StageId[] = [
  "footage",
  "story",
  "script",
  "voice",
  "assembly",
];

/**
 * - `empty`   nothing here yet, and what it needs is missing
 * - `ready`   can be run now
 * - `working` running
 * - `done`    produced something that still matches its inputs
 * - `stale`   produced something its inputs have since moved away from
 */
export type StageStatus = "empty" | "ready" | "working" | "done" | "stale";

export interface StageMeta {
  id: StageId;
  label: string;
  /** What this stage produces, in the user's words. */
  produces: string;
  /** Shown when the stage cannot run yet. */
  needs: string;
}

export const STAGES: Record<StageId, StageMeta> = {
  footage: {
    id: "footage",
    label: "Footage",
    produces: "described clips",
    needs: "Import at least one video.",
  },
  story: {
    id: "story",
    label: "Story",
    produces: "a title and a shape",
    needs: "Describe at least one moment first.",
  },
  script: {
    id: "script",
    label: "Script",
    produces: "narration lines",
    needs: "Choose a title first.",
  },
  voice: {
    id: "voice",
    label: "Voice",
    produces: "recorded narration",
    needs: "Write a script first.",
  },
  assembly: {
    id: "assembly",
    label: "Assembly",
    produces: "the rough cut",
    needs: "Record the narration first.",
  },
};

/** The identity a line and its audio share. */
export interface LineIdentity {
  clipId: string;
  segmentIndex: number;
}

export function lineKey(l: LineIdentity): string {
  return `${l.clipId}#${l.segmentIndex}`;
}

export interface ScriptLineLike extends LineIdentity {
  text: string;
}

export interface VoicedLineLike extends LineIdentity {
  text: string;
}

/**
 * What the narration was recorded with.
 *
 * Audio does not carry this, so it is stamped when a run finishes. Changing the
 * voice does not alter any line's text, so text comparison alone would call a
 * whole script of wrong-voice audio current.
 */
export interface VoiceStamp {
  providerId: string;
  voiceId: string;
  language: string;
  /** Respellings applied at synthesis time. */
  pronunciations: Record<string, string>;
}

export function voiceStampEquals(a: VoiceStamp | null, b: VoiceStamp | null): boolean {
  if (!a || !b) return false;
  return (
    a.providerId === b.providerId &&
    a.voiceId === b.voiceId &&
    a.language === b.language &&
    pronunciationsEqual(a.pronunciations, b.pronunciations)
  );
}

function pronunciationsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => bk[i] === k && a[k] === b[k]);
}

/**
 * Lines whose audio no longer matches the words.
 *
 * Per line rather than all-or-nothing on purpose: cloud narration is billed, so
 * discarding a whole recording because one line was reworded would charge the
 * user again for work that is still good.
 */
export function staleLineKeys(
  lines: ScriptLineLike[] | null,
  voiced: VoicedLineLike[] | null,
  voiceChanged: boolean,
): Set<string> {
  if (!lines || !voiced) return new Set();
  const spoken = new Map(voiced.map((v) => [lineKey(v), v.text]));
  const stale = new Set<string>();
  for (const line of lines) {
    const key = lineKey(line);
    const said = spoken.get(key);
    // A line with no audio is missing, not stale; the voice stage reports that
    // separately so "3 lines changed" never counts lines never recorded.
    if (said === undefined) continue;
    if (voiceChanged || said.trim() !== line.text.trim()) stale.add(key);
  }
  return stale;
}

/** Lines that have never been recorded. */
export function unrecordedLineKeys(
  lines: ScriptLineLike[] | null,
  voiced: VoicedLineLike[] | null,
): Set<string> {
  if (!lines) return new Set();
  const spoken = new Set((voiced ?? []).map(lineKey));
  return new Set(lines.map(lineKey).filter((k) => !spoken.has(k)));
}

/**
 * What the cut was rendered from.
 *
 * The audio files themselves can be replaced in place by a re-record, so the
 * signature includes each line's duration: same paths and different lengths
 * means the cut's timing no longer matches its narration.
 */
export function renderSignature(
  voiced: { audioPath: string; durationMs: number }[] | null,
  crossfadeMs: number,
  musicId: string | null,
  /**
   * The opening, as the shots and the recording that make it up.
   *
   * The montage is rendered inside the cut rather than beside it, so a hook
   * rewritten and re-recorded, or footage that changes which shots get picked,
   * leaves the existing cut opening on words nobody is saying any more. Empty
   * string for a film with no opening, which is also a state a cut can go
   * stale against.
   */
  introSig = "",
  /** Whether the words are drawn into the picture. */
  subtitles = false,
): string {
  if (!voiced) return "";
  const lines = voiced.map((v) => `${v.audioPath}:${v.durationMs}`).join("|");
  return `${lines}::${crossfadeMs}::${musicId ?? "none"}::${introSig || "no-intro"}::${
    subtitles ? "subs" : "no-subs"
  }`;
}

export interface PipelineInput {
  clipCount: number;
  describedCount: number;
  title: string;
  lines: ScriptLineLike[] | null;
  voiced: VoicedLineLike[] | null;
  staleLines: Set<string>;
  unrecordedLines: Set<string>;
  hasAssembly: boolean;
  assemblyCurrent: boolean;
  /**
   * There is an opening line whose recording is missing or out of date.
   *
   * Without this the rail calls the voice stage done while the film's first
   * words have never been spoken — and the cut then renders with no opening at
   * all, silently, because a montage needs the hook's length to exist.
   */
  introPending: boolean;
  /** Stage currently running, if any. */
  busy: StageId | null;
}

/**
 * Each stage's state, for the rail.
 *
 * Note that a stale stage stays `stale` rather than reverting to `ready`: the
 * work still exists and is worth keeping, it just no longer matches. Losing
 * that distinction is what would let someone export a cut whose narration is
 * one edit out of date.
 */
export function stageStatuses(input: PipelineInput): Record<StageId, StageStatus> {
  const {
    clipCount,
    describedCount,
    title,
    lines,
    voiced,
    staleLines,
    unrecordedLines,
    hasAssembly,
    assemblyCurrent,
    introPending,
    busy,
  } = input;

  const footage: StageStatus =
    clipCount === 0 ? "empty" : describedCount === 0 ? "ready" : "done";

  const story: StageStatus =
    describedCount === 0 ? "empty" : title.trim() ? "done" : "ready";

  const script: StageStatus = !title.trim()
    ? "empty"
    : !lines || lines.length === 0
      ? "ready"
      : "done";

  let voice: StageStatus;
  if (!lines || lines.length === 0) voice = "empty";
  else if (!voiced || voiced.length === 0) voice = "ready";
  else if (staleLines.size > 0 || unrecordedLines.size > 0 || introPending) voice = "stale";
  else voice = "done";

  let assembly: StageStatus;
  if (!voiced || voiced.length === 0) assembly = "empty";
  else if (!hasAssembly) assembly = "ready";
  else if (!assemblyCurrent || staleLines.size > 0 || introPending) assembly = "stale";
  else assembly = "done";

  const out: Record<StageId, StageStatus> = { footage, story, script, voice, assembly };
  if (busy) out[busy] = "working";
  return out;
}

/**
 * Why a stage is stale, in a sentence, or null when it is not.
 *
 * The rail shows a colour; a colour cannot say "two lines were reworded", and
 * without that the user has to diff the script by eye to find what to redo.
 */
export function stalenessReason(
  stage: StageId,
  input: PipelineInput,
): string | null {
  const { staleLines, unrecordedLines, assemblyCurrent, hasAssembly, introPending } = input;

  if (stage === "voice") {
    const changed = staleLines.size;
    const missing = unrecordedLines.size;
    if (changed === 0 && missing === 0 && !introPending) return null;
    const parts: string[] = [];
    if (changed > 0) {
      parts.push(`${changed} line${changed === 1 ? "" : "s"} changed since recording`);
    }
    if (missing > 0) {
      parts.push(`${missing} line${missing === 1 ? "" : "s"} never recorded`);
    }
    // Named separately because it is not one of the numbered lines, and
    // "1 line never recorded" would send the user looking for it in the script.
    if (introPending) parts.push("the opening line is not recorded");
    return `${parts.join(" · ")}.`;
  }

  if (stage === "assembly") {
    if (!hasAssembly) return null;
    if (staleLines.size > 0) {
      return "The narration changed after this cut was rendered.";
    }
    if (introPending) {
      return "The opening line changed after this cut was rendered.";
    }
    if (!assemblyCurrent) {
      return "The audio or the cut's settings changed since this was rendered.";
    }
    return null;
  }

  return null;
}

/**
 * Whether a stage can be opened.
 *
 * Everything is always open. The request was to be able to jump anywhere at any
 * time, and a rail that refuses clicks is a worse teacher than a stage that
 * explains what it is waiting for — which is what `StageMeta.needs` is for.
 */
export function canEnter(): boolean {
  return true;
}

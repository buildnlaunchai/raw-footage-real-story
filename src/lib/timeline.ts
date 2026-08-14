/**
 * The cut, as something you can edit.
 *
 * Everything before this stage decides the film by rule: narration drives
 * timing, the footage order drives sequence, the 2x cap decides how a short
 * clip covers a long line. Those rules produce a good first cut and there is
 * no argument with them — but they are rules, and a film is not finished until
 * somebody has overruled a few of them.
 *
 * So this is deliberately *overrides on a plan*, not a replacement for it. Each
 * edit says "this shot, but with different footage / trimmed later / dissolving
 * into the next one / not at all", and everything left unsaid keeps following
 * the rules. Two things fall out of that which matter:
 *
 * - An edited timeline survives a re-recorded voiceover. The plan is recomputed
 *   from the new audio and the overrides land on top, so changing one word does
 *   not throw away an afternoon of trimming.
 * - Nothing here can produce a cut the renderer cannot make. Narration is never
 *   stretched, nothing is slowed past the cap, and no shot can be shorter than
 *   the line spoken over it, because those are still decided downstream.
 *
 * Pure and dependency-free, so the whole edit model is testable without a
 * browser or ffmpeg.
 */

/** The identity a line, its audio, and its shot all share. */
export function shotKey(clipId: string, segmentIndex: number): string {
  return `${clipId}#${segmentIndex}`;
}

export interface ShotEdit {
  /**
   * Show this footage instead of the clip the line was written for.
   *
   * The line still belongs to its own moment — the words, the narration audio
   * and the subtitle are untouched. Only the picture changes, which is exactly
   * what "this shot is out of focus, use the other one" means.
   */
  sourceClipId?: string;
  /** Start the shot later in its source, in milliseconds from the clip's start. */
  sourceInMs?: number;
  /** Dissolve into the next shot. 0 is a cut. */
  transitionMs?: number;
  /** False drops the shot, and its line, from the film. */
  enabled?: boolean;
  /**
   * This shot's own sound, overriding the track's setting.
   *
   * Per shot because "keep the sound" is rarely a decision about a film — it
   * is a decision about the two clips with something worth hearing in them and
   * the twenty with wind noise.
   */
  sound?: { enabled: boolean; gain?: number };
  /**
   * Show only part of this shot's slot, because it was split.
   *
   * A split does not create a new line — the narration is one recording and
   * cannot be cut in half. It creates a second *shot* over the same line, so
   * the picture can change part way through a sentence while the voice runs
   * on. `splitAtMs` is measured from the start of the slot.
   */
  splitAtMs?: number;
  /** Which half of a split this shot is. Absent when it was never split. */
  splitHalf?: "first" | "second";
}

export interface AudioTrack {
  enabled: boolean;
  /** 0..1, as an amplitude multiplier rather than decibels. */
  gain: number;
}

export interface MusicTrack extends AudioTrack {
  /** A file the user chose. */
  path: string | null;
  /** One of the bundled beds instead. Exactly one of these two is ever set. */
  bedId: string | null;
  /** What to call it on the track header. */
  label: string | null;
}

/** Whether the music track has anything to play. */
export function hasMusic(m: MusicTrack): boolean {
  return Boolean(m.path || m.bedId);
}

/**
 * How burned-in captions look.
 *
 * Exposed rather than fixed because a caption sits on top of somebody's
 * footage: the size that reads on a phone buries a wide landscape shot, and
 * white on white snow is not a caption at all.
 */
export interface SubtitleStyle {
  /** Text height as a fraction of the frame height. */
  size: number;
  /** How far above the bottom edge it sits, as a fraction of the height. */
  bottom: number;
  /** `&HBBGGRR` — ASS colour order, which is not RGB. */
  colour: string;
  /** A dark plate behind the text rather than only an outline. */
  boxBehind: boolean;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  // Measured against the frame rather than fixed in points: 1/26 of the height
  // is about 41px on 1080p, which reads on a laptop without dominating a phone.
  size: 1 / 26,
  // The lower third — clear of the bottom edge and of anything a player draws
  // over it, without climbing into the picture.
  bottom: 0.085,
  colour: "#ffffff",
  boxBehind: false,
};

/** The colours offered, as names a person would use. */
export const SUBTITLE_COLOURS = [
  { label: "White", value: "#ffffff" },
  { label: "Yellow", value: "#ffe14d" },
  { label: "Soft grey", value: "#e6e6e6" },
];

/** `#rrggbb` to the `&HBBGGRR` that ASS wants. Not a byte swap by accident. */
export function toAssColour(hex: string): string {
  const h = hex.replace("#", "");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

export interface TimelineDoc {
  /** Shot order, by key. Absent keys keep their planned position, at the end. */
  order: string[];
  edits: Record<string, ShotEdit>;
  /** The clips' own sound, under the narration. */
  originalAudio: AudioTrack;
  music: MusicTrack;
  /** Draw the script into the picture. */
  subtitles: boolean;
  subtitleStyle: SubtitleStyle;
}

export const DEFAULT_TIMELINE: TimelineDoc = {
  order: [],
  edits: {},
  // Off by default. A rough cut is a narration over pictures, and traffic
  // under a voice is a choice somebody should make on purpose.
  originalAudio: { enabled: false, gain: 0.25 },
  music: { enabled: false, gain: 0.1, path: null, bedId: null, label: null },
  subtitles: false,
  subtitleStyle: DEFAULT_SUBTITLE_STYLE,
};

/** One shot as the timeline shows it, after the edits are applied. */
export interface Shot {
  key: string;
  clipId: string;
  segmentIndex: number;
  /** Whose footage is on screen — the line's own clip unless it was swapped. */
  sourceClipId: string;
  sourceInMs: number;
  /** How long it is on screen. Decided by the narration, never by the edit. */
  durationMs: number;
  startMs: number;
  /** Dissolve into the next shot. */
  transitionMs: number;
  enabled: boolean;
  text: string;
  /** True when the shot shows footage the line was not written for. */
  swapped: boolean;
  /**
   * This shot's own sound, when it has an opinion. Null means "whatever the
   * track says".
   *
   * `gain` stays null when the shot only said on-or-off: resolving it here
   * *and* in `soundGains` meant two sources for one number, free to disagree
   * — which they did.
   */
  sound: { enabled: boolean; gain: number | null } | null;
}

export interface PlannedShot {
  clipId: string;
  segmentIndex: number;
  durationMs: number;
  sourceInMs: number;
  text: string;
}

/**
 * Apply a document to a planned cut.
 *
 * The plan arrives in the renderer's own order and timing; this reorders it,
 * drops what is disabled, swaps footage, and lays the start times out again so
 * the timeline shows where things actually fall.
 */
export function applyEdits(planned: PlannedShot[], doc: TimelineDoc): Shot[] {
  const byKey = new Map(planned.map((p) => [shotKey(p.clipId, p.segmentIndex), p]));

  // Named order first, then anything the document has never heard of — a shot
  // added by a longer script must appear rather than vanish because an older
  // timeline does not mention it.
  const seen = new Set<string>();
  const ordered: PlannedShot[] = [];
  for (const key of doc.order) {
    const p = byKey.get(key);
    if (p && !seen.has(key)) {
      seen.add(key);
      ordered.push(p);
    }
  }
  for (const p of planned) {
    const key = shotKey(p.clipId, p.segmentIndex);
    if (!seen.has(key)) ordered.push(p);
  }

  const out: Shot[] = [];
  let cursor = 0;
  for (const p of ordered) {
    const key = shotKey(p.clipId, p.segmentIndex);
    const edit = doc.edits[key] ?? {};
    const enabled = edit.enabled !== false;
    const sourceClipId = edit.sourceClipId ?? p.clipId;
    const shot: Shot = {
      key,
      clipId: p.clipId,
      segmentIndex: p.segmentIndex,
      sourceClipId,
      sourceInMs: edit.sourceInMs ?? p.sourceInMs,
      durationMs: p.durationMs,
      startMs: cursor,
      transitionMs: Math.max(0, edit.transitionMs ?? 0),
      enabled,
      text: p.text,
      swapped: sourceClipId !== p.clipId,
      sound: edit.sound
        ? { enabled: edit.sound.enabled, gain: edit.sound.gain ?? null }
        : null,
    };
    out.push(shot);
    // A disabled shot occupies no time, but stays in the list so it can be
    // brought back without being re-found.
    if (enabled) cursor += p.durationMs;
  }
  return out;
}

/** Total runtime, less the overlap every dissolve consumes. */
export function runtimeMs(shots: Shot[]): number {
  const live = shots.filter((s) => s.enabled);
  const total = live.reduce((n, s) => n + s.durationMs, 0);
  // The last shot's transition dissolves into nothing, so it costs nothing.
  const overlap = live.slice(0, -1).reduce((n, s) => n + s.transitionMs, 0);
  return Math.max(0, total - overlap);
}

/** The dissolve at each boundary, in the order the renderer wants them. */
export function transitionsFor(shots: Shot[]): number[] {
  const live = shots.filter((s) => s.enabled);
  return live.slice(0, -1).map((s) => s.transitionMs);
}

// --- edits ------------------------------------------------------------------
//
// Each returns a new document. Immutable because the editor keeps a history
// for undo, and a mutated document would rewrite every past state with it.

export function withEdit(doc: TimelineDoc, key: string, edit: ShotEdit): TimelineDoc {
  return { ...doc, edits: { ...doc.edits, [key]: { ...doc.edits[key], ...edit } } };
}

export function withOrder(doc: TimelineDoc, order: string[]): TimelineDoc {
  return { ...doc, order };
}

/** Move a shot to another shot's position, keeping everything else in order. */
export function moved(shots: Shot[], fromKey: string, toKey: string): string[] {
  const keys = shots.map((s) => s.key);
  const from = keys.indexOf(fromKey);
  const to = keys.indexOf(toKey);
  if (from < 0 || to < 0 || from === to) return keys;
  const next = [...keys];
  const [k] = next.splice(from, 1);
  next.splice(to, 0, k);
  return next;
}

/**
 * How far a shot may be trimmed into its source and still cover its line.
 *
 * Past this the renderer would have to slow the remainder more than twice to
 * fill the slot, which it will not do — it replays the shot instead. Better to
 * stop the handle here than to let someone drag into a cut that stutters.
 */
export function maxTrimMs(clipDurationMs: number | null, slotMs: number): number {
  if (clipDurationMs == null) return 0;
  const needed = Math.ceil(slotMs / 2);
  return Math.max(0, clipDurationMs - needed);
}

/** The longest dissolve a boundary can take without swallowing either shot. */
export function maxTransitionMs(a: Shot | undefined, b: Shot | undefined): number {
  if (!a || !b) return 0;
  // A third of the shorter neighbour, matching `clamp_crossfade` in the
  // renderer — a dissolve eats time from both sides, and two overlapping fades
  // on a short shot can leave no un-faded frames at all.
  return Math.min(1_500, Math.floor(Math.min(a.durationMs, b.durationMs) / 3));
}

/**
 * How loud each shot's own sound should be, in the order the renderer wants.
 *
 * A shot with no opinion takes the track's setting; one with an opinion
 * overrides it, including turning itself off while the track is on. Zero means
 * silent, which is how the renderer already reads it.
 */
export function soundGains(shots: Shot[], track: AudioTrack): number[] {
  return shots
    .filter((s) => s.enabled)
    .map((s) => {
      if (s.sound) return s.sound.enabled ? (s.sound.gain ?? track.gain) : 0;
      return track.enabled ? track.gain : 0;
    });
}

/**
 * Whether any shot wants its own sound at all.
 *
 * The renderer probes each clip for an audio track when this is on, which
 * costs a little, so it is worth knowing that the answer is no.
 */
export function anySound(shots: Shot[], track: AudioTrack): boolean {
  return soundGains(shots, track).some((g) => g > 0);
}

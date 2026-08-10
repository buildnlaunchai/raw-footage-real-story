/**
 * Pure segment manipulation for the describe-clips screen.
 *
 * The invariant everything else relies on: a clip's segments are **contiguous
 * and gapless**, covering the whole clip in order. Users mark boundaries, never
 * ranges, so a gap or an overlap is not representable — which removes a whole
 * class of "why is there a hole at 12s" confusion from the highest-friction
 * screen in the app.
 *
 * Dependency-free so it can be exercised outside the Tauri runtime.
 */

export interface Segment {
  startSec: number;
  endSec: number;
  text: string;
}

/** Boundaries closer than this are treated as the same instant. */
export const EPSILON_SEC = 0.05;

/** The single segment an undescribed clip starts with. */
export function initialSegments(durationSec: number): Segment[] {
  return [{ startSec: 0, endSec: Math.max(0, durationSec), text: "" }];
}

/**
 * Split the segment containing `at` in two.
 *
 * The existing text stays with the earlier half, because it described what came
 * before the boundary the user just marked. Returns the input unchanged when
 * `at` is outside any segment or too close to an existing boundary.
 */
export function splitAt(segments: Segment[], at: number): Segment[] {
  const i = segments.findIndex(
    (s) => at > s.startSec + EPSILON_SEC && at < s.endSec - EPSILON_SEC,
  );
  if (i === -1) return segments;
  const target = segments[i];
  return [
    ...segments.slice(0, i),
    { startSec: target.startSec, endSec: at, text: target.text },
    { startSec: at, endSec: target.endSec, text: "" },
    ...segments.slice(i + 1),
  ];
}

/**
 * Remove the boundary before `index`, merging that segment into its
 * predecessor. Descriptions are joined rather than one being discarded.
 */
export function mergeAt(segments: Segment[], index: number): Segment[] {
  if (index <= 0 || index >= segments.length) return segments;
  const prev = segments[index - 1];
  const cur = segments[index];
  const merged: Segment = {
    startSec: prev.startSec,
    endSec: cur.endSec,
    text: [prev.text.trim(), cur.text.trim()].filter(Boolean).join(". "),
  };
  return [...segments.slice(0, index - 1), merged, ...segments.slice(index + 1)];
}

/** True when segments tile the clip in order with no gaps or overlaps. */
export function isContiguous(segments: Segment[], durationSec?: number): boolean {
  if (segments.length === 0) return false;
  if (Math.abs(segments[0].startSec) > EPSILON_SEC) return false;
  for (let i = 1; i < segments.length; i++) {
    if (Math.abs(segments[i].startSec - segments[i - 1].endSec) > EPSILON_SEC) return false;
    if (segments[i].endSec <= segments[i].startSec) return false;
  }
  if (durationSec !== undefined) {
    const end = segments[segments.length - 1].endSec;
    if (Math.abs(end - durationSec) > EPSILON_SEC) return false;
  }
  return true;
}

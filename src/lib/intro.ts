/**
 * The opening montage: which shots run under the hook, and for how long.
 *
 * The hook is one spoken line, but a single clip held under it for eight
 * seconds is not an opening — it is a long shot with a voice over it. So this
 * cuts several brief shots underneath one piece of narration, which is the one
 * place in the app where a line does not map to a moment.
 *
 * That mapping is deliberately *not* a new timeline concept. The montage is
 * rendered into a single file and enters the timeline as one ordinary item —
 * the same trick placeholders already use. What lives here is only the
 * decision: which seconds of which clips, in what order, for how long.
 *
 * Dependency-free so the decision can be tested without ffmpeg or a library.
 */

/** Shortest and longest a montage shot may be, in milliseconds. */
export const MIN_SHOT_MS = 700;
export const MAX_SHOT_MS = 1_400;
export const MIN_SHOTS = 3;
export const MAX_SHOTS = 8;

export interface ShotCandidate {
  clipId: string;
  segmentIndex: number;
  /** Where this described moment starts and ends in the source, in ms. */
  startMs: number;
  endMs: number;
  sourcePath: string | null;
}

export interface Shot {
  clipId: string;
  segmentIndex: number;
  sourcePath: string;
  /** Where to start reading the source. */
  sourceInMs: number;
  /** How long this shot is on screen. */
  durationMs: number;
}

/**
 * How many shots a hook of this length wants.
 *
 * About a second each: quick enough to read as a montage, slow enough that a
 * viewer registers what they saw. The bounds matter more than the arithmetic —
 * two shots is not a montage, and nine in eight seconds is a strobe.
 */
export function shotCount(hookMs: number): number {
  const ideal = Math.round(hookMs / 1_000);
  return Math.max(MIN_SHOTS, Math.min(MAX_SHOTS, ideal));
}

/**
 * Choose the shots.
 *
 * Ordered by what serves an opening:
 *
 * 1. **Never the clip line one opens on.** The montage crossfades into it, and
 *    a shot dissolving into itself looks like a glitch rather than a cut.
 * 2. **Footage the story does not otherwise use, first.** A library usually has
 *    far more in it than one script can carry, and the opening is the one place
 *    that material can earn its keep.
 * 3. **Then the story's own moments**, so the opening still belongs to the film
 *    that follows.
 *
 * Within each group the original order is kept, so the montage moves through
 * the trip roughly as the trip did.
 */
export function pickShots(
  hookMs: number,
  candidates: ShotCandidate[],
  opts: { storyClipIds: string[]; firstLineClipId: string | null },
): Shot[] {
  const usable = candidates.filter(
    (c) => c.sourcePath && c.endMs > c.startMs && c.clipId !== opts.firstLineClipId,
  );
  if (usable.length === 0) return [];

  const inStory = new Set(opts.storyClipIds);
  const unused = usable.filter((c) => !inStory.has(c.clipId));
  const used = usable.filter((c) => inStory.has(c.clipId));

  const want = shotCount(hookMs);
  const ordered = [...unused, ...used];

  // One shot per clip while there are clips to spare, so the opening does not
  // show the same place three times before the film has begun.
  const picked: ShotCandidate[] = [];
  const seenClips = new Set<string>();
  for (const c of ordered) {
    if (picked.length >= want) break;
    if (seenClips.has(c.clipId)) continue;
    seenClips.add(c.clipId);
    picked.push(c);
  }
  // Only if that was not enough do we allow a clip to appear twice.
  for (const c of ordered) {
    if (picked.length >= want) break;
    if (!picked.includes(c)) picked.push(c);
  }
  if (picked.length === 0) return [];

  // The hook's length is the montage's length — narration stays the clock, as
  // it is everywhere else. Remainder goes to the first shots so the total is
  // exact rather than a rounding short.
  const each = Math.floor(hookMs / picked.length);
  const remainder = hookMs - each * picked.length;

  return picked.map((c, i) => {
    const durationMs = each + (i < remainder ? 1 : 0);
    const span = c.endMs - c.startMs;
    // The middle of a described moment: the most representative second of it,
    // and away from the edges where fades and dead frames live.
    const middle = c.startMs + Math.max(0, Math.floor((span - durationMs) / 2));
    return {
      clipId: c.clipId,
      segmentIndex: c.segmentIndex,
      sourcePath: c.sourcePath!,
      sourceInMs: middle,
      durationMs,
    };
  });
}

/** Total montage length; equals the hook when there is anything to show. */
export function montageMs(shots: Shot[]): number {
  return shots.reduce((n, s) => n + s.durationMs, 0);
}

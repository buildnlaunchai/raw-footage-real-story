/**
 * The one rule that decides when a player is allowed to be moved.
 *
 * It exists because getting it wrong froze the app. The music track is shorter
 * than the film, and the viewer seeked it to the playhead's position: past the
 * end of the file, the element clamps to its own duration, so the difference
 * never closes and the next frame asks again. Sixty times a second, through a
 * twenty-six megabyte wav, the window stopped responding and the music was
 * never heard — it never played for longer than a frame at a time.
 *
 * Two conditions, then. Never ask for a moment a file does not contain, and do
 * not ask at all unless the player has genuinely drifted.
 */

/** How far out of step a player may be before it is worth moving. */
const SLACK_S = 0.35;

/**
 * Where a player should be moved to, or null to leave it alone.
 *
 * `duration` is NaN until a file's metadata has loaded, which is why an
 * unknown length is treated as "no reason to refuse" rather than as zero.
 */
export function seekTarget(
  currentTime: number,
  wanted: number,
  duration: number,
): number | null {
  if (Number.isFinite(duration) && duration > 0 && wanted >= duration) return null;
  const to = Math.max(0, wanted);
  return Math.abs(currentTime - to) > SLACK_S ? to : null;
}

/**
 * Where a looping track should be at a given moment in the film.
 *
 * Music is laid under the whole film and repeats, so a film longer than its
 * music is the ordinary case, not an edge one.
 */
export function loopPosition(elapsedS: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, elapsedS);
  return Math.max(0, elapsedS) % duration;
}

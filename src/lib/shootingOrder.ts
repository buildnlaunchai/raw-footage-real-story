/**
 * Putting footage back into the order it was shot in.
 *
 * There are two signals and they do not always agree.
 *
 * A camera's file numbering is monotonic *by construction*: it increments once
 * per recording and nothing afterwards rewrites it. `creation_time` inside the
 * file is metadata, and every transcoder, messaging app and export tool feels
 * free to replace it — which is exactly what happened to one real project here:
 * fifty clips compressed from 1080p HEVC to 720p h264 came out with timestamps
 * claiming the phone had counted *downwards* over fifteen hours.
 *
 * So where the filenames form a clean run from one camera, they win. Where they
 * do not — several cameras, files renamed by hand, a folder of `final_v2.mp4` —
 * there is no sequence to read and the timestamp is the only thing left.
 *
 * Which basis was used is returned rather than hidden, because when the two
 * disagree that is worth saying out loud instead of quietly picking one.
 */

export interface Shootable {
  fileName: string | null;
  capturedAtMs?: number | null;
}

export type OrderBasis =
  /** Camera file numbering — `IMG_8127`, `DSC_0042`. */
  | "camera-sequence"
  /** The timestamp inside each file. */
  | "capture-time"
  /** Neither is usable; alphabetical, with numbers compared as numbers. */
  | "filename";

/** `IMG_8127.MP4` -> `{ prefix: "img_", number: 8127 }`. */
function parseName(name: string | null): { prefix: string; number: number } | null {
  if (!name) return null;
  // The last run of digits before the extension: `IMG_8127.MP4` and also
  // `GX010042.MP4`. Anything with no digits at all is not a sequence.
  const stem = name.replace(/\.[^.]+$/, "");
  const m = /^(.*?)(\d+)$/.exec(stem);
  if (!m) return null;
  return { prefix: m[1].toLowerCase(), number: Number(m[2]) };
}

/**
 * Whether these files are one camera's numbered run.
 *
 * One prefix and no repeats. Two cameras give two prefixes, or the same prefix
 * with colliding numbers — either way the numbering means nothing across the
 * set and the timestamps are the better guide.
 */
export function isCameraSequence(clips: Shootable[]): boolean {
  if (clips.length < 3) return false;
  const parsed = clips.map((c) => parseName(c.fileName));
  if (parsed.some((p) => p === null)) return false;
  const prefixes = new Set(parsed.map((p) => p!.prefix));
  if (prefixes.size !== 1) return false;
  const numbers = new Set(parsed.map((p) => p!.number));
  return numbers.size === clips.length;
}

/** Which signal to trust for this particular set of files. */
export function orderBasis(clips: Shootable[]): OrderBasis {
  if (isCameraSequence(clips)) return "camera-sequence";
  // Every clip, not most: a partial set of timestamps sorts the ones that have
  // them and guesses at the rest, which is worse than one consistent rule.
  if (clips.length > 0 && clips.every((c) => c.capturedAtMs != null)) return "capture-time";
  return "filename";
}

function byFilename(a: Shootable, b: Shootable): number {
  return (a.fileName ?? "").localeCompare(b.fileName ?? "", undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/** The clips, in the order they were shot, by whichever signal is usable. */
export function sortByShootingOrder<T extends Shootable>(clips: T[]): T[] {
  const basis = orderBasis(clips);
  const out = [...clips];
  if (basis === "camera-sequence") {
    out.sort((a, b) => parseName(a.fileName)!.number - parseName(b.fileName)!.number);
  } else if (basis === "capture-time") {
    out.sort((a, b) => (a.capturedAtMs ?? 0) - (b.capturedAtMs ?? 0));
  } else {
    out.sort(byFilename);
  }
  return out;
}

/**
 * Whether the two signals tell different stories.
 *
 * Worth saying out loud when it happens: it means the timestamps were rewritten
 * somewhere between the camera and here, and it is the only warning anybody
 * gets that the dates in the list are not to be believed.
 */
export function signalsDisagree(clips: Shootable[]): boolean {
  if (!isCameraSequence(clips)) return false;
  if (!clips.every((c) => c.capturedAtMs != null)) return false;
  const byNumber = [...clips].sort(
    (a, b) => parseName(a.fileName)!.number - parseName(b.fileName)!.number,
  );
  const times = byNumber.map((c) => c.capturedAtMs!);
  return times.some((t, i) => i > 0 && t < times[i - 1]);
}

/** What was done, in a sentence, for the message shown after sorting. */
export function describeOrdering(clips: Shootable[]): string {
  const n = clips.length;
  const basis = orderBasis(clips);
  const noun = `${n} clip${n === 1 ? "" : "s"}`;
  if (basis === "camera-sequence") {
    return signalsDisagree(clips)
      ? `Ordered ${noun} by camera file number. The times stored inside these files ` +
          `disagree with that order — they were probably rewritten when the videos ` +
          `were compressed or shared, so the dates shown are not when you filmed.`
      : `Ordered ${noun} by camera file number.`;
  }
  if (basis === "capture-time") return `Ordered ${noun} by the time each was recorded.`;
  return `Ordered ${noun} by filename — these files carry no recording time and their ` +
    `names are not one camera's numbering, so this is a guess.`;
}

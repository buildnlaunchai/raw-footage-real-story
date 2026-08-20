/**
 * Version ordering, by the semver rules rather than by comparing strings.
 *
 * The string comparison is the trap this file exists to avoid: `"0.10.0" <
 * "0.9.0"` is true, because `1` sorts before `9` one character in. A version
 * floor built on that would wave through the build it was meant to stop, and
 * would do it for the first time on the tenth minor release rather than in
 * any test written before then.
 *
 * Prereleases are handled because this project ships them — the first public
 * download was tagged `v0.1.0-beta.1` — and semver puts a prerelease *below*
 * the release it leads to. `0.3.0-beta.1` is older than `0.3.0`, so a floor of
 * `0.3.0` blocks the beta, which is what a floor is for.
 *
 * Everything here is total and side-effect free: unreadable input comes back
 * as `null` rather than throwing, because every caller is deciding whether to
 * lock somebody out of an application and none of them should do that because
 * a string was not the shape they expected. See `updateGate.ts`, which turns
 * every `null` into "no constraint".
 */

/** A version, parsed. Build metadata is dropped: semver says it never orders. */
export type Version = {
  major: number;
  minor: number;
  patch: number;
  /** The dot-separated identifiers after `-`. Empty for a plain release. */
  prerelease: string[];
};

/**
 * `v` is optional because both spellings are in circulation here: the git tags
 * carry it (`v0.2.0`), `package.json` does not (`0.2.0`), and the backend may
 * send either. Accepting both costs one character and removes a whole class of
 * "the floor did nothing" bug.
 *
 * Build metadata is matched so that a version carrying it still parses, and
 * then discarded — `1.0.0+build.5` and `1.0.0` are the same version.
 */
const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Read a version, or `null` if it is not one. Never throws. */
export function parseVersion(input: string | null | undefined): Version | null {
  if (typeof input !== "string") return null;
  const found = PATTERN.exec(input.trim());
  if (!found) return null;
  const [, major, minor, patch, prerelease] = found;
  const numbers = [Number(major), Number(minor), Number(patch)];
  // A version long enough to lose integer precision is not one we published.
  if (!numbers.every((n) => Number.isSafeInteger(n))) return null;
  return {
    major: numbers[0],
    minor: numbers[1],
    patch: numbers[2],
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

/** `-1` if `a` is older, `1` if newer, `0` if they are the same version. */
export function compare(a: Version, b: Version): -1 | 0 | 1 {
  const positions: ReadonlyArray<readonly [number, number]> = [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ];
  for (const [left, right] of positions) {
    if (left !== right) return left < right ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * The half of semver that people forget.
 *
 * A release outranks any prerelease of the same numbers, and *having no
 * prerelease at all* is what makes it a release — so the empty list is the
 * high value here, not the low one. Getting this backwards would make a floor
 * of `0.3.0` accept `0.3.0-beta.1`, which is the exact build a floor gets
 * raised to exclude.
 */
function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const verdict = compareIdentifier(a[i], b[i]);
    if (verdict !== 0) return verdict;
  }
  // Everything they share is equal, so the one with more identifiers is the
  // later one: `beta.1` precedes `beta.1.1`.
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Numeric identifiers compare as numbers, so `beta.9` precedes `beta.10` —
 * the same trap as the top of this file, one level down. Anything with a
 * non-digit in it compares as text, and a numeric identifier always ranks
 * below an alphanumeric one.
 */
function compareIdentifier(a: string, b: string): -1 | 0 | 1 {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const left = Number(a);
    const right = Number(b);
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Whether `installed` is below `floor`, when both can be read.
 *
 * `null` means "cannot say", and every caller must treat that as *no
 * constraint*. That is the fail-open rule the whole update gate rests on: a
 * floor nobody can parse must not become a floor nobody can pass.
 */
export function isBelow(installed: string | null | undefined, floor: string | null | undefined): boolean | null {
  const here = parseVersion(installed);
  const bar = parseVersion(floor);
  if (!here || !bar) return null;
  return compare(here, bar) < 0;
}

/** Whether two versions are the same version, ignoring `v` and build metadata. */
export function isSameVersion(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  return compare(left, right) === 0;
}

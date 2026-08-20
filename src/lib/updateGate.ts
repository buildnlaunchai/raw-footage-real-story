/**
 * Whether the build on this machine is still allowed to run.
 *
 * Kept apart from `entitlement.ts` on purpose. That file answers "is this
 * person entitled"; this one answers "is this binary current", and they are
 * different questions with different failure modes — the entitlement gate
 * fails *closed* when it cannot get an answer, and this one must fail *open*.
 *
 * **Everything unreadable means no constraint.** A missing field, an
 * unreachable endpoint, a floor that is not a version, a config the app could
 * not parse: all of it resolves to "carry on". The reason is asymmetric cost.
 * A gate that wrongly lets an old build run for another day is a day of the
 * status quo. A gate that wrongly blocks turns one bad deploy, or one typo in
 * a JSON field, into every installed copy of the application refusing to open
 * — with the fix on the other side of the wall it just built. There is no
 * remote way back from that, because the thing that would deliver the fix is
 * the thing that stopped working.
 *
 * The same reasoning is already written into `LicenceResponse` on the Rust
 * side, about desktop binaries and unexpected JSON. This is that rule applied
 * to the one field that can lock the door on its own.
 */

import { isBelow, isSameVersion } from "./semver";

/**
 * What the platform says about which desktop builds may run.
 *
 * Every field optional, and that is the contract rather than laziness: the
 * endpoint is allowed to answer `{}`, and an app that requires a field is an
 * app that breaks when the backend adds or renames one.
 */
export type DesktopConfig = {
  /** The oldest version still allowed to run. Absent means no floor. */
  minimumVersion?: string | null;
  /**
   * Specific builds withdrawn regardless of the floor.
   *
   * Separate from the floor because "too old" and "this exact build is bad"
   * are different statements. A floor cannot express "0.4.1 is broken but
   * 0.4.0 and 0.4.2 are fine" without also condemning everything below it.
   */
  killedVersions?: string[] | null;
  /** The newest published version, for telling somebody what they would get. */
  latestVersion?: string | null;
  /** Where to send them. The app composes no alternative — see below. */
  downloadUrl?: string | null;
  /** What changed, if there is somewhere to read it. */
  notesUrl?: string | null;
};

/** Why a build is being refused. The two cases read differently on screen. */
export type UpdateRefusal = "too-old" | "withdrawn";

export type UpdateBlock = {
  reason: UpdateRefusal;
  /** What is on this machine. */
  installed: string;
  /**
   * What they need. The floor for `too-old`, the newest published version for
   * `withdrawn` — and `null` when the platform did not say, which is possible
   * for `withdrawn` and means the screen shows one version instead of two.
   */
  required: string | null;
  downloadUrl: string | null;
  notesUrl: string | null;
};

/**
 * The decision.
 *
 * `null` is the answer for "may run", including every case where the question
 * could not be asked. A `config` of `null` — unreachable, not configured,
 * unparseable — is not a refusal.
 */
export function updateBlockFor(input: {
  installed: string | null | undefined;
  config: DesktopConfig | null | undefined;
}): UpdateBlock | null {
  const { installed, config } = input;
  if (!config) return null;
  // Not knowing our own version is not grounds for blocking ourselves. It
  // should be impossible — it comes from the binary — but "impossible" is how
  // the last incident started.
  if (!installed) return null;

  const links = {
    downloadUrl: text(config.downloadUrl),
    notesUrl: text(config.notesUrl),
  };

  // Withdrawn is checked first. A build named outright is a deliberate
  // statement about *that build*, and deserves its own wording even when it
  // also happens to sit below the floor.
  if (isWithdrawn(installed, config.killedVersions)) {
    return {
      reason: "withdrawn",
      installed,
      required: text(config.latestVersion),
      ...links,
    };
  }

  // `isBelow` returns null when either side is unreadable, and null is not
  // true — so an unparseable floor is no floor at all.
  if (isBelow(installed, text(config.minimumVersion)) === true) {
    return {
      reason: "too-old",
      installed,
      // The floor is what they must clear; the latest version is what they
      // will actually get. Prefer the latter when it is known, because it is
      // the number they will see on the download page.
      required: text(config.latestVersion) ?? text(config.minimumVersion),
      ...links,
    };
  }

  return null;
}

/**
 * Whether this build is on the withdrawn list.
 *
 * Compared as versions rather than as strings so that `v0.4.1` and `0.4.1`
 * are the same entry. Entries that cannot be read are skipped rather than
 * matched: a typo in the list must not withdraw a build nobody named.
 */
function isWithdrawn(installed: string, killed: string[] | null | undefined): boolean {
  if (!Array.isArray(killed)) return false;
  return killed.some((entry) => isSameVersion(installed, entry) === true);
}

/** A usable string, or `null`. Empty and whitespace are the same as absent. */
function text(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

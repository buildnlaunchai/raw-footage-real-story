/**
 * Who gets in, and who gets told why not.
 *
 * This is the whole decision, kept apart from the screen that renders it so it
 * can be argued with in tests rather than by clicking through five states.
 *
 * ## The rule everything else hangs off
 *
 * **Silence is not a refusal.** A platform that cannot be reached has not said
 * no; it has said nothing. Reading nothing as no is how a paying customer gets
 * shown a login wall on a plane, holding footage they are on that trip to cut.
 * A definitive "this subscription is not active" blocks at once — that is a
 * real answer. A timeout does not.
 *
 * ## Why the grace period is a month
 *
 * This is a travel app. Its users are, by definition, away — on flights, in
 * hotels behind captive portals, in places where data costs money. The moment
 * they most want to cut yesterday's footage is the moment they are least
 * likely to have a usable connection.
 *
 * The two failure modes are not symmetric. Too short, and somebody who paid is
 * locked out of their own work halfway through a trip, with no way to fix it
 * from where they are. Too long, and somebody who cancelled keeps working for
 * up to a month — which costs about one month of one subscription. The second
 * is a rounding error. The first is the review that sinks a product.
 *
 * ## What this cannot do
 *
 * Checking a licence inside a program running on somebody else's machine is a
 * deterrent, not a lock — anyone determined enough can patch it out. The point
 * is to keep honest customers on a smooth path and make casual sharing
 * inconvenient. That is why the grace is generous and there is no
 * anti-tamper theatre here: effort spent on that would buy nothing and cost
 * the people who paid.
 */

/** How long a cached licence keeps working with no way to re-check it. */
import type { UpdateBlock } from "./updateGate";

export const GRACE_DAYS = 30;

/** When to start saying so. A week's notice is enough to find a connection. */
export const WARN_AFTER_DAYS = 23;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the last successful check found, and when. */
export interface CachedLicence {
  active: boolean;
  /** ISO-8601, from the server rather than this machine's clock. */
  checkedAt: string;
  /**
   * Why the platform said no, in its own word.
   *
   * Read back out of the *signed* claims by `licence_cache::recall`, not out
   * of a plain field somebody could edit — which is what lets it be trusted a
   * month later on a machine its owner controls, and what makes the offline
   * screen the same screen a live check would have chosen.
   */
  reason?: string;
  /** When the membership ended, for `membership_inactive`. */
  expiresAt?: string;
}

/**
 * Why the platform is saying no.
 *
 * These four words and no others — the vocabulary of the `reason` field,
 * confirmed against production, carried both in the JSON response and in the
 * signed token's claims. The Rust mirror is `licence::Denial`, and the wire
 * format between them is the platform's own word, unchanged.
 *
 * All four block. The difference is entirely in what the person is told, and
 * that difference is the whole reason this is not a boolean: an unpaid account
 * is fixed by a checkout, a lapsed one by a renewal, a suspended one only by
 * talking to a person, and `no_access` by us fixing our own bug. Three of the
 * four are actively harmed by being shown a billing page.
 */
export type Denial = "suspended" | "no_membership" | "membership_inactive" | "no_access";

const DENIALS: readonly string[] = [
  "suspended",
  "no_membership",
  "membership_inactive",
  "no_access",
];

/**
 * Read the platform's `reason` as one of the four, or as nothing.
 *
 * Exact and case-sensitive, which it can afford to be now that the field and
 * its values are known. What this replaced was a case-insensitive substring
 * search across `reason` *and* `status` for the letters "suspend" — a hedge
 * against not knowing which field would carry it or how it would be spelled.
 *
 * ## Why an unknown word is not a refusal
 *
 * `null` means "no opinion", not "denied", and the direction matters. Each of
 * the four *is* a denial, so a word on the list blocks. A word off it leaves
 * the entitlement to `active`, exactly as before any reason existed — because
 * the day the platform puts a `reason: "grace_period"` beside a paying account,
 * a build that treated unfamiliar words as refusals would lock out everybody
 * who had paid. A denial the app has not been taught still blocks through
 * `active: false`; it just lands on the generic screen, which is the honest
 * one when all that is known is "not active".
 */
export function denialFor(reason: string | null | undefined): Denial | null {
  return typeof reason === "string" && DENIALS.includes(reason) ? (reason as Denial) : null;
}

/**
 * The date a membership ended, as it should be read on screen.
 *
 * `null` for anything that cannot be made into a date: the field absent — the
 * platform mirrors it in the response for certain, and whether it also signs
 * it into the claims is its own business — or a string that does not parse.
 * The screen has to read without it rather than print "Invalid Date", which is
 * why this hands back nothing instead of a placeholder.
 *
 * Fixed format and UTC rather than the machine's locale, because a billing
 * date is the same date for everybody: rendering it locally would print the
 * day before the one on the invoice for anyone west of Greenwich.
 */
export function endedOn(expiresAt?: string | null): string | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * What this launch's check found.
 *
 * `unreachable` is its own answer and never collapses into `denied`. That is
 * the rule the whole offline design rests on: a platform that could not be
 * reached has not said no.
 *
 * `denied` carries *why* rather than being four separate kinds, because the
 * gate treats all four identically — they block — and only the screen behind
 * it cares which. The reason travels as far as `gateFor` and stops there.
 */
export type LiveCheck =
  | { kind: "active" }
  | { kind: "denied"; reason: Denial | null; expiresAt?: string }
  | { kind: "unreachable" }
  | { kind: "not-attempted" };

/**
 * What `auth_licence` hands back after asking the platform.
 *
 * `null` from the command is not this shape and not an error: it means the
 * stored session was refused and forgotten, and the honest state is signed
 * out.
 */
export interface LicenceState {
  active: boolean;
  /** ISO-8601 from the platform's own `Date` header, not this machine's clock. */
  checkedAt: string;
  status?: string;
  /**
   * Why, in the platform's exact word. Four are acted on — see [`denialFor`].
   */
  reason?: string;
  /** When the membership ended. Sent with `membership_inactive`. */
  expiresAt?: string;
  plan?: string;
  /**
   * Whether the signature on the platform's licence token was actually
   * checked. `false` is the honest answer for a build with no key compiled in
   * yet — it does **not** mean the check failed.
   *
   * Nothing may be written to disk on a `false`: an unsigned entitlement at
   * rest on somebody's machine is a suggestion, not evidence.
   */
  verified: boolean;
}

/**
 * A licence answer, as the two pieces of gate state it becomes.
 *
 * Both come from one response on purpose: a live check that updates the cache
 * to a different account's answer, or updates it with this machine's clock, is
 * how a grace period silently becomes wrong.
 */
export function fromLicence(state: LicenceState): { live: LiveCheck; cached: CachedLicence } {
  // A denial beats whatever `active` says, rather than being read after it.
  // The two should never disagree, and if they ever do — a backend that bars
  // an account without clearing its subscription flag is an ordinary bug —
  // the restrictive reading is the one that fails towards the truth, and it
  // keeps a contradiction from being cached as a month of access.
  const reason = denialFor(state.reason);
  const active = state.active && reason === null;
  return {
    live: active ? { kind: "active" } : { kind: "denied", reason, expiresAt: state.expiresAt },
    // The word is kept, not just the verdict. This cache is the one React
    // holds for the rest of the session; the one on disk is filled by
    // `auth_cached_licence` from the signed claims. Both have to carry the
    // reason or the same account gets a different screen depending on which
    // of them the gate happened to read.
    cached: {
      active,
      checkedAt: state.checkedAt,
      reason: state.reason,
      expiresAt: state.expiresAt,
    },
  };
}

export interface GateInput {
  /** Null when nobody is signed in on this machine. */
  session: { email: string } | null;
  cached: CachedLicence | null;
  live: LiveCheck;
  now: Date;
}

export type Gate =
  /**
   * The build itself is refused: below the floor, or withdrawn by name.
   *
   * Not an entitlement state at all, and it lives in this union anyway because
   * this is the union that decides whether the application renders. Keeping it
   * here means the existing rule — the gate renders *instead of* the app, so
   * nothing behind it mounts or starts work — covers it for free.
   *
   * It outranks every other state, including `suspended` and `read-only`. The
   * ranking is the whole point: this is the one screen that can fix the
   * others, because the update somebody is missing may be the thing that
   * repairs their sign-in. Precedence is decided in `App.tsx`, in one line,
   * rather than in [`gateFor`] — which stays about entitlement and nothing
   * else. See `updateGate.ts` for what is being decided and why it fails open.
   */
  | ({ state: "update-required" } & UpdateBlock)
  /** Restoring a session; show nothing decisive yet. */
  | { state: "checking" }
  /** Nobody signed in. The entry screen. */
  | { state: "signed-out" }
  /**
   * Signed in, blocked, and the platform did not say why — or said it in a
   * word this build has not been taught.
   *
   * The generic one, and deliberately vague: "this account doesn't have an
   * active subscription" is all that is actually known, and it is the only
   * one of these screens that can be shown without knowing the reason.
   */
  | { state: "no-licence"; email: string }
  /** Signed in, and there has never been a subscription. Fixed by buying one. */
  | { state: "no-membership"; email: string }
  /**
   * Signed in, and the subscription has lapsed. Fixed by renewing.
   *
   * `expiresAt` is when, and it is optional: the platform sends it in the
   * response, and whether it also signs it into the licence claims is its own
   * business — so the screen has to read without it. See [`endedOn`].
   */
  | { state: "membership-ended"; email: string; expiresAt?: string }
  /**
   * Signed in, and the platform says this account is barred.
   *
   * Separate from every other blocked state because the way out is different:
   * there is nothing to buy and nothing to retry, only a person to talk to.
   *
   * **This now survives going offline**, which it did not use to. The offline
   * cache is the signed licence token, and the token records why as well as
   * whether — so a suspended user reopening the app on a plane gets this
   * screen and not the billing one. See `reason` on [`CachedLicence`].
   */
  | { state: "suspended"; email: string }
  /**
   * Signed in, paid up as far as billing is concerned, and refused anyway.
   *
   * This one is ours. If it ever reaches a user it is a bug on our side, not a
   * state they can do anything about — so the screen says support and says
   * nothing about money, because there is nothing for them to buy.
   */
  | { state: "no-access"; email: string }
  /** Signed in, never yet verified, and offline. Must connect once. */
  | { state: "offline-first-run"; email: string }
  /** In. */
  | { state: "allowed" }
  /** In, but running on a cache that is getting old. */
  | { state: "allowed-grace"; daysLeft: number }
  /**
   * Past the grace period with no way to check.
   *
   * Deliberately not a locked door: existing projects still open and still
   * export. Holding somebody's finished film hostage over a lapsed check is a
   * different and worse thing than gating new work, and it is the version of
   * this that makes people angry enough to never come back.
   */
  | { state: "read-only"; daysOffline: number };

/** Whole days between two instants, never negative. */
export function daysBetween(then: string, now: Date): number {
  const t = Date.parse(then);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/**
 * Decide what the person in front of the app should see.
 *
 * Order matters: a definitive answer from the platform always beats the cache,
 * and the cache is only consulted when there is no answer to be had.
 */
export function gateFor(input: GateInput): Gate {
  const { session, cached, live, now } = input;

  if (!session) return { state: "signed-out" };
  if (live.kind === "not-attempted") return { state: "checking" };

  // A real answer, whichever way, settles it and refreshes the cache.
  if (live.kind === "denied") return blockedBy(session.email, live.reason, live.expiresAt);
  if (live.kind === "active") return { state: "allowed" };

  // Nothing came back. Fall back to what was last known to be true.
  if (!cached) return { state: "offline-first-run", email: session.email };
  // A cached "not active" is still a real answer that was given once; being
  // offline now does not make it stale in the person's favour — and it is
  // read through exactly the same words a live answer would be, so the person
  // is told the same thing either way.
  if (!cached.active) {
    return blockedBy(session.email, denialFor(cached.reason), cached.expiresAt);
  }

  const age = daysBetween(cached.checkedAt, now);
  if (age > GRACE_DAYS) return { state: "read-only", daysOffline: age };
  if (age >= WARN_AFTER_DAYS) return { state: "allowed-grace", daysLeft: GRACE_DAYS - age };
  return { state: "allowed" };
}

/**
 * The one place a reason becomes a screen.
 *
 * Shared by the live path and the offline one on purpose. Two copies of this
 * mapping is how a suspended account ends up correctly handled online and
 * pointed at a billing page on a plane — which is the bug this whole reason
 * field exists to prevent.
 */
function blockedBy(email: string, reason: Denial | null, expiresAt?: string): Gate {
  switch (reason) {
    case "suspended":
      return { state: "suspended", email };
    case "no_membership":
      return { state: "no-membership", email };
    case "membership_inactive":
      return { state: "membership-ended", email, expiresAt };
    case "no_access":
      return { state: "no-access", email };
    // No reason given, or one this build has never seen. Blocked either way,
    // and told the only thing that is actually known.
    default:
      return { state: "no-licence", email };
  }
}

/** Whether the app proper should render at all behind this gate. */
export function letsAppRender(gate: Gate): boolean {
  return gate.state === "allowed" || gate.state === "allowed-grace" || gate.state === "read-only";
}

/** Whether new work can be started, as opposed to finishing existing work. */
export function allowsNewProjects(gate: Gate): boolean {
  return gate.state === "allowed" || gate.state === "allowed-grace";
}

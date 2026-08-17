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
export const GRACE_DAYS = 30;

/** When to start saying so. A week's notice is enough to find a connection. */
export const WARN_AFTER_DAYS = 23;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the last successful check found, and when. */
export interface CachedLicence {
  active: boolean;
  /** ISO-8601, from the server rather than this machine's clock. */
  checkedAt: string;
}

/**
 * What this launch's check found.
 *
 * `unreachable` is its own answer and never collapses into `inactive`.
 */
export type LiveCheck =
  | { kind: "active" }
  | { kind: "inactive" }
  | { kind: "unreachable" }
  | { kind: "not-attempted" };

export interface GateInput {
  /** Null when nobody is signed in on this machine. */
  session: { email: string } | null;
  cached: CachedLicence | null;
  live: LiveCheck;
  now: Date;
}

export type Gate =
  /** Restoring a session; show nothing decisive yet. */
  | { state: "checking" }
  /** Nobody signed in. The entry screen. */
  | { state: "signed-out" }
  /** Signed in, and the platform says the subscription is not active. */
  | { state: "no-licence"; email: string }
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

  // A real answer, either way, settles it and refreshes the cache.
  if (live.kind === "active") return { state: "allowed" };
  if (live.kind === "inactive") return { state: "no-licence", email: session.email };

  // Nothing came back. Fall back to what was last known to be true.
  if (!cached) return { state: "offline-first-run", email: session.email };
  // A cached "not active" is still a real answer that was given once; being
  // offline now does not make it stale in the person's favour.
  if (!cached.active) return { state: "no-licence", email: session.email };

  const age = daysBetween(cached.checkedAt, now);
  if (age > GRACE_DAYS) return { state: "read-only", daysOffline: age };
  if (age >= WARN_AFTER_DAYS) return { state: "allowed-grace", daysLeft: GRACE_DAYS - age };
  return { state: "allowed" };
}

/** Whether the app proper should render at all behind this gate. */
export function letsAppRender(gate: Gate): boolean {
  return gate.state === "allowed" || gate.state === "allowed-grace" || gate.state === "read-only";
}

/** Whether new work can be started, as opposed to finishing existing work. */
export function allowsNewProjects(gate: Gate): boolean {
  return gate.state === "allowed" || gate.state === "allowed-grace";
}

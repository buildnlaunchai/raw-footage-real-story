// Who gets in, and who gets told why not.
//
// The decision is kept apart from the screen so it can be argued with here.
// Several of these pin behaviour that is easy to "simplify" into something
// that reads the same and strands a paying customer.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRACE_DAYS,
  WARN_AFTER_DAYS,
  allowsNewProjects,
  daysBetween,
  denialFor,
  endedOn,
  fromLicence,
  gateFor,
  letsAppRender,
} from "../.test-build/lib/entitlement.js";

const NOW = new Date("2026-08-17T12:00:00Z");
const SESSION = { email: "someone@example.com" };
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

test("nobody signed in is the entry screen, not a failure", () => {
  const g = gateFor({ session: null, cached: null, live: { kind: "not-attempted" }, now: NOW });
  assert.equal(g.state, "signed-out");
  assert.equal(letsAppRender(g), false);
});

test("a live yes lets them in", () => {
  const g = gateFor({ session: SESSION, cached: null, live: { kind: "active" }, now: NOW });
  assert.equal(g.state, "allowed");
  assert.ok(letsAppRender(g) && allowsNewProjects(g));
});

test("a live no blocks at once, however healthy the cache", () => {
  // The cache said yes an hour ago. The platform now says no. The platform
  // wins — this is the cancellation path, and honouring a stale yes here
  // would mean a month of free use after every cancellation.
  const g = gateFor({
    session: SESSION,
    cached: { active: true, checkedAt: daysAgo(0) },
    live: { kind: "denied", reason: null },
    now: NOW,
  });
  assert.equal(g.state, "no-licence");
  assert.equal(g.email, SESSION.email, "the screen has to say which account it means");
  assert.equal(letsAppRender(g), false);
});

// ── the invariant the whole offline design rests on ────────────────────────
//
// Mirrors `an_unreachable_platform_is_not_a_refusal` on the Rust side. If
// these two ever disagree, somebody gets locked out of software they paid for
// because their hotel wifi was captive.
test("silence is not a refusal", () => {
  const unreachable = gateFor({
    session: SESSION,
    cached: { active: true, checkedAt: daysAgo(1) },
    live: { kind: "unreachable" },
    now: NOW,
  });
  const refused = gateFor({
    session: SESSION,
    cached: { active: true, checkedAt: daysAgo(1) },
    live: { kind: "denied", reason: null },
    now: NOW,
  });
  assert.equal(unreachable.state, "allowed", "an unreachable platform locked a paying user out");
  assert.equal(refused.state, "no-licence");
  assert.notEqual(unreachable.state, refused.state);
});

test("offline on a cache that is still fresh is simply in", () => {
  const g = gateFor({
    session: SESSION,
    cached: { active: true, checkedAt: daysAgo(WARN_AFTER_DAYS - 1) },
    live: { kind: "unreachable" },
    now: NOW,
  });
  assert.equal(g.state, "allowed", "warned a week too early");
});

test("the last week offline warns, and counts down honestly", () => {
  for (const age of [WARN_AFTER_DAYS, GRACE_DAYS - 1, GRACE_DAYS]) {
    const g = gateFor({
      session: SESSION,
      cached: { active: true, checkedAt: daysAgo(age) },
      live: { kind: "unreachable" },
      now: NOW,
    });
    assert.equal(g.state, "allowed-grace", `day ${age} should warn`);
    assert.equal(g.daysLeft, GRACE_DAYS - age, `day ${age} counted down wrong`);
    assert.ok(letsAppRender(g) && allowsNewProjects(g), "warning is not blocking");
  }
});

test("past the grace period, existing work still opens and exports", () => {
  // The point of this state. Gating new work is a business decision; holding
  // somebody's finished film hostage is a different and worse thing.
  const g = gateFor({
    session: SESSION,
    cached: { active: true, checkedAt: daysAgo(GRACE_DAYS + 1) },
    live: { kind: "unreachable" },
    now: NOW,
  });
  assert.equal(g.state, "read-only");
  assert.equal(letsAppRender(g), true, "a finished film became unreachable");
  assert.equal(allowsNewProjects(g), false);
});

test("signed in, never verified, and offline has to connect once", () => {
  // Nothing has ever been confirmed for this account, so there is nothing to
  // extend grace from. This is the one place being offline genuinely blocks.
  const g = gateFor({ session: SESSION, cached: null, live: { kind: "unreachable" }, now: NOW });
  assert.equal(g.state, "offline-first-run");
  assert.equal(g.email, SESSION.email);
  assert.equal(letsAppRender(g), false);
});

test("a cached no stays no while offline", () => {
  // Being unable to re-check does not turn a refusal the platform already
  // gave into an unknown, and therefore into access.
  const g = gateFor({
    session: SESSION,
    cached: { active: false, checkedAt: daysAgo(1) },
    live: { kind: "unreachable" },
    now: NOW,
  });
  assert.equal(g.state, "no-licence");
});

test("a check still in flight shows nothing decisive", () => {
  const g = gateFor({ session: SESSION, cached: null, live: { kind: "not-attempted" }, now: NOW });
  assert.equal(g.state, "checking");
  assert.equal(letsAppRender(g), false, "the app rendered before the gate had decided");
});

test("an unreadable timestamp is treated as ancient, not as fresh", () => {
  // Garbage in the cache must fail closed. Failing open would make a corrupt
  // file the easiest way past the gate.
  assert.equal(daysBetween("not a date", NOW), Number.POSITIVE_INFINITY);
  const g = gateFor({
    session: SESSION,
    cached: { active: true, checkedAt: "not a date" },
    live: { kind: "unreachable" },
    now: NOW,
  });
  assert.equal(g.state, "read-only");
});

test("a clock set into the past does not extend the grace period", () => {
  // Rolling the machine clock back would otherwise make the cache look newer
  // than it is. Ages clamp at zero rather than going negative.
  assert.equal(daysBetween(new Date(NOW.getTime() + 86400000).toISOString(), NOW), 0);
});

test("a licence answer becomes both halves of the gate's state at once", () => {
  const { live, cached } = fromLicence({
    active: true,
    checkedAt: "2026-08-17T21:04:25Z",
    status: "active",
    verified: true,
  });
  assert.deepEqual(live, { kind: "active" });
  // The cache records what the platform said and when the platform said it —
  // not when this machine thinks it heard.
  assert.equal(cached.active, true);
  assert.equal(cached.checkedAt, "2026-08-17T21:04:25Z");
  // And a yes carries no reason, because there is nothing to explain.
  assert.equal(cached.reason, undefined);
});

test("a licence the platform says no to is denied, and is cached as such", () => {
  const { live, cached } = fromLicence({
    active: false,
    checkedAt: "2026-08-17T21:04:25Z",
    status: "canceled",
    verified: true,
  });
  assert.equal(live.kind, "denied");
  // No reason field at all. Blocked, and honestly vague about why.
  assert.equal(live.reason, null);
  // Cached as a "no" on purpose: going offline afterwards must not launder a
  // real refusal into a month of grace.
  assert.equal(cached.active, false);
  const g = gateFor({ session: SESSION, cached, live: { kind: "unreachable" }, now: NOW });
  assert.equal(g.state, "no-licence");
});

// ── four refusals, four things to say ──────────────────────────────────────
//
// All four block identically. Everything below is about the difference in what
// is said, which is the only reason the reasons exist: one is fixed by paying,
// one by paying again, one cannot be fixed by paying at all, and one is our
// bug. Three of the four are actively harmed by a "Manage subscription"
// button, which is what a single blocked state would have given all of them.

test("each reason the platform sends gets its own screen", () => {
  const cases = [
    ["suspended", "suspended"],
    ["no_membership", "no-membership"],
    ["membership_inactive", "membership-ended"],
    ["no_access", "no-access"],
  ];
  for (const [reason, state] of cases) {
    const { live } = fromLicence({
      active: false,
      checkedAt: "2026-08-17T21:04:25Z",
      reason,
      verified: true,
    });
    assert.equal(live.kind, "denied", `${reason} did not block`);
    assert.equal(live.reason, reason);

    const g = gateFor({ session: SESSION, cached: null, live, now: NOW });
    assert.equal(g.state, state, `${reason} landed on the wrong screen`);
    assert.equal(g.email, SESSION.email, "the screen has to say which account it means");
    assert.equal(letsAppRender(g), false, `${reason} let the app render`);
    assert.equal(allowsNewProjects(g), false);
  }
});

test("a lapsed membership carries the date it lapsed", () => {
  const { live, cached } = fromLicence({
    active: false,
    checkedAt: "2026-08-17T21:04:25Z",
    reason: "membership_inactive",
    expiresAt: "2026-07-01T00:00:00Z",
    verified: true,
  });
  const g = gateFor({ session: SESSION, cached: null, live, now: NOW });
  assert.equal(g.state, "membership-ended");
  assert.equal(g.expiresAt, "2026-07-01T00:00:00Z");
  // And it survives into the cache, so the offline screen reads the same.
  assert.equal(cached.expiresAt, "2026-07-01T00:00:00Z");
});

test("the end date reads as a date, or reads as nothing at all", () => {
  // Fixed format and UTC: a billing date is the same date for everybody, and
  // rendering it locally would print the day before for anyone west of here.
  assert.equal(endedOn("2026-07-01T00:00:00Z"), "1 July 2026");
  assert.equal(endedOn("2026-12-25T23:30:00Z"), "25 December 2026");
  // The screen has to read without one, so everything unusable is `null`
  // rather than "Invalid Date" printed at a paying customer.
  for (const bad of [undefined, null, "", "whenever", "not a date"]) {
    assert.equal(endedOn(bad), null, `${JSON.stringify(bad)} produced a date`);
  }
});

test("the four words are matched exactly, and nothing else is", () => {
  // Mirrors `the_four_reasons_are_matched_exactly_and_nothing_else_is` on the
  // Rust side. The backend confirmed the field and the vocabulary, so this is
  // an exact match where it used to be a case-insensitive substring search
  // across two fields for the letters "suspend".
  for (const word of ["suspended", "no_membership", "membership_inactive", "no_access"]) {
    assert.equal(denialFor(word), word, `the platform's own word went unread: ${word}`);
  }
  // Everything the old loose search used to catch. Matching these now would
  // only invent denials the platform never sent.
  for (const word of [
    "Suspended",
    "SUSPENDED",
    "account_suspended",
    "suspend",
    "no_subscription",
    "canceled",
    "past_due",
    "active",
    "",
    undefined,
    null,
  ]) {
    assert.equal(denialFor(word), null, `${JSON.stringify(word)} was read as a denial`);
  }
});

test("a word this build has never seen does not lock a paying account out", () => {
  // The expensive direction. The day the platform puts a `reason` beside an
  // entitled account — a trial note, a dunning warning — an app with opinions
  // about vocabulary it was never taught would lock out everybody who paid.
  const { live, cached } = fromLicence({
    active: true,
    checkedAt: daysAgo(0),
    status: "active",
    reason: "grace_period",
    verified: true,
  });
  assert.deepEqual(live, { kind: "active" });
  assert.equal(cached.active, true);
  assert.equal(gateFor({ session: SESSION, cached, live, now: NOW }).state, "allowed");
});

test("a denial outranks an entitlement sitting beside it", () => {
  // A backend that bars an account without clearing its subscription flag is
  // an ordinary bug. The restrictive reading is the one that is right about
  // the account, and it must win — including in what gets cached, or the
  // contradiction becomes a month of exactly the access being withdrawn.
  const { live, cached } = fromLicence({
    active: true,
    checkedAt: daysAgo(0),
    status: "active",
    reason: "suspended",
    verified: true,
  });
  assert.equal(live.kind, "denied");
  assert.equal(live.reason, "suspended");
  assert.equal(cached.active, false, "a suspension was cached as a month of access");

  const g = gateFor({ session: SESSION, cached, live, now: NOW });
  assert.equal(g.state, "suspended");
});

test("an ordinary lapse with no reason still gets the generic billing screen", () => {
  // The other half of the same guarantee: adding four reasons must not
  // quietly reroute a platform that simply did not say why.
  const { live } = fromLicence({
    active: false,
    checkedAt: "2026-08-17T21:04:25Z",
    status: "canceled",
    verified: true,
  });
  assert.equal(live.reason, null);
  assert.equal(gateFor({ session: SESSION, cached: null, live, now: NOW }).state, "no-licence");
});

// ── the gap that used to be here ───────────────────────────────────────────
//
// The offline cache is the signed licence token. For as long as its claims
// recorded only *whether* an account was entitled, a suspension could not
// survive a restart: the app went offline knowing "not entitled" and fell back
// to the generic billing screen — the one message that is actively wrong for
// somebody who was barred, because it points at a page that will take their
// money and change nothing. The platform signs `reason` into the claims now,
// `licence_cache::recall` reads it back, and these pin that the offline screen
// is the same screen a live check would have chosen.

test("a suspension survives going offline", () => {
  const { cached } = fromLicence({
    active: false,
    checkedAt: daysAgo(1),
    reason: "suspended",
    verified: true,
  });
  const g = gateFor({ session: SESSION, cached, live: { kind: "unreachable" }, now: NOW });
  assert.equal(g.state, "suspended", "offline, a suspension degraded to the billing screen");
  assert.equal(g.email, SESSION.email);
  assert.equal(letsAppRender(g), false);
});

test("every reason reads the same offline as it does live", () => {
  // One mapping, two paths through it — `blockedBy`. Two copies of it is how
  // an account gets handled correctly online and wrongly on a plane.
  for (const [reason, state] of [
    ["suspended", "suspended"],
    ["no_membership", "no-membership"],
    ["membership_inactive", "membership-ended"],
    ["no_access", "no-access"],
    [undefined, "no-licence"],
    ["grace_period", "no-licence"],
  ]) {
    const cached = { active: false, checkedAt: daysAgo(1), reason, expiresAt: "2026-07-01T00:00:00Z" };
    const offline = gateFor({ session: SESSION, cached, live: { kind: "unreachable" }, now: NOW });
    assert.equal(offline.state, state, `offline, ${reason} landed on ${offline.state}`);

    const live = gateFor({
      session: SESSION,
      cached: null,
      live: { kind: "denied", reason: denialFor(reason), expiresAt: "2026-07-01T00:00:00Z" },
      now: NOW,
    });
    assert.equal(offline.state, live.state, `${reason} says one thing live and another offline`);
  }
});

test("an ageing cache does not turn a refusal into read-only", () => {
  // The grace period is for a cached *yes*. A cached no is a real answer that
  // was given once, and going a month without being able to re-check it does
  // not soften it into "your projects still open" — it stays the refusal it
  // was, with the reason it had.
  const cached = { active: false, checkedAt: daysAgo(GRACE_DAYS + 5), reason: "suspended" };
  const g = gateFor({ session: SESSION, cached, live: { kind: "unreachable" }, now: NOW });
  assert.equal(g.state, "suspended");
  assert.equal(letsAppRender(g), false);
});

test("a check that never landed leans on the cache instead of refusing", () => {
  // The rule the whole design rests on, stated where it can be broken: a
  // failed check is `unreachable`, never `inactive`. This is what App.tsx's
  // catch does, pinned here so a "simplification" that maps an error to a
  // refusal has to argue with a test first.
  const cached = fromLicence({ active: true, checkedAt: daysAgo(2), verified: true }).cached;
  const g = gateFor({ session: SESSION, cached, live: { kind: "unreachable" }, now: NOW });
  assert.equal(g.state, "allowed");
  assert.equal(letsAppRender(g), true);
});

test("the gate ships off unless something says otherwise, exactly", () => {
  // Mirrors `AUTH_GATE_ENABLED`. The gate blocks the whole app, so every
  // ambiguous value has to mean off — an empty string from an unset variable,
  // a "false" someone typed, a stray "1". Only the literal "on" opens it.
  const enabled = (v) => v === "on";
  for (const v of [undefined, "", "false", "0", "off", "ON", "on ", "true", "1", "yes"]) {
    assert.equal(enabled(v), false, `${JSON.stringify(v)} switched the gate on`);
  }
  assert.equal(enabled("on"), true);
});

// A refused build blocks the application as hard as a refused account does.
//
// Pinned because `letsAppRender` is an allow-list, and the failure mode of an
// allow-list is somebody adding a state to it while tidying. If
// "update-required" ever appears in that list, the update gate stops gating
// and nothing else in the suite notices.
test("an update-required build renders no application and starts no work", () => {
  const gate = {
    state: "update-required",
    reason: "too-old",
    installed: "0.2.0",
    required: "0.3.0",
    downloadUrl: "https://example.com/download",
    notesUrl: null,
  };
  assert.equal(letsAppRender(gate), false);
  assert.equal(allowsNewProjects(gate), false);
});

test("a withdrawn build is refused on the same terms as an outdated one", () => {
  const gate = {
    state: "update-required",
    reason: "withdrawn",
    installed: "0.4.1",
    required: null,
    downloadUrl: null,
    notesUrl: null,
  };
  assert.equal(letsAppRender(gate), false);
  assert.equal(allowsNewProjects(gate), false);
});

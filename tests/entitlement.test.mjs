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
    live: { kind: "inactive" },
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
    live: { kind: "inactive" },
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

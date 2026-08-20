// Version ordering, and the one comparison everybody gets wrong.
//
// The first test here is the reason the file exists. The rest pin the parts
// of semver that only start mattering once this project ships a tenth minor
// release or a second beta — which is to say, after anyone would think to
// check them by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, isBelow, isSameVersion, parseVersion } from "../.test-build/lib/semver.js";

const v = (s) => {
  const parsed = parseVersion(s);
  assert.ok(parsed, `expected ${s} to parse`);
  return parsed;
};

test("0.10.0 is newer than 0.9.0, which string comparison gets backwards", () => {
  assert.equal(compare(v("0.10.0"), v("0.9.0")), 1);
  assert.equal(compare(v("0.9.0"), v("0.10.0")), -1);
  // The trap, stated outright: this is what the naive version would have done.
  assert.equal("0.10.0" < "0.9.0", true);
});

test("a leading v is optional on either side", () => {
  assert.equal(compare(v("v0.2.0"), v("0.2.0")), 0);
  assert.equal(isSameVersion("v0.2.0", "0.2.0"), true);
});

test("build metadata parses and then does not count", () => {
  assert.equal(compare(v("1.0.0+build.5"), v("1.0.0")), 0);
  assert.deepEqual(v("1.0.0+build.5").prerelease, []);
});

test("a prerelease is older than the release it leads to", () => {
  // The floor case: a floor of 0.3.0 must exclude 0.3.0-beta.1.
  assert.equal(compare(v("0.3.0-beta.1"), v("0.3.0")), -1);
  assert.equal(isBelow("0.3.0-beta.1", "0.3.0"), true);
});

test("prerelease numbers compare as numbers, not as text", () => {
  assert.equal(compare(v("0.3.0-beta.9"), v("0.3.0-beta.10")), -1);
});

test("more identifiers is later when everything shared is equal", () => {
  assert.equal(compare(v("0.3.0-beta.1"), v("0.3.0-beta.1.1")), -1);
});

test("a numeric identifier ranks below an alphanumeric one", () => {
  assert.equal(compare(v("1.0.0-1"), v("1.0.0-alpha")), -1);
});

test("major, minor and patch are each decisive in order", () => {
  assert.equal(compare(v("1.0.0"), v("0.99.99")), 1);
  assert.equal(compare(v("0.2.0"), v("0.1.99")), 1);
  assert.equal(compare(v("0.2.3"), v("0.2.2")), 1);
  assert.equal(compare(v("0.2.0"), v("0.2.0")), 0);
});

test("anything that is not a version reads as null rather than throwing", () => {
  for (const bad of ["", "  ", "1", "1.2", "1.2.3.4", "latest", "v", null, undefined, 3, {}, "1.2.x"]) {
    assert.equal(parseVersion(bad), null, `expected ${JSON.stringify(bad)} to be unreadable`);
  }
});

test("a version too large to hold precisely is refused rather than rounded", () => {
  assert.equal(parseVersion("99999999999999999999.0.0"), null);
});

test("isBelow says 'cannot say' rather than guessing", () => {
  // This is the fail-open hinge: null, and never true.
  assert.equal(isBelow("0.2.0", "not-a-version"), null);
  assert.equal(isBelow("not-a-version", "0.2.0"), null);
  assert.equal(isBelow(null, "0.2.0"), null);
  assert.equal(isBelow("0.2.0", null), null);
});

test("isBelow is false at the floor itself, not true", () => {
  // Off-by-one here locks out the exact version that was just published.
  assert.equal(isBelow("0.3.0", "0.3.0"), false);
  assert.equal(isBelow("0.3.1", "0.3.0"), false);
  assert.equal(isBelow("0.2.9", "0.3.0"), true);
});

test("isSameVersion cannot say when either side is unreadable", () => {
  assert.equal(isSameVersion("0.2.0", "rubbish"), null);
  assert.equal(isSameVersion("0.2.0", "0.2.0"), true);
  assert.equal(isSameVersion("0.2.0", "0.2.1"), false);
});

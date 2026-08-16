// The rule that decides when a player may be moved.
//
// These are not hypothetical cases. Seeking a looping music track to the
// playhead's position — past the end of a file shorter than the film — is
// what locked the app up: the element clamps, the difference never closes,
// and the next frame asks again, sixty times a second.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loopPosition, seekTarget } from "../.test-build/lib/playback.js";

test("a player already in the right place is left alone", () => {
  assert.equal(seekTarget(10, 10.1, 200), null);
});

test("a player that has drifted is moved", () => {
  assert.equal(seekTarget(10, 14, 200), 14);
});

test("nothing is ever asked for past the end of a file", () => {
  // The freeze, exactly: a 150s track and a film 400s in. The element cannot
  // go there, so asking achieves nothing and asking every frame is the bug.
  assert.equal(seekTarget(150, 400, 150), null);
});

test("a file whose length is not known yet is still seekable", () => {
  // duration is NaN until metadata loads; refusing then would leave a player
  // stuck wherever it happened to be.
  assert.equal(seekTarget(0, 12, NaN), 12);
});

test("a negative position is never asked for", () => {
  assert.equal(seekTarget(5, -3, 200), 0);
});

test("music repeats under a film longer than itself", () => {
  assert.equal(loopPosition(400, 150), 100);
  assert.equal(loopPosition(150, 150), 0);
  assert.equal(loopPosition(20, 150), 20);
});

test("music with no known length is played from where it is", () => {
  assert.equal(loopPosition(20, NaN), 20);
  assert.equal(loopPosition(20, 0), 20);
});

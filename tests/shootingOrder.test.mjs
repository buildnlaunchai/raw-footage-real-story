// Putting footage back into the order it was shot in.
//
// Grounded in a real failure: fifty clips compressed from 1080p HEVC to 720p
// h264 arrived with timestamps claiming the phone had counted *downwards* over
// fifteen hours. Trusting those would have built the film backwards while
// looking deliberate about it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeOrdering,
  isCameraSequence,
  orderBasis,
  signalsDisagree,
  sortByShootingOrder,
} from "../.test-build/lib/shootingOrder.js";

const clip = (fileName, capturedAtMs = null) => ({ fileName, capturedAtMs });
const names = (cs) => cs.map((c) => c.fileName);

// A day's shoot on one phone: numbering and timestamps agree.
const AGREEING = [
  clip("IMG_2022.MOV", 1_000),
  clip("IMG_2100.MOV", 2_000),
  clip("IMG_2165.MOV", 3_000),
];

// The real one: numbering ascends, the rewritten timestamps descend.
const THAILAND = [
  clip("IMG_8127.MP4", Date.parse("2024-01-27T11:37:58Z")),
  clip("IMG_8166.MP4", Date.parse("2024-01-27T10:34:51Z")),
  clip("IMG_8261.MP4", Date.parse("2024-01-26T20:11:54Z")),
];

test("one camera's numbering is recognised as a sequence", () => {
  assert.equal(isCameraSequence(AGREEING), true);
  assert.equal(orderBasis(AGREEING), "camera-sequence");
});

test("the file number wins when the timestamps contradict it", () => {
  // The case this exists for. Sorting by the stored time would open the film
  // on its last scene.
  assert.equal(orderBasis(THAILAND), "camera-sequence");
  assert.deepEqual(
    names(sortByShootingOrder(THAILAND)),
    ["IMG_8127.MP4", "IMG_8166.MP4", "IMG_8261.MP4"],
  );
});

test("when they agree the answer is the same either way", () => {
  assert.deepEqual(
    names(sortByShootingOrder(AGREEING)),
    ["IMG_2022.MOV", "IMG_2100.MOV", "IMG_2165.MOV"],
  );
  assert.equal(signalsDisagree(AGREEING), false);
});

test("a contradiction is reported rather than quietly resolved", () => {
  assert.equal(signalsDisagree(THAILAND), true);
  assert.match(describeOrdering(THAILAND), /camera file number/);
  assert.match(describeOrdering(THAILAND), /rewritten|not when you filmed/);
  assert.doesNotMatch(describeOrdering(AGREEING), /rewritten/);
});

test("numbers are compared as numbers, not as text", () => {
  // IMG_9 before IMG_10, which string comparison gets backwards.
  const cs = [clip("IMG_10.MP4"), clip("IMG_9.MP4"), clip("IMG_100.MP4")];
  assert.deepEqual(names(sortByShootingOrder(cs)), ["IMG_9.MP4", "IMG_10.MP4", "IMG_100.MP4"]);
});

test("two cameras are not one sequence", () => {
  // Different prefixes: the numbering means nothing across the set, so the
  // timestamps are the only thing that relates them.
  const cs = [
    clip("IMG_0003.MOV", 3_000),
    clip("DSC_0001.MOV", 1_000),
    clip("IMG_0002.MOV", 2_000),
  ];
  assert.equal(isCameraSequence(cs), false);
  assert.equal(orderBasis(cs), "capture-time");
  assert.deepEqual(names(sortByShootingOrder(cs)), ["DSC_0001.MOV", "IMG_0002.MOV", "IMG_0003.MOV"]);
});

test("the same prefix with colliding numbers is not a sequence either", () => {
  // Two phones both writing IMG_0001. The numbering repeats, so it cannot
  // order them.
  const cs = [clip("IMG_1.MP4", 3_000), clip("IMG_1.MP4", 1_000), clip("IMG_2.MP4", 2_000)];
  assert.equal(isCameraSequence(cs), false);
  assert.equal(orderBasis(cs), "capture-time");
});

test("files with no numbers fall back to the timestamp", () => {
  const cs = [
    clip("final_cut.mov", 3_000),
    clip("beach.mov", 1_000),
    clip("sunset.mov", 2_000),
  ];
  assert.equal(orderBasis(cs), "capture-time");
  assert.deepEqual(names(sortByShootingOrder(cs)), ["beach.mov", "sunset.mov", "final_cut.mov"]);
});

test("with neither signal it says the order is a guess", () => {
  const cs = [clip("b.mov"), clip("a.mov"), clip("c.mov")];
  assert.equal(orderBasis(cs), "filename");
  assert.deepEqual(names(sortByShootingOrder(cs)), ["a.mov", "b.mov", "c.mov"]);
  assert.match(describeOrdering(cs), /guess/);
});

test("a partial set of timestamps is not used", () => {
  // Sorting the clips that have a time and guessing at the rest is worse than
  // one rule applied to all of them.
  const cs = [clip("a.mov", 2_000), clip("b.mov"), clip("c.mov", 1_000)];
  assert.equal(orderBasis(cs), "filename");
});

test("two clips are too few to call a sequence", () => {
  // Any two numbered files look like a run. Three is where it starts meaning
  // something, and with two the order is the same either way.
  const cs = [clip("IMG_2.MP4", 1_000), clip("IMG_1.MP4", 2_000)];
  assert.equal(isCameraSequence(cs), false);
});

test("sorting never loses or duplicates a clip", () => {
  for (const cs of [AGREEING, THAILAND, [clip("x.mov")], []]) {
    const out = sortByShootingOrder(cs);
    assert.equal(out.length, cs.length);
    assert.deepEqual([...names(out)].sort(), [...names(cs)].sort());
  }
});

test("the original array is left alone", () => {
  const cs = [clip("IMG_3.MP4"), clip("IMG_1.MP4"), clip("IMG_2.MP4")];
  const before = names(cs);
  sortByShootingOrder(cs);
  assert.deepEqual(names(cs), before);
});

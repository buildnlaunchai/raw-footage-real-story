// The opening montage. The rules here are about what an opening is for, so
// each test says which rule it is defending rather than which line it covers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SHOTS,
  MIN_SHOTS,
  montageMs,
  pickShots,
  shotCount,
} from "../.test-build/lib/intro.js";

const candidate = (clipId, i = 0, startMs = 0, endMs = 8_000) => ({
  clipId,
  segmentIndex: i,
  startMs,
  endMs,
  sourcePath: `/clips/${clipId}.mov`,
});

const LIBRARY = ["a", "b", "c", "d", "e", "f"].map((id) => candidate(id));

test("shot count is bounded at both ends", () => {
  // Two shots is not a montage; nine in eight seconds is a strobe.
  assert.equal(shotCount(6_000), 6);
  assert.equal(shotCount(1_000), MIN_SHOTS, "a very short hook still gets a montage");
  assert.equal(shotCount(30_000), MAX_SHOTS, "a long one does not become a slideshow");
});

test("the montage is exactly as long as the hook", () => {
  // Narration is the clock here as everywhere else, and rounding must not
  // leave the last frames of the hook over a black screen.
  for (const hook of [3_000, 4_733, 8_001, 12_500]) {
    const shots = pickShots(hook, LIBRARY, { storyClipIds: [], firstLineClipId: null });
    assert.equal(montageMs(shots), hook, `hook of ${hook}ms`);
  }
});

test("the clip line one opens on is never in the montage", () => {
  // The montage crossfades into that clip. A shot dissolving into itself reads
  // as a glitch, not a cut.
  const shots = pickShots(6_000, LIBRARY, { storyClipIds: [], firstLineClipId: "c" });
  assert.ok(!shots.some((s) => s.clipId === "c"));
});

test("footage the story does not use comes first", () => {
  // A library holds far more than one script can carry, and the opening is
  // where the rest earns its keep.
  const shots = pickShots(3_000, LIBRARY, {
    storyClipIds: ["a", "b", "c"],
    firstLineClipId: null,
  });
  assert.deepEqual(
    shots.map((s) => s.clipId),
    ["d", "e", "f"],
    "unused clips chosen over ones the film already shows",
  );
});

test("the story's own moments fill in when there is nothing spare", () => {
  const shots = pickShots(5_000, LIBRARY, {
    storyClipIds: ["a", "b", "c", "d", "e", "f"],
    firstLineClipId: null,
  });
  assert.equal(shots.length, 5);
  assert.equal(new Set(shots.map((s) => s.clipId)).size, 5, "still one per clip");
});

test("no clip repeats while others are available", () => {
  const shots = pickShots(6_000, LIBRARY, { storyClipIds: [], firstLineClipId: null });
  assert.equal(new Set(shots.map((s) => s.clipId)).size, shots.length);
});

test("a tiny library repeats rather than coming up short", () => {
  // Two clips under a six-shot hook: better to see them twice than to have the
  // hook run out over nothing.
  const shots = pickShots(6_000, [candidate("a"), candidate("b")], {
    storyClipIds: [],
    firstLineClipId: null,
  });
  assert.equal(montageMs(shots), 6_000);
  assert.ok(shots.length >= 2);
});

test("shots come from the middle of a described moment", () => {
  // The ends of a segment are where fades and dead frames live.
  const shots = pickShots(3_000, [candidate("a", 0, 10_000, 20_000)], {
    storyClipIds: [],
    firstLineClipId: null,
  });
  const s = shots[0];
  assert.ok(s.sourceInMs > 10_000, "not the very start of the moment");
  assert.ok(s.sourceInMs + s.durationMs < 20_000, "and it fits inside it");
});

test("clips with no media on disk are skipped", () => {
  const shots = pickShots(3_000, [
    { ...candidate("a"), sourcePath: null },
    candidate("b"),
  ], { storyClipIds: [], firstLineClipId: null });
  assert.ok(shots.every((s) => s.clipId === "b"));
});

test("nothing usable means no montage, not a broken one", () => {
  // A failed opening has to degrade to the video as it is today.
  assert.deepEqual(pickShots(6_000, [], { storyClipIds: [], firstLineClipId: null }), []);
  const onlyFirstLine = pickShots(6_000, [candidate("a")], {
    storyClipIds: [],
    firstLineClipId: "a",
  });
  assert.deepEqual(onlyFirstLine, []);
});

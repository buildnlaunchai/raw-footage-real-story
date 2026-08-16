// The cut, as something you can edit.
//
// The model is overrides on a plan rather than a replacement for it, and the
// two properties that buys are what these defend: an edited timeline survives a
// re-recorded voiceover, and nothing expressible here can ask the renderer for
// a cut it will not make.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIMELINE,
  applyEdits,
  maxTransitionMs,
  maxTrimMs,
  moved,
  runtimeMs,
  shotGain,
  shotKey,
  transitionsFor,
  withEdit,
  withOrder,
} from "../.test-build/lib/timeline.js";

const plan = (n = 3) =>
  Array.from({ length: n }, (_, i) => ({
    clipId: `c${i}`,
    segmentIndex: 0,
    durationMs: 3_000,
    sourceInMs: 0,
    text: `Line ${i + 1}.`,
  }));

const doc = (over = {}) => ({ ...DEFAULT_TIMELINE, ...over });

test("an untouched document is the plan, unchanged", () => {
  const shots = applyEdits(plan(), doc());
  assert.deepEqual(shots.map((s) => s.clipId), ["c0", "c1", "c2"]);
  assert.deepEqual(shots.map((s) => s.startMs), [0, 3_000, 6_000]);
  assert.ok(shots.every((s) => s.enabled && !s.swapped));
});

test("a shot the document has never heard of still appears", () => {
  // A longer script adds lines. An older timeline names only the ones it knew,
  // and dropping the rest would lose narration the user just paid to record.
  const shots = applyEdits(plan(3), doc({ order: ["c2#0", "c0#0"] }));
  assert.deepEqual(shots.map((s) => s.clipId), ["c2", "c0", "c1"]);
});

test("a shot in the order that no longer exists is skipped", () => {
  // The other direction: a shorter script removes lines the timeline still
  // names. Looking them up must not put an undefined in the film.
  const shots = applyEdits(plan(2), doc({ order: ["c1#0", "gone#0", "c0#0"] }));
  assert.deepEqual(shots.map((s) => s.clipId), ["c1", "c0"]);
});

test("timings are recomputed from the plan, never stored", () => {
  // The point of overrides: re-record a line longer and the shot grows with
  // it, keeping the trim and the transition that were set by hand.
  const longer = plan();
  longer[0].durationMs = 9_000;
  const d = withEdit(doc(), "c0#0", { sourceInMs: 1_200, transitionMs: 400 });
  const shots = applyEdits(longer, d);
  assert.equal(shots[0].durationMs, 9_000, "the new narration decides the length");
  assert.equal(shots[0].sourceInMs, 1_200, "and the hand-set trim survives it");
  assert.equal(shots[0].transitionMs, 400);
  assert.equal(shots[1].startMs, 9_000, "everything after moves with it");
});

test("swapping the footage leaves the line alone", () => {
  // "This shot is out of focus, use the other one" changes the picture. The
  // words, the recording and the subtitle belong to the moment, not the frame.
  const shots = applyEdits(plan(), withEdit(doc(), "c1#0", { sourceClipId: "c9" }));
  assert.equal(shots[1].sourceClipId, "c9");
  assert.equal(shots[1].clipId, "c1", "the line still belongs to its own moment");
  assert.equal(shots[1].text, "Line 2.");
  assert.ok(shots[1].swapped, "and the timeline can say so");
});

test("a disabled shot takes no time but keeps its place", () => {
  const shots = applyEdits(plan(), withEdit(doc(), "c1#0", { enabled: false }));
  assert.equal(shots.length, 3, "still listed, so it can come back");
  assert.equal(shots[1].enabled, false);
  assert.equal(shots[2].startMs, 3_000, "the shot after it moves up");
  assert.equal(runtimeMs(shots), 6_000);
});

test("runtime accounts for every dissolve but the last", () => {
  // The final shot dissolves into nothing, so it costs nothing.
  let d = withEdit(doc(), "c0#0", { transitionMs: 500 });
  d = withEdit(d, "c1#0", { transitionMs: 500 });
  d = withEdit(d, "c2#0", { transitionMs: 500 });
  const shots = applyEdits(plan(), d);
  assert.equal(runtimeMs(shots), 9_000 - 1_000);
  assert.deepEqual(transitionsFor(shots), [500, 500], "one per boundary, not per shot");
});

test("transitions are listed for the shots that survive", () => {
  let d = withEdit(doc(), "c0#0", { transitionMs: 400 });
  d = withEdit(d, "c1#0", { enabled: false, transitionMs: 900 });
  const shots = applyEdits(plan(), d);
  assert.deepEqual(
    transitionsFor(shots),
    [400],
    "a dropped shot's boundary goes with it",
  );
});

test("reordering is by key and keeps everything else in place", () => {
  const shots = applyEdits(plan(4), doc());
  assert.deepEqual(moved(shots, "c3#0", "c0#0"), ["c3#0", "c0#0", "c1#0", "c2#0"]);
  assert.deepEqual(moved(shots, "c0#0", "c2#0"), ["c1#0", "c2#0", "c0#0", "c3#0"]);
  assert.deepEqual(moved(shots, "c0#0", "c0#0"), ["c0#0", "c1#0", "c2#0", "c3#0"]);
  assert.deepEqual(moved(shots, "nope", "c0#0"), ["c0#0", "c1#0", "c2#0", "c3#0"]);
});

test("a reorder round-trips through the document", () => {
  const shots = applyEdits(plan(3), doc());
  const d = withOrder(doc(), moved(shots, "c2#0", "c0#0"));
  assert.deepEqual(applyEdits(plan(3), d).map((s) => s.clipId), ["c2", "c0", "c1"]);
});

// --- limits the renderer would otherwise have to enforce --------------------

test("trimming stops where the clip could no longer cover its line", () => {
  // 10s of footage under a 4s line: trimming past 8s in leaves under 2s,
  // which even at the 2x cap cannot fill the slot.
  assert.equal(maxTrimMs(10_000, 4_000), 8_000);
  // Exactly enough footage cannot be trimmed at all.
  assert.equal(maxTrimMs(2_000, 4_000), 0);
  // Less than enough is already at the cap; trimming would make it worse.
  assert.equal(maxTrimMs(1_000, 4_000), 0);
  assert.equal(maxTrimMs(null, 4_000), 0, "no media, no trim");
});

test("a dissolve can never swallow either shot whole", () => {
  const shots = applyEdits(plan(), doc());
  // A third of the shorter neighbour, matching the renderer's own clamp.
  assert.equal(maxTransitionMs(shots[0], shots[1]), 1_000);
  assert.equal(maxTransitionMs(shots[2], undefined), 0, "nothing to dissolve into");

  const short = plan();
  short[1].durationMs = 900;
  const s2 = applyEdits(short, doc());
  assert.equal(maxTransitionMs(s2[0], s2[1]), 300, "the shorter side governs");
});

test("a long pair is still capped at a second and a half", () => {
  const long = plan().map((p) => ({ ...p, durationMs: 60_000 }));
  const shots = applyEdits(long, doc());
  assert.equal(maxTransitionMs(shots[0], shots[1]), 1_500);
});

test("shot keys match the identity everything else uses", () => {
  assert.equal(shotKey("abc", 2), "abc#2");
});

test("editing one shot leaves the document's other edits alone", () => {
  // The editor keeps a history for undo, so a mutation here would rewrite
  // every past state along with the present one.
  const first = withEdit(doc(), "c0#0", { transitionMs: 400 });
  const second = withEdit(first, "c1#0", { enabled: false });
  assert.equal(first.edits["c1#0"], undefined, "the earlier state is untouched");
  assert.equal(second.edits["c0#0"].transitionMs, 400, "and the earlier edit survives");
});

test("merging edits keeps fields the new one does not mention", () => {
  const d = withEdit(withEdit(doc(), "c0#0", { sourceInMs: 500 }), "c0#0", {
    transitionMs: 300,
  });
  assert.equal(d.edits["c0#0"].sourceInMs, 500);
  assert.equal(d.edits["c0#0"].transitionMs, 300);
});

// --- each shot's own sound -------------------------------------------------
//
// "Keep the clip's sound" is rarely a decision about a film. It is a decision
// about the two clips with something worth hearing in them and the twenty with
// wind noise, so it has to be answerable per shot.

import { anySound, soundGains } from "../.test-build/lib/timeline.js";

const track = (over = {}) => ({ enabled: true, gain: 0.3, ...over });

test("a shot with no opinion takes the track's setting", () => {
  const shots = applyEdits(plan(3), doc());
  assert.deepEqual(soundGains(shots, track()), [0.3, 0.3, 0.3]);
  assert.deepEqual(soundGains(shots, track({ enabled: false })), [0, 0, 0]);
});

test("a shot can keep its sound while the track is off", () => {
  // The common case in reverse: one clip worth hearing in an otherwise
  // narrated film.
  const d = withEdit(doc(), "c1#0", { sound: { enabled: true, gain: 0.8 } });
  const shots = applyEdits(plan(3), d);
  assert.deepEqual(soundGains(shots, track({ enabled: false })), [0, 0.8, 0]);
  assert.equal(anySound(shots, track({ enabled: false })), true);
});

test("a shot can be silenced while the track is on", () => {
  const d = withEdit(doc(), "c1#0", { sound: { enabled: false } });
  const shots = applyEdits(plan(3), d);
  assert.deepEqual(soundGains(shots, track()), [0.3, 0, 0.3]);
});

test("a shot that says nothing about its level borrows the track's", () => {
  const d = withEdit(doc(), "c0#0", { sound: { enabled: true } });
  const shots = applyEdits(plan(2), d);
  assert.deepEqual(soundGains(shots, track({ gain: 0.42 })), [0.42, 0.42]);
});

test("levels are listed only for the shots in the film", () => {
  const d = withEdit(doc(), "c1#0", { enabled: false });
  const shots = applyEdits(plan(3), d);
  assert.deepEqual(soundGains(shots, track()), [0.3, 0.3], "the dropped shot has no slot");
});

test("nothing wanting sound is worth knowing", () => {
  // The renderer probes every clip for an audio track when sound is on, and
  // a silent film should not pay for that.
  const shots = applyEdits(plan(3), doc());
  assert.equal(anySound(shots, track({ enabled: false })), false);
  assert.equal(anySound(shots, track()), true);
});

test("one shot's level and the whole list agree", () => {
  // They were worked out separately once and drifted apart. The viewer asks
  // for a single shot, the renderer asks for the list, and both must be the
  // same rule or what you hear while editing is not what gets filmed.
  const track = { enabled: true, gain: 0.3 };
  const shots = applyEdits(plan(3), {
    ...DEFAULT_TIMELINE,
    edits: {
      "c0#0": { sound: { enabled: false } },
      "c1#0": { sound: { enabled: true, gain: 0.8 } },
    },
  });
  assert.deepEqual(
    shots.filter((s) => s.enabled).map((s) => shotGain(s, track)),
    soundGains(shots, track),
  );
});

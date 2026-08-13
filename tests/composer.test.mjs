// The composer's output feeds the timeline, and the timeline addresses lines by
// `clipId#segmentIndex`. These tests hold that identity to being unique, which
// is the property that broke: with fewer clips than the word target implies,
// the model wrote several lines about one moment and every one of them claimed
// the same identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeScript,
  flattenCandidates,
  momentsToRequest,
  selectSegments,
  targetSegmentCount,
  WORDS_PER_SEGMENT,
  writeScript,
} from "../.test-build/lib/scriptComposerCore.js";

const key = (l) => `${l.clipId}#${l.segmentIndex}`;

/** Three clips, one segment each — the shape of the reported project. */
const CLIPS = [
  { id: "clip-a", segments: [{ startSec: 0, endSec: 85, text: "hotel room a back korlam" }] },
  { id: "clip-b", segments: [{ startSec: 0, endSec: 16, text: "chelera mathar chul fele dilam" }] },
  { id: "clip-c", segments: [{ startSec: 0, endSec: 24, text: "eta holo Masjid al haram" }] },
];

/**
 * Replays what the real model did: selects all three moments, then writes two
 * lines for each because 110 words will not fit in three.
 */
function doublingModel() {
  return async (args) => {
    if (args.system?.startsWith("You choose")) {
      return JSON.stringify({ refs: [1, 2, 3] });
    }
    // The length pass asks for N rewritten strings; echo the draft back so the
    // test measures composition, not the revision step.
    const wantStrings = /rewritten strings/.test(args.prompt ?? "");
    if (wantStrings) {
      const n = Number(/\((\d+) rewritten strings\)/.exec(args.prompt)?.[1] ?? 0);
      return JSON.stringify({
        weaknesses: "none",
        lines: Array.from({ length: n }, (_, i) => `Revised line ${i + 1}.`),
      });
    }
    const lines = [];
    for (const ref of [1, 2, 3]) {
      lines.push({ ref, text: `First sentence about moment ${ref}.` });
      lines.push({ ref, text: `Second sentence about moment ${ref}.` });
    }
    return JSON.stringify({ lines });
  };
}

test("a 110-word target over 3 clips wants more segments than exist", () => {
  // Derived rather than hardcoded: the words-per-moment figure is a tuning
  // knob, and the property being tested is the shortfall, not the constant.
  assert.equal(targetSegmentCount(110), Math.round(110 / WORDS_PER_SEGMENT));
  assert.ok(targetSegmentCount(110) > CLIPS.length, "this is the condition that triggers the bug");
});

test("every line has a unique clipId#segmentIndex", async () => {
  const draft = await composeScript(doublingModel(), CLIPS, {
    title: "Umrah", wordCount: 110, critique: false,
  });
  const keys = draft.lines.map(key);
  assert.deepEqual(
    [...new Set(keys)], keys,
    `two lines claim the same identity: ${keys.join(", ")}`,
  );
});

test("the same moment is never placed twice in a row", async () => {
  const draft = await composeScript(doublingModel(), CLIPS, {
    title: "Umrah", wordCount: 110, critique: false,
  });
  for (let i = 1; i < draft.lines.length; i++) {
    assert.notEqual(
      draft.lines[i].clipId, draft.lines[i - 1].clipId,
      `clip ${draft.lines[i].clipId} plays twice consecutively at line ${i + 1}`,
    );
  }
});

test("collapsing keeps every word rather than dropping the extra lines", async () => {
  // Straight at writeScript: the length pass legitimately rewrites text, which
  // would mask whether collapsing preserved it.
  const selected = CLIPS.map((c, i) => ({
    ref: i + 1, clipId: c.id, segmentIndex: 0, text: c.segments[0].text,
  }));
  const lines = await writeScript(doublingModel(), selected, {
    title: "Umrah", wordCount: 110,
  });
  assert.equal(lines.length, 3, "one line per moment");
  const all = lines.map((l) => l.text).join(" ");
  for (const ref of [1, 2, 3]) {
    assert.match(all, new RegExp(`First sentence about moment ${ref}`), "first sentence lost");
    assert.match(all, new RegExp(`Second sentence about moment ${ref}`), "second sentence lost");
  }
});

test("more clips than the target needs still yields the target", () => {
  // The clamp must not cut a large library down to the word-derived count.
  assert.equal(momentsToRequest(110, 40), Math.round(110 / WORDS_PER_SEGMENT));
  assert.equal(momentsToRequest(110, 3), 3, "and never more than exist");
  assert.equal(momentsToRequest(600, 40), 40, "a long script uses the whole library");
});

// --- coverage ---------------------------------------------------------------

test("a length is measured against the footage that exists", async () => {
  const { coverageFor, suggestedWordCount, WORDS_PER_SEGMENT } = await import(
    "../.test-build/lib/scriptComposerCore.js"
  );
  // The complaint that started this: 110 words over a 40-clip library.
  const thin = coverageFor(110, 40);
  assert.equal(thin.used, 8, "110 words carries eight moments at 14 words each");
  assert.equal(thin.percent, 20);

  // And what it would take to use most of it.
  assert.equal(suggestedWordCount(40), 560);
  const full = coverageFor(560, 40);
  assert.equal(full.used, 40, "the suggestion covers the library");
  assert.equal(full.percent, 100);
  assert.equal(WORDS_PER_SEGMENT, 14);
});

test("coverage never claims more moments than exist", async () => {
  const { coverageFor } = await import("../.test-build/lib/scriptComposerCore.js");
  const c = coverageFor(2000, 3);
  assert.equal(c.used, 3, "a long script over three clips still has three");
  assert.equal(c.percent, 100);
});

test("the suggestion stays in a range a person would choose", async () => {
  const { suggestedWordCount } = await import("../.test-build/lib/scriptComposerCore.js");
  assert.equal(suggestedWordCount(1), 60, "a floor, so one clip is not a 14-word film");
  assert.ok(suggestedWordCount(300) <= 900, "and a ceiling, past which this is not a rough cut");
  assert.equal(suggestedWordCount(40) % 10, 0, "rounded to something typeable");
});

// --- the footage order is the film's order ---------------------------------
//
// The running order belongs to the user, who sets it by dragging the footage
// list. Two places used to overrule it: selection asked the model to reorder,
// and the writer's output was kept in whatever order the model answered in.

test("selection is asked to choose, not to reorder", async () => {
  const seen = [];
  const model = async (args) => {
    seen.push(args.prompt ?? "");
    if (args.system?.startsWith("You choose")) return JSON.stringify({ refs: [2, 0, 1] });
    return JSON.stringify({ lines: [] });
  };
  await selectSegments(model, flattenCandidates(CLIPS), { title: "Umrah", wordCount: 60 });
  const final = seen[seen.length - 1];
  assert.doesNotMatch(final, /order the story should tell/);
  assert.match(final, /order the footage is in/);
});

test("moments come back in footage order however the model answers", async () => {
  // The model is told to choose on merit; it answered 2, 0, 1.
  const model = async (args) => {
    if (args.system?.startsWith("You choose")) return JSON.stringify({ refs: [2, 0, 1] });
    return JSON.stringify({ lines: [] });
  };
  const picked = await selectSegments(model, flattenCandidates(CLIPS), {
    title: "Umrah", wordCount: 60,
  });
  assert.deepEqual(picked.map((c) => c.ref), [0, 1, 2]);
  assert.deepEqual(picked.map((c) => c.clipId), ["clip-a", "clip-b", "clip-c"]);
});

test("a script written out of order is put back into it", async () => {
  // The writer answering 3, 1, 2 must not cut the film that way.
  const model = async (args) => {
    if (args.system?.startsWith("You choose")) return JSON.stringify({ refs: [0, 1, 2] });
    return JSON.stringify({
      lines: [
        { ref: 2, text: "Third clip, written first." },
        { ref: 0, text: "First clip, written last." },
        { ref: 1, text: "Second clip." },
      ],
    });
  };
  const draft = await composeScript(model, CLIPS, {
    title: "Umrah", wordCount: 60, critique: false, hook: false,
  });
  assert.deepEqual(
    draft.lines.map((l) => l.clipId),
    ["clip-a", "clip-b", "clip-c"],
    "the cut follows the footage list, not the model's answer order",
  );
});

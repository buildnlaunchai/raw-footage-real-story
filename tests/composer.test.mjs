// The composer's output feeds the timeline, and the timeline addresses lines by
// `clipId#segmentIndex`. These tests hold that identity to being unique, which
// is the property that broke: with fewer clips than the word target implies,
// the model wrote several lines about one moment and every one of them claimed
// the same identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeScript,
  momentsToRequest,
  targetSegmentCount,
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
  assert.equal(targetSegmentCount(110), 6);
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
  assert.equal(momentsToRequest(110, 40), 6);
  assert.equal(momentsToRequest(110, 3), 3);
  assert.equal(momentsToRequest(600, 40), 33);
});

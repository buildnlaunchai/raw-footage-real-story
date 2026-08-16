// A clip's moments must tile it: contiguous, gapless, in order. Every edit
// here has to preserve that, because the timeline reads the spans directly and
// a hole at 12s would become a hole in the cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage } from "../.test-build/lib/languages.js";
import {
  initialSegments,
  isContiguous,
  mergeAt,
  removeAt,
  splitAt,
} from "../.test-build/lib/segments.js";

const CLIP = 85.055;

/** The state the reported bug was about: one clip, two described moments. */
function twoMoments() {
  return splitAt(initialSegments(CLIP), 27).map((s, i) => ({
    ...s,
    text: i === 0 ? "kobutor" : "mosque",
  }));
}

test("removing a moment gives its span to the one before it", () => {
  const out = removeAt(twoMoments(), 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "kobutor", "the survivor keeps its own words");
  assert.equal(out[0].endSec, CLIP, "and covers the clip to the end");
  assert.ok(isContiguous(out, CLIP));
});

test("removing the first moment hands its span to the next", () => {
  const out = removeAt(twoMoments(), 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "mosque");
  assert.equal(out[0].startSec, 0, "the clip still starts at zero");
  assert.ok(isContiguous(out, CLIP));
});

test("removing discards the words rather than joining them", () => {
  // The difference from merging, and the whole point of a remove button:
  // merging keeps both, removing means you did not want one.
  const merged = mergeAt(twoMoments(), 1);
  assert.equal(merged[0].text, "kobutor. mosque");
  const removed = removeAt(twoMoments(), 1);
  assert.equal(removed[0].text, "kobutor");
});

test("the last moment is cleared, not deleted", () => {
  // A clip always spans its own length, so there is no such thing as zero
  // moments — "not described" is one empty moment covering the whole clip.
  const out = removeAt([{ startSec: 0, endSec: CLIP, text: "kobutor" }], 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "");
  assert.ok(isContiguous(out, CLIP));
});

test("removing from the middle keeps the tiling intact", () => {
  const three = splitAt(splitAt(initialSegments(CLIP), 20), 50).map((s, i) => ({
    ...s,
    text: `m${i}`,
  }));
  assert.equal(three.length, 3);
  const out = removeAt(three, 1);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((s) => s.text),
    ["m0", "m2"],
    "the removed one goes, the others keep their own words",
  );
  assert.ok(isContiguous(out, CLIP), "no hole where it used to be");
});

test("an out-of-range index changes nothing", () => {
  const before = twoMoments();
  assert.deepEqual(removeAt(before, 9), before);
  assert.deepEqual(removeAt(before, -1), before);
});

test("a script's language is read from the script, not from a setting", () => {
  // The setting did not survive a save, so a Bengali project reopened as
  // English — the one language the local voice supports — and Kokoro read
  // Bengali through an English lexicon.
  assert.equal(detectLanguage("বিকেল চারটার দিকে আমরা বাড়ি থেকে বের হলাম"), "bn");
  assert.equal(detectLanguage("We left the house at about four in the afternoon"), "en");
  // A place name in Latin letters does not make a Bengali script English.
  assert.equal(detectLanguage("আমরা Chattogram চিড়িয়াখানায় গেলাম আজকে"), "bn");
  // Nothing to go on: the caller keeps whatever was chosen.
  assert.equal(detectLanguage(""), null);
  assert.equal(detectLanguage("123 — 456"), null);
});

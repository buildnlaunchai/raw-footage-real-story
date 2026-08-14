// Captions, and the one rule in them that is arithmetic rather than drawing.
//
// The drawing itself is checked by scripts/check-captions.mjs, which measures
// real rendered glyphs in every engine that draws one. What is left here is the
// fit: a caption is one line by design, and how wide that line runs depends on
// the script as much as the character count, so the size has to give way before
// the sentence does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shrinkToFit } from "../.test-build/lib/captions.js";

test("a line that fits keeps the size it was given", () => {
  // The ordinary case. A caption that quietly resizes itself when it did not
  // need to is the complaint this whole area started with.
  assert.equal(shrinkToFit(41, 900, 1920), 41);
});

test("a line filling the frame to its margins is not touched", () => {
  // 4% each side of 1920 leaves 1766.
  assert.equal(shrinkToFit(41, 1766, 1920), 41);
});

test("a line wider than the frame is shrunk until it fits", () => {
  const fitted = shrinkToFit(41, 2400, 1920);
  assert.ok(fitted < 41, "should have shrunk");
  assert.ok((2400 * fitted) / 41 <= 1920 * 0.92 + 1, "still too wide");
});

test("a long Bengali line at a large size still lands inside the frame", () => {
  // The case that drove this. The wrap counts characters, and 28 Bengali
  // characters run far wider than 28 Latin ones at the same size, so a setting
  // that is comfortable in English can run off the edge in Bengali.
  const fontPx = 96;
  const measured = 3400;
  const fitted = shrinkToFit(fontPx, measured, 1920);
  assert.ok((measured * fitted) / fontPx <= 1920, "would have run off the edge");
});

test("shrinking stops at a size somebody can still read", () => {
  assert.equal(shrinkToFit(41, 100000, 1920), 12);
});

test("an unmeasurable line is left alone rather than divided by zero", () => {
  assert.equal(shrinkToFit(41, 0, 1920), 41);
});

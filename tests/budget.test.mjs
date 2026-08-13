// How many words a clip can carry.
//
// This stopped being a preference the moment slowing was capped at 2x: a line
// longer than its clip allows cannot be spoken over that clip at all. So the
// arithmetic here has to agree with `timeline.rs` exactly — if it promises
// more than the planner will honour, every shot in the film comes out replayed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availableMs,
  composeScript,
  flattenCandidates,
  MAX_STRETCH,
  MIN_USABLE_UNITS,
  overBudget,
  unitBudget,
  usableCandidates,
} from "../.test-build/lib/scriptComposerCore.js";
import { languageFor } from "../.test-build/lib/languages.js";

const EN = languageFor("en");
const BN = languageFor("bn");

test("the budget grows with the footage", () => {
  const short = unitBudget(2_000, EN);
  const long = unitBudget(10_000, EN);
  assert.ok(long > short * 3, `${short} -> ${long}`);
});

test("a budget is never more than the planner will honour", () => {
  // The property that matters: speaking the budgeted words takes no longer
  // than the slot the planner will give, which is at most 2x the footage.
  for (const available of [1_000, 2_000, 5_000, 12_000, 60_000]) {
    for (const lang of [EN, BN]) {
      const words = unitBudget(available, lang);
      const speakingMs = (words / lang.unitsPerSecond) * 1000;
      const slot = Math.max(available * MAX_STRETCH, 1_500);
      assert.ok(
        speakingMs <= slot,
        `${lang.code}: ${words} words is ${Math.round(speakingMs)}ms over ${available}ms of footage, slot ${slot}ms`,
      );
    }
  }
});

test("Bengali gets fewer words than English for the same clip", () => {
  // Measured, not assumed: 79 recorded Bengali lines came back at 2.38 words a
  // second against English's 2.79, so the same footage carries fewer of them.
  assert.ok(unitBudget(6_000, BN) < unitBudget(6_000, EN));
});

test("footage with no known length has no budget", () => {
  // A placeholder is generated at whatever length is asked for, so nothing
  // constrains it.
  assert.equal(unitBudget(null, EN), null);
  assert.equal(availableMs(null, 0), null);
});

test("a moment is measured from where it starts to the end of the clip", () => {
  // Which is what timeline.rs does. Measuring to the end of the *segment*
  // instead would budget less than the planner allows.
  assert.equal(availableMs(60_000, 40_000), 20_000);
  assert.equal(availableMs(60_000, 0), 60_000);
  assert.equal(availableMs(10_000, 12_000), 0, "never negative");
});

test("clips too short to say anything over are kept out of the running", () => {
  const clips = [
    { id: "tiny", durationMs: 400, segments: [{ startSec: 0, endSec: 0.4, text: "a flash" }] },
    { id: "real", durationMs: 9_000, segments: [{ startSec: 0, endSec: 9, text: "the harbour" }] },
  ];
  const usable = usableCandidates(flattenCandidates(clips), EN);
  assert.deepEqual(usable.map((c) => c.clipId), ["real"]);
  assert.ok(unitBudget(400, EN) < MIN_USABLE_UNITS);
});

test("a library of only short clips still makes a film", () => {
  // Excluding everything would refuse to work rather than work badly.
  const clips = [
    { id: "a", durationMs: 400, segments: [{ startSec: 0, endSec: 0.4, text: "one" }] },
  ];
  const all = flattenCandidates(clips);
  assert.equal(usableCandidates(all, EN).length, 0);
  assert.equal(all.length, 1, "the caller falls back to these");
});

test("over-budget lines are found, and only those", () => {
  const selected = flattenCandidates([
    { id: "a", durationMs: 2_000, segments: [{ startSec: 0, endSec: 2, text: "x" }] },
    { id: "b", durationMs: 30_000, segments: [{ startSec: 0, endSec: 30, text: "y" }] },
  ]);
  const lines = [
    { clipId: "a", segmentIndex: 0, text: new Array(40).fill("word").join(" ") },
    { clipId: "b", segmentIndex: 0, text: "Short enough." },
  ];
  const over = overBudget(lines, selected, EN);
  assert.equal(over.length, 1);
  assert.equal(over[0].index, 0);
  assert.ok(over[0].used > over[0].budget);
});

// --- the auto-shorten pass -------------------------------------------------

const CLIPS = [
  { id: "a", durationMs: 2_000, segments: [{ startSec: 0, endSec: 2, text: "harbour" }] },
  { id: "b", durationMs: 30_000, segments: [{ startSec: 0, endSec: 30, text: "road" }] },
];
const LONG = new Array(40).fill("word").join(" ");

function model({ shortened = "Boats, iced in." } = {}) {
  const seen = [];
  const fn = async (args) => {
    seen.push(args);
    if (args.system?.startsWith("You choose")) return JSON.stringify({ refs: [0, 1] });
    if (/Rewrite it shorter/.test(args.prompt ?? "")) return JSON.stringify({ line: shortened });
    return JSON.stringify({
      lines: [
        { ref: 0, text: LONG },
        { ref: 1, text: "The road ran forty miles." },
      ],
    });
  };
  fn.seen = seen;
  return fn;
}

const OPTS = { title: "North", wordCount: 60, critique: false, hook: false };

test("the writer is told each moment's limit, per moment", () => {
  // A single global cap would make every line as short as the shortest clip
  // allows, and the film would lose half its words.
  const m = model();
  return composeScript(m, CLIPS, OPTS).then(() => {
    const write = m.seen.find((a) => /Write the narration/.test(a.prompt ?? ""));
    assert.match(write.prompt, /\[at most \d+ words\]/);
    const limits = [...write.prompt.matchAll(/at most (\d+) words/g)].map((x) => Number(x[1]));
    assert.equal(limits.length, 2);
    assert.ok(limits[0] < limits[1], `2s clip should allow fewer than 30s: ${limits}`);
  });
});

test("a line that outruns its clip is rewritten shorter", async () => {
  const draft = await composeScript(model(), CLIPS, OPTS);
  assert.equal(draft.lines[0].text, "Boats, iced in.");
  assert.equal(draft.lines[1].text, "The road ran forty miles.", "the line that fitted is untouched");
});

test("only the offending line is rewritten", async () => {
  const m = model();
  await composeScript(m, CLIPS, OPTS);
  const rewrites = m.seen.filter((a) => /Rewrite it shorter/.test(a.prompt ?? ""));
  assert.equal(rewrites.length, 1, "rewriting the whole script would discard approved lines");
});

test("a rewrite that came back longer is refused", async () => {
  // Otherwise a model that misunderstands makes the problem worse and the app
  // reports success.
  const draft = await composeScript(model({ shortened: `${LONG} and more` }), CLIPS, OPTS);
  assert.equal(draft.lines[0].text, LONG, "the original is kept for the app to flag");
});

test("the word count reflects the shortened script", async () => {
  const draft = await composeScript(model(), CLIPS, OPTS);
  const actual = draft.lines.reduce((n, l) => n + l.text.trim().split(/\s+/).length, 0);
  assert.equal(draft.words, actual);
});

// Showing every stage at once means a user can edit the script after recording
// and walk straight to export. These are the rules that stop that from shipping
// a video whose narration is one edit out of date.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderSignature,
  stageStatuses,
  staleLineKeys,
  stalenessReason,
  unrecordedLineKeys,
  voiceStampEquals,
} from "../.test-build/lib/pipeline.js";

const line = (clipId, segmentIndex, text) => ({ clipId, segmentIndex, text });

const LINES = [
  line("a", 0, "The harbour was still frozen."),
  line("b", 0, "Light came in low across the water."),
];

const stamp = (over = {}) => ({
  providerId: "local",
  voiceId: "af_kore",
  language: "en",
  pronunciations: {},
  ...over,
});

// --- what changed --------------------------------------------------------

test("audio matching its line is not stale", () => {
  assert.equal(staleLineKeys(LINES, LINES, false).size, 0);
});

test("rewording a line makes only that line stale", () => {
  const edited = [line("a", 0, "The harbour had frozen over."), LINES[1]];
  const stale = staleLineKeys(edited, LINES, false);
  assert.deepEqual([...stale], ["a#0"]);
});

test("whitespace-only edits are not treated as changes", () => {
  const edited = [line("a", 0, "  The harbour was still frozen.  "), LINES[1]];
  assert.equal(staleLineKeys(edited, LINES, false).size, 0);
});

test("changing the voice makes every recorded line stale", () => {
  // No line's text changed, so text comparison alone would call a whole script
  // of wrong-voice audio current.
  const stale = staleLineKeys(LINES, LINES, true);
  assert.deepEqual([...stale].sort(), ["a#0", "b#0"]);
});

test("a line that was never recorded is missing, not stale", () => {
  const recorded = [LINES[0]];
  assert.equal(staleLineKeys(LINES, recorded, false).size, 0);
  assert.deepEqual([...unrecordedLineKeys(LINES, recorded)], ["b#0"]);
});

test("a voice stamp differs when any part of it does", () => {
  assert.ok(voiceStampEquals(stamp(), stamp()));
  assert.ok(!voiceStampEquals(stamp(), stamp({ voiceId: "af_heart" })));
  assert.ok(!voiceStampEquals(stamp(), stamp({ language: "bn" })));
  assert.ok(!voiceStampEquals(stamp(), stamp({ providerId: "elevenlabs" })));
  assert.ok(
    !voiceStampEquals(stamp(), stamp({ pronunciations: { haram: "huh-RAHM" } })),
    "a respelling changes how the line is spoken",
  );
  assert.ok(!voiceStampEquals(null, stamp()), "never recorded is never a match");
});

// --- the cut -------------------------------------------------------------

test("re-recording a line invalidates the cut even at the same path", () => {
  // Audio is written back to line-NN.wav, so paths alone would look unchanged.
  const before = [{ audioPath: "line-01.wav", durationMs: 4000 }];
  const after = [{ audioPath: "line-01.wav", durationMs: 4600 }];
  assert.notEqual(renderSignature(before, 0, null), renderSignature(after, 0, null));
});

test("the cut's own settings are part of its signature", () => {
  const v = [{ audioPath: "line-01.wav", durationMs: 4000 }];
  assert.notEqual(renderSignature(v, 0, null), renderSignature(v, 250, null));
  assert.notEqual(renderSignature(v, 0, null), renderSignature(v, 0, "calm"));
  assert.equal(renderSignature(v, 250, "calm"), renderSignature(v, 250, "calm"));
});

test("the opening is part of the cut's signature", () => {
  // The montage is rendered inside the cut, not beside it. A rewritten and
  // re-recorded hook, or footage that changes which shots get picked, leaves
  // the existing file opening on words nobody is saying — and without this the
  // app would call that cut current.
  const v = [{ audioPath: "line-01.wav", durationMs: 4000 }];
  const intro = "line-00.wav:3000|b#0@2000+1500,c#0@2000+1500";
  const other = "line-00.wav:3000|b#0@2000+1500,d#0@2000+1500";
  assert.notEqual(renderSignature(v, 0, null, intro), renderSignature(v, 0, null, other));
  assert.notEqual(
    renderSignature(v, 0, null, intro),
    renderSignature(v, 0, null, ""),
    "removing the opening is a change like any other",
  );
  assert.equal(renderSignature(v, 0, null, intro), renderSignature(v, 0, null, intro));
});

// --- the rail ------------------------------------------------------------

const base = {
  clipCount: 2,
  describedCount: 2,
  title: "Umrah",
  lines: LINES,
  voiced: LINES,
  staleLines: new Set(),
  unrecordedLines: new Set(),
  hasAssembly: true,
  assemblyCurrent: true,
  introPending: false,
  busy: null,
};

test("a finished project reads as done throughout", () => {
  const s = stageStatuses(base);
  assert.deepEqual(s, {
    footage: "done",
    story: "done",
    script: "done",
    voice: "done",
    assembly: "done",
  });
});

test("an empty project blocks nothing but marks what is missing", () => {
  const s = stageStatuses({
    ...base,
    clipCount: 0,
    describedCount: 0,
    title: "",
    lines: null,
    voiced: null,
    hasAssembly: false,
  });
  assert.equal(s.footage, "empty");
  assert.equal(s.story, "empty");
  assert.equal(s.assembly, "empty");
});

test("editing a recorded line marks voice and assembly stale, not the script", () => {
  const staleLines = new Set(["a#0"]);
  const s = stageStatuses({ ...base, staleLines });
  assert.equal(s.script, "done", "the script itself is fine — it is what changed");
  assert.equal(s.voice, "stale");
  assert.equal(s.assembly, "stale", "a cut built on that audio is out of date too");
});

test("stale work is kept rather than reverting to ready", () => {
  // Dropping to "ready" would read as "nothing here yet" and invite a full
  // re-run, which for a cloud voice is billed a second time.
  const s = stageStatuses({ ...base, staleLines: new Set(["a#0"]) });
  assert.notEqual(s.voice, "ready");
});

test("a running stage overrides its status", () => {
  assert.equal(stageStatuses({ ...base, busy: "voice" }).voice, "working");
});

test("staleness explains itself in words, not just colour", () => {
  const input = {
    ...base,
    staleLines: new Set(["a#0"]),
    unrecordedLines: new Set(["b#0"]),
  };
  const voice = stalenessReason("voice", input);
  assert.match(voice, /1 line changed since recording/);
  assert.match(voice, /1 line never recorded/);
  assert.match(stalenessReason("assembly", input), /narration changed/);
  assert.equal(stalenessReason("voice", base), null, "nothing to say when current");
});

test("a cut is stale when its settings changed even if the words did not", () => {
  const reason = stalenessReason("assembly", { ...base, assemblyCurrent: false });
  assert.match(reason, /settings changed/);
});

// --- the opening ---------------------------------------------------------

test("an unspoken opening holds the voice stage open", () => {
  // Otherwise the rail reads done, the user renders, and the film quietly has
  // no opening at all — a montage cannot be cut without the hook's length.
  const s = stageStatuses({ ...base, introPending: true });
  assert.equal(s.voice, "stale");
  assert.equal(s.assembly, "stale");
});

test("the opening is named rather than counted among the lines", () => {
  // "1 line never recorded" would send the user hunting through a script that
  // does not contain it.
  const why = stalenessReason("voice", { ...base, introPending: true });
  assert.match(why, /opening line/);
  assert.doesNotMatch(why, /1 line never recorded/);
});

test("an opening and reworded lines are both reported", () => {
  const why = stalenessReason("voice", {
    ...base,
    staleLines: new Set(["c1#0"]),
    introPending: true,
  });
  assert.match(why, /1 line changed/);
  assert.match(why, /opening line/);
});

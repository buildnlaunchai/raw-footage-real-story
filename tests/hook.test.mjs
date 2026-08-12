// The opening line. It is the first thing anyone hears and it is written by a
// model that would rather write a paragraph, so most of what is defended here
// is length, and the rest is what an opening must not do.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeScript,
  echoesScript,
  HOOK_FLOOR_WORDS,
  HOOK_MAX_WORDS,
  HOOK_MIN_WORDS,
  hookLengthOk,
  writeHook,
} from "../.test-build/lib/scriptComposerCore.js";

const MATERIAL = {
  title: "Twelve days north",
  moments: ["harbour at dawn, boats iced in", "a road with no other car on it"],
  // Long enough to be a plausible verbatim copy: a model that returns line one
  // has to fail the echo check, not fall out on length first.
  lines: [
    "The harbour did not so much freeze as stop, boats caught mid-turn where the water took them.",
    "The road ran forty miles without ever meeting another car coming the other way.",
  ],
};

/** A model that says one fixed thing, and counts how often it was asked. */
function saying(...replies) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return replies[Math.min(calls.length - 1, replies.length - 1)];
  };
  fn.calls = calls;
  return fn;
}

const GOOD = "Twelve days, one road, and a harbour that had stopped moving entirely by the time we arrived";

test("a hook of the right length comes back as written", async () => {
  const model = saying(JSON.stringify({ hook: GOOD }));
  assert.equal(await writeHook(model, MATERIAL), GOOD);
  assert.equal(model.calls.length, 1, "no retry when the first answer is usable");
});

test("the cap is a refusal; the floor is only what we ask for", () => {
  // Measured against a live 7B writing Bengali: natural openings came back at
  // five to nine words, and enforcing the English floor rejected two in three.
  // A short opening is a short opening; a paragraph is not an opening at all.
  assert.equal(hookLengthOk("Two words"), false, "not a sentence");
  assert.equal(hookLengthOk("The road ran forty miles."), true, "short, but an opening");
  assert.equal(hookLengthOk(GOOD), true);
  assert.equal(hookLengthOk(new Array(60).fill("word").join(" ")), false);
  assert.ok(HOOK_FLOOR_WORDS < HOOK_MIN_WORDS);
  assert.ok(HOOK_MIN_WORDS < HOOK_MAX_WORDS);
});

test("the ask is still the band, whatever is accepted", async () => {
  const model = saying(JSON.stringify({ hook: GOOD }));
  await writeHook(model, MATERIAL);
  assert.match(model.calls[0].prompt, new RegExp(`${HOOK_MIN_WORDS} and ${HOOK_MAX_WORDS}`));
});

test("a paragraph is retried, then given up on", async () => {
  // Given up on rather than truncated: half a sentence read aloud over an
  // opening montage is worse than no opening at all.
  const essay = JSON.stringify({ hook: new Array(80).fill("word").join(" ") });
  const model = saying(essay);
  assert.equal(await writeHook(model, MATERIAL), null);
  assert.equal(model.calls.length, 3, "bounded, not an unbounded loop");
  assert.match(model.calls[1].prompt, /too long/, "the retry says which way it missed");
});

// --- not the film's own first line -----------------------------------------

test("a hook that is the first line verbatim is rejected", async () => {
  // Measured against a live 7B: two of five attempts returned line one word
  // for word, having been told in the same prompt not to. The instruction is
  // not enough, so the check is mechanical.
  const copy = JSON.stringify({ hook: MATERIAL.lines[0] });
  const model = saying(copy, copy, JSON.stringify({ hook: GOOD }));
  assert.equal(await writeHook(model, MATERIAL), GOOD);
  assert.match(model.calls[1].prompt, /repeated a line the film already has/);
});

test("echo detection catches a rewrite, not just a copy", () => {
  const line = "The harbour did not so much freeze as stop, boats caught mid-turn.";
  assert.ok(echoesScript(line, [line]), "verbatim");
  assert.ok(
    echoesScript("Somewhere the harbour did not so much freeze as stop entirely", [line]),
    "a run of six words is a copy with a hat on",
  );
  // A fragment of the line is still the line, however short.
  assert.ok(echoesScript("did not so much freeze", [line]), "a fragment counts");
  assert.equal(
    echoesScript("We arrived and did not so much mind the cold at all", [line]),
    false,
    "four words in common is ordinary English, not a copy",
  );
});

test("echo detection ignores punctuation and case", () => {
  const line = "The road ran forty miles without meeting another car.";
  assert.ok(echoesScript("the ROAD ran forty miles, without meeting another car", [line]));
});

test("shared subject matter is not an echo", () => {
  // Two sentences about the same trip will share words. Rejecting on that
  // would leave every hook unwritten.
  const lines = [
    "The harbour did not so much freeze as stop.",
    "The road ran forty miles without meeting another car.",
  ];
  assert.equal(
    echoesScript("Forty miles of road, and a harbour that had simply stopped", lines),
    false,
  );
});

test("an all-echo model gives up rather than opening on line one", async () => {
  const copy = JSON.stringify({ hook: MATERIAL.lines[0] });
  const model = saying(copy);
  assert.equal(await writeHook(model, MATERIAL), null);
});

test("the retry is taken when it lands", async () => {
  const model = saying(JSON.stringify({ hook: "Short." }), JSON.stringify({ hook: GOOD }));
  // "Short." is two words: under the floor, so genuinely refused.
  assert.equal(await writeHook(model, MATERIAL), GOOD);
});

test("quotes, numbering and labels are stripped rather than spoken", async () => {
  // The voice reads exactly what it is given, so a stray quotation mark is a
  // sound. Cheaper to clean than to spend another call asking for it again.
  const model = saying(JSON.stringify({ hook: `1. "${GOOD}"` }));
  assert.equal(await writeHook(model, MATERIAL), GOOD);
});

test("a plain-text answer is accepted, not only JSON", async () => {
  // Local models honour the schema unevenly, and a usable line in the wrong
  // wrapper is still a usable line.
  assert.equal(await writeHook(saying(GOOD), MATERIAL), GOOD);
});

test("the fast model writes it", async () => {
  // The final narration earns the slower model. One short line chosen from
  // material already written does not, and it is the line most likely to be
  // regenerated three times over.
  const model = saying(JSON.stringify({ hook: GOOD }));
  await writeHook(model, MATERIAL);
  assert.equal(model.calls[0].tier, "fast");
});

test("the hook is told what it must not repeat", async () => {
  // It plays immediately before those lines. A hook that paraphrases line one
  // makes the film start twice.
  const model = saying(JSON.stringify({ hook: GOOD }));
  await writeHook(model, MATERIAL);
  const p = model.calls[0].prompt;
  assert.match(p, /must not repeat or paraphrase/);
  assert.ok(p.includes(MATERIAL.lines[0]), "and is shown them");
});

test("a model that throws loses the opening, not the script", async () => {
  const boom = async () => {
    throw new Error("ollama died");
  };
  assert.equal(await writeHook(boom, MATERIAL), null);
});

// --- inside the composer ---------------------------------------------------

const CLIPS = [
  { id: "a", segments: [{ startSec: 0, endSec: 8, text: "harbour at dawn" }] },
  { id: "b", segments: [{ startSec: 0, endSec: 8, text: "an empty road" }] },
];

/** Selects both moments, writes one line each, and answers the hook call. */
function composerModel({ hook = GOOD } = {}) {
  const seen = [];
  const fn = async (args) => {
    seen.push(args);
    if (args.system?.startsWith("You choose")) return JSON.stringify({ refs: [0, 1] });
    if (args.system?.startsWith("You write the opening line")) {
      return JSON.stringify({ hook });
    }
    return JSON.stringify({
      lines: [
        { ref: 0, text: "The harbour did not so much freeze as stop." },
        { ref: 1, text: "The road ran forty miles without meeting another car." },
      ],
    });
  };
  fn.seen = seen;
  return fn;
}

test("the hook rides along with a generated script", async () => {
  const draft = await composeScript(composerModel(), CLIPS, {
    title: "North", wordCount: 30, critique: false,
  });
  assert.equal(draft.hook, GOOD);
});

test("the hook is not counted towards the word target", async () => {
  // The target is a promise about how long the film is. Twenty words of
  // opening would eat into it silently, and the correction pass would then
  // shorten the narration to make room for a line that is not narration.
  const draft = await composeScript(composerModel(), CLIPS, {
    title: "North", wordCount: 30, critique: false,
  });
  const inLines = draft.lines.reduce((n, l) => n + l.text.trim().split(/\s+/).length, 0);
  assert.equal(draft.words, inLines, "words counts the script, not the opening");
});

test("the hook is never shown to the critique pass", async () => {
  // Asked to check a line that narrates no moment, the model rewrites it into
  // a description of the first clip — which is the one thing an opening is
  // not allowed to be.
  const model = composerModel();
  await composeScript(model, CLIPS, { title: "North", wordCount: 30, critique: true });
  const critique = model.seen.find((a) => /list what is weak/.test(a.prompt ?? ""));
  assert.ok(critique, "the critique pass ran");
  assert.ok(!critique.prompt.includes(GOOD), "and never saw the opening");
});

test("the hook is written last, after the length is settled", async () => {
  const model = composerModel();
  await composeScript(model, CLIPS, { title: "North", wordCount: 30, critique: true });
  const hookAt = model.seen.findIndex((a) => a.system?.startsWith("You write the opening line"));
  assert.equal(hookAt, model.seen.length - 1);
});

test("turning it off spends no call at all", async () => {
  const model = composerModel();
  const draft = await composeScript(model, CLIPS, {
    title: "North", wordCount: 30, critique: false, hook: false,
  });
  assert.equal(draft.hook, null);
  assert.ok(!model.seen.some((a) => a.system?.startsWith("You write the opening line")));
});

test("a failed hook still returns the script", async () => {
  const draft = await composeScript(composerModel({ hook: "Too short." }), CLIPS, {
    title: "North", wordCount: 30, critique: false,
  });
  assert.equal(draft.hook, null, "no opening");
  assert.equal(draft.lines.length, 2, "but the film is intact");
});

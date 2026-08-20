// What a fresh machine is told it can and cannot do. These are the sentences a
// non-technical user reads before they have any idea how this app works, so
// each one has to be true on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  attention,
  capabilities,
  ffmpegState,
  installFor,
  ollamaReport,
  recommendedScriptRoute,
  usable,
} from "../.test-build/lib/readiness.js";

const REQ = {
  fastModel: "qwen2.5:7b",
  qualityModel: "qwen2.5:14b",
  hasOpenAiKey: false,
  hasElevenLabsKey: false,
};

const probe = (over = {}) => ({
  ffmpeg: { ffmpeg: "/opt/homebrew/bin/ffmpeg", ffprobe: "/opt/homebrew/bin/ffprobe", caps: { zscale: true } },
  ffmpegError: null,
  ollamaModels: ["qwen2.5:7b", "qwen2.5:14b"],
  ollamaError: null,
  installers: [{ name: "brew", path: "/opt/homebrew/bin/brew" }],
  ...over,
});

// --- ffmpeg ---------------------------------------------------------------

test("ffmpeg has three states, and a build without zscale is not a failure", () => {
  assert.equal(ffmpegState(probe()), "ready");
  assert.equal(ffmpegState(probe({ ffmpeg: null, ffmpegError: "FFMPEG_NOT_FOUND" })), "missing");
  const noZ = probe();
  noZ.ffmpeg.caps.zscale = false;
  assert.equal(ffmpegState(noZ), "limited");
});

test("a limited ffmpeg still lets the app be used", () => {
  const noZ = probe();
  noZ.ffmpeg.caps.zscale = false;
  const caps = capabilities(noZ, REQ);
  const footage = caps.find((c) => c.id === "footage");
  assert.equal(footage.ready, true, "importing works without zscale");
  assert.match(footage.caveat, /HDR/, "but says what will look wrong");
  assert.equal(usable(caps), true);
});

test("missing ffmpeg makes the app unusable — nothing else can start", () => {
  // Not a matter of taste: import calls ffmpeg for thumbnails and duration, so
  // a machine without it cannot get a single clip in.
  const caps = capabilities(probe({ ffmpeg: null, ffmpegError: "FFMPEG_NOT_FOUND" }), REQ);
  assert.equal(usable(caps), false);
  const footage = caps.find((c) => c.id === "footage");
  assert.equal(footage.blocking, true);
  assert.match(footage.detail, /cannot be imported/);
});

// --- ollama ---------------------------------------------------------------

test("Ollama running with nothing pulled is its own state", () => {
  // The trap: Ollama answers, so everything looks fine, and generation fails.
  const r = ollamaReport(probe({ ollamaModels: [] }), REQ);
  assert.equal(r.state, "no-models");
  assert.deepEqual(r.missing, ["qwen2.5:7b", "qwen2.5:14b"]);
});

test("unreachable is distinct from installed-but-empty", () => {
  const r = ollamaReport(probe({ ollamaModels: null, ollamaError: "OLLAMA_UNREACHABLE" }), REQ);
  assert.equal(r.state, "unreachable");
});

test("the fast model alone is usable, with the cost named", () => {
  const p = probe({ ollamaModels: ["qwen2.5:7b"] });
  assert.equal(ollamaReport(p, REQ).state, "partial");
  const script = capabilities(p, REQ).find((c) => c.id === "script");
  assert.equal(script.ready, true, "4.7GB is enough to start");
  assert.match(script.caveat, /qwen2\.5:14b/, "and says what the second model buys");
});

test("a size is never satisfied by a different size", () => {
  // Matching on the base name made qwen2.5:7b satisfy qwen2.5:14b — they share
  // one — so a machine with the small model reported ready and then failed on
  // the final write. Wrong in the direction that costs a broken generation.
  const r = ollamaReport(probe({ ollamaModels: ["qwen2.5:latest"] }), REQ);
  assert.equal(r.state, "no-models", "latest is not evidence of either size");
  assert.deepEqual(r.missing, ["qwen2.5:7b", "qwen2.5:14b"]);
});

test("an untagged configuration is satisfied by whatever tag is installed", () => {
  // Asking for `qwen2.5` means any of it will do; that is the only looseness
  // that is safe.
  const r = ollamaReport(probe({ ollamaModels: ["qwen2.5:latest"] }), {
    ...REQ,
    fastModel: "qwen2.5",
    qualityModel: "qwen2.5",
  });
  assert.equal(r.state, "ready");
});

// --- capabilities, not products -------------------------------------------

test("an OpenAI key satisfies the script row on its own", () => {
  const p = probe({ ollamaModels: null, ollamaError: "OLLAMA_UNREACHABLE" });
  const caps = capabilities(p, { ...REQ, hasOpenAiKey: true });
  const script = caps.find((c) => c.id === "script");
  assert.equal(script.ready, true, "a cloud key is a real answer, not a fallback");
  assert.match(script.detail, /OpenAI/);
  assert.equal(script.caveat, undefined, "no nagging about a model you chose not to use");
});

test("with neither, the script row says which two things are missing", () => {
  const caps = capabilities(probe({ ollamaModels: null, ollamaError: "X" }), REQ);
  const script = caps.find((c) => c.id === "script");
  assert.equal(script.ready, false);
  assert.match(script.detail, /Ollama is not running/);
  assert.match(script.detail, /no OpenAI key/);
});

test("voice is ready on a machine with nothing installed", () => {
  // Kokoro ships inside the app, so this row is never a barrier — which is
  // exactly why "install nothing" cannot be claimed for the other two.
  const bare = probe({ ffmpeg: null, ffmpegError: "X", ollamaModels: null, ollamaError: "X" });
  const voice = capabilities(bare, REQ).find((c) => c.id === "voice");
  assert.equal(voice.ready, true);
  assert.match(voice.detail, /included with the app/);
});

test("a fully ready machine asks for nothing", () => {
  const caps = capabilities(probe(), REQ);
  assert.equal(attention(caps), 0);
  assert.equal(usable(caps), true);
});

// --- which route a machine should be on ------------------------------------
//
// The recommendation is the cloud one, and these pin down the single case where
// it is not: a machine that has already paid for the models.

test("a machine with nothing is pointed at the cloud, not at a download", () => {
  const bare = probe({ ffmpeg: null, ffmpegError: "X", ollamaModels: null, ollamaError: "X" });
  assert.equal(recommendedScriptRoute(bare, REQ), "openai");
});

test("a linked key wins even where the local models are all present", () => {
  assert.equal(recommendedScriptRoute(probe(), { ...REQ, hasOpenAiKey: true }), "openai");
});

test("working local models and no key stay local", () => {
  // The download is already on disk. Sending this person to link a key would be
  // recommending they go and acquire a capability they have.
  assert.equal(recommendedScriptRoute(probe(), REQ), "local");
  assert.equal(
    recommendedScriptRoute(probe({ ollamaModels: ["qwen2.5:7b"] }), REQ),
    "local",
    "the fast model alone is a working setup",
  );
});

test("Ollama installed but empty is not a working setup", () => {
  // The trap state again: the server answers, so nothing looks wrong, and there
  // is still a multi-gigabyte pull between this machine and a script.
  assert.equal(recommendedScriptRoute(probe({ ollamaModels: [] }), REQ), "openai");
});

test("the script row describes the route in use, not whichever is listed first", () => {
  const both = capabilities(probe(), { ...REQ, hasOpenAiKey: true });
  const script = both.find((c) => c.id === "script");
  assert.match(script.detail, /OpenAI/);
  assert.doesNotMatch(script.detail, /Ollama/, "the app is not calling Ollama here");
});

test("a key silences the half-installed-models caveat", () => {
  // Nagging about the 9 GB second model is only fair to somebody whose scripts
  // are actually going to be written by the small one.
  const partial = probe({ ollamaModels: ["qwen2.5:7b"] });
  const script = capabilities(partial, { ...REQ, hasOpenAiKey: true }).find((c) => c.id === "script");
  assert.equal(script.caveat, undefined);
  assert.equal(attention(capabilities(partial, { ...REQ, hasOpenAiKey: true })), 0);
});

test("with neither, the sentence leads with the key rather than the download", () => {
  const caps = capabilities(probe({ ollamaModels: null, ollamaError: "X" }), REQ);
  const script = caps.find((c) => c.id === "script");
  assert.equal(script.ready, false);
  assert.ok(
    script.detail.indexOf("OpenAI") < script.detail.indexOf("Ollama"),
    `the cheaper fix is named first: ${script.detail}`,
  );
});

test("the picker offers the cloud provider first", () => {
  // `SCRIPT_PROVIDERS` is rendered with `Object.values`, so key order is what a
  // new user reads first. It cannot be imported here — that module pulls in
  // `@tauri-apps` — so the ordering is guarded against the source, which is
  // where somebody would accidentally undo it.
  const src = readFileSync(new URL("../src/lib/scriptProviders.ts", import.meta.url), "utf8");
  const record = src.slice(src.indexOf("SCRIPT_PROVIDERS: Record"));
  assert.ok(
    record.indexOf("openai: {") < record.indexOf("local: {"),
    "cloud-first, deliberately",
  );
  assert.match(record.slice(0, record.indexOf("local: {")), /recommended: true/);
});

// --- install instructions -------------------------------------------------

test("a detected manager is runnable; an absent one is not invented", () => {
  const withBrew = installFor("ffmpeg", "macos", [{ name: "brew", path: "/opt/homebrew/bin/brew" }]);
  assert.equal(withBrew.program, "/opt/homebrew/bin/brew");
  assert.deepEqual(withBrew.args, ["install", "ffmpeg-full"]);

  const without = installFor("ffmpeg", "macos", []);
  assert.equal(without.program, undefined, "nothing to run");
  assert.match(without.note, /Homebrew was not found/);
  assert.equal(without.command, "brew install ffmpeg-full", "still shown to copy");
});

test("macOS gets ffmpeg-full and the Ollama cask", () => {
  // ffmpeg-full because the plain formula has no zscale; the cask because the
  // formula leaves the user needing `brew services start`.
  assert.match(installFor("ffmpeg", "macos", []).command, /ffmpeg-full/);
  assert.match(installFor("ollama", "macos", []).command, /--cask ollama-app/);
});

test("Windows gets the exact package ids", () => {
  assert.equal(installFor("ffmpeg", "windows", []).command, "winget install -e --id Gyan.FFmpeg");
  assert.equal(installFor("ollama", "windows", []).command, "winget install -e --id Ollama.Ollama");
  assert.match(installFor("ollama", "windows", []).note, /ask for permission/);
});

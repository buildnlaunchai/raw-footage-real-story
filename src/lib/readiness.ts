/**
 * Can this machine do the work, and what happens if it cannot.
 *
 * The rule lives here rather than in Rust because it depends on which models
 * the app is configured to use and which keys are stored — both of which are
 * frontend facts. Rust reports what it found; this decides what that means.
 *
 * Organised by *capability*, not by product. "Script" is one row satisfied by
 * either Ollama or an OpenAI key, because a user who has one does not care that
 * the other is missing, and a checklist of four products invites them to
 * install things they will never use.
 *
 * Dependency-free so it can be tested without a machine that has any of this.
 */

export type FfmpegState = "missing" | "limited" | "ready";

/**
 * - `unreachable` Ollama is not running (or not installed)
 * - `no-models`   running, nothing pulled — the trap, because Ollama looks fine
 * - `partial`     the fast model only; usable, with a quality cost
 * - `ready`       both models
 */
export type OllamaState = "unreachable" | "no-models" | "partial" | "ready";

/**
 * What Rust found, mirrored field for field.
 *
 * Written out rather than imported from `assembly.ts` so this module stays
 * free of `@tauri-apps` and can be tested in plain node. It mirrors
 * `FfmpegInfo` exactly, which is what lets one probe serve both this screen and
 * the app's own idea of whether ffmpeg exists — they used to be detected
 * separately, and a fresh install updated one of them.
 */
export interface Probe {
  ffmpeg: {
    ffmpeg: string;
    ffprobe: string;
    version: string;
    caps: { zscale: boolean; tonemap: boolean; subtitles: boolean };
  } | null;
  ffmpegError: string | null;
  ollamaModels: string[] | null;
  ollamaError: string | null;
  installers: { name: string; path: string }[];
}

export interface Requirements {
  /** Selection and story ideas; the cheap one. */
  fastModel: string;
  /** The final narration; the one the viewer hears. */
  qualityModel: string;
  /**
   * Whether the signed-in account has a usable key for each provider.
   *
   * "Has a key", not "has saved a key on this machine" — there is no such
   * thing any more. These are answered by `provider_key_status`, and a machine
   * that could not reach the platform answers `false` for both: the setup
   * screen is mostly about what is installed here, and a network problem must
   * not stop it rendering.
   */
  hasOpenAiKey: boolean;
  hasElevenLabsKey: boolean;
}

export function ffmpegState(p: Probe): FfmpegState {
  if (!p.ffmpeg) return "missing";
  // Present but built without libzimg: everything works except tone-mapping
  // HDR footage, which most phone video now is. A caveat, never a blocker.
  return p.ffmpeg.caps.zscale ? "ready" : "limited";
}

export interface OllamaReport {
  state: OllamaState;
  present: string[];
  missing: string[];
}

/**
 * Does this machine have the model we asked for?
 *
 * Exact tag, with one exception: a configured name with no tag at all
 * (`qwen2.5`) is satisfied by any tag of it, since that is what the user asked
 * for. Matching on the base name in general was wrong and briefly shipped —
 * `qwen2.5:7b` and `qwen2.5:14b` share a base, so having the small one reported
 * the large one as present, and the failure surfaced much later as a confusing
 * error on the one call whose output the viewer actually hears.
 *
 * Erring toward "you still need this" costs a re-check. Erring the other way
 * costs a generation that dies halfway.
 */
function hasModel(installed: string[], want: string): boolean {
  if (installed.includes(want)) return true;
  const [base, tag] = want.split(":");
  return tag === undefined && installed.some((m) => m.split(":")[0] === base);
}

export function ollamaReport(p: Probe, req: Requirements): OllamaReport {
  if (p.ollamaModels === null) {
    return { state: "unreachable", present: [], missing: [req.fastModel, req.qualityModel] };
  }
  const present: string[] = [];
  const missing: string[] = [];
  for (const m of [req.fastModel, req.qualityModel]) {
    (hasModel(p.ollamaModels, m) ? present : missing).push(m);
  }
  if (present.length === 0) return { state: "no-models", present, missing };
  if (missing.length === 0) return { state: "ready", present, missing };
  // The fast model alone is enough to produce a script; only the final write
  // is worse for it. Blocking on the second would put nine more gigabytes
  // between a new user and their first video for a difference in polish.
  return { state: "partial", present, missing };
}

export interface Capability {
  id: "footage" | "script" | "voice";
  label: string;
  /** Can the user do this at all? */
  ready: boolean;
  /**
   * Does the app become unusable without it?
   *
   * Only footage is. ffmpeg is needed to *import* — thumbnails and duration
   * come from it — so without it nothing else can even begin, and there is no
   * cloud alternative for it as there is for the other two.
   */
  blocking: boolean;
  /** What is true right now. */
  detail: string;
  /** A caveat that does not stop the work. */
  caveat?: string;
}

/**
 * Which of the two script routes the app should be on.
 *
 * `"openai"` is the recommended one and the answer in every case except the
 * one where it would be wrong: a machine that has already paid the download
 * cost for local models and has no key on the account. Recommending the cloud
 * to somebody with fourteen gigabytes of working models on disk would be
 * telling them to go and link a key to reach a capability they already have.
 *
 * With neither, the answer is still `"openai"`. That is the point of the
 * default — the shortest path from a fresh install to a first script is a key
 * the account may already hold, not a download measured in gigabytes, and the
 * screen that offers a choice should be sitting on that one when it opens.
 */
export type ScriptRoute = "openai" | "local";

function localScriptReady(ol: OllamaReport): boolean {
  return ol.state === "ready" || ol.state === "partial";
}

export function recommendedScriptRoute(p: Probe, req: Requirements): ScriptRoute {
  if (req.hasOpenAiKey) return "openai";
  return localScriptReady(ollamaReport(p, req)) ? "local" : "openai";
}

export function capabilities(p: Probe, req: Requirements): Capability[] {
  const ff = ffmpegState(p);
  const ol = ollamaReport(p, req);

  const footage: Capability = {
    id: "footage",
    label: "Import and render video",
    ready: ff !== "missing",
    blocking: true,
    detail:
      ff === "missing"
        ? "ffmpeg not found. Clips cannot be imported until it is installed."
        : `ffmpeg found at ${p.ffmpeg?.ffmpeg ?? ""}`,
    caveat:
      ff === "limited"
        ? "This build has no zscale, so HDR footage cannot be tone-mapped and will look washed out."
        : undefined,
  };

  const route = recommendedScriptRoute(p, req);
  const script: Capability = {
    id: "script",
    label: "Write the narration",
    ready: req.hasOpenAiKey || localScriptReady(ol),
    blocking: false,
    // Says which route is actually in use, which is the one `route` picked —
    // not whichever happens to be listed first. A machine with both a key and
    // a local model is using the key, and saying "Ollama" there would describe
    // a provider the app is not calling.
    detail:
      route === "openai"
        ? req.hasOpenAiKey
          ? "OpenAI, using the key on your account"
          : ol.state === "unreachable"
            ? "Your account has no OpenAI key, and Ollama is not running here."
            : "Your account has no OpenAI key, and Ollama is running but has no models."
        : `Ollama, using ${ol.present.join(" and ")}`,
    caveat:
      route === "local" && ol.state === "partial"
        ? `Only ${ol.present[0]} is installed. Scripts will be written by the smaller model, which reads less well than ${ol.missing[0]}.`
        : undefined,
  };

  // Kokoro ships inside the app and is verified at build time, so this is the
  // one capability that is ready on a machine with nothing installed.
  const voice: Capability = {
    id: "voice",
    label: "Record the narration",
    ready: true,
    blocking: false,
    detail: req.hasElevenLabsKey
      ? "Built-in voices, or ElevenLabs using the key on your account"
      : "Built-in voices, included with the app",
  };

  return [footage, script, voice];
}

/** Things worth telling the user about, for the sidebar chip. */
export function attention(caps: Capability[]): number {
  return caps.filter((c) => !c.ready || c.caveat).length;
}

/** Is the app usable at all? False only when a blocking capability is missing. */
export function usable(caps: Capability[]): boolean {
  return caps.every((c) => c.ready || !c.blocking);
}

// --- install instructions ---------------------------------------------------

export interface InstallStep {
  /** Shown as the command, and run verbatim when a manager was detected. */
  command: string;
  program?: string;
  args?: string[];
  note?: string;
}

/**
 * How to install a dependency on this machine.
 *
 * Returns the runnable form when the package manager was found, and the
 * copy-and-paste form otherwise. Never invents a manager: telling somebody to
 * run `brew` on a machine without Homebrew is how a setup screen loses trust.
 */
export function installFor(
  what: "ffmpeg" | "ollama",
  platform: "macos" | "windows" | "other",
  installers: { name: string; path: string }[],
): InstallStep {
  const brew = installers.find((i) => i.name === "brew");
  const winget = installers.find((i) => i.name === "winget");

  if (what === "ffmpeg") {
    if (platform === "macos") {
      // ffmpeg-full, not ffmpeg: the plain formula is built without libzimg,
      // so it has no zscale and cannot tone-map HDR.
      return {
        command: "brew install ffmpeg-full",
        program: brew?.path,
        args: brew ? ["install", "ffmpeg-full"] : undefined,
        note: brew ? undefined : "Homebrew was not found. Install it from brew.sh first.",
      };
    }
    if (platform === "windows") {
      return {
        command: "winget install -e --id Gyan.FFmpeg",
        program: winget?.path,
        args: winget ? ["install", "-e", "--id", "Gyan.FFmpeg", "--accept-package-agreements", "--accept-source-agreements"] : undefined,
        note: winget ? undefined : "winget was not found. It ships with Windows 11 and current Windows 10.",
      };
    }
    return { command: "sudo apt install ffmpeg" };
  }

  if (platform === "macos") {
    // The cask, not the formula: it installs the app, which starts the server
    // itself. The formula leaves the user needing `brew services start ollama`,
    // which is one more terminal step and the exact thing this screen exists to
    // avoid.
    return {
      command: "brew install --cask ollama-app",
      program: brew?.path,
      args: brew ? ["install", "--cask", "ollama-app"] : undefined,
      note: brew ? undefined : "Homebrew was not found. Install it from brew.sh, or download Ollama from ollama.com.",
    };
  }
  if (platform === "windows") {
    return {
      command: "winget install -e --id Ollama.Ollama",
      program: winget?.path,
      args: winget ? ["install", "-e", "--id", "Ollama.Ollama", "--accept-package-agreements", "--accept-source-agreements"] : undefined,
      note: "Windows will ask for permission during this install.",
    };
  }
  return { command: "curl -fsSL https://ollama.com/install.sh | sh" };
}

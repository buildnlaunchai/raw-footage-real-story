import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { ProjectGallery } from "./components/ProjectGallery";
import { SegmentEditor } from "./components/SegmentEditor";
import { StoryPanel } from "./components/StoryPanel";
import { ScriptPanel } from "./components/ScriptPanel";
import { ProviderPicker } from "./components/ProviderPicker";
import { LibrarySidebar, type LibraryView } from "./components/LibrarySidebar";
import { VideoTable } from "./components/VideoTable";
import { ClipDescriber } from "./components/ClipDescriber";
import { SettingsPanel } from "./components/SettingsPanel";
import { ReadinessPanel } from "./components/ReadinessPanel";
import {
  attention as attentionCount,
  capabilities as capabilitiesOf,
  usable as isUsable,
  type Probe,
} from "./lib/readiness";
import { TakeHistory } from "./components/TakeHistory";
import {
  addTake,
  deleteTake,
  listTakes,
  renderTake,
  scriptTake,
  voiceTake,
  type Take,
} from "./lib/takes";
import {
  getIntroEnabled,
  getWritingInstructions,
  setIntroEnabled as storeIntroEnabled,
  SCRIPT_PROVIDERS,
} from "./lib/scriptProviders";
import { CheckIcon, FilterIcon, SaveIcon, SearchIcon, SortIcon } from "./components/Icons";
import {
  allowMedia,
  backfillCaptureTimes,
  formatSpan,
  listLibrary,
  reorderClips,
  purgeClip,
  setSegments,
  storageUsage,
  type LibraryClip,
  type StorageUsage,
} from "./lib/library";
import { listProjects, type ProjectSummary } from "./lib/project";
import {
  describeOrdering,
  sortByShootingOrder,
  sortClipsBy,
  SORT_BASES,
  type SortBasis,
} from "./lib/shootingOrder";
import { invoke } from "@tauri-apps/api/core";
import { AssemblyPanel } from "./components/AssemblyPanel";
import {
  renderSignature,
  stageStatuses,
  staleLineKeys,
  stalenessReason,
  unrecordedLineKeys,
  voiceStampEquals,
  STAGES,
  STAGE_ORDER,
  type StageId,
  type VoiceStamp,
} from "./lib/pipeline";
import { FfmpegSetup } from "./components/FfmpegSetup";
import { OLLAMA_HOST, OLLAMA_MODEL, OLLAMA_MODEL_QUALITY } from "./config/ollama";
import {
  createProject,
  describedCount,
  openProject,
  saveProject,
  totalSegments,
  type ProjectClip,
  type ProjectFile,
} from "./lib/project";
import type { Segment } from "./lib/segments";
import { DEFAULT_LANGUAGE, detectLanguage, languageFor } from "./lib/languages";
import {
  type QualityTier,
  type ScriptProviderId,
} from "./lib/scriptProviders";
import { suggestStoryIdeas, type IdeaProgress, type StoryIdea } from "./lib/storyIdeas";
import {
  candidatesOf,
  generateHookForScript,
  generateScriptForTitle,
  overBudget as overBudgetLines,
  shortenLineToFit,
  type ComposeProgress,
  type ScriptLineDraft,
  type ScriptStyle,
} from "./lib/scriptComposer";
import { INTRO_FADE_MS, pickShots, type ShotCandidate } from "./lib/intro";
import { TimelinePanel } from "./components/TimelinePanel";
import { blankCaption, CAPTION_FACES, drawCaptions, loadCaptionFont } from "./lib/captions";
import { resolveResource } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  applyEdits,
  DEFAULT_TIMELINE,
  soundGains,
  toAssColour,
  transitionsFor,
  type PlannedShot,
  type TimelineDoc,
} from "./lib/timeline";
import { coverageFor, suggestedWordCount } from "./lib/scriptComposerCore";
import { audioUrl, concatNarration } from "./lib/voiceover";
import {
  characterCount,
  hasApiKey,
  providerFor,
  PROVIDERS,
  type LineFailure,
  type ProviderId,
  type SynthProgress,
  type VoicedLine,
  type VoiceOption,
} from "./lib/ttsProviders";
import {
  detectFfmpeg,
  importMedia,
  INTRO_CLIP_ID,
  MUSIC_BEDS,
  planTimeline,
  captionCues,
  renderRoughCut,
  VIDEO_EXTENSIONS,
  type AssembleResult,
  type FfmpegInfo,
  type ImportedMedia,
  type IntroSpec,
  type RenderProgress,
} from "./lib/assembly";
import { AUTH_GATE_ENABLED } from "./lib/authGate";
import { gateFor, letsAppRender, type Gate } from "./lib/entitlement";
import { GraceBanner, LoginGate } from "./components/LoginGate";
import "./App.css";

/**
 * Chosen by measurement rather than by being first alphabetically: af_kore
 * scored highest of the English-accent voices in the audition (74.6 against
 * af_heart's 58.2). See `src-tauri/src/voice_audition.rs`.
 */
const DEFAULT_VOICE = "af_kore";

/** The family captions are drawn in; loaded from the app's own resources. */
const CAPTION_FONT = "RFRS Caption";

/**
 * Turn anything thrown into something a person can read.
 *
 * Tauri rejects with a plain `{code, message}` object rather than an Error, so
 * a bare `String(err)` produces "[object Object]" — which is how a clear
 * "Add your OpenAI API key" message reached the UI as noise.
 */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: unknown; code?: unknown };
    if (typeof e.message === "string" && e.message) return e.message;
    if (typeof e.code === "string" && e.code) return e.code;
    try {
      return JSON.stringify(err);
    } catch {
      return "An unknown error occurred.";
    }
  }
  return String(err);
}

/** A project clip as the assembly layer wants it. */
function toClipSpec(c: ProjectClip) {
  return {
    id: c.id,
    description: c.segments[0]?.text ?? "",
    sourcePath: c.sourcePath ?? undefined,
    sourceDurationMs: c.sourceDurationMs ?? undefined,
    isPlaceholder: c.isPlaceholder,
    isHdr: c.isHdr,
    hasAudio: c.hasAudio,
  };
}

function App() {
  // --- shell ---------------------------------------------------------------
  const [stage, setStage] = useState<StageId>("footage");
  const [query, setQuery] = useState("");

  /** Sidebar destination, and which tab of the main column is showing. */
  // Home is intentionally empty for now, so the app opens on the library
  // rather than on a blank page.
  const [view, setView] = useState<LibraryView>("all");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  /** Which stage is showing inside a collection. */
  const [tab, setTab] = useState<StageId>("footage");

  // The library spans every project, so it is loaded separately from whichever
  // one is open.
  const [library, setLibrary] = useState<LibraryClip[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [userName, setUserName] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  /** What the last reorder did, and whether the file dates can be believed. */
  const [orderNote, setOrderNote] = useState<string | null>(null);

  /** What this machine has. Null until the first probe returns. */
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [hasElevenLabsKey, setHasElevenLabsKey] = useState(false);
  /** Only ever auto-opened once per launch; after that it is the user's call. */
  const nudged = useRef(false);
  /** Latest probe and requirements, for callbacks that must not close over stale ones. */
  const probeRef = useRef<Probe | null>(null);
  const requirementsRef = useRef({
    fastModel: OLLAMA_MODEL,
    qualityModel: OLLAMA_MODEL_QUALITY,
    hasOpenAiKey: false,
    hasElevenLabsKey: false,
  });
  /** The recorded lines joined end to end, for hearing the script whole. */
  const [fullNarration, setFullNarration] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  /** Kept generations, and which of each kind is loaded. */
  const [takes, setTakes] = useState<Take[]>([]);
  const [currentScriptTake, setCurrentScriptTake] = useState<string | null>(null);
  const [currentVoiceTake, setCurrentVoiceTake] = useState<string | null>(null);
  const [currentRenderTake, setCurrentRenderTake] = useState<string | null>(null);
  /** What just finished, so the app can say so instead of silently changing. */
  const [justDone, setJustDone] = useState<"script" | "voice" | null>(null);
  /** The Settings override, read once and passed to every composition. */
  const [instructions, setInstructions] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  // Running order is the default because it is the order the film is cut in:
  // the script is written to follow it and assembly reads it straight through.
  // Every other sort is a way of *looking* at the list, not a way of changing
  // what gets made.
  const [sortBy, setSortBy] = useState<
    "sequence" | "sequence-desc" | "added" | "name" | "duration" | "described"
  >("sequence");
  const [filterProject, setFilterProject] = useState<string>("");
  const [preview, setPreview] = useState<LibraryClip | null>(null);
  /** Clips awaiting a delete confirmation. */
  const [pendingDelete, setPendingDelete] = useState<{
    clips: LibraryClip[];
    /** Run once the removal has happened — the describer uses it to move on. */
    after?: () => void;
  } | null>(null);
  /** Clip whose timings are being edited; the table's one box cannot hold them. */
  const [splitting, setSplitting] = useState<string | null>(null);
  /**
   * Held in a ref because import runs above where the loader is defined, and
   * reordering them would put the loader above the state it reads.
   */
  const refreshLibraryRef = useRef<(() => Promise<void>) | null>(null);
  /** Latest manifest, for callbacks that must not close over a stale one. */
  const manifestRef = useRef<ProjectFile | null>(null);

  /**
   * What the current narration was recorded with, and what the current cut was
   * rendered from.
   *
   * Neither artifact carries its own inputs — audio does not know which voice
   * made it, and a rendered file does not know which audio went in — so the
   * inputs are stamped when each run succeeds. Without that, changing the voice
   * and re-opening the assembly stage would look perfectly up to date.
   */
  const [voiceStamp, setVoiceStamp] = useState<VoiceStamp | null>(null);
  const [renderedSig, setRenderedSig] = useState("");

  // --- project -------------------------------------------------------------
  const [manifest, setManifest] = useState<ProjectFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<ImportedMedia[]>([]);
  const [dirty, setDirty] = useState(false);

  /**
   * The sign-in gate.
   *
   * Every one of these is inert while `AUTH_GATE_ENABLED` is false, which is
   * the default and how every build ships today. The state lives here rather
   * than behind the flag so that turning the flag on is a one-line change
   * rather than a refactor — and so this code is compiled and type-checked
   * even while it is dark.
   */
  const [gateSession, setGateSession] = useState<{ email: string } | null>(null);
  const [gateCached, setGateCached] = useState<Parameters<typeof gateFor>[0]["cached"]>(null);
  const [gateLive, setGateLive] = useState<Parameters<typeof gateFor>[0]["live"]>({
    kind: "not-attempted",
  });
  const [gateWaiting, setGateWaiting] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);

  const gate: Gate = AUTH_GATE_ENABLED
    ? gateFor({ session: gateSession, cached: gateCached, live: gateLive, now: new Date() })
    // Not merely "allowed" — the flag being off means there is no gate at all,
    // and the app must render exactly as it did before this existed.
    : { state: "allowed" };
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // --- story (B) -----------------------------------------------------------
  const [ideas, setIdeas] = useState<StoryIdea[] | null>(null);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [ideaProgress, setIdeaProgress] = useState<IdeaProgress | null>(null);
  const [ideaError, setIdeaError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [wordCount, setWordCount] = useState(150);
  const [style, setStyle] = useState<ScriptStyle>("cinematic");
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
  const [critique, setCritique] = useState(true);
  const [scriptProvider, setScriptProvider] = useState<ScriptProviderId>("local");
  const [qualityTier, setQualityTier] = useState<QualityTier>("balanced");
  const [scriptUsage, setScriptUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    calls: number;
  } | null>(null);

  // --- script (C/D) --------------------------------------------------------
  const [lines, setLines] = useState<ScriptLineDraft[] | null>(null);
  const [words, setWords] = useState(0);
  // The opening: one written line, its recording, and whether to make one at
  // all. Kept beside the script rather than inside it because it belongs to no
  // moment — see `ScriptSection.hook`.
  const [hook, setHook] = useState<string | null>(null);
  const [hookAudio, setHookAudio] = useState<VoicedLine | null>(null);
  const [introEnabled, setIntroEnabled] = useState(true);
  const [hookBusy, setHookBusy] = useState(false);
  const [shortening, setShortening] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [composeProgress, setComposeProgress] = useState<ComposeProgress | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [pronunciations, setPronunciations] = useState<Record<string, string>>({});

  // --- voiceover -----------------------------------------------------------
  const [providerId, setProviderId] = useState<ProviderId>("local");
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [failures, setFailures] = useState<LineFailure[]>([]);
  const [voiced, setVoiced] = useState<VoicedLine[] | null>(null);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [ttsProgress, setTtsProgress] = useState<SynthProgress | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [resynthesizing, setResynthesizing] = useState<string | null>(null);

  /**
   * Re-record only the lines whose audio no longer matches.
   *
   * The alternative is re-recording everything, which for a cloud voice bills
   * again for lines that were never touched.
   */
  async function onRerecordStale() {
    if (!lines || !projectId || !voiced) return;
    const stamp: VoiceStamp = { providerId, voiceId: voice, language, pronunciations };
    const changed = voiceStamp !== null && !voiceStampEquals(voiceStamp, stamp);
    const stale = staleLineKeys(lines, voiced, changed);
    const missing = unrecordedLineKeys(lines, voiced);
    const targets = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => {
        const key = `${l.clipId}#${l.segmentIndex}`;
        return stale.has(key) || missing.has(key);
      });
    // The opening is not one of the numbered lines, so it has to be asked
    // about separately — and it is exactly what someone means by "record what
    // changed" after rewriting it.
    if (targets.length === 0 && !introPending) return;

    setTtsBusy(true);
    setTtsError(null);
    try {
      const redone: VoicedLine[] = [];
      for (const { l, i } of targets) {
        redone.push(
          await provider.synthesizeLine(
            { clipId: l.clipId, segmentIndex: l.segmentIndex, text: l.text },
            i + 1,
            { voiceId: voice, projectId, language, pronunciations },
          ),
        );
      }
      setVoiced((cur) => {
        const replaced = new Set(redone.map((v) => `${v.clipId}#${v.segmentIndex}`));
        const kept = (cur ?? []).filter(
          (v) => !replaced.has(`${v.clipId}#${v.segmentIndex}`),
        );
        const rank = new Map(lines.map((l, i) => [`${l.clipId}#${l.segmentIndex}`, i]));
        return [...kept, ...redone].sort(
          (a, b) =>
            (rank.get(`${a.clipId}#${a.segmentIndex}`) ?? 0) -
            (rank.get(`${b.clipId}#${b.segmentIndex}`) ?? 0),
        );
      });
      if (introPending && hook) await recordHook(hook);
      // Everything now matches the current voice, so the stamp moves with it.
      setVoiceStamp(stamp);
      setAssembly(null);
      setDirty(true);
    } catch (err) {
      setTtsError(errorText(err));
    } finally {
      setTtsBusy(false);
    }
  }

  // --- assembly ------------------------------------------------------------
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null>(null);
  const [assembly, setAssembly] = useState<AssembleResult | null>(null);
  const [assemblyBusy, setAssemblyBusy] = useState(false);
  const [renderProgress, setRenderProgress] = useState<RenderProgress | null>(null);
  const [assemblyError, setAssemblyError] = useState<string | null>(null);
  // Kept as the render's defaults; the timeline overrides both per boundary
  // and per track, and is where a user actually sets them now.
  const [crossfadeMs] = useState(0);
  const [timelineDoc, setTimelineDoc] = useState<TimelineDoc>(DEFAULT_TIMELINE);
  const [planned, setPlanned] = useState<PlannedShot[]>([]);
  /** The music track as a URL the viewer can play. */
  const [musicUrl, setMusicUrl] = useState<string | null>(null);

  const projectId = manifest?.project.id ?? null;

  // --- the opening ---------------------------------------------------------
  //
  // Derived rather than stored: which shots the montage uses depends on the
  // hook's length, on what the story already shows and on which clip the film
  // opens on, all of which move while the user works. Recomputing means the
  // opening cannot quietly describe a version of the project that no longer
  // exists.
  const introShots = useMemo(() => {
    if (!introEnabled || !hookAudio || !manifest) return [];
    const candidates: ShotCandidate[] = manifest.clips.flatMap((c) =>
      c.segments.map((s, i) => ({
        clipId: c.id,
        segmentIndex: i,
        startMs: Math.round(s.startSec * 1000),
        endMs: Math.round(s.endSec * 1000),
        sourcePath: c.sourcePath,
      })),
    );
    // The montage runs the hook's length *plus* the dissolve. The dissolve
    // overlaps the montage with the first narrated line, so a montage cut to
    // the hook exactly had its last words fading out under the film — the
    // opening was heard cut off half way through. The extra is picture with
    // no speech over it, which is precisely what a dissolve should consume.
    return pickShots(hookAudio.durationMs + INTRO_FADE_MS, candidates, {
      storyClipIds: (lines ?? []).map((l) => l.clipId),
      firstLineClipId: lines?.[0]?.clipId ?? null,
    });
  }, [introEnabled, hookAudio, manifest, lines]);

  const introSpec: IntroSpec | null = useMemo(() => {
    if (!hookAudio || introShots.length === 0) return null;
    const hdr = new Map(manifest?.clips.map((c) => [c.id, c.isHdr]) ?? []);
    return {
      shots: introShots.map((s) => ({
        sourcePath: s.sourcePath,
        sourceInMs: s.sourceInMs,
        durationMs: s.durationMs,
        isHdr: hdr.get(s.clipId) ?? false,
      })),
      audioPath: hookAudio.audioPath,
      fadeMs: INTRO_FADE_MS,
      // What the recording actually says, not what the editor now shows: the
      // caption has to match the audio in the file being rendered.
      text: hookAudio.text,
    };
  }, [introShots, hookAudio, manifest]);

  /**
   * What the timeline contributes to the cut's identity.
   *
   * Every edit changes the film, so every edit has to make an existing render
   * stale — otherwise dropping a shot leaves the app showing a video that
   * still contains it.
   */
  const timelineSig = JSON.stringify([
    timelineDoc.order,
    timelineDoc.edits,
    timelineDoc.originalAudio,
    timelineDoc.music,
    timelineDoc.subtitles,
  ]);

  /** What the cut's opening was made from, for the staleness check. */
  const introSignature = introSpec
    ? `${introSpec.audioPath}:${hookAudio?.durationMs ?? 0}|` +
      introShots.map((s) => `${s.clipId}#${s.segmentIndex}@${s.sourceInMs}+${s.durationMs}`).join(",")
    : "";

  /**
   * Lines saying more than the clip they are spoken over can carry.
   *
   * Recomputed from the current text rather than stamped at generation, so an
   * edit shows up as you make it — which is the whole point, since generation
   * already fits its own drafts and this exists for what happens afterwards.
   */
  const overBudget = useMemo(() => {
    const out = new Map<string, { budget: number; used: number }>();
    if (!manifest || !lines) return out;
    const selected = candidatesOf(
      manifest.clips.map((c) => ({
        id: c.id,
        durationMs: c.sourceDurationMs,
        segments: c.segments,
      })),
    );
    for (const o of overBudgetLines(lines, selected, languageFor(language))) {
      const l = lines[o.index];
      out.set(`${l.clipId}#${l.segmentIndex}`, { budget: o.budget, used: o.used });
    }
    return out;
  }, [manifest, lines, language]);

  /** The recording no longer says what the written hook says. */
  const hookStale =
    hookAudio !== null && hook !== null && hookAudio.text.trim() !== hook.trim();

  /**
   * There is an opening the film cannot currently open with.
   *
   * Never spoken, or spoken with different words. Both mean the same thing to
   * everything downstream: a render now would either drop the montage or open
   * on a line nobody is saying.
   */
  const introPending = introEnabled && hook !== null && (hookAudio === null || hookStale);

  const introProps = {
    enabled: introEnabled,
    hook,
    audio: hookAudio,
    stale: hookStale,
    busy: hookBusy,
    shots: introShots.length,
    language,
    onEdit: onEditHook,
    onRegenerate: () => void onRegenerateHook(),
    onRecord: () => void onRecordHook(),
  };

  /**
   * The language the narration will actually be spoken in.
   *
   * Read from the script itself where there is a script to read, because the
   * stored code is separate state and has been wrong: it did not survive a
   * save, so a Bengali project reopened as English — the one language the
   * local voice does support — and the guard below never fired. Kokoro then
   * read Bengali through an English phoneme lexicon, which makes sound and not
   * speech. The captions were moved onto the text for the same reason.
   */
  const spokenLanguage = useMemo(
    () => detectLanguage((lines ?? []).map((l) => l.text).join(" ")) ?? language,
    [lines, language],
  );
  const scriptLanguage = languageFor(spokenLanguage);

  // Kokoro plus an English lexicon is English-only. Rather than let someone
  // reach a silent failure, the provider moves and the reason is stated.
  useEffect(() => {
    if (!scriptLanguage.localVoiceSupported && providerId === "local") {
      setProviderId("elevenlabs");
    }
  }, [scriptLanguage, providerId]);

  const provider = providerFor(providerId);

  const loadVoices = useCallback(() => {
    setVoicesError(null);
    providerFor(providerId)
      .listVoices()
      .then((list) => {
        setVoices(list);
        // Keep the current voice if this provider offers it; otherwise fall to
        // the first recommended one, then to whatever exists.
        setVoice((cur) => {
          if (list.some((v) => v.id === cur)) return cur;
          return list.find((v) => v.recommended)?.id ?? list[0]?.id ?? "";
        });
      })
      .catch((err) => {
        setVoices([]);
        setVoicesError(errorText(err));
      });
  }, [providerId]);

  useEffect(() => {
    loadVoices();
  }, [loadVoices]);

  useEffect(() => {
    void detectFfmpeg().then(setFfmpeg);
  }, []);

  // --- project lifecycle ---------------------------------------------------

  function resetVideoState() {
    setIdeas(null);
    setTitle("");
    setLines(null);
    setTimelineDoc(DEFAULT_TIMELINE);
    setHook(null);
    setHookAudio(null);
    setVoiced(null);
    setAssembly(null);
    setPronunciations({});
  }

  async function onCreate(name: string) {
    setBusy(true);
    setError(null);
    try {
      const created = await createProject(name);
      setManifest(created);
      setSplitting(null);
      resetVideoState();
      setDirty(false);
      // The sidebar reads the project list, so a new collection has to be
      // announced or it will not appear until something else refreshes.
      await refreshLibraryRef.current?.();
      // A new collection is empty; opening it lands where footage is added.
      setView("project");
      setTab("footage");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function onOpen(id: string) {
    setBusy(true);
    setError(null);
    try {
      const opened = await openProject(id);
      setManifest(opened);
      setSplitting(null);
      resetVideoState();
      // Reopen the most recent video, so a saved script survives a restart.
      const last = opened.videos[opened.videos.length - 1];
      if (last) {
        setTitle(last.title);
        setPronunciations(last.pronunciations ?? {});
        if (last.script) {
          setLines(last.script.lines.map((l) => ({ ...l })));
          setWords(last.script.lines.reduce((n, l) => n + l.text.split(/\s+/).length, 0));
          if (last.script.wordCountTarget) setWordCount(last.script.wordCountTarget);
          // The words survive a restart; the recording of them does not, the
          // same as every other line.
          setHook(last.script.hook ?? null);
        }
        setTimelineDoc({ ...DEFAULT_TIMELINE, ...(last.timelineDoc ?? {}) });
        // The script's language decides how captions wrap and which font can
        // draw them, so a Bengali project must not reopen as English.
        if (last.language) setLanguage(last.language);
      }
      setDirty(false);

      // Everything imported before recording times existed carries none, which
      // is the whole existing library. Read them out of the files in the
      // background so the dates fill in rather than staying blank forever.
      void backfillCaptureTimes(id).then(async (filled) => {
        if (filled > 0) {
          setManifest(await openProject(id));
          await refreshLibraryRef.current?.();
        }
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  /** Fold the working video state back into the manifest before persisting. */
  const withVideoState = useCallback(
    (m: ProjectFile): ProjectFile => {
      if (!title && !lines) return m;
      const id = "video-1";
      const now = new Date().toISOString();
      const existing = m.videos.find((v) => v.id === id);
      const video = {
        id,
        title: title || "Untitled video",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        selection: (lines ?? []).map((l) => ({
          clipId: l.clipId,
          segmentIndex: l.segmentIndex,
        })),
        script: lines
          ? {
              model: OLLAMA_MODEL,
              generatedAt: now,
              lines: lines.map((l) => ({ ...l, edited: true })),
              wordCountTarget: wordCount,
              hook,
            }
          : (existing?.script ?? null),
        audio: voiced
          ? {
              voice,
              sampleRate: 24000,
              lines: voiced.map((v) => ({
                clipId: v.clipId,
                segmentIndex: v.segmentIndex,
                path: v.audioPath,
                durationMs: v.durationMs,
                skippedWords: v.skipped,
              })),
            }
          : (existing?.audio ?? null),
        timeline: existing?.timeline ?? [],
        // The edits, not the resolved cut: timings are recomputed from the
        // narration every time, so storing them would only create a second
        // copy free to disagree with the first.
        timelineDoc,
        language,
        render: existing?.render ?? null,
        pronunciations,
      };
      return {
        ...m,
        videos: existing
          ? m.videos.map((v) => (v.id === id ? video : v))
          : [...m.videos, video],
      };
    },
    [title, lines, wordCount, hook, voiced, voice, pronunciations, timelineDoc, language],
  );


  /**
   * Sign in, sign out, and re-check.
   *
   * Reachable only when the gate is on. Errors are shown in the gate's own
   * words rather than swallowed: every state on that screen is a dead end
   * unless it tells the person what happened.
   */
  async function onGateSignIn() {
    setGateError(null);
    setGateWaiting(true);
    try {
      const who = await invoke<{ email: string; userId: string }>("auth_sign_in");
      setGateSession({ email: who.email });
      // Signed in, but entitlement is a separate question and is asked next.
      setGateLive({ kind: "not-attempted" });
      await onGateRecheck();
    } catch (err) {
      setGateError(errorText(err));
    } finally {
      setGateWaiting(false);
    }
  }

  function onGateCancel() {
    setGateWaiting(false);
    setGateError(null);
  }

  async function onGateSignOut() {
    try {
      await invoke("auth_sign_out");
    } catch {
      // Nothing useful to say: the session is being abandoned either way.
    }
    setGateSession(null);
    setGateCached(null);
    setGateLive({ kind: "not-attempted" });
    setGateError(null);
  }

  /**
   * Ask the platform whether this account is entitled.
   *
   * Not yet wired to a licence endpoint — that is the half still waiting on
   * the backend. Until it exists this reports `unreachable`, which is the
   * honest answer and, deliberately, the one that leans on the cache rather
   * than locking anybody out.
   */
  async function onGateRecheck() {
    setGateError(null);
    setGateLive({ kind: "unreachable" });
  }

  const onSave = useCallback(async () => {
    if (!manifest) return;
    setBusy(true);
    setError(null);
    try {
      const merged = withVideoState(manifest);
      await saveProject(merged);
      setManifest(merged);
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, [manifest, withVideoState]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void onSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave]);

  // --- import --------------------------------------------------------------

  const runImport = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || !projectId) return;
      // ffmpeg is needed to import, not only to render: thumbnails and
      // durations both come from it. Refusing here with a reason beats the raw
      // FFMPEG_NOT_FOUND that used to surface from the command layer.
      if (probeRef.current && !isUsable(capabilitiesOf(probeRef.current, requirementsRef.current))) {
        setError(
          "ffmpeg is needed to import clips — it makes the thumbnails and reads " +
            "how long each one is. Open Setup in the sidebar to install it.",
        );
        setView("readiness");
        return;
      }
      setImporting(true);
      setError(null);
      try {
        const results = await importMedia(paths, projectId);
        setRejected(results.filter((r) => r.verdict === "rejected"));
        const usable = results.filter((r) => r.verdict !== "rejected");

        const current = manifestRef.current;
        if (!current || usable.length === 0) return;

        // Grown as the batch is walked, not just seeded from the manifest: the
        // same file picked twice in one import used to pass this filter twice,
        // because the set never learned about the first copy.
        const seen = new Set(current.clips.map((c) => c.sourcePath));
        // One stamp for the whole batch: an import is a single act, and the
        // order inside it is the order they were sorted into, not the order
        // the loop happened to reach them in.
        const importedAt = new Date().toISOString();
        const added: ProjectClip[] = usable
          .filter((r) => !seen.has(r.sourcePath) && seen.add(r.sourcePath) !== null)
          .map((r) => ({
            id: crypto.randomUUID(),
            sourcePath: r.sourcePath,
            sha256: null,
            sourceDurationMs: r.info?.durationMs ?? null,
            isPlaceholder: false,
            fileName: r.fileName,
            thumbnailPath: r.thumbnailPath,
            isHdr: r.info?.isHdr ?? false,
            width: r.info?.width ?? null,
            height: r.info?.height ?? null,
            codec: r.info?.codec ?? null,
            hasAudio: r.info?.hasAudio ?? false,
            capturedAtMs: r.info?.createdAtMs ?? null,
            // One stamp for the batch, so a single import is one moment and
            // the files inside it keep the order they were sorted into.
            importedAt: importedAt,
            favorite: false,
            deletedAt: null,
            segments: [],
          }));
        if (added.length === 0) return;

        // In the order they were shot, not the order the picker handed them
        // over. macOS returns a Finder selection in whatever the window was
        // sorted by — routinely newest first — and the running order decides
        // both what the script narrates and how the cut is assembled, so
        // importing a trip newest-first builds a film that runs backwards.
        //
        // Sorted as a batch rather than pairwise: whether these files are one
        // camera's numbered run is a fact about the set, not about any two of
        // them, and it is the fact that decides which signal to trust.
        const ordered = sortByShootingOrder(added);
        setOrderNote(describeOrdering(added));

        const next = { ...current, clips: [...current.clips, ...ordered] };
        setManifest(next);

        // Written straight away rather than left dirty. Importing already put
        // thumbnails in the project folder, and the sidebar's clip counts come
        // from disk — leaving this unsaved meant the table showed footage the
        // collection beside it still counted as zero.
        await saveProject(next);
        setDirty(false);
        setSavedAt(new Date().toLocaleTimeString());
        await refreshLibraryRef.current?.();
      } catch (err) {
        setError(errorText(err));
      } finally {
        setImporting(false);
      }
    },
    [projectId],
  );

  async function pickFiles(): Promise<string[]> {
    const picked = await openDialog({
      title: "Add clips",
      multiple: true,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  }

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") void runImport(event.payload.paths);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [runImport]);

  const onChangeSegments = useCallback((clipId: string, segments: Segment[]) => {
    setManifest((m) =>
      m ? { ...m, clips: m.clips.map((c) => (c.id === clipId ? { ...c, segments } : c)) } : m,
    );
    setDirty(true);
  }, []);

  // --- stage B -------------------------------------------------------------

  async function onSuggestIdeas() {
    if (!manifest) return;
    setIdeasBusy(true);
    setIdeaError(null);
    setIdeaProgress(null);
    try {
      setIdeas(await suggestStoryIdeas(manifest.clips, { onProgress: setIdeaProgress }));
    } catch (err) {
      setIdeaError(errorText(err));
    } finally {
      setIdeasBusy(false);
      setIdeaProgress(null);
    }
  }

  // --- stage C -------------------------------------------------------------

  async function onGenerateScript() {
    if (!manifest || !title) return;
    setComposing(true);
    setComposeError(null);
    setComposeProgress(null);
    try {
      const draft = await generateScriptForTitle(manifest.clips, {
        title,
        wordCount,
        style,
        language,
        critique,
        hook: introEnabled,
        provider: scriptProvider,
        qualityTier,
        instructions: instructions ?? undefined,
        onProgress: setComposeProgress,
      });
      setLines(draft.lines);
      setWords(draft.words);
      setScriptUsage(draft.usage ?? null);
      setHook(draft.hook ?? null);
      // A new script invalidates the audio and the cut made from the old one.
      setVoiced(null);
      setHookAudio(null);
      setAssembly(null);
      setDirty(true);

      // Kept before anything can overwrite it, so regenerating compares rather
      // than replaces.
      const take = scriptTake(
        draft.lines,
        `${scriptLanguage.label} · ${style} · ${SCRIPT_PROVIDERS[scriptProvider].label}`,
      );
      setTakes(await addTake(manifest.project.id, take));
      setCurrentScriptTake(take.id);

      // Writing finishes while the user is looking at the Story screen, and
      // the result is somewhere else. Say it worked, and go there.
      setJustDone("script");
      setStage("script");
      setTab("script");

      // Writing finishes on a screen the user is not looking at the result on.
      // Say it worked, and go to it.
      setJustDone("script");
      setStage("script");
      setTab("script");
    } catch (err) {
      setComposeError(errorText(err));
    } finally {
      setComposing(false);
      setComposeProgress(null);
    }
  }

  function onEditLine(index: number, text: string) {
    setLines((ls) => {
      if (!ls) return ls;
      const next = ls.map((l, i) => (i === index ? { ...l, text } : l));
      setWords(next.reduce((n, l) => n + l.text.trim().split(/\s+/).filter(Boolean).length, 0));
      return next;
    });
    setDirty(true);
  }

  /**
   * Write a new opening line and nothing else.
   *
   * The first thing anyone hears, and short enough that trying three costs
   * seconds — but only if trying one does not also rewrite the narration
   * underneath it.
   */
  async function onRegenerateHook() {
    if (!manifest || !lines || !title) return;
    setHookBusy(true);
    setComposeError(null);
    try {
      const written = await generateHookForScript(
        {
          title,
          moments: manifest.clips.flatMap((c) => c.segments.map((s) => s.text)),
          lines: lines.map((l) => l.text),
        },
        { language, style, provider: scriptProvider, qualityTier },
      );
      if (written) {
        setHook(written);
        // The old recording says the old words.
        setHookAudio(null);
        setDirty(true);
      } else {
        setComposeError(
          "The model didn't return an opening line of a usable length. Try again.",
        );
      }
    } catch (err) {
      setComposeError(errorText(err));
    } finally {
      setHookBusy(false);
    }
  }

  /** Rewrite one line so it fits its clip, on request rather than silently. */
  async function onShortenLine(index: number, budget: number) {
    if (!lines) return;
    const line = lines[index];
    if (!line) return;
    const key = `${line.clipId}#${line.segmentIndex}`;
    setShortening(key);
    setComposeError(null);
    try {
      const shorter = await shortenLineToFit(line.text, budget, language, {
        provider: scriptProvider,
        qualityTier,
        instructions: instructions ?? undefined,
      });
      if (shorter) {
        onEditLine(index, shorter);
      } else {
        setComposeError(
          "The model couldn't make that line shorter without losing what it says. Try editing it by hand.",
        );
      }
    } catch (err) {
      setComposeError(errorText(err));
    } finally {
      setShortening(null);
    }
  }

  function onEditHook(text: string) {
    setHook(text);
    setDirty(true);
  }

  /**
   * Speak the opening line.
   *
   * The same provider, voice and pronunciations as the rest, through the
   * single-line path — so a hook rewritten twice does not re-record the film.
   * Line number 0 keeps it out of the way of the numbered lines, which start
   * at 1.
   */
  const recordHook = useCallback(
    async (text: string): Promise<VoicedLine | null> => {
      if (!projectId || !text.trim()) return null;
      const spoken = await provider.synthesizeLine(
        { clipId: INTRO_CLIP_ID, segmentIndex: 0, text },
        0,
        { voiceId: voice, projectId, language, pronunciations },
      );
      setHookAudio(spoken);
      return spoken;
    },
    [projectId, provider, voice, language, pronunciations],
  );

  async function onRecordHook() {
    if (!hook) return;
    setHookBusy(true);
    setTtsError(null);
    try {
      await recordHook(hook);
      setAssembly(null);
      setDirty(true);
    } catch (err) {
      setTtsError(errorText(err));
    } finally {
      setHookBusy(false);
    }
  }

  // --- voiceover + stage D -------------------------------------------------

  async function onGenerateVoiceover() {
    if (!lines || !projectId) return;
    setTtsBusy(true);
    setTtsError(null);
    setFailures([]);
    setTtsProgress({ done: 0, total: lines.length, clipId: "" });
    try {
      const result = await provider.synthesize(lines, {
        voiceId: voice,
        projectId,
        language,
        pronunciations,
        onProgress: setTtsProgress,
      });
      // Keep whatever succeeded. With a cloud provider those lines are already
      // billed, and discarding them would charge for them twice.
      setVoiced(result.lines.length > 0 ? result.lines : null);
      setVoiceStamp({ providerId, voiceId: voice, language, pronunciations });
      setFullNarration(null);

      // The opening, in the same voice, as part of the same run. Its own
      // failure: no opening is a film that starts on its first line, and
      // throwing here would discard narration that is already recorded and,
      // on a cloud voice, already billed.
      if (introEnabled && hook) {
        try {
          await recordHook(hook);
        } catch (err) {
          setTtsError(
            `The narration recorded, but the opening line did not: ${errorText(err)}`,
          );
          setHookAudio(null);
        }
      }
      if (result.lines.length > 0 && projectId) {
        const take = voiceTake(
          result.lines,
          `${PROVIDERS[providerId].label} · ${voice} · ${scriptLanguage.label}`,
        );
        setTakes(await addTake(projectId, take));
        setCurrentVoiceTake(take.id);
        setJustDone("voice");
      }
      setFailures(result.failures);
      setAssembly(null);
      setDirty(true);
    } catch (err) {
      setTtsError(errorText(err));
      setVoiced(null);
    } finally {
      setTtsBusy(false);
      setTtsProgress(null);
    }
  }

  /** Retry only the lines that failed, rather than re-billing the whole script. */
  async function onRetryFailed() {
    if (!lines || !projectId || failures.length === 0) return;
    setTtsBusy(true);
    setTtsError(null);
    const stillFailing: LineFailure[] = [];
    const recovered: VoicedLine[] = [];
    for (const f of failures) {
      const line = lines[f.lineNumber - 1];
      if (!line) continue;
      try {
        recovered.push(
          await provider.synthesizeLine(
            { clipId: line.clipId, segmentIndex: line.segmentIndex, text: line.text },
            f.lineNumber,
            { voiceId: voice, projectId, language, pronunciations },
          ),
        );
      } catch (err) {
        stillFailing.push({
          ...f,
          message: errorText(err),
        });
      }
    }
    setVoiced((cur) => {
      const merged = [...(cur ?? []), ...recovered];
      // Keep script order rather than completion order.
      const rank = new Map(lines.map((l, i) => [`${l.clipId}#${l.segmentIndex}`, i]));
      return merged.sort(
        (a, b) =>
          (rank.get(`${a.clipId}#${a.segmentIndex}`) ?? 0) -
          (rank.get(`${b.clipId}#${b.segmentIndex}`) ?? 0),
      );
    });
    setFailures(stillFailing);
    setTtsBusy(false);
    setDirty(true);
  }

  /**
   * Audition the voice on this project's own words.
   *
   * The built-in sample sentence is English, so previewing a Bengali project
   * used to play English in a voice chosen to read Bengali — which tells the
   * user nothing about the thing they are about to pay to generate. The first
   * script line is the honest sample; the sentence remains the fallback for
   * auditioning before a script exists.
   */
  async function onPreview() {
    setPreviewing(true);
    setTtsError(null);
    try {
      const sample = await provider.preview(voice, lines?.[0]?.text, spokenLanguage);
      await new Audio(audioUrl(sample.audioPath)).play();
    } catch (err) {
      setTtsError(errorText(err));
    } finally {
      setPreviewing(false);
    }
  }

  /**
   * Record one line on demand, before committing to the whole script.
   *
   * Checking a voice or a pronunciation should not cost a full run — which for
   * a cloud provider is billed, and for either is the difference between
   * seconds and minutes.
   */
  async function onHearLine(index: number) {
    if (!lines || !projectId) return;
    const line = lines[index];
    if (!line) return;
    const key = `${line.clipId}#${line.segmentIndex}`;
    setResynthesizing(key);
    setTtsError(null);
    try {
      const one = await provider.synthesizeLine(
        { clipId: line.clipId, segmentIndex: line.segmentIndex, text: line.text },
        index + 1,
        { voiceId: voice, projectId, language, pronunciations },
      );
      setVoiced((cur) => {
        const rest = (cur ?? []).filter(
          (v) => `${v.clipId}#${v.segmentIndex}` !== key,
        );
        const merged = [...rest, one];
        // Script order, so a line heard early does not jump to the end.
        const rank = new Map(lines.map((l, i) => [`${l.clipId}#${l.segmentIndex}`, i]));
        return merged.sort(
          (a, b) =>
            (rank.get(`${a.clipId}#${a.segmentIndex}`) ?? 0) -
            (rank.get(`${b.clipId}#${b.segmentIndex}`) ?? 0),
        );
      });
      // A single new line invalidates any cut built from the old audio.
      setAssembly(null);
      setDirty(true);
      await new Audio(audioUrl(one.audioPath) + `?t=${Date.now()}`).play();
    } catch (err) {
      setTtsError(errorText(err));
    } finally {
      setResynthesizing(null);
    }
  }

  /** Record a correction and re-record only the lines that contained the word. */
  async function onCorrectWord(word: string, respelling: string) {
    if (!voiced || !projectId) return;
    const next = { ...pronunciations, [word.toLowerCase()]: respelling };
    setPronunciations(next);
    setDirty(true);

    const affected = voiced
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => v.skipped.some((s) => s.toLowerCase() === word.toLowerCase()));

    for (const { v, i } of affected) {
      const key = `${v.clipId}#${v.segmentIndex}`;
      setResynthesizing(key);
      try {
        const redone = await provider.synthesizeLine(
          { clipId: v.clipId, segmentIndex: v.segmentIndex, text: v.text },
          i + 1,
          { voiceId: voice, projectId, language, pronunciations: next },
        );
        setVoiced((cur) => (cur ? cur.map((x, j) => (j === i ? redone : x)) : cur));
        // Audio changed, so any existing cut is stale.
        setAssembly(null);
      } catch (err) {
        setTtsError(errorText(err));
      } finally {
        setResynthesizing(null);
      }
    }
  }

  /**
   * Ask Rust what the cut would be, so the timeline can lay itself out.
   *
   * Re-asked whenever the narration or the swaps change, because both decide
   * how long each shot is — and that arithmetic lives in one place on purpose.
   */
  useEffect(() => {
    if (!voiced || voiced.length === 0 || !manifest) {
      setPlanned([]);
      return;
    }
    let cancelled = false;
    const clipSpecs = manifest.clips.map(toClipSpec);
    const starts = new Map<string, number>();
    const swaps = new Map<string, string>();
    for (const v of voiced) {
      const key = `${v.clipId}#${v.segmentIndex}`;
      const edit = timelineDoc.edits[key];
      const seg = manifest.clips.find((c) => c.id === v.clipId)?.segments[v.segmentIndex];
      starts.set(key, edit?.sourceInMs ?? Math.round((seg?.startSec ?? 0) * 1000));
      if (edit?.sourceClipId) swaps.set(key, edit.sourceClipId);
    }
    void planTimeline(clipSpecs, voiced, { segmentStarts: starts, sourceClipIds: swaps })
      .then((items) => {
        if (cancelled) return;
        const byKey = new Map(voiced.map((v) => [`${v.clipId}#${v.segmentIndex}`, v]));
        setPlanned(
          items.map((i) => {
            const line = byKey.get(`${i.clipId}#${i.segmentIndex}`);
            return {
              clipId: i.clipId,
              segmentIndex: i.segmentIndex,
              durationMs: i.timelineDurationMs,
              sourceInMs: i.sourceInMs,
              text: line?.text ?? "",
              // Carried so the viewer can play the line rather than miming it.
              audioPath: line?.audioPath,
            };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setPlanned([]);
      });
    return () => {
      cancelled = true;
    };
  }, [voiced, manifest, timelineDoc.edits]);

  useEffect(() => {
    let cancelled = false;
    const { path, bedId } = timelineDoc.music;
    if (path) {
      setMusicUrl(audioUrl(path));
      return;
    }
    if (!bedId) {
      setMusicUrl(null);
      return;
    }
    void resolveResource(`resources/music/${bedId}.m4a`)
      .then((p) => {
        if (!cancelled) setMusicUrl(convertFileSrc(p));
      })
      .catch(() => {
        if (!cancelled) setMusicUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [timelineDoc.music.path, timelineDoc.music.bedId]);


  // --- assembly ------------------------------------------------------------

  async function onRender() {
    if (!voiced || !manifest) return;
    setAssemblyBusy(true);
    setAssemblyError(null);
    // Write the state that is about to be filmed, before filming it.
    //
    // Saving was manual, so the subtitle size, the music, the reordering and
    // every trim lived only in this tab until somebody pressed ⌘S. Rendering
    // then merged into a project file that had never heard of any of it, and
    // reopening the project brought back the defaults — which reads as "the
    // subtitles did not come out the way I set them", because the next render
    // used the defaults too. Rendering is a deliberate act; the settings that
    // produced a cut belong on disk with it.
    try {
      await onSave();
    } catch {
      // A failed save is not a reason to refuse to render. The cut is made
      // from what is on screen either way, and the error is already shown.
    }
    // Fixed up front: it names the output file, so the take and the mp4 it
    // owns cannot end up pointing at different things.
    const takeId = crypto.randomUUID();
    try {
      // Clip specs describe the media; segment offsets travel per line, so a
      // clip used twice at different moments gets two independent starts.
      const clipSpecs = manifest.clips.map(toClipSpec);
      // The timeline decides what is in the cut, in what order, from which
      // footage and where each shot starts. Anything it has no opinion about
      // falls back to the plan, which is what the edits are overrides on.
      const shots = applyEdits(planned, timelineDoc);
      const liveShots = shots.filter((sh) => sh.enabled);
      const rank = new Map(liveShots.map((sh, i) => [sh.key, i]));
      const inCut = voiced
        .filter((v) => rank.has(`${v.clipId}#${v.segmentIndex}`))
        .sort(
          (a, b) =>
            rank.get(`${a.clipId}#${a.segmentIndex}`)! -
            rank.get(`${b.clipId}#${b.segmentIndex}`)!,
        );
      if (inCut.length === 0) {
        setAssemblyError("Every shot is switched off in the timeline, so there is nothing to render.");
        setAssemblyBusy(false);
        return;
      }

      const segmentStarts = new Map<string, number>();
      const sourceClipIds = new Map<string, string>();
      for (const v of voiced) {
        const key = `${v.clipId}#${v.segmentIndex}`;
        const edit = timelineDoc.edits[key];
        const seg = manifest.clips.find((c) => c.id === v.clipId)?.segments[v.segmentIndex];
        const planStart = seg ? Math.round(seg.startSec * 1000) : 0;
        segmentStarts.set(key, edit?.sourceInMs ?? planStart);
        if (edit?.sourceClipId) sourceClipIds.set(key, edit.sourceClipId);
      }
      // Captions are drawn here, in the webview, because it is the only
      // renderer in this app that shapes Bengali correctly — ffmpeg's two text
      // tools both place ি and ে after their consonant. ffmpeg is handed
      // finished pictures instead.
      let captions: Awaited<ReturnType<typeof drawCaptionsFor>>["images"] = [];
      let captionBox: { width: number; height: number; blank: string } | null = null;
      if (timelineDoc.subtitles) {
        const cues = await captionCues(clipSpecs, inCut, {
          segmentStarts,
          sourceClipIds,
          intro: introSpec,
          introFadeMs: INTRO_FADE_MS,
        });
        const drawn = await drawCaptionsFor(cues);
        captions = drawn.images;
        if (drawn.images.length > 0) {
          captionBox = {
            ...drawn.box,
            blank: blankCaption(drawn.box.width, drawn.box.height),
          };
        }
      }

      const result = await renderRoughCut(clipSpecs, inCut, {
        projectId: manifest.project.id,
        projectName: manifest.project.name,
        model: OLLAMA_MODEL,
        voice,
        createdAt: manifest.project.createdAt,
        videoId: "video-1",
        takeId,
        videoTitle: title,
        segmentStarts,
        sourceClipIds,
        crossfadeMs,
        musicId: timelineDoc.music.enabled ? timelineDoc.music.bedId : null,
        musicPath: timelineDoc.music.enabled ? timelineDoc.music.path : null,
        musicGain: timelineDoc.music.gain,
        transitions: transitionsFor(shots),
        sourceAudioGain: timelineDoc.originalAudio.enabled
          ? timelineDoc.originalAudio.gain
          : 0,
        soundGains: soundGains(shots, timelineDoc.originalAudio),
        language: spokenLanguage,
        captions,
        captionBox: captionBox ?? undefined,
        subtitleStyle: {
          size: timelineDoc.subtitleStyle.size,
          bottom: timelineDoc.subtitleStyle.bottom,
          // Still ASS order on the wire: the renderer converts, and one
          // conversion in one place beats two that can disagree.
          colour: toAssColour(timelineDoc.subtitleStyle.colour),
          boxBehind: timelineDoc.subtitleStyle.boxBehind,
          font: "",
        },
        intro: introSpec,
        subtitles: timelineDoc.subtitles,
        onProgress: setRenderProgress,
      });
      setAssembly(result);
      // Both are partial failures: the cut exists, one thing it was asked for
      // is missing. Saying so beats a video that quietly lacks what you ticked.
      const missed = [result.introError && `without its opening: ${result.introError}`,
                      result.subtitleError]
        .filter(Boolean)
        .join(" · ");
      if (missed) setAssemblyError(`The cut rendered, but ${missed}`);
      // Stamp what this cut was made from, so a later edit can be seen.
      setRenderedSig(renderSignature(inCut, crossfadeMs, null, introSignature, timelineSig));

      const take = renderTake(
        takeId,
        result.videoPath,
        result.durationMs,
        // What this take is, in the terms the timeline set it: how many shots
        // survived, what was under them, and whether it carries captions.
        [
          `${liveShots.length} shot${liveShots.length === 1 ? "" : "s"}`,
          timelineDoc.music.enabled && timelineDoc.music.label
            ? timelineDoc.music.label
            : "no music",
          timelineDoc.originalAudio.enabled ? "clip sound on" : null,
          timelineDoc.subtitles ? "subtitles" : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      setTakes(await addTake(manifest.project.id, take));
      setCurrentRenderTake(takeId);
    } catch (err) {
      setAssemblyError(errorText(err));
      setAssembly(null);
    } finally {
      setAssemblyBusy(false);
      setRenderProgress(null);
    }
  }

  /**
   * Draw every caption in the webview and hand back the pictures.
   *
   * The fonts are the ones bundled with the app rather than whatever the
   * machine has, so a Mac with no Bengali font installed does not quietly draw
   * boxes.
   */
  async function drawCaptionsFor(cues: { startMs: number; endMs: number; text: string }[]) {
    if (cues.length === 0) return { images: [], box: { width: 0, height: 0 } };
    try {
      const urls = await Promise.all(
        CAPTION_FACES.map(async (f) =>
          convertFileSrc(await resolveResource(`resources/fonts/${f}`)),
        ),
      );
      await loadCaptionFont(CAPTION_FONT, urls);
    } catch {
      // Falls back to the system stack, which still shapes correctly.
    }
    return drawCaptions(
      cues,
      {
        size: timelineDoc.subtitleStyle.size,
        colour: timelineDoc.subtitleStyle.colour,
        boxBehind: timelineDoc.subtitleStyle.boxBehind,
      },
      1920,
      1080,
      CAPTION_FONT,
    );
  }

  /** Pick a music file from disk for the timeline's music track. */
  async function onPickMusic() {
    try {
      const picked = await openDialog({
        multiple: false,
        title: "Choose a music track",
        filters: [{ name: "Audio", extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg"] }],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      // The webview has to be allowed to read it, the same as footage — this
      // is a file from wherever the user keeps their music.
      await allowMedia([path]);
      setTimelineDoc((d) => ({
        ...d,
        music: {
          ...d.music,
          path,
          bedId: null,
          label: path.split("/").pop() ?? "Music",
          enabled: true,
        },
      }));
      setDirty(true);
    } catch (err) {
      setError(errorText(err));
    }
  }

  /** Join the recorded lines so the script can be heard end to end. */
  async function onJoinNarration() {
    if (!voiced || !projectId) return;
    setJoining(true);
    setTtsError(null);
    try {
      setFullNarration(await concatNarration(projectId, voiced.map((v) => v.audioPath)));
    } catch (err) {
      setTtsError(errorText(err));
    } finally {
      setJoining(false);
    }
  }

  /**
   * Put the open collection's footage into the order these rows are in.
   *
   * Written straight to disk as well as to the manifest in memory. The order
   * decides what the script narrates and what the cut shows, so leaving it
   * only in memory would mean a drag survived until the next reload and no
   * further — and the user has no reason to think dragging needs saving.
   *
   * The list arrives in screen order, which is reversed when the table is
   * showing last-to-first; the file always stores first-to-last.
   */
  async function onReorder(rows: LibraryClip[]) {
    if (!manifest) return;
    const onScreen = sortBy === "sequence-desc" ? [...rows].reverse() : rows;
    const ids = onScreen.map((r) => r.clipId);

    // Reorder in memory the same way the Rust side does it, so the table moves
    // under the cursor rather than after a round trip.
    const rank = new Map(ids.map((id, i) => [id, i]));
    const named = manifest.clips
      .filter((c) => rank.has(c.id))
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    const rest = manifest.clips.filter((c) => !rank.has(c.id));
    setManifest({ ...manifest, clips: [...named, ...rest] });

    try {
      await reorderClips(manifest.project.id, ids);
      // A reordered library invalidates a cut assembled from the old order.
      setAssembly(null);
      await refreshLibraryRef.current?.();
    } catch (err) {
      setError(errorText(err));
    }
  }

  /**
   * Put the whole collection back into the order it was shot in.
   *
   * Offered rather than done behind the user's back: a collection somebody has
   * already dragged into shape must not rearrange itself, and the basis used
   * is reported because when the two signals disagree that is worth saying.
   */
  async function onSortByCapture() {
    if (!manifest) return;
    await applyOrder(sortByShootingOrder(manifest.clips), describeOrdering(manifest.clips));
  }

  /**
   * Put the collection in an order the user named, rather than one guessed at.
   *
   * Guessing is right at import, when there is no order yet and anything beats
   * whatever the file picker returned. It is wrong afterwards: by then they
   * have looked at the list and know which signal they trust.
   */
  async function onArrange(action: SortBasis | "auto" | "reverse") {
    if (!manifest) return;
    if (action === "auto") return onSortByCapture();
    if (action === "reverse") {
      const flipped = [...manifest.clips].reverse();
      return applyOrder(flipped, `Reversed the running order of ${flipped.length} clips.`);
    }
    const sorted = sortClipsBy(manifest.clips, action);
    const named = SORT_BASES.find((b) => b.id === action);
    const placed = sorted.filter((c) =>
      action === "shot-time" ? c.capturedAtMs != null : action === "import-time" ? c.importedAt : true,
    ).length;
    // Said plainly when the signal could not place everything, because the
    // clips it could not place are sitting at the end and that is not obvious.
    const note =
      placed === sorted.length
        ? `Ordered ${sorted.length} clips by ${named?.label.toLowerCase()}.`
        : `Ordered ${placed} of ${sorted.length} clips by ${named?.label.toLowerCase()}. ` +
          `The rest carry no ${action === "shot-time" ? "recording time" : "import time"} ` +
          `and are left at the end, in the order they were already in.`;
    await applyOrder(sorted, note);
  }

  /** Commit a new running order: on screen, on disk, and in the library. */
  async function applyOrder(sorted: ProjectClip[], note: string) {
    if (!manifest) return;
    setManifest({ ...manifest, clips: sorted });
    setOrderNote(note);
    try {
      await reorderClips(manifest.project.id, sorted.map((c) => c.id));
      setAssembly(null);
      await refreshLibraryRef.current?.();
    } catch (err) {
      setError(errorText(err));
    }
  }

  // --- library -------------------------------------------------------------

  const refreshLibrary = useCallback(async () => {
    setRefreshing(true);
    try {
      const [clips, list, usage] = await Promise.all([
        listLibrary(),
        listProjects(),
        storageUsage(),
      ]);
      setLibrary(clips);
      setProjects(list);
      setStorage(usage);

      // Footage lives outside the app folder, so the webview has to be told it
      // may read each file before any player can show it.
      await allowMedia(clips.map((c) => c.sourcePath));

      // A project deleted from disk — here or in Finder — must not stay open,
      // or the stages keep working on something that is no longer there.
      setManifest((m) => (m && !list.some((p) => p.id === m.project.id) ? null : m));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  /**
   * Ask the machine what it has.
   *
   * Cheap enough to run on demand: an ffmpeg lookup and one HTTP call to
   * localhost. Re-run after anything that could change the answer — an install,
   * a model pull, a key being saved — so the screen never has to be reopened
   * to be believed.
   */
  const checkReadiness = useCallback(async () => {
    setProbing(true);
    try {
      const [p, openai, eleven] = await Promise.all([
        invoke<Probe>("readiness_probe", { ollamaHost: OLLAMA_HOST }),
        hasApiKey("openai"),
        hasApiKey("elevenlabs"),
      ]);
      setProbe(p);
      setHasOpenAiKey(openai);
      setHasElevenLabsKey(eleven);
      probeRef.current = p;
      requirementsRef.current = {
        fastModel: OLLAMA_MODEL,
        qualityModel: OLLAMA_MODEL_QUALITY,
        hasOpenAiKey: openai,
        hasElevenLabsKey: eleven,
      };
    } catch (err) {
      setError(errorText(err));
    } finally {
      setProbing(false);
    }
  }, []);

  refreshLibraryRef.current = refreshLibrary;
  manifestRef.current = manifest;

  useEffect(() => {
    void refreshLibrary();
    void invoke<string>("machine_user").then(setUserName).catch(() => setUserName(""));
    void getWritingInstructions().then(setInstructions);
    void getIntroEnabled().then(setIntroEnabled);
    void checkReadiness();
  }, [refreshLibrary]);

  /**
   * Remove clips from the library.
   *
   * A hard removal, not the soft one the Trash view used to back — that view is
   * gone, and a delete that hides things with nowhere to look for them is worse
   * than one that says plainly what it does. What it destroys is the clip entry
   * and the descriptions written about it; the video file is referenced rather
   * than copied, so it stays exactly where it was and can be imported again.
   */
  async function onDeleteClips(clips: LibraryClip[]) {
    if (clips.length === 0) return;
    setError(null);
    try {
      const mine = manifest?.project.id;
      const here = clips.filter((c) => c.projectId === mine).map((c) => c.clipId);
      if (here.length > 0) {
        // The open collection is edited in memory and saved, so the copy on
        // screen and the copy on disk cannot disagree.
        setManifest((m) =>
          m ? { ...m, clips: m.clips.filter((c) => !here.includes(c.id)) } : m,
        );
        setDirty(true);
      }
      for (const c of clips.filter((c) => c.projectId !== mine)) {
        await purgeClip(c.projectId, c.clipId);
      }
      // A removed clip may have been in the script, the recording or the cut.
      if (here.length > 0) {
        setSplitting((cur) => (here.includes(cur ?? "") ? null : cur));
      }
      await refreshLibrary();
    } catch (err) {
      setError(errorText(err));
    }
  }

  // --- readiness ------------------------------------------------------------

  const caps = probe
    ? capabilitiesOf(probe, {
        fastModel: OLLAMA_MODEL,
        qualityModel: OLLAMA_MODEL_QUALITY,
        hasOpenAiKey,
        hasElevenLabsKey,
      })
    : [];
  const needsAttention = probe ? attentionCount(caps) : 0;
  const canImport = probe ? isUsable(caps) : true;

  // Opened once, on the first probe that finds something missing. Not on every
  // probe: a re-check that still shows a caveat should not throw the user back
  // to this screen while they are working.
  useEffect(() => {
    if (!probe || nudged.current) return;
    nudged.current = true;
    if (attentionCount(capabilitiesOf(probe, {
      fastModel: OLLAMA_MODEL,
      qualityModel: OLLAMA_MODEL_QUALITY,
      hasOpenAiKey,
      hasElevenLabsKey,
    })) > 0) {
      setView("readiness");
    }
  }, [probe, hasOpenAiKey, hasElevenLabsKey]);

  // --- render --------------------------------------------------------------

  // --- library table -------------------------------------------------------

  const q = query.trim().toLowerCase();

  // The Footage tab is the same table scoped to the open collection. One list
  // component rather than two: describing a clip is the same act whether you
  // arrived at it from the library or from inside a project, and a second
  // editor would be a second place for the two to disagree.
  /**
   * The library, with the open collection served from memory.
   *
   * `library` is read from disk. The open collection's clips live in the
   * manifest until they are saved, so a freshly imported clip existed in state
   * and not in the table — the import worked and looked like it had not. One
   * derived list rather than a mirror kept in step by hand: whichever copy is
   * newer is the one the table shows, by construction.
   */
  const liveLibrary = useMemo(() => {
    if (!manifest) return library;
    const others = library.filter((c) => c.projectId !== manifest.project.id);
    const mine: LibraryClip[] = manifest.clips.map((c, i) => ({
      projectId: manifest.project.id,
      projectName: manifest.project.name,
      clipId: c.id,
      fileName: c.fileName ?? c.sourcePath?.split("/").pop() ?? "Untitled clip",
      sourcePath: c.sourcePath,
      thumbnailPath: c.thumbnailPath,
      durationMs: c.sourceDurationMs,
      width: c.width ?? null,
      height: c.height ?? null,
      codec: c.codec ?? null,
      isPlaceholder: c.isPlaceholder,
      isHdr: c.isHdr,
      favorite: c.favorite ?? false,
      deletedAt: c.deletedAt ?? null,
      description: c.segments
        .map((sg) => sg.text.trim())
        .filter(Boolean)
        .join(". "),
      segmentCount: c.segments.length,
      segments: c.segments,
      addedAt: manifest.project.createdAt,
      capturedAtMs: c.capturedAtMs ?? null,
      // Position in the manifest is the running order, exactly as the Rust
      // side derives it — the open collection is served from memory, so the
      // index has to come from the same array either way.
      sequence: i,
    }));
    return [...others, ...mine];
  }, [library, manifest]);

  const onFootageTab = view === "project" && tab === "footage";
  const baseRows = onFootageTab
    ? liveLibrary.filter((c) => c.projectId === manifest?.project.id && !c.deletedAt)
    : liveLibrary
        .filter((c) => !c.deletedAt)
        .filter((c) => !filterProject || c.projectId === filterProject);

  const tableRows = baseRows
    .filter(
      (c) =>
        !q ||
        c.fileName.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.projectName.toLowerCase().includes(q),
    )
    .sort((a, b) => {
      switch (sortBy) {
        case "sequence":
        case "sequence-desc": {
          // Sequence is per project, so across collections group by project
          // first — "third" only means anything inside one of them.
          const byProject = a.projectName.localeCompare(b.projectName);
          if (byProject !== 0 && !onFootageTab) return byProject;
          return sortBy === "sequence"
            ? a.sequence - b.sequence
            : b.sequence - a.sequence;
        }
        case "name":
          return a.fileName.localeCompare(b.fileName);
        case "duration":
          return (b.durationMs ?? 0) - (a.durationMs ?? 0);
        case "described":
          // Undescribed first: this list exists so they can be dealt with.
          return Number(Boolean(a.description)) - Number(Boolean(b.description));
        default:
          return b.addedAt.localeCompare(a.addedAt);
      }
    });

  /**
   * Reordering is only offered where the order means something: one
   * collection, shown in its running order.
   *
   * And it turns pagination off. Dragging clip four to position forty is the
   * whole point of dragging, and no page size makes both ends visible — a
   * paged reorder can only ever shuffle within a window.
   */
  const reordering =
    onFootageTab && (sortBy === "sequence" || sortBy === "sequence-desc");

  const PER_PAGE = 10;
  const pageCount = reordering ? 1 : Math.max(1, Math.ceil(tableRows.length / PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const pageRows = reordering
    ? tableRows
    : tableRows.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  /** How much footage the list below adds up to. */
  const shownDurationMs = tableRows.reduce((n, c) => n + (c.durationMs ?? 0), 0);

  const counts = { all: liveLibrary.filter((c) => !c.deletedAt).length };

  const VIEW_TITLE: Record<LibraryView, string> = {
    home: "Home",
    projects: "Projects",
    all: "All Videos",
    project: manifest?.project.name ?? "Collection",
    settings: "Settings",
    readiness: "Setup",
  };

  /** Opening a collection is what puts the pipeline on screen. */
  async function openProjectById(id: string) {
    if (manifest?.project.id !== id) await onOpen(id);
    setView("project");
    setTab("footage");
    setPage(1);
    try {
      setTakes(await listTakes(id));
    } catch {
      setTakes([]);
    }
  }

  /** Put a kept generation back into the editor. */
  async function onRestoreTake(take: Take) {
    if (take.kind === "script") {
      setLines(take.lines.map((l) => ({ ...l })));
      setWords(
        take.lines.reduce((n, l) => n + l.text.trim().split(/\s+/).filter(Boolean).length, 0),
      );
      setCurrentScriptTake(take.id);
      // The recording and the cut belong to a different script now.
      setVoiced(null);
      setAssembly(null);
      setFullNarration(null);
      setDirty(true);
    } else if (take.kind === "voice") {
      setLines(take.lines.map((l) => ({ ...l })));
      // The spoken words live on `lines`; `audio` carries only the files. A
      // recording restored without its script is audio nothing can address.
      const said = new Map(
        take.lines.map((l) => [`${l.clipId}#${l.segmentIndex}`, l.text]),
      );
      setVoiced(
        take.audio.map((a) => ({
          clipId: a.clipId,
          segmentIndex: a.segmentIndex,
          text: said.get(`${a.clipId}#${a.segmentIndex}`) ?? "",
          audioPath: a.path,
          durationMs: a.durationMs,
          speechEndMs: a.durationMs,
          skipped: a.skippedWords ?? [],
        })),
      );
      setCurrentVoiceTake(take.id);
      // No stamp: this audio was made in an earlier session, and claiming to
      // know what voice produced it would be a guess.
      setVoiceStamp(null);
      setAssembly(null);
      setFullNarration(null);
      setDirty(true);
    } else if (take.videoPath) {
      setAssembly((cur) =>
        cur
          ? { ...cur, videoPath: take.videoPath!, durationMs: take.durationMs ?? cur.durationMs }
          : cur,
      );
      setCurrentRenderTake(take.id);
    }
  }

  async function onDeleteTake(take: Take) {
    if (!projectId) return;
    try {
      setTakes(await deleteTake(projectId, take.id));
      if (take.id === currentRenderTake) setCurrentRenderTake(null);
      if (take.id === currentScriptTake) setCurrentScriptTake(null);
      if (take.id === currentVoiceTake) setCurrentVoiceTake(null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  // --- stage derivations (only meaningful with a project open) --------------

  const described = manifest ? describedCount(manifest.clips) : 0;
  const segments = manifest ? totalSegments(manifest.clips) : 0;

  const currentStamp: VoiceStamp = { providerId, voiceId: voice, language, pronunciations };
  const voiceChanged = voiceStamp !== null && !voiceStampEquals(voiceStamp, currentStamp);
  const staleLines = staleLineKeys(lines, voiced, voiceChanged);
  const unrecorded = unrecordedLineKeys(lines, voiced);
  const assemblyCurrent =
    !assembly ||
    renderedSig === "" ||
    renderedSig === renderSignature(voiced, crossfadeMs, null, introSignature, timelineSig);

  const busyStage: StageId | null = importing
    ? "footage"
    : ideasBusy
      ? "story"
      : composing
        ? "script"
        : ttsBusy
          ? "voice"
          : assemblyBusy
            ? "assembly"
            : null;

  const pipeline = {
    clipCount: manifest?.clips.length ?? 0,
    describedCount: described,
    title,
    lines,
    voiced,
    staleLines,
    unrecordedLines: unrecorded,
    hasAssembly: assembly !== null,
    assemblyCurrent,
    introPending,
    busy: busyStage,
  };
  const statuses = stageStatuses(pipeline);
  const staleNotes = {
    voice: stalenessReason("voice", pipeline),
    assembly: stalenessReason("assembly", pipeline),
  };

  function blocked(needFrom: StageId) {
    return (
      <div className="stage-blocked">
        <h3>{STAGES[stage].label} isn’t ready yet</h3>
        <p className="hint">{STAGES[stage].needs}</p>
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            setStage(needFrom);
            setTab(needFrom);
          }}
        >
          Go to {STAGES[needFrom].label}
        </button>
      </div>
    );
  }

  function staleBanner(note: string | null, action: React.ReactNode) {
    if (!note) return null;
    return (
      <div className="stale-banner" role="status">
        <strong>Out of date.</strong>
        <span>{note}</span>
        {action}
      </div>
    );
  }

  const stageBody = !manifest ? (
    <div className="stage-blocked">
      <h3>No collection open</h3>
      <p className="hint">
        The pipeline works on one collection at a time. Choose one from the
        sidebar, or make a new one.
      </p>
      <button type="button" className="primary-button" onClick={() => setView("projects")}>
        Choose a collection
      </button>
    </div>
  ) : (
    <>
      {error && (
        <div className="error" role="alert">
          <strong>Something went wrong.</strong>
          <span>{error}</span>
        </div>
      )}

      {rejected.length > 0 && (
        <div className="error" role="alert">
          <strong>
            {rejected.length} file{rejected.length === 1 ? "" : "s"} couldn’t be used.
          </strong>
          <ul className="media-warnings">
            {rejected.map((r) => (
              <li key={r.sourcePath}>
                <strong>{r.fileName}</strong> — {r.reasons.join(" ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      {stage === "story" &&
        (described === 0 ? (
          blocked("footage")
        ) : (
          <StoryPanel
            ideas={ideas}
            busy={ideasBusy}
            progress={ideaProgress}
            error={ideaError}
            describedClips={described}
            totalSegments={segments}
            chosenTitle={title}
            wordCount={wordCount}
            coverage={coverageFor(wordCount, segments)}
            suggested={suggestedWordCount(segments)}
            style={style}
            onStyle={setStyle}
            language={language}
            onLanguage={setLanguage}
            scriptProvider={scriptProvider}
            onScriptProvider={setScriptProvider}
            qualityTier={qualityTier}
            onQualityTier={setQualityTier}
            usage={scriptUsage}
            critique={critique}
            onCritique={setCritique}
            onSuggest={onSuggestIdeas}
            onChooseTitle={setTitle}
            onWordCount={setWordCount}
            onContinue={onGenerateScript}
            continueLabel={lines ? "Regenerate script" : "Generate script"}
            continueBusy={composing}
            continueError={composeError}
          />
        ))}

      {stage === "script" &&
        (!title.trim() ? (
          blocked("story")
        ) : composing ? (
          <div className="panel">
            <p className="working" role="status">
              {composeProgress?.stage === "selecting"
                ? `Choosing moments (${composeProgress.done}/${composeProgress.total})…`
                : composeProgress?.stage === "writing"
                  ? "Writing the narration…"
                  : composeProgress?.stage === "critiquing"
                    ? "Reviewing and revising the draft…"
                    : "Working…"}
            </p>
          </div>
        ) : !lines ? (
          <div className="stage-blocked">
            <h3>No script yet</h3>
            <p className="hint">
              “{title}” is ready to write. This picks the moments that serve it and
              narrates them.
            </p>
            <button type="button" className="primary-button" onClick={onGenerateScript}>
              Generate script
            </button>
          </div>
        ) : (
          <ScriptPanel
            clips={manifest.clips}
            title={title}
            lines={lines}
            words={words}
            wordTarget={wordCount}
            voiced={voiced}
            staleLines={staleLines}
            pronunciations={pronunciations}
            showPronunciationFixes={provider.capabilities.reportsUnpronounceableWords}
            busy={ttsBusy}
            resynthesizing={resynthesizing}
            intro={introProps}
            overBudget={overBudget}
            shortening={shortening}
            onShorten={(i, b) => void onShortenLine(i, b)}
            onEditLine={onEditLine}
            onHearLine={onHearLine}
            onCorrectWord={onCorrectWord}
          />
        ))}

      {justDone === "script" && stage === "script" && (
        <div className="done-banner" role="status">
          <CheckIcon size={16} />
          <span>
            <strong>Script written.</strong> {lines?.length ?? 0} lines,{" "}
            {words} words. Read it through and change anything that does not
            sound like you.
          </span>
          <button
            type="button"
            className="ghost-button small"
            onClick={() => setJustDone(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {stage === "script" && !composing && (
        <TakeHistory
          kind="script"
          takes={takes}
          currentId={currentScriptTake}
          busy={composing || ttsBusy}
          onRestore={onRestoreTake}
          onDelete={onDeleteTake}
        />
      )}

      {stage === "voice" &&
        (!lines ? (
          blocked("script")
        ) : (
          <>
            {staleBanner(
              staleNotes.voice,
              <button
                type="button"
                className="ghost-button small"
                onClick={onRerecordStale}
                disabled={ttsBusy}
              >
                Re-record just those
              </button>,
            )}

            <div className="panel">
              <div className="panel-head">
                <h2>Voice</h2>
                <span className="hint">
                  {characterCount(lines)} characters
                  {provider.capabilities.billing === "per-character" && " · billed"}
                </span>
              </div>
              <ProviderPicker
                providerId={providerId}
                onProvider={setProviderId}
                voices={voices}
                voiceId={voice}
                onVoice={setVoice}
                voicesError={voicesError}
                onReloadVoices={loadVoices}
                scriptLines={lines}
                language={scriptLanguage}
                disabled={ttsBusy}
                previewing={previewing}
                onPreview={onPreview}
              />
              <div className="voice-record">
                <button
                  type="button"
                  className="primary-button"
                  onClick={onGenerateVoiceover}
                  disabled={ttsBusy || !voice}
                >
                  {ttsBusy
                    ? ttsProgress
                      ? `Recording ${ttsProgress.done}/${ttsProgress.total}…`
                      : "Recording…"
                    : voiced
                      ? "Re-record all"
                      : "Record narration"}
                </button>
                <span className="hint">
                  {!voice
                    ? "Choose a voice above first."
                    : voiced
                      ? "Re-records every line with the current voice."
                      : `Records all ${lines.length} lines.`}
                </span>
              </div>

              {ttsBusy && ttsProgress && (
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${(ttsProgress.done / Math.max(1, ttsProgress.total)) * 100}%`,
                    }}
                  />
                </div>
              )}

              {ttsError && (
                <div className="error" role="alert">
                  <strong>Couldn’t generate the voiceover.</strong>
                  <span>{ttsError}</span>
                </div>
              )}
              {failures.length > 0 && (
                <div className="warning" role="status">
                  <strong>
                    {failures.length} line{failures.length === 1 ? "" : "s"} didn’t record.
                  </strong>
                  <span>The rest were kept. {failures[0].message}</span>
                  <div className="actions">
                    <button
                      type="button"
                      className="ghost-button small"
                      onClick={onRetryFailed}
                      disabled={ttsBusy}
                    >
                      Retry just those lines
                    </button>
                  </div>
                </div>
              )}
            </div>

            <ScriptPanel
              clips={manifest.clips}
              title={title}
              lines={lines}
              words={words}
              wordTarget={wordCount}
              voiced={voiced}
              staleLines={staleLines}
              pronunciations={pronunciations}
              showPronunciationFixes={provider.capabilities.reportsUnpronounceableWords}
              busy={ttsBusy}
              resynthesizing={resynthesizing}
              intro={introProps}
              overBudget={overBudget}
              shortening={shortening}
              onShorten={(i, b) => void onShortenLine(i, b)}
              onEditLine={onEditLine}
              onHearLine={onHearLine}
              onCorrectWord={onCorrectWord}
            />

            {voiced && voiced.length > 0 && (
              <div className="panel">
                <div className="panel-head">
                  <h2>The whole narration</h2>
                  <span className="hint">
                    {voiced.length} line{voiced.length === 1 ? "" : "s"}, end to end
                  </span>
                </div>

                {fullNarration ? (
                  <audio
                    className="narration-player"
                    controls
                    src={audioUrl(fullNarration) + `?t=${Date.now()}`}
                  />
                ) : (
                  <p className="hint" style={{ margin: "0 0 0.9rem" }}>
                    Line by line tells you each sentence works. Whether the script
                    works is only audible end to end.
                  </p>
                )}

                <div className="actions">
                  <button
                    type="button"
                    className={fullNarration ? "ghost-button" : "primary-button"}
                    onClick={onJoinNarration}
                    disabled={joining || ttsBusy}
                  >
                    {joining
                      ? "Joining…"
                      : fullNarration
                        ? "Rebuild after edits"
                        : "▶ Play the whole narration"}
                  </button>
                  {staleLines.size > 0 && fullNarration && (
                    <span className="hint">
                      Some lines changed since this was joined.
                    </span>
                  )}
                </div>
              </div>
            )}

            {justDone === "voice" && (
              <div className="done-banner" role="status">
                <CheckIcon size={16} />
                <span>
                  <strong>Narration recorded.</strong> {voiced?.length ?? 0} lines.
                  Play it whole below before assembling.
                </span>
                <button
                  type="button"
                  className="ghost-button small"
                  onClick={() => setJustDone(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            <TakeHistory
              kind="voice"
              takes={takes}
              currentId={currentVoiceTake}
              busy={ttsBusy}
              onRestore={onRestoreTake}
              onDelete={onDeleteTake}
              onPlay={async (t) => {
                if (!projectId || t.audio.length === 0) return;
                setTtsError(null);
                try {
                  // Named after the take, so listening back does not overwrite
                  // the joined copy of the current recording.
                  const path = await concatNarration(
                    projectId,
                    t.audio.map((a) => a.path),
                    350,
                    `take-${t.id}`,
                  );
                  await new Audio(audioUrl(path) + `?t=${Date.now()}`).play();
                } catch (err) {
                  setTtsError(errorText(err));
                }
              }}
            />
          </>
        ))}

      {stage === "assembly" &&
        (!voiced ? (
          blocked("voice")
        ) : (
          <>
            {staleBanner(
              staleNotes.assembly,
              <button
                type="button"
                className="ghost-button small"
                onClick={onRender}
                disabled={assemblyBusy || !ffmpeg}
              >
                Render again
              </button>,
            )}

            <FfmpegSetup
              info={ffmpeg}
              hasHdrClips={manifest.clips.some((c) => c.isHdr)}
              onFound={setFfmpeg}
              onRecheck={async () => setFfmpeg(await detectFfmpeg())}
            />

            {ffmpeg && (
              <>
              {planned.length > 0 && (
                <TimelinePanel
                  planned={planned}
                  doc={timelineDoc}
                  onChange={(d) => {
                    setTimelineDoc(d);
                    setDirty(true);
                  }}
                  clips={manifest.clips}
                  busy={assemblyBusy}
                  onRender={() => void onRender()}
                  onPickMusic={() => void onPickMusic()}
                  beds={MUSIC_BEDS}
                  musicUrl={musicUrl}
                  subtitles={timelineDoc.subtitles ? timelineDoc.subtitleStyle : null}
                  opening={{
                    enabled: introEnabled,
                    onToggle: (on) => {
                      setIntroEnabled(on);
                      void storeIntroEnabled(on);
                      setAssembly(null);
                    },
                    summary: hook
                      ? introPending
                        ? `“${hook.slice(0, 60)}${hook.length > 60 ? "…" : ""}” — not recorded yet.`
                        : `“${hook.slice(0, 60)}${hook.length > 60 ? "…" : ""}” over ${introShots.length} shot${introShots.length === 1 ? "" : "s"}.`
                      : "One spoken line over a quick montage, before the film starts. Written with the script.",
                  }}
                />
              )}

              <AssemblyPanel
                title={title}
                voiced={voiced}
                clips={manifest.clips.map((c) => ({
                  id: c.id,
                  description: c.segments[0]?.text ?? "",
                  sourcePath: c.sourcePath ?? undefined,
                  sourceDurationMs: c.sourceDurationMs ?? undefined,
                  isPlaceholder: c.isPlaceholder,
                  isHdr: c.isHdr,
                }))}
                ffmpeg={ffmpeg}
                result={assembly}
                busy={assemblyBusy}
                progress={renderProgress}
                error={assemblyError}
                hasPlaceholders
                makingPlaceholders={false}
                onMakePlaceholders={() => {}}
                onRender={onRender}
                intro={introSpec ? { hook, shots: introShots.length } : null}
                hasExternalMedia={manifest.clips.some((c) => c.sourcePath && !c.isPlaceholder)}
              >
                            </AssemblyPanel>
              </>
            )}

            <TakeHistory
              kind="render"
              takes={takes}
              currentId={currentRenderTake}
              busy={assemblyBusy}
              onRestore={onRestoreTake}
              onDelete={onDeleteTake}
              onPlay={onRestoreTake}
            />
          </>
        ))}
    </>
  );

  // The gate renders instead of the application, not on top of it: nothing
  // behind it should mount, subscribe or start work.
  if (!letsAppRender(gate)) {
    return (
      <LoginGate
        gate={gate}
        onSignIn={() => void onGateSignIn()}
        onCancel={onGateCancel}
        onRecheck={() => void onGateRecheck()}
        onSignOut={() => void onGateSignOut()}
        waiting={gateWaiting}
        error={gateError}
      />
    );
  }

  return (
    <div className="lib">
      {gate.state === "allowed-grace" && (
        <GraceBanner daysLeft={gate.daysLeft} onRecheck={() => void onGateRecheck()} />
      )}
      <LibrarySidebar
        view={view}
        onView={(v) => {
          setView(v);
          setPage(1);
        }}
        counts={counts}
        projects={projects}
        openProjectId={manifest?.project.id ?? null}
        onOpenProject={openProjectById}
        onNewProject={() => setView("projects")}
        onRefresh={() => void refreshLibrary()}
        refreshing={refreshing}
        storage={storage}
        userName={userName}
        onOpenSettings={() => setView("settings")}
        attention={needsAttention}
        usable={canImport}
        onOpenReadiness={() => setView("readiness")}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => {
          const next = !sidebarCollapsed;
          setSidebarCollapsed(next);
          // Remembered, because someone who wants the room wants it every
          // time, not once per launch.
          try {
            localStorage.setItem("sidebarCollapsed", next ? "1" : "0");
          } catch {
            /* private mode or a full disk; the choice just will not stick */
          }
        }}
      />

      <main className="lib-main">
        {view === "readiness" ? (
          <>
            <header className="lib-head">
              <h1>Setup</h1>
              <span className="lib-head-count">what this machine can do</span>
            </header>
            <ReadinessPanel
              probe={probe}
              requirements={{
                fastModel: OLLAMA_MODEL,
                qualityModel: OLLAMA_MODEL_QUALITY,
                hasOpenAiKey,
                hasElevenLabsKey,
              }}
              platform={
                navigator.userAgent.includes("Mac")
                  ? "macos"
                  : navigator.userAgent.includes("Win")
                    ? "windows"
                    : "other"
              }
              ollamaHost={OLLAMA_HOST}
              checking={probing}
              onRecheck={() => void checkReadiness()}
              onOpenProviders={() => {
                if (manifest) {
                  setView("project");
                  setTab("voice");
                } else {
                  setView("projects");
                }
              }}
            />
          </>
        ) : view === "settings" ? (
          <>
            <header className="lib-head">
              <h1>Settings</h1>
              <span className="lib-head-count">how the script is written</span>
            </header>
            <SettingsPanel language={language} />
          </>
        ) : view === "home" ? (
          // Left empty on purpose, pending a decision about what belongs here.
          <div className="lib-home-empty" />
        ) : view === "projects" ? (
          <ProjectGallery
            projects={projects}
            onRefresh={refreshLibrary}
            onCreate={onCreate}
            // The one way in, so opening a collection cannot mean two
            // different things. This used to route to Home, which was the
            // workspace until Home was deliberately emptied — after which
            // "Make the movie" landed on a blank page.
            onOpen={openProjectById}
            busy={busy}
            error={error}
          />
        ) : (
          <>
            <header className="lib-head">
              <h1>{VIEW_TITLE[view]}</h1>
              <span className="lib-head-count">
                {view === "all" || onFootageTab ? (
                  <>
                    {tableRows.length} video{tableRows.length === 1 ? "" : "s"}
                    {shownDurationMs > 0 && (
                      <>
                        {" · "}
                        <strong title="Total length of the footage listed below">
                          {formatSpan(shownDurationMs)}
                        </strong>
                        {" of footage"}
                      </>
                    )}
                  </>
                ) : (
                  STAGES[tab].produces
                )}
              </span>

              <label className="lib-search">
                <SearchIcon />
                <span className="visually-hidden">Search videos and descriptions</span>
                <input
                  value={query}
                  placeholder="Search videos, description…"
                  onChange={(e) => {
                    setQuery(e.currentTarget.value);
                    setPage(1);
                  }}
                />
              </label>

              {view !== "project" && (
              <label className="lib-tool">
                <FilterIcon />
                <span className="visually-hidden">Filter by collection</span>
                <select
                  value={filterProject}
                  onChange={(e) => {
                    setFilterProject(e.currentTarget.value);
                    setPage(1);
                  }}
                >
                  <option value="">All collections</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              )}

              <label className="lib-tool">
                <SortIcon />
                <span className="visually-hidden">Sort</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.currentTarget.value as typeof sortBy)}
                >
                  <option value="sequence">Running order · first to last</option>
                  <option value="sequence-desc">Running order · last to first</option>
                  <option value="added">Newest first</option>
                  <option value="name">Name</option>
                  <option value="duration">Longest first</option>
                  <option value="described">Undescribed first</option>
                </select>
              </label>

              {onFootageTab && manifest && manifest.clips.length > 1 && (
                <label className="lib-tool">
                  <SortIcon />
                  <span className="visually-hidden">Arrange the running order</span>
                  <select
                    value=""
                    onChange={(e) => {
                      const action = e.currentTarget.value;
                      // Reset so the same choice can be made twice running —
                      // this is a command, not a setting, and it should not
                      // sit there looking like the current state.
                      e.currentTarget.value = "";
                      if (action) void onArrange(action as SortBasis | "auto" | "reverse");
                    }}
                    title="Put the whole collection in a chosen order. This is the order the script is written to and the film is cut in."
                  >
                    <option value="">Arrange…</option>
                    <option value="auto">Shooting order (work it out)</option>
                    {SORT_BASES.map((b) => (
                      <option key={b.id} value={b.id} title={b.hint}>
                        {b.label}
                      </option>
                    ))}
                    <option value="reverse">Reverse current order</option>
                  </select>
                </label>
              )}

              {onFootageTab && manifest && (
                <button
                  type="button"
                  className="lib-new"
                  onClick={async () => {
                    if (!canImport) {
                      setView("readiness");
                      return;
                    }
                    runImport(await pickFiles());
                  }}
                  disabled={importing}
                  title={canImport ? undefined : "ffmpeg is needed to import clips"}
                >
                  {importing ? "Importing…" : canImport ? "+ Add footage" : "Set up ffmpeg first"}
                </button>
              )}


              {manifest && (
                <button
                  type="button"
                  className="lib-tool"
                  onClick={onSave}
                  disabled={busy || !dirty}
                  title={
                    dirty ? "Save (⌘S)" : savedAt ? `Saved at ${savedAt}` : "Up to date"
                  }
                >
                  <SaveIcon size={16} />
                  {busy ? "Saving…" : dirty ? "Save" : "Saved"}
                </button>
              )}

              {/* Creating collections belongs to Projects and the sidebar's
                  "+", not to a page whose job is listing what already exists. */}
              {view === "project" && (
                <button
                  type="button"
                  className="lib-tool"
                  onClick={() => setView("projects")}
                >
                  All collections
                </button>
              )}
            </header>

            {orderNote && onFootageTab && (
              <p className="order-note" role="status">
                <span>{orderNote}</span>
                <button
                  type="button"
                  className="describer-remove"
                  onClick={() => setOrderNote(null)}
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </p>
            )}

            {view === "project" && (
              <nav className="lib-tabs" aria-label="Stages">
                {STAGE_ORDER.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="lib-tab"
                    aria-current={tab === id}
                    onClick={() => {
                      setTab(id);
                      setStage(id);
                      setPage(1);
                    }}
                    title={`${STAGES[id].label} — ${statuses[id]}`}
                  >
                    <span className="lib-tab-dot" data-status={statuses[id]} />
                    {STAGES[id].label}
                  </button>
                ))}
              </nav>
            )}

            {view === "all" || onFootageTab ? (
              onFootageTab && !manifest ? (
                <div className="stage-blocked">
                  <h3>No collection open</h3>
                  <p className="hint">
                    Footage belongs to a collection. Choose one from the sidebar,
                    or browse everything under All Videos.
                  </p>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => setView("projects")}
                  >
                    Choose a collection
                  </button>
                </div>
              ) : (
              <div className="lib-table-wrap">
                {pageRows.length === 0 ? (
                  <p className="lib-empty">
                    {onFootageTab
                      ? baseRows.length === 0
                        ? "Nothing in this collection yet. Use “+ Add footage”."
                        : "Nothing matches that."
                      : liveLibrary.length === 0
                        ? "No footage yet. Open a collection and add some."
                        : "Nothing matches that."}
                  </p>
                ) : (
                  <>
                    <VideoTable
                      clips={pageRows}
                      onPlay={setPreview}
                      onOpenProject={openProjectById}
                      onDescribe={(c) => setPreview(c)}
                      onDelete={(cs) => setPendingDelete({ clips: cs })}
                      reorder={
                        reordering && manifest
                          ? {
                              reversed: sortBy === "sequence-desc",
                              onReorder: (rows) => void onReorder(rows),
                            }
                          : undefined
                      }
                    />

                    <div className="lib-foot">
                      <span>
                        Showing {(safePage - 1) * PER_PAGE + 1} to{" "}
                        {Math.min(safePage * PER_PAGE, tableRows.length)} of{" "}
                        {tableRows.length} video{tableRows.length === 1 ? "" : "s"}
                      </span>
                      {pageCount > 1 && (
                        <div className="lib-pages">
                          <button
                            type="button"
                            className="lib-page"
                            onClick={() => setPage(safePage - 1)}
                            disabled={safePage === 1}
                            aria-label="Previous page"
                          >
                            ‹
                          </button>
                          {Array.from({ length: pageCount }, (_, i) => (
                            <button
                              key={i}
                              type="button"
                              className="lib-page"
                              aria-current={safePage === i + 1}
                              onClick={() => setPage(i + 1)}
                            >
                              {i + 1}
                            </button>
                          ))}
                          <button
                            type="button"
                            className="lib-page"
                            onClick={() => setPage(safePage + 1)}
                            disabled={safePage === pageCount}
                            aria-label="Next page"
                          >
                            ›
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
              )
            ) : (
              stageBody
            )}

            {/* Timings live here, not in the table: one box cannot hold three. */}
            {onFootageTab && manifest && splitting && (
              <>
                <div className="actions" style={{ margin: "1rem 0 0.5rem" }}>
                  <span className="hint">
                    Editing the moments inside one clip. The table above edits
                    whole-clip descriptions.
                  </span>
                  <button
                    type="button"
                    className="ghost-button small"
                    style={{ marginLeft: "auto" }}
                    onClick={() => setSplitting(null)}
                  >
                    Done
                  </button>
                </div>
                <SegmentEditor
                clips={manifest.clips.filter((c) => c.id === splitting && !c.deletedAt)}
                selectedId={splitting}
                importing={importing}
                onSelect={setSplitting}
                onChangeSegments={(clipId, segs) => {
                  onChangeSegments(clipId, segs);
                  void refreshLibrary();
                }}
                  onImportClips={async () => runImport(await pickFiles())}
                />
              </>
            )}
          </>
        )}
      </main>

      {pendingDelete && (
        <div
          className="confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm removal"
          onClick={() => setPendingDelete(null)}
        >
          <div className="confirm-panel" onClick={(e) => e.stopPropagation()}>
            <h2>
              Remove {pendingDelete.clips.length} clip
              {pendingDelete.clips.length === 1 ? "" : "s"} from the library?
            </h2>
            <p className="hint">
              {pendingDelete.clips.length === 1
                ? pendingDelete.clips[0].fileName
                : `${pendingDelete.clips[0].fileName} and ${
                    pendingDelete.clips.length - 1
                  } other${pendingDelete.clips.length === 2 ? "" : "s"}`}
            </p>
            <p>
              This forgets the clip and everything written about it. The video
              file itself is left where it is — footage is referenced, not
              copied — so you can import it again, but the descriptions are gone.
            </p>
            {pendingDelete.clips.some((c) => c.description.trim()) && (
              <p className="warning" style={{ margin: "0.75rem 0 0" }}>
                {pendingDelete.clips.filter((c) => c.description.trim()).length} of
                these{pendingDelete.clips.length === 1 ? " is" : " are"} described.
              </p>
            )}
            <div className="actions" style={{ marginTop: "1.25rem" }}>
              <button
                type="button"
                className="primary-button bulk-delete"
                onClick={() => {
                  const { clips: doomed, after } = pendingDelete;
                  void onDeleteClips(doomed).then(() => after?.());
                  setPendingDelete(null);
                }}
              >
                Remove
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setPendingDelete(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <ClipDescriber
          clips={tableRows}
          startAt={`${preview.projectId}/${preview.clipId}`}
          segmentsFor={(c) => c.segments}
          onCommit={(c, segs) => {
            if (manifest?.project.id === c.projectId) {
              onChangeSegments(c.clipId, segs);
            } else {
              void setSegments(c.projectId, c.clipId, segs).then(() => refreshLibrary());
            }
          }}
          onDelete={(clip, after) => setPendingDelete({ clips: [clip], after })}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

export default App;

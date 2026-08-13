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
  listLibrary,
  reorderClips,
  purgeClip,
  setSegments,
  storageUsage,
  type LibraryClip,
  type StorageUsage,
} from "./lib/library";
import { listProjects, type ProjectSummary } from "./lib/project";
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
import { DEFAULT_LANGUAGE, languageFor } from "./lib/languages";
import {
  type QualityTier,
  type ScriptProviderId,
} from "./lib/scriptProviders";
import { suggestStoryIdeas, type IdeaProgress, type StoryIdea } from "./lib/storyIdeas";
import {
  generateHookForScript,
  generateScriptForTitle,
  type ComposeProgress,
  type ScriptLineDraft,
  type ScriptStyle,
} from "./lib/scriptComposer";
import { INTRO_FADE_MS, pickShots, type ShotCandidate } from "./lib/intro";
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
  renderRoughCut,
  VIDEO_EXTENSIONS,
  type AssembleResult,
  type FfmpegInfo,
  type ImportedMedia,
  type IntroSpec,
  type RenderProgress,
} from "./lib/assembly";
import "./App.css";

/**
 * Chosen by measurement rather than by being first alphabetically: af_kore
 * scored highest of the English-accent voices in the audition (74.6 against
 * af_heart's 58.2). See `src-tauri/src/voice_audition.rs`.
 */
const DEFAULT_VOICE = "af_kore";

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

function App() {
  // --- shell ---------------------------------------------------------------
  const [stage, setStage] = useState<StageId>("footage");
  const [query, setQuery] = useState("");

  /** Sidebar destination, and which tab of the main column is showing. */
  // Home is intentionally empty for now, so the app opens on the library
  // rather than on a blank page.
  const [view, setView] = useState<LibraryView>("all");
  /** Which stage is showing inside a collection. */
  const [tab, setTab] = useState<StageId>("footage");

  // The library spans every project, so it is loaded separately from whichever
  // one is open.
  const [library, setLibrary] = useState<LibraryClip[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [userName, setUserName] = useState("");
  const [refreshing, setRefreshing] = useState(false);

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
  const [crossfadeMs, setCrossfadeMs] = useState(0);
  const [musicId, setMusicId] = useState<string | null>(null);

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
    return pickShots(hookAudio.durationMs, candidates, {
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
    };
  }, [introShots, hookAudio, manifest]);

  /** What the cut's opening was made from, for the staleness check. */
  const introSignature = introSpec
    ? `${introSpec.audioPath}:${hookAudio?.durationMs ?? 0}|` +
      introShots.map((s) => `${s.clipId}#${s.segmentIndex}@${s.sourceInMs}+${s.durationMs}`).join(",")
    : "";

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

  const scriptLanguage = languageFor(language);

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
      }
      setDirty(false);
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
    [title, lines, wordCount, hook, voiced, voice, pronunciations],
  );

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
            favorite: false,
            deletedAt: null,
            segments: [],
          }));
        if (added.length === 0) return;

        const next = { ...current, clips: [...current.clips, ...added] };
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
      const sample = await provider.preview(voice, lines?.[0]?.text, language);
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

  // --- assembly ------------------------------------------------------------

  async function onRender() {
    if (!voiced || !manifest) return;
    setAssemblyBusy(true);
    setAssemblyError(null);
    // Fixed up front: it names the output file, so the take and the mp4 it
    // owns cannot end up pointing at different things.
    const takeId = crypto.randomUUID();
    try {
      // Clip specs describe the media; segment offsets travel per line, so a
      // clip used twice at different moments gets two independent starts.
      const clipSpecs = manifest.clips.map((c) => ({
        id: c.id,
        description: c.segments[0]?.text ?? "",
        sourcePath: c.sourcePath ?? undefined,
        sourceDurationMs: c.sourceDurationMs ?? undefined,
        isPlaceholder: c.isPlaceholder,
        isHdr: c.isHdr,
      }));
      const segmentStarts = new Map<string, number>();
      for (const v of voiced) {
        const seg = manifest.clips.find((c) => c.id === v.clipId)?.segments[v.segmentIndex];
        if (seg) {
          segmentStarts.set(`${v.clipId}#${v.segmentIndex}`, Math.round(seg.startSec * 1000));
        }
      }
      const result = await renderRoughCut(clipSpecs, voiced, {
        projectId: manifest.project.id,
        projectName: manifest.project.name,
        model: OLLAMA_MODEL,
        voice,
        createdAt: manifest.project.createdAt,
        videoId: "video-1",
        takeId,
        videoTitle: title,
        segmentStarts,
        crossfadeMs,
        musicId,
        intro: introSpec,
        onProgress: setRenderProgress,
      });
      setAssembly(result);
      if (result.introError) {
        setAssemblyError(
          `The cut rendered, but without its opening: ${result.introError}`,
        );
      }
      // Stamp what this cut was made from, so a later edit can be seen.
      setRenderedSig(renderSignature(voiced, crossfadeMs, musicId, introSignature));

      const take = renderTake(
        takeId,
        result.videoPath,
        result.durationMs,
        `${crossfadeMs > 0 ? "crossfade" : "hard cuts"} · ${
          musicId ? (MUSIC_BEDS.find((m) => m.id === musicId)?.label ?? musicId) : "no music"
        }`,
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
    renderedSig === renderSignature(voiced, crossfadeMs, musicId, introSignature);

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
                <div className="field-row">
                  <span className="field-label">Transitions</span>
                  <div className="style-row">
                    <button
                      type="button"
                      className={`style-chip${crossfadeMs === 0 ? " is-selected" : ""}`}
                      onClick={() => setCrossfadeMs(0)}
                      title="The default: an instant cut between clips"
                    >
                      Hard cuts
                    </button>
                    <button
                      type="button"
                      className={`style-chip${crossfadeMs === 400 ? " is-selected" : ""}`}
                      onClick={() => setCrossfadeMs(400)}
                      title="A 400ms dissolve; shortens the film slightly"
                    >
                      Crossfade
                    </button>
                  </div>
                </div>

                <div className="field-row">
                  <span className="field-label">Music</span>
                  <div className="style-row">
                    <button
                      type="button"
                      className={`style-chip${musicId === null ? " is-selected" : ""}`}
                      onClick={() => setMusicId(null)}
                    >
                      None
                    </button>
                    {MUSIC_BEDS.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`style-chip${musicId === m.id ? " is-selected" : ""}`}
                        onClick={() => setMusicId(m.id)}
                        title={m.hint}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              </AssemblyPanel>
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

  return (
    <div className="lib">
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
            <SettingsPanel
              language={language}
              introEnabled={introEnabled}
              onIntroEnabledChange={(on) => {
                setIntroEnabled(on);
                void storeIntroEnabled(on);
              }}
            />
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
                {view === "all" || onFootageTab
                  ? `${tableRows.length} video${tableRows.length === 1 ? "" : "s"}`
                  : STAGES[tab].produces}
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
          className="describer"
          role="dialog"
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

import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { ProjectGallery } from "./components/ProjectGallery";
import { SegmentEditor } from "./components/SegmentEditor";
import { StoryPanel } from "./components/StoryPanel";
import { ScriptPanel } from "./components/ScriptPanel";
import { ProviderPicker } from "./components/ProviderPicker";
import { LibrarySidebar, type LibraryView } from "./components/LibrarySidebar";
import { VideoTable } from "./components/VideoTable";
import { FilterIcon, SaveIcon, SearchIcon, SortIcon } from "./components/Icons";
import {
  listLibrary,
  setDescription,
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
import { OLLAMA_MODEL } from "./config/ollama";
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
  generateScriptForTitle,
  type ComposeProgress,
  type ScriptLineDraft,
  type ScriptStyle,
} from "./lib/scriptComposer";
import { audioUrl } from "./lib/voiceover";
import {
  characterCount,
  providerFor,
  type LineFailure,
  type ProviderId,
  type SynthProgress,
  type VoicedLine,
  type VoiceOption,
} from "./lib/ttsProviders";
import {
  detectFfmpeg,
  importMedia,
  MUSIC_BEDS,
  renderRoughCut,
  VIDEO_EXTENSIONS,
  type AssembleResult,
  type FfmpegInfo,
  type ImportedMedia,
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

/**
 * Re-derive a table row from a clip edit.
 *
 * The row is a flattened view of a clip, so an edit made in memory has to be
 * flattened the same way rather than waiting for a re-read from disk.
 */
function libraryFrom(row: LibraryClip, edit: (c: ProjectClip) => ProjectClip): LibraryClip {
  const asClip: ProjectClip = {
    id: row.clipId,
    sourcePath: row.sourcePath,
    sha256: null,
    sourceDurationMs: row.durationMs,
    isPlaceholder: row.isPlaceholder,
    fileName: row.fileName,
    thumbnailPath: row.thumbnailPath,
    isHdr: row.isHdr,
    width: row.width,
    height: row.height,
    codec: row.codec,
    favorite: row.favorite,
    deletedAt: row.deletedAt,
    segments: [],
  };
  const next = edit(asClip);
  return {
    ...row,
    favorite: next.favorite ?? row.favorite,
    deletedAt: next.deletedAt ?? null,
    description: next.segments.map((sg) => sg.text.trim()).filter(Boolean).join(" ") ||
      (next.segments.length === 0 ? "" : row.description),
    segmentCount: next.segments.length || row.segmentCount,
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
  /** Which stage is showing inside a collection. */
  const [tab, setTab] = useState<StageId>("footage");

  // The library spans every project, so it is loaded separately from whichever
  // one is open.
  const [library, setLibrary] = useState<LibraryClip[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [userName, setUserName] = useState("");
  const [savingRows, setSavingRows] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<"added" | "name" | "duration" | "described">("added");
  const [filterProject, setFilterProject] = useState<string>("");
  const [preview, setPreview] = useState<LibraryClip | null>(null);
  /** Clip whose timings are being edited; the table's one box cannot hold them. */
  const [splitting, setSplitting] = useState<string | null>(null);
  /**
   * Held in a ref because import runs above where the loader is defined, and
   * reordering them would put the loader above the state it reads.
   */
  const refreshLibraryRef = useRef<(() => Promise<void>) | null>(null);

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
    if (targets.length === 0) return;

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
    setVoiced(null);
    setAssembly(null);
    setPronunciations({});
  }

  async function onCreate(name: string) {
    setBusy(true);
    setError(null);
    try {
      setManifest(await createProject(name));
      setSplitting(null);
      resetVideoState();
      setDirty(false);
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
    [title, lines, wordCount, voiced, voice, pronunciations],
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

  const applyImport = useCallback((results: ImportedMedia[]) => {
    setRejected(results.filter((r) => r.verdict === "rejected"));
    const usable = results.filter((r) => r.verdict !== "rejected");
    if (usable.length === 0) return;
    setManifest((m) => {
      if (!m) return m;
      // Grown as the batch is walked, not just seeded from the manifest: the
      // same file picked twice in one import used to pass this filter twice,
      // because `existing` never learned about the first copy.
      const existing = new Set(m.clips.map((c) => c.sourcePath));
      const added: ProjectClip[] = usable
        .filter((r) => !existing.has(r.sourcePath) && existing.add(r.sourcePath) !== null)
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
      return added.length === 0 ? m : { ...m, clips: [...m.clips, ...added] };
    });
    setDirty(true);
  }, []);

  const runImport = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || !projectId) return;
      setImporting(true);
      setError(null);
      try {
        applyImport(await importMedia(paths, projectId));
        // The table reads the library, not the manifest, so it has to be told.
        void refreshLibraryRef.current?.();
      } catch (err) {
        setError(errorText(err));
      } finally {
        setImporting(false);
      }
    },
    [projectId, applyImport],
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
        provider: scriptProvider,
        qualityTier,
        onProgress: setComposeProgress,
      });
      setLines(draft.lines);
      setWords(draft.words);
      setScriptUsage(draft.usage ?? null);
      // A new script invalidates the audio and the cut made from the old one.
      setVoiced(null);
      setAssembly(null);
      setDirty(true);
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
        videoTitle: title,
        segmentStarts,
        crossfadeMs,
        musicId,
        onProgress: setRenderProgress,
      });
      setAssembly(result);
      // Stamp what this cut was made from, so a later edit can be seen.
      setRenderedSig(renderSignature(voiced, crossfadeMs, musicId));
    } catch (err) {
      setAssemblyError(errorText(err));
      setAssembly(null);
    } finally {
      setAssemblyBusy(false);
      setRenderProgress(null);
    }
  }

  // --- library -------------------------------------------------------------

  const refreshLibrary = useCallback(async () => {
    try {
      const [clips, list, usage] = await Promise.all([
        listLibrary(),
        listProjects(),
        storageUsage(),
      ]);
      setLibrary(clips);
      setProjects(list);
      setStorage(usage);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  refreshLibraryRef.current = refreshLibrary;

  useEffect(() => {
    void refreshLibrary();
    void invoke<string>("machine_user").then(setUserName).catch(() => setUserName(""));
  }, [refreshLibrary]);

  /**
   * Apply a library change.
   *
   * When the clip belongs to the project that is currently open, the change
   * goes through the in-memory manifest instead of the disk command. Writing
   * the file directly would put it ahead of the copy in state, and the next
   * save from the editor would quietly undo it.
   */
  async function mutateClip(
    clip: LibraryClip,
    inMemory: (c: ProjectClip) => ProjectClip,
    onDisk: () => Promise<unknown>,
  ) {
    const key = `${clip.projectId}/${clip.clipId}`;
    setSavingRows((s) => new Set(s).add(key));
    try {
      if (manifest && manifest.project.id === clip.projectId) {
        setManifest((m) =>
          m
            ? {
                ...m,
                clips: m.clips.map((c) => (c.id === clip.clipId ? inMemory(c) : c)),
              }
            : m,
        );
        setDirty(true);
        // Reflect it in the table without a round trip to disk.
        setLibrary((ls) =>
          ls.map((l) =>
            l.projectId === clip.projectId && l.clipId === clip.clipId
              ? libraryFrom(l, inMemory)
              : l,
          ),
        );
      } else {
        await onDisk();
        await refreshLibrary();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSavingRows((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  // --- render --------------------------------------------------------------

  // --- library table -------------------------------------------------------

  const q = query.trim().toLowerCase();

  // The Footage tab is the same table scoped to the open collection. One list
  // component rather than two: describing a clip is the same act whether you
  // arrived at it from the library or from inside a project, and a second
  // editor would be a second place for the two to disagree.
  const onFootageTab = view === "project" && tab === "footage";
  const baseRows = onFootageTab
    ? library.filter((c) => c.projectId === manifest?.project.id && !c.deletedAt)
    : library
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

  const PER_PAGE = 10;
  const pageCount = Math.max(1, Math.ceil(tableRows.length / PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const pageRows = tableRows.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  const counts = { all: library.filter((c) => !c.deletedAt).length };

  const VIEW_TITLE: Record<LibraryView, string> = {
    home: "Home",
    projects: "Projects",
    all: "All Videos",
    project: manifest?.project.name ?? "Collection",
  };

  /** Opening a collection is what puts the pipeline on screen. */
  async function openProjectById(id: string) {
    if (manifest?.project.id !== id) await onOpen(id);
    setView("project");
    setTab("footage");
    setPage(1);
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
    renderedSig === renderSignature(voiced, crossfadeMs, musicId);

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
            onEditLine={onEditLine}
            onHearLine={onHearLine}
            onCorrectWord={onCorrectWord}
          />
        ))}

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
                <div className="actions">
                  <span className="hint">
                    {characterCount(lines)} characters
                    {provider.capabilities.billing === "per-character" && " · billed"}
                  </span>
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
                </div>
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
              onEditLine={onEditLine}
              onHearLine={onHearLine}
              onCorrectWord={onCorrectWord}
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
                projectId={manifest.project.id}
                onMakePlaceholders={() => {}}
                onRender={onRender}
                onConsolidate={() => {}}
                consolidating={false}
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
        storage={storage}
        userName={userName}
        onOpenSettings={() => setView("projects")}
      />

      <main className="lib-main">
        {view === "home" ? (
          // Left empty on purpose, pending a decision about what belongs here.
          <div className="lib-home-empty" />
        ) : view === "projects" ? (
          <ProjectGallery
            onCreate={onCreate}
            onOpen={async (id) => {
              await onOpen(id);
              setView("home");
              setTab("footage");
              void refreshLibrary();
            }}
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
                  onClick={async () => runImport(await pickFiles())}
                  disabled={importing}
                >
                  {importing ? "Importing…" : "+ Add footage"}
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
                    {library.length === 0
                      ? "No footage yet. Open a collection to import some."
                      : "Nothing matches that."}
                  </p>
                ) : (
                  <>
                    <VideoTable
                      clips={pageRows}
                      saving={savingRows}
                      onPlay={setPreview}
                      onOpenProject={openProjectById}
                      onOpenSegments={async (c) => {
                        await openProjectById(c.projectId);
                        setSplitting(c.clipId);
                      }}
                      onDescribe={(c, text) =>
                        mutateClip(
                          c,
                          (clip) => ({
                            ...clip,
                            segments: text
                              ? [
                                  {
                                    startSec: clip.segments[0]?.startSec ?? 0,
                                    endSec:
                                      clip.segments[0]?.endSec ??
                                      (c.durationMs ?? 0) / 1000,
                                    text,
                                  },
                                ]
                              : [],
                          }),
                          () => setDescription(c.projectId, c.clipId, text),
                        )
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

      {preview && (
        <div
          className="clip-preview"
          role="dialog"
          aria-label={preview.fileName}
          onClick={() => setPreview(null)}
        >
          <div className="clip-preview-inner" onClick={(e) => e.stopPropagation()}>
            {preview.sourcePath ? (
              <video src={audioUrl(preview.sourcePath)} controls autoPlay playsInline />
            ) : (
              <p className="hint">This clip has no media on disk.</p>
            )}
            <div className="clip-preview-bar">
              <strong>{preview.fileName}</strong>
              <span className="hint">{preview.projectName}</span>
              <button
                type="button"
                className="ghost-button small"
                onClick={() => setPreview(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

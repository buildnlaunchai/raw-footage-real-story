import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { ProjectGallery } from "./components/ProjectGallery";
import { SegmentEditor } from "./components/SegmentEditor";
import { StoryPanel } from "./components/StoryPanel";
import { ScriptPanel } from "./components/ScriptPanel";
import { ProviderPicker } from "./components/ProviderPicker";
import { AppShell } from "./components/AppShell";
import { AssemblyPanel } from "./components/AssemblyPanel";
import { StageHero } from "./components/StageHero";
import { StageRail } from "./components/StageRail";
import { DownloadIcon, PlayIcon } from "./components/Icons";
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
  SCRIPT_PROVIDERS,
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

function App() {
  // --- shell ---------------------------------------------------------------
  const [stage, setStage] = useState<StageId>("footage");
  const [query, setQuery] = useState("");

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
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
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
      setSelectedClipId(null);
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
      setSelectedClipId(opened.clips[0]?.id ?? null);
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
      const existing = new Set(m.clips.map((c) => c.sourcePath));
      const added: ProjectClip[] = usable
        .filter((r) => !existing.has(r.sourcePath))
        .map((r) => ({
          id: crypto.randomUUID(),
          sourcePath: r.sourcePath,
          sha256: null,
          sourceDurationMs: r.info?.durationMs ?? null,
          isPlaceholder: false,
          fileName: r.fileName,
          thumbnailPath: r.thumbnailPath,
          isHdr: r.info?.isHdr ?? false,
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

  // --- render --------------------------------------------------------------

  if (!manifest) {
    return (
      <ProjectGallery onCreate={onCreate} onOpen={onOpen} busy={busy} error={error} />
    );
  }

  const described = describedCount(manifest.clips);
  const segments = totalSegments(manifest.clips);

  // --- what is still true? --------------------------------------------------
  //
  // With every stage reachable at all times, nothing stops a user editing a
  // line and walking straight to export. These derive whether each artifact
  // still matches what produced it, so the rail can say so.

  const currentStamp: VoiceStamp = {
    providerId,
    voiceId: voice,
    language,
    pronunciations,
  };
  // A missing stamp means the audio predates this session — a reopened project.
  // That is not evidence the voice changed, only that we cannot know, and
  // crying stale on every open would train people to ignore the warning.
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
    clipCount: manifest.clips.length,
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
  const summaries: Record<StageId, string> = {
    footage:
      manifest.clips.length === 0
        ? "Nothing imported"
        : `${described} of ${segments} described`,
    story: title.trim() || "No title yet",
    script: lines ? `${lines.length} lines · ${words} words` : "Not written",
    voice: voiced ? `${voiced.length} of ${lines?.length ?? 0} recorded` : "Not recorded",
    assembly: assembly ? `${(assembly.durationMs / 1000).toFixed(0)}s cut` : "Not rendered",
  };

  const q = query.trim().toLowerCase();
  const railClips = q
    ? manifest.clips.filter(
        (c) =>
          (c.sourcePath ?? "").toLowerCase().includes(q) ||
          c.segments.some((sg) => sg.text.toLowerCase().includes(q)),
      )
    : manifest.clips;

  const idx = STAGE_ORDER.indexOf(stage);
  const goPrev = idx > 0 ? () => setStage(STAGE_ORDER[idx - 1]) : null;
  const goNext = idx < STAGE_ORDER.length - 1 ? () => setStage(STAGE_ORDER[idx + 1]) : null;
  const heroMedia = manifest.clips.find((c) => c.thumbnailPath)?.thumbnailPath ?? null;

  const attention = staleLines.size + unrecorded.size + failures.length;

  /** A stage that cannot run yet still opens, and says what it needs. */
  function blocked(needFrom: StageId) {
    return (
      <div className="stage-blocked">
        <h3>{STAGES[stage].label} isn’t ready yet</h3>
        <p className="hint">{STAGES[stage].needs}</p>
        <button type="button" className="primary-button" onClick={() => setStage(needFrom)}>
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

  const hero = {
    footage: {
      badge: "Stage 1 · Footage",
      title: manifest.project.name,
      meta: [
        `${manifest.clips.length} clip${manifest.clips.length === 1 ? "" : "s"}`,
        `${segments} segment${segments === 1 ? "" : "s"}`,
        `${described} described`,
      ],
      lede:
        "Bring in a trip’s worth of footage and mark what happens when. Every " +
        "described moment becomes something the story can reach for.",
      actions: (
        <>
          <button
            type="button"
            className="primary-button"
            onClick={async () => runImport(await pickFiles())}
            disabled={importing}
          >
            {importing ? "Importing…" : "Import footage"}
          </button>
          {described > 0 && (
            <button type="button" className="ghost-button" onClick={() => setStage("story")}>
              Next: Story
            </button>
          )}
        </>
      ),
    },
    story: {
      badge: "Stage 2 · Story",
      title: title.trim() || "Choose what this video is about",
      meta: [
        `${described} described moment${described === 1 ? "" : "s"}`,
        `${wordCount} words`,
        scriptLanguage.label,
      ],
      lede:
        "One library can carry many videos. Pick a title and a shape, and the " +
        "script stage will choose which moments serve it.",
      actions: (
        <>
          <button
            type="button"
            className="primary-button"
            onClick={onSuggestIdeas}
            disabled={ideasBusy || described === 0}
          >
            {ideasBusy ? "Thinking…" : "Suggest stories"}
          </button>
          {title.trim() && (
            <button type="button" className="ghost-button" onClick={() => setStage("script")}>
              Next: Script
            </button>
          )}
        </>
      ),
    },
    script: {
      badge: "Stage 3 · Script",
      title: title.trim() || "Untitled",
      meta: [
        lines ? `${lines.length} lines` : null,
        lines ? `${words} of ${wordCount} words` : null,
        scriptLanguage.label,
        SCRIPT_PROVIDERS[scriptProvider].label,
      ],
      lede:
        "Narration written over the moments you described. Edit any line here — " +
        "the voice stage will show which recordings that leaves out of date.",
      actions: (
        <>
          <button
            type="button"
            className="primary-button"
            onClick={onGenerateScript}
            disabled={composing || !title.trim()}
          >
            {composing ? "Writing…" : lines ? "Regenerate script" : "Generate script"}
          </button>
          {lines && (
            <button type="button" className="ghost-button" onClick={() => setStage("voice")}>
              Next: Voice
            </button>
          )}
        </>
      ),
    },
    voice: {
      badge: "Stage 4 · Voice",
      title: "Narration",
      meta: [
        voiced ? `${voiced.length} recorded` : null,
        PROVIDERS[providerId].label,
        scriptLanguage.label,
      ],
      lede: provider.capabilities.isCloud
        ? "Your footage stays on this machine. Narration text is sent to the provider you chose."
        : "Recorded on this machine. Nothing is uploaded.",
      actions: (
        <>
          <button
            type="button"
            className="primary-button"
            onClick={onGenerateVoiceover}
            disabled={ttsBusy || !lines || !voice}
          >
            <PlayIcon />
            {ttsBusy
              ? ttsProgress
                ? `Recording ${ttsProgress.done}/${ttsProgress.total}…`
                : "Recording…"
              : voiced
                ? "Re-record all"
                : "Record narration"}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={onPreview}
            disabled={previewing || !voice}
          >
            {previewing ? "Preview…" : "▶ Preview voice"}
          </button>
          {voiced && (
            <button type="button" className="ghost-button" onClick={() => setStage("assembly")}>
              Next: Assembly
            </button>
          )}
        </>
      ),
    },
    assembly: {
      badge: "Stage 5 · Assembly",
      title: title.trim() || manifest.project.name,
      meta: [
        assembly ? `${(assembly.durationMs / 1000).toFixed(1)}s` : null,
        voiced ? `${voiced.length} shots` : null,
        crossfadeMs > 0 ? "crossfade" : "hard cuts",
        musicId ? MUSIC_BEDS.find((m) => m.id === musicId)?.label ?? null : "no music",
      ],
      lede:
        "Narration is the master clock: each clip stays on screen for exactly as " +
        "long as its line takes to say.",
      actions: (
        <>
          <button
            type="button"
            className="primary-button"
            onClick={onRender}
            disabled={assemblyBusy || !voiced || !ffmpeg}
          >
            <DownloadIcon />
            {assemblyBusy
              ? renderProgress
                ? `Rendering ${renderProgress.done}/${renderProgress.total}…`
                : "Rendering…"
              : assembly
                ? "Render again"
                : "Render rough cut"}
          </button>
          {assembly && <span className="hint">Export options are below.</span>}
        </>
      ),
    },
  }[stage];

  return (
    <AppShell
      projectName={manifest.project.name}
      active={stage}
      statuses={statuses}
      onStage={setStage}
      query={query}
      onQuery={setQuery}
      dirty={dirty}
      saving={busy}
      savedAt={savedAt}
      onSave={onSave}
      attention={attention}
      attentionLabel={
        attention === 0
          ? "Everything is up to date"
          : `${attention} thing${attention === 1 ? "" : "s"} need attention`
      }
      onLeaveProject={() => {
        setManifest(null);
        setRejected([]);
        resetVideoState();
        setStage("footage");
      }}
      rail={
        <StageRail
          active={stage}
          statuses={statuses}
          summaries={summaries}
          staleNotes={staleNotes}
          onStage={setStage}
          clips={railClips}
          selectedClipId={selectedClipId}
          onSelectClip={(id) => {
            setSelectedClipId(id);
            setStage("footage");
          }}
          thumbUrl={(c) => (c.thumbnailPath ? audioUrl(c.thumbnailPath) : null)}
        />
      }
    >
      <StageHero
        badge={hero.badge}
        status={statuses[stage]}
        title={hero.title}
        meta={hero.meta}
        lede={hero.lede}
        media={heroMedia ? audioUrl(heroMedia) : null}
        actions={hero.actions}
        onPrev={goPrev}
        onNext={goNext}
      />

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

      {/* ── stage 1 ── */}
      {stage === "footage" && (
        <SegmentEditor
          clips={railClips}
          selectedId={selectedClipId}
          importing={importing}
          onSelect={setSelectedClipId}
          onChangeSegments={onChangeSegments}
          onImportClips={async () => runImport(await pickFiles())}
        />
      )}

      {/* ── stage 2 ── */}
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

      {/* ── stage 3 ── */}
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

      {/* ── stage 4 ── */}
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

      {/* ── stage 5 ── */}
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
    </AppShell>
  );
}

export default App;

import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { ProjectPicker } from "./components/ProjectPicker";
import { SegmentEditor } from "./components/SegmentEditor";
import { StoryPanel } from "./components/StoryPanel";
import { ScriptPanel } from "./components/ScriptPanel";
import { VoicePicker } from "./components/VoicePicker";
import { AssemblyPanel } from "./components/AssemblyPanel";
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
import { suggestStoryIdeas, type IdeaProgress, type StoryIdea } from "./lib/storyIdeas";
import {
  generateScriptForTitle,
  type ComposeProgress,
  type ScriptLineDraft,
} from "./lib/scriptComposer";
import {
  audioUrl,
  generateVoiceover,
  listVoices,
  previewVoice,
  resynthesizeLine,
  type TtsProgress,
  type VoiceInfo,
  type VoicedLine,
} from "./lib/voiceover";
import {
  detectFfmpeg,
  importMedia,
  renderRoughCut,
  VIDEO_EXTENSIONS,
  type AssembleResult,
  type FfmpegInfo,
  type ImportedMedia,
  type RenderProgress,
} from "./lib/assembly";
import "./App.css";

const DEFAULT_VOICE = "af_heart";

function App() {
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

  // --- script (C/D) --------------------------------------------------------
  const [lines, setLines] = useState<ScriptLineDraft[] | null>(null);
  const [words, setWords] = useState(0);
  const [composing, setComposing] = useState(false);
  const [composeProgress, setComposeProgress] = useState<ComposeProgress | null>(null);
  const [pronunciations, setPronunciations] = useState<Record<string, string>>({});

  // --- voiceover -----------------------------------------------------------
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [voiced, setVoiced] = useState<VoicedLine[] | null>(null);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [ttsProgress, setTtsProgress] = useState<TtsProgress | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [resynthesizing, setResynthesizing] = useState<string | null>(null);

  // --- assembly ------------------------------------------------------------
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null>(null);
  const [assembly, setAssembly] = useState<AssembleResult | null>(null);
  const [assemblyBusy, setAssemblyBusy] = useState(false);
  const [renderProgress, setRenderProgress] = useState<RenderProgress | null>(null);
  const [assemblyError, setAssemblyError] = useState<string | null>(null);

  const projectId = manifest?.project.id ?? null;

  useEffect(() => {
    listVoices()
      .then((list) => {
        setVoices(list);
        if (!list.some((v) => v.id === DEFAULT_VOICE) && list.length > 0) setVoice(list[0].id);
      })
      .catch((err) => setTtsError(err.message));
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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
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
        setError(err instanceof Error ? err.message : String(err));
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
      setIdeaError(err instanceof Error ? err.message : String(err));
    } finally {
      setIdeasBusy(false);
      setIdeaProgress(null);
    }
  }

  // --- stage C -------------------------------------------------------------

  async function onGenerateScript() {
    if (!manifest || !title) return;
    setComposing(true);
    setError(null);
    setComposeProgress(null);
    try {
      const draft = await generateScriptForTitle(manifest.clips, {
        title,
        wordCount,
        onProgress: setComposeProgress,
      });
      setLines(draft.lines);
      setWords(draft.words);
      // A new script invalidates the audio and the cut made from the old one.
      setVoiced(null);
      setAssembly(null);
      setDirty(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    setTtsProgress({ done: 0, total: lines.length, clipId: "" });
    try {
      const result = await generateVoiceover(lines, {
        voice,
        projectId,
        pronunciations,
        onProgress: setTtsProgress,
      });
      setVoiced(result);
      setAssembly(null);
      setDirty(true);
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : String(err));
      setVoiced(null);
    } finally {
      setTtsBusy(false);
      setTtsProgress(null);
    }
  }

  async function onPreview() {
    setPreviewing(true);
    setTtsError(null);
    try {
      const sample = await previewVoice(voice);
      await new Audio(audioUrl(sample.audioPath)).play();
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
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
        const redone = await resynthesizeLine(
          { clipId: v.clipId, segmentIndex: v.segmentIndex, text: v.text },
          i + 1,
          { voice, projectId, pronunciations: next },
        );
        setVoiced((cur) => (cur ? cur.map((x, j) => (j === i ? redone : x)) : cur));
        // Audio changed, so any existing cut is stale.
        setAssembly(null);
      } catch (err) {
        setTtsError(err instanceof Error ? err.message : String(err));
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
        onProgress: setRenderProgress,
      });
      setAssembly(result);
    } catch (err) {
      setAssemblyError(err instanceof Error ? err.message : String(err));
      setAssembly(null);
    } finally {
      setAssemblyBusy(false);
      setRenderProgress(null);
    }
  }

  // --- render --------------------------------------------------------------

  if (!manifest) {
    return (
      <main className="app">
        <header className="masthead">
          <p className="eyebrow">Build &amp; Launch AI</p>
          <h1>Raw Footage, Real Story</h1>
          <p className="lede">
            Bring in a trip’s worth of footage, describe what’s in it, and cut as
            many videos from it as you like. Everything runs on this machine.
          </p>
        </header>
        <ProjectPicker onCreate={onCreate} onOpen={onOpen} busy={busy} error={error} />
      </main>
    );
  }

  const described = describedCount(manifest.clips);
  const segments = totalSegments(manifest.clips);

  return (
    <main className="app app-wide">
      <header className="masthead">
        <p className="eyebrow">
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setManifest(null);
              setRejected([]);
              resetVideoState();
            }}
          >
            ← Projects
          </button>
        </p>
        <h1>{manifest.project.name}</h1>
        <p className="lede">
          {manifest.clips.length} clip{manifest.clips.length === 1 ? "" : "s"} · {segments}{" "}
          segment{segments === 1 ? "" : "s"} · {described} described
        </p>
      </header>

      <div className="actions sticky-actions">
        <button type="button" className="primary-button" onClick={onSave} disabled={busy || !dirty}>
          {busy ? "Saving…" : dirty ? "Save project" : "Saved"}
        </button>
        <span className="hint">
          {dirty ? "Unsaved changes" : savedAt ? `Saved at ${savedAt}` : "Up to date"} ·{" "}
          <kbd>⌘S</kbd>
        </span>
      </div>

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

      <SegmentEditor
        clips={manifest.clips}
        selectedId={selectedClipId}
        importing={importing}
        onSelect={setSelectedClipId}
        onChangeSegments={onChangeSegments}
        onImportClips={async () => runImport(await pickFiles())}
      />

      {described > 0 && (
        <StoryPanel
          ideas={ideas}
          busy={ideasBusy}
          progress={ideaProgress}
          error={ideaError}
          describedClips={described}
          totalSegments={segments}
          chosenTitle={title}
          wordCount={wordCount}
          onSuggest={onSuggestIdeas}
          onChooseTitle={setTitle}
          onWordCount={setWordCount}
          onContinue={onGenerateScript}
          continueLabel={lines ? "Regenerate script" : "Generate script"}
          continueBusy={composing}
        />
      )}

      {composing && composeProgress && (
        <p className="working" role="status">
          {composeProgress.stage === "selecting"
            ? `Choosing moments (${composeProgress.done}/${composeProgress.total})…`
            : composeProgress.stage === "writing"
              ? "Writing the narration…"
              : "Adjusting length…"}
        </p>
      )}

      {lines && !composing && (
        <ScriptPanel
          clips={manifest.clips}
          title={title}
          lines={lines}
          words={words}
          wordTarget={wordCount}
          voiced={voiced}
          pronunciations={pronunciations}
          busy={ttsBusy}
          resynthesizing={resynthesizing}
          onEditLine={onEditLine}
          onCorrectWord={onCorrectWord}
        >
          <VoicePicker
            voices={voices}
            selected={voice}
            disabled={ttsBusy}
            previewing={previewing}
            onSelect={setVoice}
            onPreview={onPreview}
          />
          <div className="actions">
            <button
              type="button"
              className="primary-button"
              onClick={onGenerateVoiceover}
              disabled={ttsBusy || voices.length === 0}
            >
              {ttsBusy ? "Recording…" : voiced ? "Re-record voiceover" : "Generate voiceover"}
            </button>
            {ttsBusy && ttsProgress && (
              <span className="hint">
                {ttsProgress.done} of {ttsProgress.total}
              </span>
            )}
          </div>
          {ttsError && (
            <div className="error" role="alert">
              <strong>Couldn’t generate the voiceover.</strong>
              <span>{ttsError}</span>
            </div>
          )}
        </ScriptPanel>
      )}

      {voiced && !ttsBusy && (
        <FfmpegSetup
          info={ffmpeg}
          hasHdrClips={manifest.clips.some((c) => c.isHdr)}
          onFound={setFfmpeg}
          onRecheck={async () => setFfmpeg(await detectFfmpeg())}
        />
      )}

      {voiced && !ttsBusy && ffmpeg && (
        <AssemblyPanel
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
        />
      )}

      <footer className="footer">
        <span className="badge">Library → story → script → voice → cut</span>
        <p>Everything runs locally. Nothing is uploaded.</p>
      </footer>
    </main>
  );
}

export default App;

import { useEffect, useState } from "react";
import { ClipEditor } from "./components/ClipEditor";
import { ScriptResult } from "./components/ScriptResult";
import { VoiceoverPanel } from "./components/VoiceoverPanel";
import { AssemblyPanel } from "./components/AssemblyPanel";
import { FfmpegSetup } from "./components/FfmpegSetup";
import { OLLAMA_MODEL } from "./config/ollama";
import { generateScript, ScriptGenerationError } from "./lib/scriptGeneration";
import { asOllamaError } from "./lib/ollama";
import {
  audioUrl,
  generateVoiceover,
  listVoices,
  previewVoice,
  type TtsProgress,
  type VoiceInfo,
  type VoicedLine,
} from "./lib/voiceover";
import {
  detectFfmpeg,
  makePlaceholderClips,
  renderRoughCut,
  type AssembleResult,
  type FfmpegInfo,
  type RenderProgress,
} from "./lib/assembly";
import type { Clip, ScriptLine } from "./lib/types";
import "./App.css";

const newClip = (description = ""): Clip => ({
  id: crypto.randomUUID(),
  description,
});

const DEFAULT_VOICE = "af_heart";

function App() {
  const [clips, setClips] = useState<Clip[]>(() => [newClip(), newClip(), newClip()]);
  const [script, setScript] = useState<ScriptLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  // One project id per app session; audio is written under it.
  const [projectId] = useState(() => crypto.randomUUID());
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [voiced, setVoiced] = useState<VoicedLine[] | null>(null);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [progress, setProgress] = useState<TtsProgress | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsElapsedMs, setTtsElapsedMs] = useState<number | null>(null);

  const [createdAt] = useState(() => new Date().toISOString());
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null>(null);
  const [assembly, setAssembly] = useState<AssembleResult | null>(null);
  const [assemblyBusy, setAssemblyBusy] = useState(false);
  const [makingPlaceholders, setMakingPlaceholders] = useState(false);
  const [renderProgress, setRenderProgress] = useState<RenderProgress | null>(null);
  const [assemblyError, setAssemblyError] = useState<string | null>(null);

  const filled = clips.filter((c) => c.description.trim().length > 0).length;

  useEffect(() => {
    listVoices()
      .then((list) => {
        setVoices(list);
        if (!list.some((v) => v.id === DEFAULT_VOICE) && list.length > 0) {
          setVoice(list[0].id);
        }
      })
      .catch((err) => setTtsError(err.message));
    void detectFfmpeg().then(setFfmpeg);
  }, []);

  async function onMakePlaceholders() {
    if (!voiced) return;
    setMakingPlaceholders(true);
    setAssemblyError(null);
    try {
      const generated = await makePlaceholderClips(clips, voiced, projectId);
      const byId = new Map(generated.map((g) => [g.clipId, g]));
      setClips((cs) =>
        cs.map((c) => {
          const g = byId.get(c.id);
          return g
            ? { ...c, sourcePath: g.sourcePath, sourceDurationMs: g.sourceDurationMs }
            : c;
        }),
      );
    } catch (err) {
      setAssemblyError(err instanceof Error ? err.message : String(err));
    } finally {
      setMakingPlaceholders(false);
    }
  }

  async function onRender() {
    if (!voiced) return;
    setAssemblyBusy(true);
    setAssemblyError(null);
    setRenderProgress(null);
    try {
      const result = await renderRoughCut(clips, voiced, {
        projectId,
        projectName: "Untitled project",
        model: OLLAMA_MODEL,
        voice,
        createdAt,
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

  async function onGenerate() {
    setBusy(true);
    setError(null);
    const started = performance.now();
    try {
      const result = await generateScript(clips);
      setScript(result);
      setElapsedMs(performance.now() - started);
      // The old audio belongs to the old script.
      setVoiced(null);
      setTtsElapsedMs(null);
    } catch (err) {
      setError(
        err instanceof ScriptGenerationError
          ? err.message
          : asOllamaError(err).message,
      );
      setScript(null);
    } finally {
      setBusy(false);
    }
  }

  async function onGenerateVoiceover() {
    if (!script) return;
    setTtsBusy(true);
    setTtsError(null);
    setProgress({ done: 0, total: script.length, clipId: "" });
    const started = performance.now();
    try {
      const result = await generateVoiceover(script, {
        voice,
        projectId,
        onProgress: setProgress,
      });
      setVoiced(result);
      setTtsElapsedMs(performance.now() - started);
      setAssembly(null);
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : String(err));
      setVoiced(null);
    } finally {
      setTtsBusy(false);
      setProgress(null);
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

  return (
    <main className="app">
      <header className="masthead">
        <p className="eyebrow">Build &amp; Launch AI</p>
        <h1>Raw Footage, Real Story</h1>
        <p className="lede">
          Describe your clips and a local model writes the narration, then speaks
          it. Nothing leaves this machine.
        </p>
      </header>

      <ClipEditor
        clips={clips}
        disabled={busy || ttsBusy}
        onAdd={() => setClips((cs) => [...cs, newClip()])}
        onRemove={(id) => setClips((cs) => cs.filter((c) => c.id !== id))}
        onChange={(id, description) =>
          setClips((cs) => cs.map((c) => (c.id === id ? { ...c, description } : c)))
        }
      />

      <div className="actions">
        <button
          type="button"
          className="primary-button"
          onClick={onGenerate}
          disabled={busy || ttsBusy || filled === 0}
        >
          {busy ? "Writing script…" : "Generate script"}
        </button>
        <span className="hint">
          {filled === 0
            ? "Describe at least one clip"
            : `${filled} clip${filled === 1 ? "" : "s"} · ${OLLAMA_MODEL}`}
        </span>
      </div>

      {error && (
        <div className="error" role="alert">
          <strong>Couldn’t generate the script.</strong>
          <span>{error}</span>
        </div>
      )}

      {busy && (
        <p className="working" role="status">
          Running {OLLAMA_MODEL} locally — this takes a few seconds.
        </p>
      )}

      {script && !busy && (
        <ScriptResult
          clips={clips}
          script={script}
          model={OLLAMA_MODEL}
          elapsedMs={elapsedMs}
        />
      )}

      {script && !busy && (
        <VoiceoverPanel
          clips={clips}
          voices={voices}
          voice={voice}
          voiced={voiced}
          busy={ttsBusy}
          previewing={previewing}
          progress={progress}
          error={ttsError}
          elapsedMs={ttsElapsedMs}
          onSelectVoice={setVoice}
          onPreview={onPreview}
          onGenerate={onGenerateVoiceover}
        />
      )}

      {voiced && !ttsBusy && !ffmpeg && (
        <FfmpegSetup
          onFound={setFfmpeg}
          onRecheck={async () => setFfmpeg(await detectFfmpeg())}
        />
      )}

      {voiced && !ttsBusy && ffmpeg && (
        <AssemblyPanel
          clips={clips}
          ffmpeg={ffmpeg}
          result={assembly}
          busy={assemblyBusy}
          progress={renderProgress}
          error={assemblyError}
          hasPlaceholders={clips.some((c) => c.sourcePath)}
          makingPlaceholders={makingPlaceholders}
          projectId={projectId}
          onMakePlaceholders={onMakePlaceholders}
          onRender={onRender}
        />
      )}

      <footer className="footer">
        <span className="badge">Stage 3 of 4</span>
        <p>Script, voiceover and rough cut. Real video upload comes next.</p>
      </footer>
    </main>
  );
}

export default App;

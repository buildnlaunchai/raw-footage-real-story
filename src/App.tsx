import { useState } from "react";
import { ClipEditor } from "./components/ClipEditor";
import { ScriptResult } from "./components/ScriptResult";
import { OLLAMA_MODEL } from "./config/ollama";
import { generateScript, ScriptGenerationError } from "./lib/scriptGeneration";
import { asOllamaError } from "./lib/ollama";
import type { Clip, ScriptLine } from "./lib/types";
import "./App.css";

// Ids must be unique for the lifetime of the list, and a module-level counter
// isn't: Vite resets it on every hot reload and React StrictMode runs the
// initialiser twice, so a later "Add clip" re-mints an id that already exists.
// Duplicate ids become duplicate React keys, and React then reconciles two rows
// onto one element — which shows up as a repeated row rather than as a key error.
const newClip = (description = ""): Clip => ({
  id: crypto.randomUUID(),
  description,
});

function App() {
  const [clips, setClips] = useState<Clip[]>(() => [newClip(), newClip(), newClip()]);
  const [script, setScript] = useState<ScriptLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  const filled = clips.filter((c) => c.description.trim().length > 0).length;

  async function onGenerate() {
    setBusy(true);
    setError(null);
    const started = performance.now();
    try {
      const result = await generateScript(clips);
      setScript(result);
      setElapsedMs(performance.now() - started);
    } catch (err) {
      // A bad script contract and a dead server are different problems, and
      // only one of them is the user's to fix.
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

  return (
    <main className="app">
      <header className="masthead">
        <p className="eyebrow">Build &amp; Launch AI</p>
        <h1>Raw Footage, Real Story</h1>
        <p className="lede">
          Describe your clips and a local model writes the narration. Nothing
          leaves this machine.
        </p>
      </header>

      <ClipEditor
        clips={clips}
        disabled={busy}
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
          disabled={busy || filled === 0}
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

      <footer className="footer">
        <span className="badge">Stage 1 of 4</span>
        <p>Script generation. Voiceover and rough-cut assembly come next.</p>
      </footer>
    </main>
  );
}

export default App;

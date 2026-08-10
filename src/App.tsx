import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { ProjectPicker } from "./components/ProjectPicker";
import { SegmentEditor } from "./components/SegmentEditor";
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
import { importMedia, VIDEO_EXTENSIONS, type ImportedMedia } from "./lib/assembly";
import "./App.css";

function App() {
  const [manifest, setManifest] = useState<ProjectFile | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<ImportedMedia[]>([]);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const projectId = manifest?.project.id ?? null;

  // --- project lifecycle ---------------------------------------------------

  async function onCreate(name: string) {
    setBusy(true);
    setError(null);
    try {
      const created = await createProject(name);
      setManifest(created);
      setSelectedClipId(null);
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
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const onSave = useCallback(async () => {
    if (!manifest) return;
    setBusy(true);
    setError(null);
    try {
      await saveProject(manifest);
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [manifest]);

  // ⌘S is muscle memory for anyone who has ever lost work.
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

  // --- clip import ---------------------------------------------------------

  const applyImport = useCallback((results: ImportedMedia[]) => {
    setRejected(results.filter((r) => r.verdict === "rejected"));
    const usable = results.filter((r) => r.verdict !== "rejected");
    if (usable.length === 0) return;

    setManifest((m) => {
      if (!m) return m;
      const existing = new Set(m.clips.map((c) => c.sourcePath));
      const added: ProjectClip[] = usable
        // Re-importing the same file should not duplicate the clip.
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
      if (added.length === 0) return m;
      return { ...m, clips: [...m.clips, ...added] };
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

  // --- segment editing -----------------------------------------------------

  const onChangeSegments = useCallback((clipId: string, segments: Segment[]) => {
    setManifest((m) =>
      m ? { ...m, clips: m.clips.map((c) => (c.id === clipId ? { ...c, segments } : c)) } : m,
    );
    setDirty(true);
  }, []);

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

      <footer className="footer">
        <span className="badge">Stage A</span>
        <p>Clip library and segment descriptions. Story ideas and script come next.</p>
      </footer>
    </main>
  );
}

export default App;

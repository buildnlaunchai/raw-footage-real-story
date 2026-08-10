/** New / open / recent projects. The first thing seen on launch. */
import { useEffect, useState } from "react";
import { deleteProject, listProjects, type ProjectSummary } from "../lib/project";

interface Props {
  onCreate: (name: string) => void;
  onOpen: (id: string) => void;
  busy: boolean;
  error: string | null;
}

function when(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(t).toLocaleDateString();
}

export function ProjectPicker({ onCreate, onOpen, busy, error }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState("");
  const [listError, setListError] = useState<string | null>(null);

  async function refresh() {
    try {
      setProjects(await listProjects());
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Projects</h2>
        <p className="hint">A project is your footage; you can cut many videos from it.</p>
      </div>

      <form
        className="voice-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate(name.trim());
        }}
      >
        <label className="visually-hidden" htmlFor="project-name">
          New project name
        </label>
        <input
          id="project-name"
          className="clip-input"
          value={name}
          disabled={busy}
          placeholder="e.g. Iceland, March"
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
          {busy ? "Working…" : "New project"}
        </button>
      </form>

      {(error || listError) && (
        <div className="error" role="alert">
          <strong>Something went wrong.</strong>
          <span>{error ?? listError}</span>
        </div>
      )}

      {projects.length > 0 && (
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id} className="project-row">
              <button
                type="button"
                className="project-open"
                onClick={() => onOpen(p.id)}
                disabled={busy}
              >
                <span className="project-name">{p.name}</span>
                <span className="hint">
                  {p.clipCount} clip{p.clipCount === 1 ? "" : "s"}
                  {p.clipCount > 0 && ` · ${p.describedClipCount} described`}
                  {p.videoCount > 0 && ` · ${p.videoCount} video${p.videoCount === 1 ? "" : "s"}`}
                  {` · ${when(p.updatedAt)}`}
                </span>
              </button>
              <button
                type="button"
                className="icon-button"
                title="Delete project"
                aria-label={`Delete ${p.name}`}
                disabled={busy}
                onClick={async () => {
                  await deleteProject(p.id);
                  void refresh();
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {projects.length === 0 && !listError && (
        <p className="placeholder-note">No projects yet. Name one above to begin.</p>
      )}
    </section>
  );
}

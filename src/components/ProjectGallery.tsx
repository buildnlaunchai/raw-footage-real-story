/**
 * The launch screen: a project as a poster, its footage playing behind it.
 *
 * A project is a pile of clips until you can see it. Selecting one plays its
 * footage end to end in the background, which answers "what is actually in
 * here" far faster than a row of filenames — and the frame you stop on is
 * offered as the cover, so choosing artwork costs one click on something you
 * were already looking at.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  clearPoster,
  deleteProject,
  setPosterFromFrame,
  setPosterFromImage,
  type ProjectSummary,
} from "../lib/project";
import { audioUrl } from "../lib/voiceover";
import { PlayIcon, SearchIcon } from "./Icons";

interface Props {
  /**
   * Owned by the app, not by this screen.
   *
   * The gallery used to load and delete from its own copy, which is how
   * deleting a project here left it listed in the sidebar: two lists of the
   * same fact, and only one of them was told.
   */
  projects: ProjectSummary[];
  /** Re-read projects, storage and the clip library after a change here. */
  onRefresh: () => void | Promise<void>;
  onCreate: (name: string) => void;
  /**
   * False once the grace period has run out. Existing projects still open and
   * still export — only starting new ones waits for a connection. The rule
   * itself is `allowsNewProjects` in entitlement.ts; this only renders it.
   */
  canCreate: boolean;
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

export function ProjectGallery({
  projects,
  onRefresh,
  onCreate,
  canCreate,
  onOpen,
  busy,
  error,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [posterError, setPosterError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");

  /** Which clip of the selected project is on screen. */
  const [reelIndex, setReelIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  async function refresh(keep?: string) {
    await onRefresh();
    if (keep) setSelectedId(keep);
  }

  // Follow the list: a selection that was deleted elsewhere should not linger,
  // and an empty selection should land on something.
  useEffect(() => {
    setSelectedId((cur) =>
      cur && projects.some((p) => p.id === cur) ? cur : (projects[0]?.id ?? null),
    );
  }, [projects]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
  }, [projects, query]);

  const selected = projects.find((p) => p.id === selectedId) ?? null;
  const reel = selected?.previewPaths ?? [];
  const currentClip = reel[reelIndex] ?? null;

  // Selecting a different project starts its reel from the top.
  useEffect(() => {
    setReelIndex(0);
    setPlaying(reel.length > 0);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Advance through the clips one after another, looping at the end.
  function onClipEnded() {
    if (reel.length === 0) return;
    setReelIndex((i) => (i + 1) % reel.length);
  }

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !currentClip) return;
    if (playing) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [currentClip, playing]);

  const backdrop = selected?.posterPath ?? selected?.thumbnails[0] ?? null;
  const describedAll =
    selected != null && selected.clipCount > 0 && selected.describedClipCount === selected.clipCount;

  async function useCurrentFrame() {
    if (!selected || !currentClip) return;
    setPosterError(null);
    try {
      const at = Math.max(0, Math.round((videoRef.current?.currentTime ?? 0) * 1000));
      await setPosterFromFrame(selected.id, currentClip, at);
      await refresh(selected.id);
    } catch (err) {
      setPosterError(err instanceof Error ? err.message : String(err));
    }
  }

  async function uploadCover() {
    if (!selected) return;
    setPosterError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
      });
      if (typeof picked !== "string") return;
      await setPosterFromImage(selected.id, picked);
      await refresh(selected.id);
    } catch (err) {
      setPosterError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="gallery">
      <div className="gallery-stage">
        {currentClip ? (
          <video
            ref={videoRef}
            className="gallery-media"
            src={audioUrl(currentClip)}
            poster={backdrop ? audioUrl(backdrop) : undefined}
            muted
            playsInline
            onEnded={onClipEnded}
            // A clip that will not decode should not stall the whole reel.
            onError={onClipEnded}
          />
        ) : backdrop ? (
          <img className="gallery-media" src={audioUrl(backdrop)} alt="" />
        ) : (
          <div className="gallery-media gallery-media-empty" />
        )}

        <header className="gallery-top">
          <span className="gallery-brand">Raw Footage</span>
          <nav className="gallery-nav">
            <span aria-current="true">Projects</span>
            <span className="hint">
              {projects.length} project{projects.length === 1 ? "" : "s"}
            </span>
          </nav>
          <label className="gallery-search">
            <SearchIcon />
            <span className="visually-hidden">Search projects</span>
            <input
              value={query}
              placeholder="Search"
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          </label>
        </header>

        <div className="gallery-hero">
          {selected ? (
            <>
              <div className="gallery-chips">
                <span className="gallery-chip">
                  {selected.clipCount} clip{selected.clipCount === 1 ? "" : "s"}
                </span>
                <span className="gallery-chip">
                  {selected.describedClipCount} described
                </span>
                {selected.videoCount > 0 && (
                  <span className="gallery-chip">
                    {selected.videoCount} video{selected.videoCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>

              <h1 className="gallery-title">{selected.name}</h1>

              <p className="gallery-meta">
                <span className={describedAll ? "is-good" : undefined}>
                  {selected.clipCount === 0
                    ? "No footage yet"
                    : describedAll
                      ? "Fully described"
                      : `${selected.clipCount - selected.describedClipCount} still to describe`}
                </span>
                <span className="sep">·</span>
                <span>{when(selected.updatedAt)}</span>
                {reel.length > 0 && (
                  <>
                    <span className="sep">·</span>
                    <span>
                      clip {reelIndex + 1} of {reel.length}
                    </span>
                  </>
                )}
              </p>

              <div className="gallery-actions">
                <button
                  type="button"
                  className="gallery-play"
                  onClick={() => {
                    if (reel.length === 0) return;
                    setPlaying((p) => !p);
                  }}
                  disabled={reel.length === 0}
                  title={reel.length === 0 ? "This project has no footage yet" : undefined}
                >
                  <PlayIcon size={22} />
                  {playing ? "Pause" : reel.length === 0 ? "Nothing to play" : "Play now"}
                </button>

                <button
                  type="button"
                  className="gallery-primary"
                  onClick={() => onOpen(selected.id)}
                  disabled={busy}
                >
                  Make the movie
                </button>

                <div className="gallery-cover-tools">
                  <button
                    type="button"
                    className="gallery-ghost"
                    onClick={useCurrentFrame}
                    disabled={!currentClip}
                    title="Use the frame showing right now as this project's cover"
                  >
                    Use this frame
                  </button>
                  <button type="button" className="gallery-ghost" onClick={uploadCover}>
                    Upload cover
                  </button>
                  {selected.posterPath && (
                    <button
                      type="button"
                      className="gallery-ghost"
                      onClick={async () => {
                        await clearPoster(selected.id);
                        await refresh(selected.id);
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {posterError && (
                <p className="gallery-error" role="alert">
                  Couldn’t set the cover. {posterError}
                </p>
              )}
            </>
          ) : (
            <>
              <h1 className="gallery-title">Raw Footage, Real Story</h1>
              <p className="gallery-lede">
                Bring in a trip’s worth of footage, describe what’s in it, and cut as
                many videos from it as you like. Everything runs on this machine.
              </p>
            </>
          )}

          {error && (
            <p className="gallery-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>

      <section className="gallery-shelf">
        <div className="section-head">
          <h2>Projects</h2>
          {!naming && (
            <button
              type="button"
              className="gallery-ghost"
              onClick={() => setNaming(true)}
              disabled={!canCreate}
              // Said on the control rather than only in the banner: somebody
              // who reaches for this button is owed the reason here, where
              // they are looking.
              title={canCreate ? undefined : "Connect to the internet to start a new project"}
            >
              + New project
            </button>
          )}
        </div>

        {naming && canCreate && (
          <form
            className="gallery-new"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) {
                onCreate(name.trim());
                setName("");
                setNaming(false);
              }
            }}
          >
            <input
              autoFocus
              value={name}
              disabled={busy}
              placeholder="e.g. Iceland, March"
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <button type="submit" className="gallery-primary" disabled={busy || !name.trim()}>
              {busy ? "Working…" : "Create"}
            </button>
            <button
              type="button"
              className="gallery-ghost"
              onClick={() => {
                setNaming(false);
                setName("");
              }}
            >
              Cancel
            </button>
          </form>
        )}

        {shown.length === 0 ? (
          <p className="gallery-empty">
            {projects.length === 0
              ? "No projects yet. Make one to begin."
              : "No project matches that."}
          </p>
        ) : (
          <ul className="gallery-row">
            {shown.map((p) => {
              const art = p.posterPath ?? p.thumbnails[0] ?? null;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    className="gallery-card"
                    aria-current={p.id === selectedId}
                    onClick={() => setSelectedId(p.id)}
                    onDoubleClick={() => onOpen(p.id)}
                    title="Click to preview · double-click to open"
                  >
                    {art ? (
                      <img src={audioUrl(art)} alt="" />
                    ) : (
                      <span className="gallery-card-empty">No footage yet</span>
                    )}
                    <span className="gallery-card-body">
                      <span className="gallery-card-title">{p.name}</span>
                      <span className="gallery-card-sub">
                        {p.clipCount} clip{p.clipCount === 1 ? "" : "s"} ·{" "}
                        {when(p.updatedAt)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="gallery-delete"
                    title={`Delete ${p.name}`}
                    aria-label={`Delete ${p.name}`}
                    disabled={busy}
                    onClick={async () => {
                      await deleteProject(p.id);
                      if (selectedId === p.id) setSelectedId(null);
                      void onRefresh();
                    }}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

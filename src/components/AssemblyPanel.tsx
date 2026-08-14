/** Stage 3 UI — assemble the rough cut, watch it, export it. */
import { useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  INTRO_CLIP_ID,
  saveVideoAs,
  type AssembleResult,
  type FfmpegInfo,
  type RenderProgress,
  type TimelineItem,
} from "../lib/assembly";
import { audioUrl } from "../lib/voiceover";
import { DownloadIcon } from "./Icons";
import type { Clip } from "../lib/types";
import type { VoicedLine } from "../lib/ttsProviders";

interface Props {
  /** Used to name the saved file. */
  title?: string;
  clips: Clip[];
  /** The narration behind the timeline, so each row can show what is said. */
  voiced: VoicedLine[] | null;
  /** Accepted for compatibility; the version string is no longer shown. */
  ffmpeg?: FfmpegInfo;
  result: AssembleResult | null;
  busy: boolean;
  progress: RenderProgress | null;
  error: string | null;
  hasPlaceholders: boolean;
  makingPlaceholders: boolean;
  onMakePlaceholders: () => void;
  onRender: () => void;
  /** The opening this cut will get, or has: its words and how many shots. */
  intro: { hook: string | null; shots: number } | null;
  hasExternalMedia: boolean;
  children?: React.ReactNode;
}

const FIT_LABEL: Record<TimelineItem["fit"], string> = {
  exact: "exact",
  trimmed: "trimmed to fit",
  slowed: "slowed to fit",
  replayed: "shown twice",
};

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function clock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function AssemblyPanel({
  title,
  clips,
  voiced,
  result,
  busy,
  progress,
  error,
  hasPlaceholders,
  makingPlaceholders,
  onMakePlaceholders,
  onRender,
  intro,
  hasExternalMedia,
  children,
}: Props) {
  const byId = new Map(clips.map((c) => [c.id, c]));
  // Keyed by the line's identity, not its clip: one clip can carry several
  // moments, and each has its own narration.
  const narrationFor = new Map(
    (voiced ?? []).map((v) => [`${v.clipId}#${v.segmentIndex ?? 0}`, v.text]),
  );
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The player's own transport, because the browser's default controls hide
  // themselves the moment the pointer settles — which reads as "there is no
  // playhead" to anyone who has not learned to wave at the video first.
  const [playing, setPlaying] = useState(false);
  const [headMs, setHeadMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const suggestedName =
    (title?.trim() || "rough-cut").replace(/[^\w\d ]+/g, "").replace(/\s+/g, "-").toLowerCase() ||
    "rough-cut";
  const [exported, setExported] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  function toggle() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  function seek(ms: number, andPlay = false) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    setHeadMs(ms);
    if (andPlay && v.paused) void v.play();
  }

  /** The row whose slot the playhead is inside, to light it in the list. */
  const playingRow = result?.timeline.findIndex(
    (t) => headMs >= t.timelineStartMs && headMs < t.timelineStartMs + t.timelineDurationMs,
  );

  /**
   * Save the finished cut as an mp4.
   *
   * The bundle and project-file exports were built for handing a project to
   * something else. What is wanted here is the video, so that is the only
   * thing offered.
   */
  async function saveVideo() {
    if (!result) return;
    setExportError(null);
    setExported(null);
    try {
      const path = await save({
        title: "Save video",
        defaultPath: `${suggestedName}.mp4`,
        filters: [{ name: "MP4 video", extensions: ["mp4"] }],
      });
      if (!path) return;
      setExported(await saveVideoAs(result.videoPath, path));
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Rough cut</h2>
        {result && (
          <p className="hint">
            {secs(result.durationMs)} · 1080p30 · {result.timeline.length} shots
          </p>
        )}
      </div>

      {import.meta.env.DEV && !hasPlaceholders && (
        <div className="dev-strip">
          <span className="dev-badge">Dev</span>
          <p>
            Video upload isn’t built yet. Generate stand-in colour cards so the
            assembly can be watched end to end.
          </p>
          <button
            type="button"
            className="ghost-button small"
            onClick={onMakePlaceholders}
            disabled={busy || makingPlaceholders}
          >
            {makingPlaceholders ? "Generating…" : "Use placeholder clips"}
          </button>
        </div>
      )}

      {children}

      <div className="actions">
        <button type="button" className="primary-button" onClick={onRender} disabled={busy}>
          {busy ? "Assembling…" : result ? "Re-assemble" : "Assemble rough cut"}
        </button>
        {busy && progress && (
          <span className="hint">
            {progress.stage === "placeholders"
              ? `Placeholder ${progress.done} of ${progress.total}`
              : "Encoding…"}
          </span>
        )}
      </div>

      {error && (
        <div className="error" role="alert">
          <strong>Couldn’t assemble the rough cut.</strong>
          <span>{error}</span>
        </div>
      )}

      {result && !busy && (
        <>
          <div className="tl-viewer">
            <div className="tl-stage">
              <video
                ref={videoRef}
                className="tl-video"
                src={audioUrl(result.videoPath)}
                preload="metadata"
                playsInline
                onClick={toggle}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onTimeUpdate={(e) => setHeadMs(e.currentTarget.currentTime * 1000)}
                onLoadedMetadata={(e) => setDurationMs(e.currentTarget.duration * 1000)}
              />
            </div>
            <div className="tl-transport">
              <button
                type="button"
                className="primary-button small"
                onClick={toggle}
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? "❚❚ Pause" : "▶ Play"}
              </button>
              <button
                type="button"
                className="ghost-button small"
                onClick={() => seek(0)}
                title="Back to the start"
              >
                ↺
              </button>
              <input
                className="tl-seek"
                type="range"
                min={0}
                max={Math.max(1, Math.round(durationMs))}
                value={Math.min(Math.round(headMs), Math.round(durationMs))}
                aria-label="Playhead"
                onChange={(e) => seek(Number(e.currentTarget.value))}
              />
              <span className="tl-clock">
                {clock(headMs)} / {clock(durationMs || result.durationMs)}
              </span>
            </div>
          </div>

          <div className="actions">
            <button type="button" className="primary-button" onClick={saveVideo}>
              <DownloadIcon /> Save video (.mp4)
            </button>
            <span className="hint">
              {secs(result.durationMs)} · {result.timeline.length} shots
              {result.timeline.some((t) => t.clipId === INTRO_CLIP_ID) &&
                ` (including the opening)`}
            </span>
          </div>

          <details className="shot-details">
            <summary>
              Shot list · click a row to play the film from that moment
            </summary>
            <ol className="script-list timeline-list">
              {result.timeline.map((item, i) => {
                const isIntro = item.clipId === INTRO_CLIP_ID;
                // The opening is numbered out of the sequence, so line one of
                // the script is still row one of the cut.
                const number = i + (result.timeline[0].clipId === INTRO_CLIP_ID ? 0 : 1);
                return (
                  <li
                    key={`${item.clipId}#${item.segmentIndex}`}
                    className="script-row shot-row-seek"
                    data-playing={playingRow === i || undefined}
                    onClick={() => seek(item.timelineStartMs, true)}
                    title="Play from here"
                  >
                    <span className="clip-index" aria-hidden="true">
                      {isIntro ? "▶" : String(number).padStart(2, "0")}
                    </span>
                    <div className="voiced-body">
                      <p className="script-clip">
                        {isIntro
                          ? `Opening montage · ${intro?.shots ?? 0} shot${
                              (intro?.shots ?? 0) === 1 ? "" : "s"
                            }`
                          : byId.get(item.clipId)?.description}
                      </p>
                      <p className="script-text">
                        {isIntro
                          ? intro?.hook
                          : narrationFor.get(`${item.clipId}#${item.segmentIndex}`)}
                      </p>
                      <div className="voiced-controls">
                        <span className="hint">
                          {secs(item.timelineStartMs)} →{" "}
                          {secs(item.timelineStartMs + item.timelineDurationMs)}
                        </span>
                        {!isIntro && (
                          <span className={`fit-chip fit-${item.fit}`}>{FIT_LABEL[item.fit]}</span>
                        )}
                        {isIntro && <span className="fit-chip fit-exact">montage</span>}
                        {item.stretch > 1.01 && (
                          <span
                            className={item.fit === "replayed" ? "skip-chip" : "hint"}
                            title={
                              item.fit === "replayed"
                                ? "This line has more words than the clip has seconds. Slowing stops at 2x, so the shot is shown again to cover the rest — shorten the line, or describe more of this clip."
                                : "Slowed slightly so the picture keeps moving under the narration."
                            }
                          >
                            {item.stretch.toFixed(2)}× slower
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </details>

          {hasExternalMedia && (
            <p className="placeholder-note">
              Video files are referenced where they sit, not copied. The bundle
              pulls them in at export; consolidate now if you plan to move or
              delete the originals.
            </p>
          )}

          {exported && <p className="placeholder-note">Exported to {exported}</p>}
          {exportError && (
            <div className="error" role="alert">
              <strong>Export failed.</strong>
              <span>{exportError}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

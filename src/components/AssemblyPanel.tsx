/** Stage 3 UI — assemble the rough cut, watch it, export it. */
import { useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
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
  ffmpeg: FfmpegInfo;
  result: AssembleResult | null;
  busy: boolean;
  progress: RenderProgress | null;
  error: string | null;
  hasPlaceholders: boolean;
  makingPlaceholders: boolean;
  onMakePlaceholders: () => void;
  onRender: () => void;
  hasExternalMedia: boolean;
  children?: React.ReactNode;
}

const FIT_LABEL: Record<TimelineItem["fit"], string> = {
  exact: "exact",
  trimmed: "trimmed to fit",
  held: "last frame held",
};

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function AssemblyPanel({
  title,
  clips,
  voiced,
  ffmpeg,
  result,
  busy,
  progress,
  error,
  hasPlaceholders,
  makingPlaceholders,
  onMakePlaceholders,
  onRender,
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
  const suggestedName =
    (title?.trim() || "rough-cut").replace(/[^\w\d ]+/g, "").replace(/\s+/g, "-").toLowerCase() ||
    "rough-cut";
  const [exported, setExported] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

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
        <p className="hint">
          {result ? `${secs(result.durationMs)} · 1080p30` : ffmpeg.version.replace(/^ffmpeg /, "")}
        </p>
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
          <video
            ref={videoRef}
            className="preview"
            controls
            src={audioUrl(result.videoPath)}
            preload="metadata"
          />

          <ol className="script-list timeline-list">
            {result.timeline.map((item, i) => (
              <li key={`${item.clipId}#${item.segmentIndex}`} className="script-row">
                <span className="clip-index" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="voiced-body">
                  <p className="script-clip">{byId.get(item.clipId)?.description}</p>
                  <p className="script-text">
                    {narrationFor.get(`${item.clipId}#${item.segmentIndex}`)}
                  </p>
                  <div className="voiced-controls">
                    <span className="hint">
                      {secs(item.timelineStartMs)} → {secs(item.timelineStartMs + item.timelineDurationMs)}
                    </span>
                    <span className={`fit-chip fit-${item.fit}`}>{FIT_LABEL[item.fit]}</span>
                    {item.holdMs > 0 && <span className="hint">held {secs(item.holdMs)}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ol>

          <div className="actions">
            <button type="button" className="primary-button" onClick={saveVideo}>
              <DownloadIcon /> Save video (.mp4)
            </button>
            <span className="hint">
              {secs(result.durationMs)} · {result.timeline.length} shots
            </span>
          </div>

          {hasExternalMedia && (
            <p className="placeholder-note">
              Video files are referenced where they sit, not copied. The bundle
              pulls them in at export; consolidate now if you plan to move or
              delete the originals.
            </p>
          )}

          {exported && (
            <p className="placeholder-note">Exported to {exported}</p>
          )}
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

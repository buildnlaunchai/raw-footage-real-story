/** Stage 3 UI — assemble the rough cut, watch it, export it. */
import { useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  exportBundle,
  exportProjectOnly,
  type AssembleResult,
  type FfmpegInfo,
  type RenderProgress,
  type TimelineItem,
} from "../lib/assembly";
import { audioUrl } from "../lib/voiceover";
import type { Clip } from "../lib/types";

interface Props {
  clips: Clip[];
  ffmpeg: FfmpegInfo;
  result: AssembleResult | null;
  busy: boolean;
  progress: RenderProgress | null;
  error: string | null;
  hasPlaceholders: boolean;
  makingPlaceholders: boolean;
  projectId: string;
  onMakePlaceholders: () => void;
  onRender: () => void;
  onConsolidate: () => void;
  consolidating: boolean;
  hasExternalMedia: boolean;
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
  clips,
  ffmpeg,
  result,
  busy,
  progress,
  error,
  hasPlaceholders,
  makingPlaceholders,
  projectId,
  onMakePlaceholders,
  onRender,
  onConsolidate,
  consolidating,
  hasExternalMedia,
}: Props) {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  async function doExport(kind: "bundle" | "project") {
    setExportError(null);
    setExported(null);
    try {
      const path = await save({
        title: kind === "bundle" ? "Export bundle" : "Export project file",
        defaultPath: kind === "bundle" ? "rough-cut-bundle.zip" : "project.json",
        filters:
          kind === "bundle"
            ? [{ name: "Zip archive", extensions: ["zip"] }]
            : [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const written =
        kind === "bundle"
          ? await exportBundle(projectId, path)
          : await exportProjectOnly(projectId, path);
      setExported(written);
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
              <li key={item.clipId} className="script-row">
                <span className="clip-index" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="voiced-body">
                  <p className="script-clip">{byId.get(item.clipId)?.description}</p>
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
            <button type="button" className="primary-button" onClick={() => doExport("bundle")}>
              Export bundle (.zip)
            </button>
            <button type="button" className="ghost-button" onClick={() => doExport("project")}>
              Project file only
            </button>
            {hasExternalMedia && (
              <button
                type="button"
                className="ghost-button"
                onClick={onConsolidate}
                disabled={consolidating}
                title="Copy referenced video files into the project folder so it survives the originals moving"
              >
                {consolidating ? "Copying…" : "Consolidate media"}
              </button>
            )}
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

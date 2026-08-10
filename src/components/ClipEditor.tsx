/**
 * Clip list: each clip pairs a description with (optionally) a video file.
 *
 * The description stays required — it's what the model reads to write the
 * narration. Video is an additional field, not a replacement for it.
 */
import { audioUrl } from "../lib/voiceover";
import type { Clip } from "../lib/types";

interface Props {
  clips: Clip[];
  disabled: boolean;
  importing: boolean;
  onChange: (id: string, description: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onAddMedia: (id: string) => void;
  onClearMedia: (id: string) => void;
  onImportClips: () => void;
}

function formatDuration(ms?: number): string {
  if (!ms) return "";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function ClipEditor({
  clips,
  disabled,
  importing,
  onChange,
  onRemove,
  onAdd,
  onAddMedia,
  onClearMedia,
  onImportClips,
}: Props) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Clips</h2>
        <p className="hint">Describe what each clip shows. Order matters.</p>
      </div>

      <ul className="clip-list">
        {clips.map((clip, i) => (
          <li key={clip.id} className="clip-row">
            <span className="clip-index" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>

            <div className="clip-body">
              <label className="visually-hidden" htmlFor={`clip-${clip.id}`}>
                Description for clip {i + 1}
              </label>
              <textarea
                id={`clip-${clip.id}`}
                className="clip-input"
                rows={2}
                value={clip.description}
                disabled={disabled}
                placeholder="e.g. Empty harbour at dawn, boats frozen in"
                onChange={(e) => onChange(clip.id, e.currentTarget.value)}
              />

              <div className="media-slot">
                {clip.sourcePath ? (
                  <>
                    {clip.thumbnailPath ? (
                      <img
                        className="media-thumb"
                        src={audioUrl(clip.thumbnailPath)}
                        alt=""
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="media-thumb media-thumb-empty" aria-hidden="true" />
                    )}
                    <span className="media-name" title={clip.sourcePath}>
                      {clip.isPlaceholder
                        ? "Placeholder card"
                        : clip.fileName ?? clip.sourcePath}
                    </span>
                    <span className="hint">{formatDuration(clip.sourceDurationMs)}</span>
                    {clip.isHdr && <span className="skip-chip">HDR</span>}
                    <button
                      type="button"
                      className="ghost-button small"
                      disabled={disabled}
                      onClick={() => onClearMedia(clip.id)}
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ghost-button small"
                    disabled={disabled || importing}
                    onClick={() => onAddMedia(clip.id)}
                  >
                    + Add video
                  </button>
                )}
              </div>

              {clip.warnings && clip.warnings.length > 0 && (
                <ul className="media-warnings">
                  {clip.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </div>

            <button
              type="button"
              className="icon-button"
              disabled={disabled || clips.length === 1}
              onClick={() => onRemove(clip.id)}
              aria-label={`Remove clip ${i + 1}`}
              title={clips.length === 1 ? "Keep at least one clip" : "Remove clip"}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <div className="actions">
        <button type="button" className="ghost-button" onClick={onAdd} disabled={disabled}>
          + Add clip
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={onImportClips}
          disabled={disabled || importing}
        >
          {importing ? "Reading files…" : "Add clips…"}
        </button>
        <span className="hint">or drop video files anywhere</span>
      </div>
    </section>
  );
}

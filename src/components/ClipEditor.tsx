/**
 * Clip list + per-clip description.
 *
 * The description field is the real input for now; actual video file handling
 * lands in a later stage and slots in alongside it without changing this shape.
 */
import type { Clip } from "../lib/types";

interface Props {
  clips: Clip[];
  disabled: boolean;
  onChange: (id: string, description: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

export function ClipEditor({ clips, disabled, onChange, onRemove, onAdd }: Props) {
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

      <button type="button" className="ghost-button" onClick={onAdd} disabled={disabled}>
        + Add clip
      </button>

      <p className="placeholder-note">
        Video upload isn’t wired up yet — descriptions stand in for the footage.
      </p>
    </section>
  );
}

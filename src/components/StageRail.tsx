/**
 * The pipeline, always on screen, always clickable.
 *
 * Every stage shows its own state, so "where am I" and "what still needs doing"
 * are answered without moving. Nothing is disabled: a stage that cannot run yet
 * still opens and says what it is waiting for, which teaches the order better
 * than a dead button does.
 */
import { CheckIcon, AlertIcon, STAGE_ICONS } from "./Icons";
import {
  STAGES,
  STAGE_ORDER,
  type StageId,
  type StageStatus,
} from "../lib/pipeline";
import type { ProjectClip } from "../lib/project";

interface Props {
  active: StageId;
  statuses: Record<StageId, StageStatus>;
  /** One line per stage: what it holds now, or what it is waiting for. */
  summaries: Record<StageId, string>;
  staleNotes: Partial<Record<StageId, string | null>>;
  onStage: (id: StageId) => void;

  clips: ProjectClip[];
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  thumbUrl: (clip: ProjectClip) => string | null;
}

const STATUS_LABEL: Record<StageStatus, string> = {
  empty: "not started",
  ready: "ready",
  working: "working",
  done: "done",
  stale: "needs attention",
};

export function StageRail({
  active,
  statuses,
  summaries,
  staleNotes,
  onStage,
  clips,
  selectedClipId,
  onSelectClip,
  thumbUrl,
}: Props) {
  return (
    <aside className="rail">
      <p className="rail-brand">Raw Footage</p>

      <ol className="stage-rail">
        {STAGE_ORDER.map((id, i) => {
          const status = statuses[id];
          const Icon = STAGE_ICONS[id];
          const note = staleNotes[id];
          return (
            <li
              key={id}
              className="stage-item"
              aria-current={active === id}
              data-done={status === "done"}
            >
              <button type="button" className="stage-button" onClick={() => onStage(id)}>
                <span
                  className="stage-dot"
                  data-status={status}
                  title={`${STAGES[id].label} — ${STATUS_LABEL[status]}`}
                >
                  {status === "done" ? (
                    <CheckIcon />
                  ) : status === "stale" ? (
                    <AlertIcon />
                  ) : (
                    <Icon size={14} />
                  )}
                </span>
                <span className="stage-text">
                  <span className="stage-name">
                    {i + 1}. {STAGES[id].label}
                  </span>
                  <span className="stage-sub" data-tone={note ? "stale" : undefined}>
                    {note ?? summaries[id]}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <hr className="rail-divider" />

      <p className="rail-heading">
        Your clips {clips.length > 0 && <span className="hint">· {clips.length}</span>}
      </p>

      {clips.length === 0 ? (
        <p className="hint" style={{ margin: "0 0 0 0.55rem" }}>
          Nothing imported yet.
        </p>
      ) : (
        <ul className="rail-list">
          {clips.map((clip) => {
            const thumb = thumbUrl(clip);
            const described = clip.segments.filter((s) => s.text.trim()).length;
            return (
              <li key={clip.id}>
                <button
                  type="button"
                  className="rail-row"
                  aria-current={selectedClipId === clip.id}
                  onClick={() => onSelectClip(clip.id)}
                >
                  {thumb ? (
                    <img className="rail-thumb" src={thumb} alt="" />
                  ) : (
                    <span className="rail-thumb-empty">—</span>
                  )}
                  <span className="stage-text">
                    <span className="rail-name">
                      {clip.sourcePath?.split("/").pop() ?? "Placeholder clip"}
                    </span>
                    <span className="rail-sub">
                      {described} of {clip.segments.length} described
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

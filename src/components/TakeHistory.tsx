/**
 * Previous attempts at one stage.
 *
 * Regenerating used to overwrite, so the only way to compare two scripts was to
 * remember the first one. Each generation is kept until it is deleted on
 * purpose.
 */
import { ofKind, whenTaken, type Take, type TakeKind } from "../lib/takes";

interface Props {
  kind: TakeKind;
  takes: Take[];
  /** The take currently loaded, if any, so it can say so rather than offer to restore it. */
  currentId: string | null;
  busy: boolean;
  onRestore: (take: Take) => void;
  onDelete: (take: Take) => void;
  onPlay?: (take: Take) => void;
}

const NOUN: Record<TakeKind, string> = {
  script: "script",
  voice: "recording",
  render: "cut",
};

export function TakeHistory({
  kind,
  takes,
  currentId,
  busy,
  onRestore,
  onDelete,
  onPlay,
}: Props) {
  const mine = ofKind(takes, kind);
  if (mine.length === 0) return null;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          Previous {NOUN[kind]}s <span className="hint">· {mine.length}</span>
        </h2>
      </div>

      <ul className="take-list">
        {mine.map((t) => {
          const current = t.id === currentId;
          return (
            <li key={t.id} className="take-row" data-current={current || undefined}>
              <div style={{ minWidth: 0 }}>
                <p className="take-label">
                  {t.label}
                  {current && <span className="badge">current</span>}
                </p>
                <p className="take-detail">
                  {whenTaken(t.createdAt)}
                  {t.detail && ` · ${t.detail}`}
                </p>
              </div>

              <div className="actions">
                {kind === "render" && onPlay && t.videoPath && (
                  <button
                    type="button"
                    className="ghost-button small"
                    onClick={() => onPlay(t)}
                  >
                    ▶ Watch
                  </button>
                )}
                {!current && (
                  <button
                    type="button"
                    className="ghost-button small"
                    onClick={() => onRestore(t)}
                    disabled={busy}
                    title={
                      kind === "render"
                        ? "Make this the cut being shown"
                        : `Load this ${NOUN[kind]} back into the editor`
                    }
                  >
                    Restore
                  </button>
                )}
                <button
                  type="button"
                  className="describer-remove"
                  onClick={() => onDelete(t)}
                  disabled={busy}
                  title={
                    kind === "render"
                      ? "Delete this take and its video file"
                      : `Forget this ${NOUN[kind]}`
                  }
                  aria-label="Delete this take"
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

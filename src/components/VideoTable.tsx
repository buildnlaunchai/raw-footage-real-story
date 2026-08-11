/**
 * Every clip in the library, as a table you can describe from.
 *
 * Describing footage is the one task in this app that is genuinely bulk work,
 * and a table is the right shape for it: the description sits beside the frame
 * it belongs to, and moving down the list is one keystroke.
 */
import { useState } from "react";
import {
  containerOf,
  formatDuration,
  formatWhen,
  tagHue,
  type LibraryClip,
} from "../lib/library";
import { audioUrl } from "../lib/voiceover";
import { PencilIcon, PlayCircleIcon, StarIcon, TrashIcon, UndoIcon } from "./Icons";

interface Props {
  clips: LibraryClip[];
  /** Rows currently saving, keyed `projectId/clipId`. */
  saving: Set<string>;
  trashView: boolean;
  onPlay: (clip: LibraryClip) => void;
  onFavorite: (clip: LibraryClip) => void;
  onDelete: (clip: LibraryClip) => void;
  onRestore: (clip: LibraryClip) => void;
  onPurge: (clip: LibraryClip) => void;
  onDescribe: (clip: LibraryClip, text: string) => void;
  /** Send a multi-segment clip to the editor that can handle it. */
  onOpenSegments: (clip: LibraryClip) => void;
  onOpenProject: (projectId: string) => void;
}

export function VideoTable({
  clips,
  saving,
  trashView,
  onPlay,
  onFavorite,
  onDelete,
  onRestore,
  onPurge,
  onDescribe,
  onOpenSegments,
  onOpenProject,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const key = (c: LibraryClip) => `${c.projectId}/${c.clipId}`;

  function startEdit(c: LibraryClip) {
    if (c.segmentCount > 1) {
      onOpenSegments(c);
      return;
    }
    setEditing(key(c));
    setDraft(c.description);
  }

  function commit(c: LibraryClip) {
    if (draft.trim() !== c.description.trim()) onDescribe(c, draft.trim());
    setEditing(null);
  }

  return (
    <div className="lib-scroll">
      <table className="lib-table">
        <thead>
          <tr>
            <th>Video</th>
            <th>Description</th>
            <th>Duration</th>
            <th>Date added</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {clips.map((c) => {
            const k = key(c);
            const when = formatWhen(c.addedAt);
            const hue = tagHue(c.projectId);
            const isEditing = editing === k;
            const spec = [
              containerOf(c.fileName),
              c.width && c.height ? `${c.width}x${c.height}` : null,
              c.codec,
              c.isHdr ? "HDR" : null,
            ]
              .filter(Boolean)
              .join(" • ");

            return (
              <tr key={k}>
                <td>
                  <div className="lib-video-cell">
                    <button
                      type="button"
                      className="lib-thumb"
                      onClick={() => onPlay(c)}
                      title="Play this clip"
                    >
                      {c.thumbnailPath ? (
                        <img src={audioUrl(c.thumbnailPath)} alt="" />
                      ) : (
                        <span className="lib-thumb-empty">no frame</span>
                      )}
                      <span className="lib-dur-badge">{formatDuration(c.durationMs)}</span>
                    </button>

                    <div style={{ minWidth: 0 }}>
                      <p className="lib-video-name" title={c.fileName}>
                        {c.fileName}
                      </p>
                      <p className="lib-video-spec">{spec}</p>
                      <button
                        type="button"
                        className="lib-tag"
                        style={{
                          color: `hsl(${hue} 70% 68%)`,
                          borderColor: `hsl(${hue} 60% 34%)`,
                          background: `hsl(${hue} 60% 16%)`,
                        }}
                        onClick={() => onOpenProject(c.projectId)}
                        title={`Open ${c.projectName}`}
                      >
                        {c.projectName}
                      </button>
                    </div>
                  </div>
                </td>

                <td>
                  <div className="lib-desc">
                    {isEditing ? (
                      <textarea
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.currentTarget.value)}
                        onBlur={() => commit(c)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setEditing(null);
                          // Enter commits; Shift+Enter keeps a line break, since
                          // some descriptions genuinely want two sentences.
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            commit(c);
                          }
                        }}
                        placeholder="What happens in this clip?"
                      />
                    ) : (
                      <span className={c.description ? undefined : "lib-desc-empty"}>
                        {c.description || "Not described yet"}
                      </span>
                    )}

                    <button
                      type="button"
                      className="lib-desc-edit"
                      onClick={() => (isEditing ? commit(c) : startEdit(c))}
                      title={
                        c.segmentCount > 1
                          ? "This clip has several described moments — open the segment editor"
                          : "Edit description"
                      }
                    >
                      <PencilIcon size={14} />
                    </button>
                  </div>

                  {c.segmentCount > 1 && (
                    <p className="lib-locked">
                      {c.segmentCount} described moments · edit in Footage
                    </p>
                  )}
                  {saving.has(k) && <p className="lib-locked">Saving…</p>}
                </td>

                <td className="lib-when">{formatDuration(c.durationMs)}</td>

                <td className="lib-when">
                  {when.date}
                  <span>{when.time}</span>
                </td>

                <td>
                  <div className="lib-actions">
                    {trashView ? (
                      <>
                        <button
                          type="button"
                          className="lib-act"
                          onClick={() => onRestore(c)}
                          title="Put back"
                        >
                          <UndoIcon />
                        </button>
                        <button
                          type="button"
                          className="lib-act"
                          onClick={() => onPurge(c)}
                          title="Delete for good"
                        >
                          <TrashIcon />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="lib-act"
                          onClick={() => onPlay(c)}
                          title="Play"
                        >
                          <PlayCircleIcon />
                        </button>
                        <button
                          type="button"
                          className="lib-act"
                          onClick={() => startEdit(c)}
                          title="Edit description"
                        >
                          <PencilIcon />
                        </button>
                        <button
                          type="button"
                          className="lib-act"
                          onClick={() => onDelete(c)}
                          title="Move to trash"
                        >
                          <TrashIcon />
                        </button>
                        <button
                          type="button"
                          className="lib-act"
                          data-on={c.favorite}
                          onClick={() => onFavorite(c)}
                          title={c.favorite ? "Remove from favourites" : "Add to favourites"}
                          aria-pressed={c.favorite}
                        >
                          <StarIcon filled={c.favorite} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

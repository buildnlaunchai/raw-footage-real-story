/**
 * Every clip in the library, as a table you can describe from.
 *
 * Describing footage is the one task in this app that is genuinely bulk work,
 * and a table is the right shape for it: the description sits beside the frame
 * it belongs to, and moving down the list is one keystroke.
 */
import {
  containerOf,
  formatDuration,
  formatWhen,
  tagHue,
  type LibraryClip,
} from "../lib/library";
import { audioUrl } from "../lib/voiceover";
import { useState } from "react";
import { PencilIcon, PlayCircleIcon, TrashIcon } from "./Icons";

interface Props {
  clips: LibraryClip[];
  onPlay: (clip: LibraryClip) => void;
  /** Open the describe view, which handles both whole clips and split ones. */
  onDescribe: (clip: LibraryClip) => void;
  /**
   * Remove clips from the library. One or many — the same call, because
   * deleting forty is the same act as deleting one and a separate path for
   * each is a second place to get it wrong.
   */
  onDelete: (clips: LibraryClip[]) => void;
  onOpenProject: (projectId: string) => void;
}

export function VideoTable({
  clips,
  onPlay,
  onDescribe,
  onDelete,
  onOpenProject,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const key = (c: LibraryClip) => `${c.projectId}/${c.clipId}`;

  // Selection is scoped to what is on screen. Carrying it across a page or a
  // filter change means "delete 40" could include rows the user never saw.
  const shown = clips.map(key);
  const picked = clips.filter((c) => selected.has(key(c)));
  const allShown = shown.length > 0 && shown.every((k) => selected.has(k));

  function toggle(k: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function toggleAll() {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allShown) shown.forEach((k) => next.delete(k));
      else shown.forEach((k) => next.add(k));
      return next;
    });
  }

  return (
    <div>
      {picked.length > 0 && (
        <div className="bulk-bar" role="status">
          <strong>
            {picked.length} selected
          </strong>
          <button
            type="button"
            className="ghost-button small"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
          <button
            type="button"
            className="primary-button small bulk-delete"
            onClick={() => {
              onDelete(picked);
              setSelected(new Set());
            }}
          >
            <TrashIcon size={15} /> Remove {picked.length} from library
          </button>
        </div>
      )}

      <div className="lib-scroll">
      <table className="lib-table">
        <thead>
          <tr>
            <th className="lib-pick">
              <input
                type="checkbox"
                checked={allShown}
                onChange={toggleAll}
                aria-label={allShown ? "Deselect all on this page" : "Select all on this page"}
              />
            </th>
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
            const spec = [
              containerOf(c.fileName),
              c.width && c.height ? `${c.width}x${c.height}` : null,
              c.codec,
              c.isHdr ? "HDR" : null,
            ]
              .filter(Boolean)
              .join(" • ");

            return (
              <tr key={k} data-picked={selected.has(k) || undefined}>
                <td className="lib-pick">
                  <input
                    type="checkbox"
                    checked={selected.has(k)}
                    onChange={() => toggle(k)}
                    aria-label={`Select ${c.fileName}`}
                  />
                </td>
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
                      <button
                        type="button"
                        className="lib-video-name lib-name-button"
                        title={c.fileName}
                        onClick={() => onDescribe(c)}
                      >
                        {c.fileName}
                      </button>
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
                  {/* Editing happens in the describe view: it is the only one
                      that can express a clip split into several moments. */}
                  <button
                    type="button"
                    className="lib-desc lib-desc-open"
                    onClick={() => onDescribe(c)}
                    title="Describe this clip"
                  >
                    <span className={c.description ? undefined : "lib-desc-empty"}>
                      {c.description || "Not described yet"}
                    </span>
                    <span className="lib-desc-edit" aria-hidden="true">
                      <PencilIcon size={14} />
                    </span>
                  </button>

                  {c.segmentCount > 1 && (
                    <p className="lib-locked">{c.segmentCount} described moments</p>
                  )}
                </td>

                <td className="lib-when">{formatDuration(c.durationMs)}</td>

                <td className="lib-when">
                  {when.date}
                  <span>{when.time}</span>
                </td>

                <td>
                  <div className="lib-actions">
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
                      onClick={() => onDescribe(c)}
                      title="Describe this clip"
                    >
                      <PencilIcon />
                    </button>
                    <button
                      type="button"
                      className="lib-act lib-act-danger"
                      onClick={() => onDelete([c])}
                      title="Remove from the library (the video file itself is left alone)"
                      aria-label={`Remove ${c.fileName}`}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

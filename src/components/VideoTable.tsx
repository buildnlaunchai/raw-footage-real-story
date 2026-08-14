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
import { useRef, useState } from "react";
import { PencilIcon, TrashIcon } from "./Icons";

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
  /**
   * Reordering, when this list is showing one project in its running order.
   *
   * Absent everywhere else: the order belongs to a project, and the
   * all-collections view is several projects interleaved, where "third" would
   * mean nothing.
   */
  reorder?: {
    /** The rows in their new top-to-bottom order. */
    onReorder: (clips: LibraryClip[]) => void;
    /** True when the list is showing last-to-first. */
    reversed: boolean;
  };
}

export function VideoTable({
  clips,
  onPlay,
  onDescribe,
  onDelete,
  onOpenProject,
  reorder,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /**
   * Reordering by pointer rather than by HTML5 drag-and-drop.
   *
   * The first version used `draggable` on the handle and never fired: WebKit —
   * which is the webview this ships in — refuses to begin a drag unless
   * `dataTransfer.setData` is called during dragstart, and a `<button>` brings
   * its own native drag behaviour besides. Pointer events have none of that,
   * work identically on a trackpad and a touchscreen, and give the row-follows-
   * your-finger feedback the drag API cannot.
   */
  const [drag, setDrag] = useState<{ key: string; y: number; overKey: string | null } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
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

  /** Move one row to another row's position and hand the whole order back. */
  function move(fromKey: string, toKey: string) {
    if (!reorder || fromKey === toKey) return;
    const from = clips.findIndex((c) => key(c) === fromKey);
    const to = clips.findIndex((c) => key(c) === toKey);
    if (from < 0 || to < 0) return;
    const next = [...clips];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    reorder.onReorder(next);
  }

  /** Keyboard equivalent, because a drag handle nobody can tab to is a wall. */
  function nudge(k: string, delta: number) {
    const i = clips.findIndex((c) => key(c) === k);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= clips.length) return;
    move(k, key(clips[j]));
  }

  /** Which row the pointer is currently over, by its position on screen. */
  function rowAt(clientY: number): string | null {
    for (const [k, el] of rowRefs.current) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return k;
    }
    return null;
  }

  function startDrag(k: string, e: React.PointerEvent) {
    if (!reorder) return;
    e.preventDefault();
    // Capture on the handle, so the drag survives the pointer leaving the row
    // — which it does immediately, because the row moves out from under it.
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ key: k, y: e.clientY, overKey: k });
  }

  function moveDrag(e: React.PointerEvent) {
    if (!drag) return;
    const overKey = rowAt(e.clientY) ?? drag.overKey;
    setDrag({ ...drag, y: e.clientY, overKey });
    // Keep the row being dropped onto in view when dragging past either end.
    const el = overKey ? rowRefs.current.get(overKey) : null;
    const r = el?.getBoundingClientRect();
    if (r && (r.top < 90 || r.bottom > window.innerHeight - 60)) {
      el?.scrollIntoView({ block: "nearest" });
    }
  }

  function endDrag() {
    if (!drag) return;
    const { key: from, overKey } = drag;
    setDrag(null);
    if (overKey && overKey !== from) move(from, overKey);
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
            {reorder && <th className="lib-order" scope="col"><span className="visually-hidden">Order</span>#</th>}
            <th>Video</th>
            <th>Description</th>
            <th className="lib-when">Added</th>
            <th className="lib-act-cell"><span className="visually-hidden">Remove</span></th>
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
              <tr
                key={k}
                ref={(el) => {
                  if (el) rowRefs.current.set(k, el);
                  else rowRefs.current.delete(k);
                }}
                data-picked={selected.has(k) || undefined}
                data-dragging={drag?.key === k || undefined}
                data-dropzone={
                  (drag && drag.overKey === k && drag.key !== k) || undefined
                }
              >
                {reorder && (
                  <td className="lib-order">
                    <button
                      type="button"
                      className="drag-handle"
                      onPointerDown={(e) => startDrag(k, e)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={() => setDrag(null)}
                      onKeyDown={(e) => {
                        // Up on screen is one step earlier in the film — except
                        // in the reversed view, where up is one step later.
                        const up = reorder.reversed ? 1 : -1;
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          nudge(k, up);
                        } else if (e.key === "ArrowDown") {
                          e.preventDefault();
                          nudge(k, -up);
                        }
                      }}
                      title="Drag to reorder, or use the arrow keys"
                      aria-label={`Position ${c.sequence + 1}. Drag or use arrow keys to reorder ${c.fileName}`}
                    >
                      <span className="drag-grip" aria-hidden="true">⠿</span>
                      <span className="drag-index">{c.sequence + 1}</span>
                    </button>
                  </td>
                )}
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

                <td className="lib-when">
                  {when.date}
                  <span>{when.time}</span>
                </td>

                {/* Delete only. Play is the thumbnail and describe is the
                    description cell, so the other two buttons here were a
                    third copy of each — and they were the reason the table
                    needed scrolling sideways to reach anything. */}
                <td className="lib-act-cell">
                  <button
                    type="button"
                    className="lib-act lib-act-danger"
                    onClick={() => onDelete([c])}
                    title="Remove from the library (the video file itself is left alone)"
                    aria-label={`Remove ${c.fileName}`}
                  >
                    <TrashIcon />
                  </button>
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

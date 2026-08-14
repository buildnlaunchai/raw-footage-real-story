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
import { useEffect, useRef, useState } from "react";
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
  /**
   * A drag in progress: what is held, where the pointer is, and which gap it
   * would drop into.
   *
   * `insertAt` is a gap index from 0 to n, not a row — "before the row
   * currently at this index". Dropping *onto* a row left the answer to "where
   * does this land" ambiguous, which is most of why reordering was hard to
   * follow: above it or below it are different results and the old feedback
   * could not tell them apart.
   */
  const [drag, setDrag] = useState<
    { key: string; x: number; y: number; insertAt: number } | null
  >(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  /** Position being typed, for jumps too long to drag. */
  const [typing, setTyping] = useState<{ key: string; value: string } | null>(null);
  const pointer = useRef({ y: 0 });
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

  /** Drop a row into a gap and hand the whole order back. */
  function moveTo(fromKey: string, insertAt: number) {
    if (!reorder) return;
    const from = clips.findIndex((c) => key(c) === fromKey);
    if (from < 0) return;
    const to = insertAt > from ? insertAt - 1 : insertAt;
    if (to === from) return;
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
    moveTo(k, delta > 0 ? j + 1 : j);
  }

  /**
   * Which gap the pointer is in.
   *
   * Above a row's midpoint means before it, below means after it — the rule
   * every list in every app uses, and the reason a drop can now be predicted
   * rather than discovered.
   */
  function gapAt(clientY: number): number {
    let best = clips.length;
    for (let i = 0; i < clips.length; i++) {
      const el = rowRefs.current.get(key(clips[i]));
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        best = i;
        break;
      }
    }
    return best;
  }

  /**
   * The running-order number a shot would take, in the terms the row shows.
   *
   * Reversed on screen means position one is the *last* clip, so the number on
   * the label has to be worked back from the end or it contradicts the column
   * it is sitting next to.
   */
  function destinationNumber(fromKey: string, insertAt: number): number {
    const from = clips.findIndex((c) => key(c) === fromKey);
    const index = insertAt > from ? insertAt - 1 : insertAt;
    return reorder?.reversed ? clips.length - index : index + 1;
  }

  // While a drag is near the top or bottom of the window, keep scrolling — a
  // fifty-clip list cannot be crossed inside one screen, and a drag that stops
  // dead at the edge is a drag that cannot reach most of its destinations.
  useEffect(() => {
    if (!drag) return;
    let frame = 0;
    const tick = () => {
      const y = pointer.current.y;
      const margin = 110;
      const speed =
        y < margin ? -Math.min(22, (margin - y) / 4)
        : y > window.innerHeight - margin ? Math.min(22, (y - (window.innerHeight - margin)) / 4)
        : 0;
      if (speed !== 0) {
        window.scrollBy(0, speed);
        setDrag((d) => (d ? { ...d, insertAt: gapAt(y) } : d));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const held = drag ? clips.find((c) => key(c) === drag.key) : undefined;

  function startDrag(k: string, e: React.PointerEvent) {
    if (!reorder) return;
    e.preventDefault();
    // Capture on the handle, so the drag survives the pointer leaving the row
    // — which it does immediately, because the row moves out from under it.
    e.currentTarget.setPointerCapture(e.pointerId);
    pointer.current.y = e.clientY;
    setDrag({ key: k, x: e.clientX, y: e.clientY, insertAt: gapAt(e.clientY) });
  }

  function moveDrag(e: React.PointerEvent) {
    if (!drag) return;
    pointer.current.y = e.clientY;
    setDrag({ ...drag, x: e.clientX, y: e.clientY, insertAt: gapAt(e.clientY) });
  }

  function endDrag() {
    if (!drag) return;
    const { key: from, insertAt } = drag;
    setDrag(null);
    moveTo(from, insertAt);
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

      {/* What is being held, following the pointer, and where it will land.
          The single thing missing before: a faded row left behind at its old
          position says nothing about what you picked up or where it is going. */}
      {drag && held && (
        <div
          className="drag-ghost"
          style={{ left: drag.x + 16, top: drag.y - 22 }}
          aria-hidden="true"
        >
          {held.thumbnailPath && <img src={audioUrl(held.thumbnailPath)} alt="" />}
          <span className="drag-ghost-name">{held.fileName}</span>
          <span className="drag-ghost-to">→ {destinationNumber(drag.key, drag.insertAt)}</span>
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
          {clips.map((c, i) => {
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
                data-insert={
                  drag
                    ? drag.insertAt === i
                      ? "before"
                      : drag.insertAt === clips.length && i === clips.length - 1
                        ? "after"
                        : undefined
                    : undefined
                }
              >
                {reorder && (
                  <td className="lib-order">
                    <div className="order-cell">
                      <button
                        type="button"
                        className="drag-handle"
                        onPointerDown={(e) => startDrag(k, e)}
                        onPointerMove={moveDrag}
                        onPointerUp={endDrag}
                        onPointerCancel={() => setDrag(null)}
                        onKeyDown={(e) => {
                          // Up on screen is one step earlier in the film —
                          // except in the reversed view, where up is later.
                          const up = reorder.reversed ? 1 : -1;
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            nudge(k, up);
                          } else if (e.key === "ArrowDown") {
                            e.preventDefault();
                            nudge(k, -up);
                          }
                        }}
                        title="Drag to move this clip, or use the arrow keys"
                        aria-label={`Move ${c.fileName}, currently ${c.sequence + 1}`}
                      >
                        <span className="drag-grip" aria-hidden="true">⠿</span>
                      </button>

                      {/* Typing a number beats dragging for anything more than
                          a few rows: crossing fifty clips by hand means
                          scrolling the whole way with the button held down. */}
                      {typing?.key === k ? (
                        <input
                          className="order-input"
                          autoFocus
                          value={typing.value}
                          inputMode="numeric"
                          aria-label={`Move ${c.fileName} to position`}
                          onChange={(e) => setTyping({ key: k, value: e.currentTarget.value })}
                          onBlur={() => setTyping(null)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const n = Number(typing.value);
                              if (Number.isFinite(n) && n >= 1 && n <= clips.length) {
                                // The number is a running-order position, which
                                // in the reversed view counts from the far end.
                                const index = reorder.reversed ? clips.length - n : n - 1;
                                moveTo(k, index > i ? index + 1 : index);
                              }
                              setTyping(null);
                            } else if (e.key === "Escape") {
                              setTyping(null);
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="order-number"
                          onClick={() => setTyping({ key: k, value: String(c.sequence + 1) })}
                          title="Click to type a position to move this clip to"
                        >
                          {c.sequence + 1}
                        </button>
                      )}
                    </div>
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

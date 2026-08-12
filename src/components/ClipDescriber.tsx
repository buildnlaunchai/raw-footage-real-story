/**
 * Describe footage one clip at a time.
 *
 * Describing is the highest-friction step in the app and the only one that is
 * genuinely repetitive, so it gets a screen built for repetition: watch, type,
 * next. The table is for finding a clip; this is for working through them.
 *
 * Splitting lives here too, because deciding a clip holds two moments is
 * something you discover while watching it, not while reading a list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  initialSegments,
  mergeAt,
  removeAt,
  splitAt,
  type Segment,
} from "../lib/segments";
import { formatDuration, type LibraryClip } from "../lib/library";
import { audioUrl } from "../lib/voiceover";
import { PlayIcon, TrashIcon } from "./Icons";

interface Props {
  /** The clips this view steps through, in the order the table showed them. */
  clips: LibraryClip[];
  startAt: string;
  /** Segments as they stand for a clip, so edits survive stepping away and back. */
  segmentsFor: (clip: LibraryClip) => Segment[];
  onCommit: (clip: LibraryClip, segments: Segment[]) => void;
  /**
   * Remove this clip, then run `after`.
   *
   * The confirmation lives in the app so there is one of it, and the follow-up
   * is passed in because only this view knows where the user was: mid-browse at
   * "8 of 103", which is a position to keep rather than a dialog to close.
   */
  onDelete: (clip: LibraryClip, after: () => void) => void;
  onClose: () => void;
}

function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const key = (c: LibraryClip) => `${c.projectId}/${c.clipId}`;

export function ClipDescriber({
  clips,
  startAt,
  segmentsFor,
  onCommit,
  onDelete,
  onClose,
}: Props) {
  const [onlyUndescribed, setOnlyUndescribed] = useState(false);
  const [currentKey, setCurrentKey] = useState(startAt);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const committed = useRef<{ clip: LibraryClip; segments: Segment[] } | null>(null);

  /**
   * The walk order.
   *
   * The clip being described stays in the list even once it has text, or
   * filtering to undescribed would eject you from the clip you are typing into
   * the moment you typed.
   */
  const walk = useMemo(() => {
    if (!onlyUndescribed) return clips;
    return clips.filter((c) => !c.description.trim() || key(c) === currentKey);
  }, [clips, onlyUndescribed, currentKey]);

  const index = walk.findIndex((c) => key(c) === currentKey);
  const clip = walk[index] ?? walk[0] ?? null;

  // Load the clip's segments whenever the clip changes.
  useEffect(() => {
    if (!clip) return;
    const existing = segmentsFor(clip);
    setSegments(
      existing.length > 0
        ? existing
        : initialSegments((clip.durationMs ?? 0) / 1000),
    );
    setPlayhead(0);
    setMediaError(null);
  }, [clip?.clipId, clip?.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Write the working copy back, unless nothing was typed into a fresh clip. */
  const commit = useCallback(
    (target: LibraryClip | null, next: Segment[]) => {
      if (!target) return;
      const meaningful = next.some((s) => s.text.trim()) || next.length > 1;
      const had = segmentsFor(target).length > 0;
      if (!meaningful && !had) return;
      const last = committed.current;
      if (
        last &&
        key(last.clip) === key(target) &&
        JSON.stringify(last.segments) === JSON.stringify(next)
      ) {
        return;
      }
      committed.current = { clip: target, segments: next };
      onCommit(target, next);
    },
    [onCommit, segmentsFor],
  );

  const go = useCallback(
    (delta: number) => {
      commit(clip, segments);
      const next = walk[index + delta];
      if (next) setCurrentKey(key(next));
    },
    [clip, segments, walk, index, commit],
  );

  const split = useCallback(() => {
    setSegments((cur) => splitAt(cur, playhead));
  }, [playhead]);

  function close() {
    commit(clip, segments);
    onClose();
  }

  /**
   * Remove the clip on screen and carry on down the list.
   *
   * The next clip is chosen *before* the removal, because afterwards this one
   * is gone from `clips` and the index that pointed at it resolves to the top
   * of the list — which would silently throw somebody at position 8 of 103 back
   * to the beginning.
   */
  function removeCurrent() {
    if (!clip) return;
    const next = walk[index + 1] ?? walk[index - 1] ?? null;
    onDelete(clip, () => {
      if (next) setCurrentKey(key(next));
      else onClose();
    });
  }

  // Keyboard: the point of this screen is not reaching for the mouse.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing =
        e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (typing) return;
      if (e.key === " ") {
        e.preventDefault();
        const el = videoRef.current;
        if (el) (el.paused ? el.play() : el.pause());
      }
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        split();
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!clip) {
    return (
      <div className="describer" role="dialog" aria-label="Describe footage">
        <div className="describer-panel">
          <div className="describer-head">
            <strong>Nothing left to describe</strong>
            <button type="button" className="lib-act" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
          <p className="lib-empty">Every clip in this list has a description.</p>
        </div>
      </div>
    );
  }

  const remaining = clips.filter((c) => !c.description.trim()).length;
  const spec = [
    clip.width && clip.height ? `${clip.width}×${clip.height}` : null,
    clip.codec,
    clip.isHdr ? "HDR" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="describer"
      role="dialog"
      aria-label={`Describe ${clip.fileName}`}
      onClick={close}
    >
      <div className="describer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="describer-head">
          <div style={{ minWidth: 0 }}>
            <strong className="describer-name">{clip.fileName}</strong>
            <span className="hint">
              {clip.projectName}
              {spec && ` · ${spec}`} · {formatDuration(clip.durationMs)}
            </span>
          </div>
          <div className="describer-head-actions">
          <button
            type="button"
            className="lib-act lib-act-danger"
            onClick={removeCurrent}
            title="Remove this clip from the library"
            aria-label={`Remove ${clip.fileName} from the library`}
          >
            <TrashIcon />
          </button>
          <button type="button" className="lib-act" onClick={close} aria-label="Close">
            ✕
          </button>
          </div>
        </div>

        <div className="describer-body">
          <div className="describer-video">
            {clip.sourcePath ? (
              <video
                ref={videoRef}
                src={audioUrl(clip.sourcePath)}
                controls
                autoPlay
                muted
                playsInline
                onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
                // A black rectangle is not a diagnosis. Say what failed, since
                // the usual causes — a file that has moved, or a codec the
                // webview will not decode — need different fixes.
                onError={() =>
                  setMediaError(
                    `Couldn’t play this file. It may have moved, or be in a format ` +
                      `this player can’t decode. Thumbnails and rendering are ` +
                      `unaffected — they go through ffmpeg.`,
                  )
                }
                onLoadedData={() => setMediaError(null)}
              />
            ) : (
              <p className="lib-empty">This clip has no media on disk.</p>
            )}

            {mediaError && (
              <div className="warning" role="alert">
                <strong>Preview unavailable.</strong>
                <span>{mediaError}</span>
                <span className="hint">{clip.sourcePath}</span>
              </div>
            )}

            <div className="describer-tools">
              <span className="hint">
                Playhead {clock(playhead)} / {clock((clip.durationMs ?? 0) / 1000)}
              </span>
              <button
                type="button"
                className="ghost-button small"
                onClick={split}
                disabled={!clip.sourcePath}
                title="Cut a new moment at the playhead"
              >
                Split here <kbd>S</kbd>
              </button>
            </div>
          </div>

          <div className="describer-moments">
            <p className="field-label" style={{ marginTop: 0 }}>
              {segments.length === 1
                ? "What happens in this clip?"
                : `${segments.length} moments`}
            </p>

            {segments.map((sg, i) => (
              <div className="describer-moment" key={`${sg.startSec}-${i}`}>
                <div className="describer-moment-head">
                  <span className="segment-time">
                    {clock(sg.startSec)} – {clock(sg.endSec)}
                  </span>
                  {i > 0 && (
                    <button
                      type="button"
                      className="ghost-button small"
                      onClick={() => setSegments((cur) => mergeAt(cur, i))}
                      title="Remove this boundary and join with the moment before it"
                    >
                      Merge up
                    </button>
                  )}
                  {clip.sourcePath && (
                    <button
                      type="button"
                      className="ghost-button small"
                      onClick={() => {
                        const el = videoRef.current;
                        if (el) {
                          el.currentTime = sg.startSec;
                          void el.play();
                        }
                      }}
                      title="Play from here"
                    >
                      <PlayIcon size={13} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="describer-remove"
                    onClick={() => setSegments((cur) => removeAt(cur, i))}
                    title={
                      segments.length === 1
                        ? "Clear this description"
                        : "Remove this moment and give its time to the one beside it"
                    }
                    aria-label={
                      segments.length === 1 ? "Clear description" : "Remove this moment"
                    }
                  >
                    ✕
                  </button>
                </div>
                <textarea
                  className="clip-input"
                  rows={segments.length > 1 ? 2 : 4}
                  autoFocus={i === 0}
                  value={sg.text}
                  placeholder="Describe what happens…"
                  onChange={(e) => {
                    const text = e.currentTarget.value;
                    setSegments((cur) =>
                      cur.map((x, j) => (j === i ? { ...x, text } : x)),
                    );
                  }}
                  onBlur={() => commit(clip, segments)}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="describer-foot">
          <label className="checkbox-row" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={onlyUndescribed}
              onChange={(e) => {
                commit(clip, segments);
                setOnlyUndescribed(e.currentTarget.checked);
              }}
            />
            Only undescribed
            {remaining > 0 && <span className="hint"> · {remaining} left</span>}
          </label>

          <div className="describer-nav">
            <button
              type="button"
              className="ghost-button"
              onClick={() => go(-1)}
              disabled={index <= 0}
            >
              ◀ Previous
            </button>
            <span className="hint">
              {index + 1} of {walk.length}
            </span>
            <button
              type="button"
              className="primary-button"
              onClick={() => go(1)}
              disabled={index >= walk.length - 1}
            >
              Next ▶
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

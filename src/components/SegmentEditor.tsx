/**
 * Describing a clip library, segment by segment.
 *
 * This is the highest-friction screen in the product: someone may be describing
 * 300 clips in one sitting. Everything here is subordinate to data-entry speed.
 *
 * The model that makes it fast: a clip's segments are always **contiguous and
 * gapless**, starting as one segment spanning the whole clip. Marking at the
 * playhead *splits* the segment under it. There is no way to create a gap, an
 * overlap, or an out-of-order segment, so the user never has to think about
 * boundaries as data — only about where one moment becomes another.
 *
 * Keyboard, so hands never leave the keys:
 *   Space   play / pause          S      split at playhead
 *   Enter   next segment          ⌘Enter next clip
 *   [ / ]   previous / next clip  N      next undescribed clip
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { audioUrl } from "../lib/voiceover";
import { formatTime, isDescribed, type ProjectClip } from "../lib/project";
import { initialSegments, mergeAt, splitAt, type Segment } from "../lib/segments";

interface Props {
  clips: ProjectClip[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChangeSegments: (clipId: string, segments: Segment[]) => void;
  onImportClips: () => void;
  importing: boolean;
}

export function SegmentEditor({
  clips,
  selectedId,
  onSelect,
  onChangeSegments,
  onImportClips,
  importing,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const [onlyUndescribed, setOnlyUndescribed] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const clip = clips.find((c) => c.id === selectedId) ?? null;
  const durationSec = (clip?.sourceDurationMs ?? 0) / 1000;

  const visible = useMemo(
    () => (onlyUndescribed ? clips.filter((c) => !isDescribed(c)) : clips),
    [clips, onlyUndescribed],
  );

  // A clip always has at least one segment, so there is always somewhere to type.
  const segments = useMemo<Segment[]>(() => {
    if (!clip) return [];
    if (clip.segments.length > 0) return clip.segments;
    return initialSegments(durationSec);
  }, [clip, durationSec]);

  const commit = useCallback(
    (next: Segment[]) => {
      if (clip) onChangeSegments(clip.id, next);
    },
    [clip, onChangeSegments],
  );

  const step = useCallback(
    (delta: number) => {
      if (!clip) return;
      const i = visible.findIndex((c) => c.id === clip.id);
      const next = visible[Math.min(visible.length - 1, Math.max(0, i + delta))];
      if (next) {
        onSelect(next.id);
        setFocusIndex(0);
      }
    },
    [clip, visible, onSelect],
  );

  const nextUndescribed = useCallback(() => {
    const next = clips.find((c) => !isDescribed(c) && c.id !== clip?.id);
    if (next) {
      onSelect(next.id);
      setFocusIndex(0);
    }
  }, [clips, clip, onSelect]);

  const split = useCallback(() => {
    const next = splitAt(segments, playhead);
    if (next.length !== segments.length) {
      commit(next);
      // Land the caret in the half that still needs describing.
      const created = next.findIndex((s) => s.startSec === playhead);
      setFocusIndex(created === -1 ? 0 : created);
      requestAnimationFrame(() => inputRefs.current[created]?.focus());
    }
  }, [segments, playhead, commit]);

  // Global shortcuts, suppressed while typing except for the ones that mean
  // "I'm done with this field".
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

      if (e.key === "Enter" && typing) {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) {
          step(1);
        } else {
          const next = Math.min(segments.length - 1, focusIndex + 1);
          setFocusIndex(next);
          inputRefs.current[next]?.focus();
        }
        return;
      }
      if (typing) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          if (videoRef.current?.paused) void videoRef.current.play();
          else videoRef.current?.pause();
          break;
        case "s":
        case "S":
          e.preventDefault();
          split();
          break;
        case "[":
          step(-1);
          break;
        case "]":
          step(1);
          break;
        case "n":
        case "N":
          nextUndescribed();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [segments.length, focusIndex, split, step, nextUndescribed]);

  const described = clips.filter(isDescribed).length;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Describe clips</h2>
        <p className="hint">
          {described} of {clips.length} described
        </p>
      </div>

      {clips.length === 0 ? (
        <div className="empty-state">
          <p>No footage yet. Add the clips from your trip — all of them.</p>
          <button
            type="button"
            className="primary-button"
            onClick={onImportClips}
            disabled={importing}
          >
            {importing ? "Reading files…" : "Add clips…"}
          </button>
        </div>
      ) : (
        <div className="segment-layout">
          <div className="clip-rail">
            <label className="rail-filter">
              <input
                type="checkbox"
                checked={onlyUndescribed}
                onChange={(e) => setOnlyUndescribed(e.currentTarget.checked)}
              />
              Undescribed only
            </label>
            <ul className="rail-list">
              {visible.map((c, i) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`rail-item${c.id === selectedId ? " is-selected" : ""}`}
                    onClick={() => {
                      onSelect(c.id);
                      setFocusIndex(0);
                    }}
                  >
                    {c.thumbnailPath ? (
                      <img src={audioUrl(c.thumbnailPath)} alt="" aria-hidden="true" />
                    ) : (
                      <span className="rail-thumb-empty" aria-hidden="true" />
                    )}
                    <span className="rail-name">{c.fileName ?? `Clip ${i + 1}`}</span>
                    <span className={isDescribed(c) ? "rail-dot is-done" : "rail-dot"} />
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="ghost-button small"
              onClick={onImportClips}
              disabled={importing}
            >
              + Add more
            </button>
          </div>

          <div className="segment-main">
            {clip ? (
              <>
                {clip.sourcePath ? (
                  <video
                    ref={videoRef}
                    className="segment-video"
                    src={audioUrl(clip.sourcePath)}
                    controls
                    preload="metadata"
                    onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
                  />
                ) : (
                  <div className="segment-video segment-video-empty">No media</div>
                )}

                <div className="segment-toolbar">
                  <span className="hint">at {formatTime(playhead)}</span>
                  <button type="button" className="ghost-button small" onClick={split}>
                    Split here <kbd>S</kbd>
                  </button>
                  <button
                    type="button"
                    className="ghost-button small"
                    onClick={nextUndescribed}
                  >
                    Next undescribed <kbd>N</kbd>
                  </button>
                </div>

                <ol className="segment-list">
                  {segments.map((s, i) => (
                    <li key={`${s.startSec}-${i}`} className="segment-row">
                      <span className="segment-time">
                        {formatTime(s.startSec)}–{formatTime(s.endSec)}
                      </span>
                      <input
                        ref={(el) => {
                          inputRefs.current[i] = el;
                        }}
                        className="clip-input segment-input"
                        value={s.text}
                        placeholder="what happens in this moment"
                        onFocus={() => setFocusIndex(i)}
                        onChange={(e) => {
                          const next = [...segments];
                          next[i] = { ...s, text: e.currentTarget.value };
                          commit(next);
                        }}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        disabled={i === 0}
                        title="Merge into the segment above"
                        aria-label={`Merge segment ${i + 1} into the previous one`}
                        onClick={() => commit(mergeAt(segments, i))}
                      >
                        ⌫
                      </button>
                    </li>
                  ))}
                </ol>

                <p className="placeholder-note">
                  <kbd>Space</kbd> play · <kbd>S</kbd> split at playhead ·{" "}
                  <kbd>Enter</kbd> next segment · <kbd>⌘Enter</kbd> next clip ·{" "}
                  <kbd>[</kbd> <kbd>]</kbd> change clip · <kbd>N</kbd> next undescribed
                </p>
              </>
            ) : (
              <p className="hint">Pick a clip to describe it.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

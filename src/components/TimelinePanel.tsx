/**
 * The cut, laid out in time, with the tracks that make it up.
 *
 * A list of rows would have been less work and is what the assembly screen
 * already does. It is the wrong shape for this: the questions somebody has at
 * this stage are "how long is that shot", "does this one run on", "where does
 * the music come in" — all of them about *proportion*, which a list cannot
 * show and a ruler shows for free.
 *
 * Everything here edits by override. The shot lengths on screen come from the
 * narration and cannot be dragged, because stretching a voice to fit a picture
 * is the one thing this app will not do.
 */
import { useEffect, useRef, useState } from "react";
import {
  applyEdits,
  maxTransitionMs,
  maxTrimMs,
  moved,
  runtimeMs,
  shotGain,
  withEdit,
  hasMusic,
  withOrder,
  SUBTITLE_COLOURS,
  type SubtitleStyle,
  type PlannedShot,
  type Shot,
  type TimelineDoc,
} from "../lib/timeline";
import { formatSpan } from "../lib/library";
import { audioUrl } from "../lib/voiceover";
import type { ProjectClip } from "../lib/project";
import { TrashIcon } from "./Icons";

interface Props {
  planned: PlannedShot[];
  doc: TimelineDoc;
  onChange: (doc: TimelineDoc) => void;
  clips: ProjectClip[];
  /** Narration is the clock; shown so the tracks line up against something. */
  busy: boolean;
  onRender: () => void;
  onPickMusic: () => void;
  /** The bundled beds, offered beside "choose a file". */
  beds: { id: string; label: string; hint: string }[];
  /** How captions will look, so the viewer can show them before a render. */
  subtitles: SubtitleStyle | null;
  /** The music track, already resolved to something an <audio> can load. */
  musicUrl: string | null;
  /**
   * The film's opening, controlled here rather than in its own panel: it is a
   * decision about this film, made while looking at it, and the timeline is
   * where the film is being looked at.
   */
  opening?: { enabled: boolean; onToggle: (on: boolean) => void; summary: string };
  children?: React.ReactNode;
}

/** Pixels per second at rest. The ruler scales; the tracks follow it. */
const BASE_PPS = 26;
/**
 * Width of the track-name column, which every lane is offset by.
 *
 * Pinned in pixels and mirrored by `.tl-track-name` and `.tl-ruler` in the
 * stylesheet, because the playhead and the auto-scroll both have to land on
 * the same pixel as the lanes, and a rem would make that depend on the root
 * font size at runtime.
 */
const LABEL_W = 104;
const ZOOMS = [0.5, 1, 2, 4];

function clock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function TimelinePanel({
  planned,
  doc,
  onChange,
  clips,
  busy,
  onRender,
  onPickMusic,
  beds,
  subtitles,
  musicUrl,
  opening,
  children,
}: Props) {
  const [zoom, setZoom] = useState(1);
  /**
   * Playback runs off the shot list rather than a rendered file, so it works
   * before anything has been assembled — which is when the edits are being
   * made. One <video> is moved from clip to clip and seeked, and the narration
   * plays alongside it from its own element.
   */
  const [playing, setPlaying] = useState(false);
  const [head, setHead] = useState(0);
  const video = useRef<HTMLVideoElement | null>(null);
  const voice = useRef<HTMLAudioElement | null>(null);
  const music = useRef<HTMLAudioElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const startedAt = useRef<{ wall: number; head: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // `insertAt` is a gap index, not a shot: "before the shot at this index".
  // Dropping onto a shot cannot distinguish left-of from right-of, which is
  // most of what makes a reorder hard to predict.
  const [drag, setDrag] = useState<{ key: string; x: number; insertAt: number } | null>(null);
  const lane = useRef<HTMLDivElement | null>(null);
  const shotRefs = useRef(new Map<string, HTMLDivElement>());

  const shots = applyEdits(planned, doc);
  const live = shots.filter((s) => s.enabled);
  const total = runtimeMs(shots);
  const pps = BASE_PPS * zoom;
  const width = Math.max(320, (total / 1000) * pps);
  const byId = new Map(clips.map((c) => [c.id, c]));
  const current = selected ? shots.find((s) => s.key === selected) : undefined;
  /** The shot under the playhead, for the caption preview. */
  const underHead = at(head)?.shot;

  function edit(key: string, patch: Parameters<typeof withEdit>[2]) {
    onChange(withEdit(doc, key, patch));
  }

  // --- reordering, on pointer events for the same reason the footage list is:
  // WebKit will not start an HTML5 drag without setData, and a captured
  // pointer keeps working once the row has moved out from under it.
  function gapAt(clientX: number): number {
    for (let i = 0; i < live.length; i++) {
      const el = shotRefs.current.get(live[i].key);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return live.length;
  }

  /** Where a dragged shot would end up, numbered as the timeline shows it. */
  function destination(fromKey: string, insertAt: number): number {
    const from = live.findIndex((s) => s.key === fromKey);
    return (insertAt > from ? insertAt - 1 : insertAt) + 1;
  }

  /** Which shot is on screen at a given moment, and how far into it. */
  function at(ms: number): { shot: Shot; into: number } | null {
    for (const s of live) {
      if (ms >= s.startMs && ms < s.startMs + s.durationMs) {
        return { shot: s, into: ms - s.startMs };
      }
    }
    return null;
  }

  // The clock. One rAF loop advances the playhead from wall time rather than
  // from the video element, because the video is swapped at every cut and its
  // own currentTime restarts each time.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const s = startedAt.current;
      if (s) {
        const now = s.head + (performance.now() - s.wall);
        if (now >= total) {
          setPlaying(false);
          setHead(total);
        } else {
          setHead(now);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, total]);

  // Keep the picture, the voice and the music pointed at wherever the playhead
  // is, and each at the level its track is set to.
  //
  // Three elements rather than one mixed stream, because the point of this
  // viewer is to judge the balance between them: the levels have to be
  // audible as they are changed, without re-rendering anything.
  useEffect(() => {
    const cur = at(head);
    const v = video.current;
    const a = voice.current;
    const m = music.current;

    if (v && cur) {
      const clip = byId.get(cur.shot.sourceClipId);
      const src = clip?.sourcePath ? audioUrl(clip.sourcePath) : "";
      if (src && !v.src.endsWith(encodeURI(clip!.sourcePath!).split("/").pop() ?? "")) {
        v.src = src;
      }
      // Where in the source file this moment falls. A slowed shot advances
      // through its source more slowly than the playhead advances through the
      // film, which is what the stretch accounts for.
      const want = (cur.shot.sourceInMs + cur.into) / 1000;
      if (Math.abs(v.currentTime - want) > 0.35) v.currentTime = want;
      // The clip's own sound, at the level this shot asks for. Muted rather
      // than left at zero volume as well, because a muted element is what
      // lets it play at all before the user has touched the page.
      // The renderer's own rule, so the preview cannot disagree with the file.
      const gain = shotGain(cur.shot, doc.originalAudio);
      v.volume = Math.min(1, Math.max(0, gain));
      v.muted = gain <= 0;
      if (playing && v.paused) void v.play().catch(() => setPlaying(false));
      if (!playing && !v.paused) v.pause();
    }

    // The narration. One recording per line, so the element is moved from line
    // to line exactly as the picture is, and seeked to how far into this one
    // the playhead has reached.
    if (a) {
      const path = cur?.shot.audioPath;
      if (!path) {
        if (!a.paused) a.pause();
      } else {
        const src = audioUrl(path);
        if (a.src !== src) a.src = src;
        const want = cur!.into / 1000;
        if (Math.abs(a.currentTime - want) > 0.35) a.currentTime = want;
        a.volume = 1;
        if (playing && a.paused) void a.play().catch(() => {});
        if (!playing && !a.paused) a.pause();
      }
    }

    // The music runs under the whole film, so it is seeked to the playhead
    // itself rather than to a position within a shot.
    if (m) {
      const on = doc.music.enabled && hasMusic(doc.music) && musicUrl !== null;
      m.volume = on ? Math.min(1, Math.max(0, doc.music.gain)) : 0;
      m.muted = !on;
      if (on) {
        const want = head / 1000;
        if (Math.abs(m.currentTime - want) > 0.5) m.currentTime = want;
        if (playing && m.paused) void m.play().catch(() => {});
      }
      if ((!playing || !on) && !m.paused) m.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head, playing, doc.originalAudio, doc.music, musicUrl]);

  /**
   * Keep the playhead in view while it moves.
   *
   * A timeline that does not follow the play is a timeline you cannot use to
   * find the moment you are listening to — which is the whole reason to play
   * it here rather than watch the finished file. Nudged only when the head
   * approaches an edge, so a still playhead never drags the view around under
   * somebody who is reading it.
   */
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = LABEL_W + (head / 1000) * pps;
    const left = el.scrollLeft;
    const right = left + el.clientWidth;
    if (x < left + el.clientWidth * 0.15 || x > right - el.clientWidth * 0.15) {
      el.scrollTo({ left: Math.max(0, x - el.clientWidth * 0.4), behavior: "auto" });
    }
  }, [head, playing, pps]);

  function toggle() {
    if (playing) {
      setPlaying(false);
      startedAt.current = null;
      video.current?.pause();
      voice.current?.pause();
      music.current?.pause();
    } else {
      startedAt.current = { wall: performance.now(), head: head >= total ? 0 : head };
      if (head >= total) setHead(0);
      setPlaying(true);
      // Started here, inside the gesture, rather than left to the effect that
      // runs after it. A webview grants permission to play audio to the click,
      // and an effect a frame later is not the click — which would leave the
      // narration silent while the picture ran, the exact complaint this
      // viewer exists to answer.
      void video.current?.play().catch(() => {});
      void voice.current?.play().catch(() => {});
      if (doc.music.enabled && hasMusic(doc.music)) {
        void music.current?.play().catch(() => {});
      }
    }
  }

  /**
   * Space plays and pauses, as it does in every editor.
   *
   * Ignored while typing, so renaming a project does not start the film.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space" && e.key !== " ") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      // Buttons answer to space themselves, and taking it from them would
      // break the transport controls sitting right above the timeline.
      if (tag === "BUTTON") return;
      e.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ticks: number[] = [];
  for (let t = 0; t <= total; t += total > 120_000 ? 30_000 : total > 30_000 ? 10_000 : 5_000) {
    ticks.push(t);
  }

  return (
    <section className="panel timeline-panel">
      <div className="panel-head">
        <h2>Timeline</h2>
        <span className="hint">
          {live.length} shot{live.length === 1 ? "" : "s"} · {formatSpan(total)}
          {shots.length !== live.length && ` · ${shots.length - live.length} dropped`}
        </span>
        <div className="actions">
          <div className="zoom-row" role="group" aria-label="Zoom">
            {ZOOMS.map((z) => (
              <button
                key={z}
                type="button"
                className={`style-chip small${zoom === z ? " is-selected" : ""}`}
                onClick={() => setZoom(z)}
              >
                {z}×
              </button>
            ))}
          </div>
          <button type="button" className="primary-button" onClick={onRender} disabled={busy}>
            {busy ? "Rendering…" : "Render this cut"}
          </button>
        </div>
      </div>

      {children}

      {opening && (
        <div className="tl-track-row tl-opening-row">
          <label className="tl-track-toggle">
            <input
              type="checkbox"
              checked={opening.enabled}
              onChange={(e) => opening.onToggle(e.currentTarget.checked)}
            />
            <strong>Opening</strong>
          </label>
          <span className="hint tl-track-hint">{opening.summary}</span>
        </div>
      )}

      {/* A viewer that plays the cut as it stands, before anything has been
          rendered — which is exactly when the edits are being made. Captions
          are drawn over it in HTML at the size and height the burn-in will
          use, so their placement can be judged before committing to a render. */}
      <div className="tl-viewer">
        <div className="tl-stage">
          <video ref={video} className="tl-video" playsInline />
          {/* The narration and the music, played alongside the picture rather
              than mixed into it, so their levels can be judged by ear while
              they are being set. Never shown: the transport above drives them. */}
          <audio ref={voice} preload="auto" />
          <audio ref={music} preload="auto" loop src={musicUrl ?? undefined} />
          {subtitles && underHead && (
            <div
              className="tl-caption"
              style={{
                bottom: `${subtitles.bottom * 100}%`,
                fontSize: `${subtitles.size * 100}cqh`,
                color: subtitles.colour,
                background: subtitles.boxBehind ? "rgba(0,0,0,0.6)" : undefined,
                padding: subtitles.boxBehind ? "0.15em 0.5em" : undefined,
              }}
            >
              {underHead.text}
            </div>
          )}
        </div>
        <div className="tl-transport">
          <button type="button" className="primary-button small" onClick={toggle}>
            {playing ? "❚❚ Pause" : "▶ Play"}
          </button>
          <button
            type="button"
            className="ghost-button small"
            onClick={() => {
              setPlaying(false);
              startedAt.current = null;
              setHead(0);
            }}
            title="Back to the start"
          >
            ↺
          </button>
          <input
            className="tl-seek"
            type="range"
            min={0}
            max={Math.max(1, total)}
            value={Math.min(head, total)}
            aria-label="Playhead"
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              setHead(v);
              startedAt.current = { wall: performance.now(), head: v };
            }}
          />
          <span className="tl-clock">
            {clock(head)} / {clock(total)}
          </span>
        </div>
      </div>

      {drag && (
        <div className="tl-drag-note" role="status">
          Moving shot {live.findIndex((s) => s.key === drag.key) + 1} → position{" "}
          <strong>{destination(drag.key, drag.insertAt)}</strong>
        </div>
      )}

      <div className="tl-scroll" ref={scroller}>
        <div className="tl-inner" style={{ width }}>
          {/* Where the viewer above is, drawn across every track. */}
          {total > 0 && (
            <span
              className="tl-head"
              style={{ left: `${LABEL_W + (head / 1000) * pps}px` }}
              aria-hidden="true"
            />
          )}
          {/* ── ruler ───────────────────────────────────────────────────── */}
          {/* Clicking the ruler moves the playhead there, like any editor. */}
          <div
            className="tl-ruler"
            role="slider"
            aria-label="Playhead"
            aria-valuemin={0}
            aria-valuemax={Math.round(total)}
            aria-valuenow={Math.round(head)}
            tabIndex={-1}
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const ms = Math.max(0, Math.min(total, ((e.clientX - r.left) / pps) * 1000));
              setHead(ms);
              startedAt.current = { wall: performance.now(), head: ms };
            }}
          >
            {ticks.map((t) => (
              <span key={t} className="tl-tick" style={{ left: (t / 1000) * pps }}>
                {clock(t)}
              </span>
            ))}
          </div>

          {/* ── picture ─────────────────────────────────────────────────── */}
          <div className="tl-track">
            <span className="tl-track-name">Picture</span>
            <div className="tl-lane" ref={lane}>
              {live.map((s, i) => {
                const clip = byId.get(s.sourceClipId);
                const w = (s.durationMs / 1000) * pps;
                const next = live[i + 1];
                return (
                  <div
                    key={s.key}
                    ref={(el) => {
                      if (el) shotRefs.current.set(s.key, el);
                      else shotRefs.current.delete(s.key);
                    }}
                    className="tl-shot"
                    style={{ width: w, left: (s.startMs / 1000) * pps }}
                    data-selected={selected === s.key || undefined}
                    data-dragging={drag?.key === s.key || undefined}
                    data-insert={
                      drag
                        ? drag.insertAt === i
                          ? "before"
                          : drag.insertAt === live.length && i === live.length - 1
                            ? "after"
                            : undefined
                        : undefined
                    }
                    onPointerDown={(e) => {
                      setSelected(s.key);
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setDrag({ key: s.key, x: e.clientX, insertAt: gapAt(e.clientX) });
                    }}
                    onPointerMove={(e) => {
                      if (!drag) return;
                      setDrag({ ...drag, x: e.clientX, insertAt: gapAt(e.clientX) });
                    }}
                    onPointerUp={() => {
                      if (drag) {
                        const from = live.findIndex((x) => x.key === drag.key);
                        const to = drag.insertAt > from ? drag.insertAt - 1 : drag.insertAt;
                        if (to !== from && live[to]) {
                          onChange(withOrder(doc, moved(shots, drag.key, live[to].key)));
                        }
                      }
                      setDrag(null);
                    }}
                    onPointerCancel={() => setDrag(null)}
                    title={s.text}
                  >
                    {clip?.thumbnailPath && (
                      <img className="tl-shot-thumb" src={audioUrl(clip.thumbnailPath)} alt="" />
                    )}
                    <span className="tl-shot-label">
                      <strong>{i + 1}</strong>
                      {s.swapped && <span className="tl-swapped" title="Showing other footage">↔</span>}
                    </span>
                    <span className="tl-shot-len">{clock(s.durationMs)}</span>

                    {/* The dissolve into the next shot, drawn where it lands. */}
                    {next && s.transitionMs > 0 && (
                      <span
                        className="tl-fade"
                        style={{ width: (s.transitionMs / 1000) * pps }}
                        title={`${s.transitionMs}ms dissolve`}
                      />
                    )}
                  </div>
                );
              })}
              {live.length === 0 && (
                <p className="tl-empty">Every shot is switched off. Turn one back on below.</p>
              )}
            </div>
          </div>

          {/* ── narration ───────────────────────────────────────────────── */}
          <div className="tl-track">
            <span className="tl-track-name">Narration</span>
            <div className="tl-lane">
              {live.map((s) => (
                <div
                  key={s.key}
                  className="tl-audio tl-narration"
                  style={{
                    width: (s.durationMs / 1000) * pps,
                    left: (s.startMs / 1000) * pps,
                  }}
                  title={s.text}
                >
                  <span>{s.text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── the clips' own sound ────────────────────────────────────── */}
          <div className="tl-track" data-off={!doc.originalAudio.enabled || undefined}>
            <span className="tl-track-name">Clip sound</span>
            <div className="tl-lane">
              {doc.originalAudio.enabled &&
                live.map((s) => (
                  <div
                    key={s.key}
                    className="tl-audio tl-source"
                    style={{
                      width: (s.durationMs / 1000) * pps,
                      left: (s.startMs / 1000) * pps,
                      opacity: 0.35 + doc.originalAudio.gain * 0.65,
                    }}
                  />
                ))}
            </div>
          </div>

          {/* ── music ───────────────────────────────────────────────────── */}
          <div className="tl-track" data-off={!doc.music.enabled || undefined}>
            <span className="tl-track-name">Music</span>
            <div className="tl-lane">
              {doc.music.enabled && hasMusic(doc.music) && (
                <div
                  className="tl-audio tl-music"
                  style={{ width: (total / 1000) * pps, left: 0 }}
                >
                  <span>{doc.music.label ?? "Music"}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── tracks ────────────────────────────────────────────────────── */}
      <details className="tl-mixer-details" open>
        <summary>
          Sound &amp; subtitles
          <span className="hint">
            {[
              doc.originalAudio.enabled && "clip sound",
              doc.music.enabled && hasMusic(doc.music) && (doc.music.label ?? "music"),
              doc.subtitles && "subtitles",
            ]
              .filter(Boolean)
              .join(" · ") || "narration only"}
          </span>
        </summary>
        <div className="tl-mixer">
        <TrackRow
          label="Clip sound"
          hint="The video's own audio — traffic, voices, wind — under the narration."
          track={doc.originalAudio}
          onChange={(t) => onChange({ ...doc, originalAudio: { ...doc.originalAudio, ...t } })}
        />
        <TrackRow
          label="Music"
          hint={doc.music.label ?? "No track chosen yet."}
          track={doc.music}
          onChange={(t) => onChange({ ...doc, music: { ...doc.music, ...t } })}
          extra={
            <>
              {beds.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`style-chip small${doc.music.bedId === b.id ? " is-selected" : ""}`}
                  title={b.hint}
                  onClick={() =>
                    onChange({
                      ...doc,
                      music: {
                        ...doc.music,
                        bedId: b.id,
                        path: null,
                        label: b.label,
                        enabled: true,
                      },
                    })
                  }
                >
                  {b.label}
                </button>
              ))}
              <button type="button" className="ghost-button small" onClick={onPickMusic}>
                {doc.music.path ? "Change file" : "Own file…"}
              </button>
            </>
          }
          disabled={!hasMusic(doc.music)}
        />
        <div className="tl-track-row">
          <label className="tl-track-toggle">
            <input
              type="checkbox"
              checked={doc.subtitles}
              onChange={(e) => onChange({ ...doc, subtitles: e.currentTarget.checked })}
            />
            <strong>Subtitles</strong>
          </label>

          {doc.subtitles ? (
            <>
              <label className="tl-sub-field">
                Size {(doc.subtitleStyle.size * 100).toFixed(1)}%
                {/* Straight through: the slider is tenths of a percent of the
                    frame height, and that is what gets stored. The first
                    version showed `1/size` and set `1/(78 - value)`, so the
                    thumb jumped to the far end after every drag and set the
                    opposite of what it looked like it was setting. */}
                <input
                  type="range"
                  min={20}
                  max={80}
                  value={Math.round(doc.subtitleStyle.size * 1000)}
                  onChange={(e) =>
                    onChange({
                      ...doc,
                      subtitleStyle: {
                        ...doc.subtitleStyle,
                        size: Number(e.currentTarget.value) / 1000,
                      },
                    })
                  }
                />
              </label>
              <label className="tl-sub-field">
                Height {(doc.subtitleStyle.bottom * 100).toFixed(0)}%
                <input
                  type="range"
                  min={2}
                  max={30}
                  value={Math.round(doc.subtitleStyle.bottom * 100)}
                  onChange={(e) =>
                    onChange({
                      ...doc,
                      subtitleStyle: {
                        ...doc.subtitleStyle,
                        bottom: Number(e.currentTarget.value) / 100,
                      },
                    })
                  }
                />
              </label>
              {SUBTITLE_COLOURS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={`tl-swatch${doc.subtitleStyle.colour === c.value ? " is-selected" : ""}`}
                  style={{ background: c.value }}
                  title={c.label}
                  aria-label={c.label}
                  onClick={() =>
                    onChange({ ...doc, subtitleStyle: { ...doc.subtitleStyle, colour: c.value } })
                  }
                />
              ))}
              <label className="tl-track-toggle">
                <input
                  type="checkbox"
                  checked={doc.subtitleStyle.boxBehind}
                  onChange={(e) =>
                    onChange({
                      ...doc,
                      subtitleStyle: { ...doc.subtitleStyle, boxBehind: e.currentTarget.checked },
                    })
                  }
                />
                Plate
              </label>
              <span className="hint tl-track-hint">
                Shown on the viewer above exactly where it will be burned in. A .srt is
                saved beside the video either way.
              </span>
            </>
          ) : (
            <span className="hint tl-track-hint">
              Drawn into the picture, in the language the script was written in. A .srt
              is saved beside the video either way.
            </span>
          )}
        </div>
        </div>
      </details>

      {/* ── the selected shot ─────────────────────────────────────────── */}
      {current ? (
        <ShotEditor
          shot={current}
          shots={shots}
          clips={clips}
          trackGain={doc.originalAudio.gain}
          onEdit={edit}
          onClose={() => setSelected(null)}
        />
      ) : (
        <p className="hint tl-pick-hint">
          Click a shot to trim it, swap its footage, set the dissolve into the next
          one, or drop it from the film. Drag one sideways to move it.
        </p>
      )}
    </section>
  );
}

function TrackRow({
  label,
  hint,
  track,
  onChange,
  extra,
  disabled,
}: {
  label: string;
  hint: string;
  track: { enabled: boolean; gain: number };
  onChange: (t: Partial<{ enabled: boolean; gain: number }>) => void;
  extra?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="tl-track-row">
      <label className="tl-track-toggle">
        <input
          type="checkbox"
          checked={track.enabled}
          disabled={disabled}
          onChange={(e) => onChange({ enabled: e.currentTarget.checked })}
        />
        <strong>{label}</strong>
      </label>
      <input
        className="tl-gain"
        type="range"
        min={0}
        max={100}
        value={Math.round(track.gain * 100)}
        disabled={!track.enabled || disabled}
        aria-label={`${label} level`}
        onChange={(e) => onChange({ gain: Number(e.currentTarget.value) / 100 })}
      />
      <span className="tl-gain-value">{Math.round(track.gain * 100)}%</span>
      {extra}
      <span className="hint tl-track-hint">{hint}</span>
    </div>
  );
}

function ShotEditor({
  shot,
  shots,
  clips,
  trackGain,
  onEdit,
  onClose,
}: {
  shot: Shot;
  shots: Shot[];
  clips: ProjectClip[];
  trackGain: number;
  onEdit: (key: string, patch: Parameters<typeof withEdit>[2]) => void;
  onClose: () => void;
}) {
  const live = shots.filter((s) => s.enabled);
  const at = live.findIndex((s) => s.key === shot.key);
  const next = at >= 0 ? live[at + 1] : undefined;
  const source = clips.find((c) => c.id === shot.sourceClipId);
  const maxTrim = maxTrimMs(source?.sourceDurationMs ?? null, shot.durationMs);
  const maxFade = maxTransitionMs(shot, next);

  return (
    <div className="tl-editor">
      <div className="panel-head">
        <h3>
          Shot {at >= 0 ? at + 1 : "—"} · {shot.text.slice(0, 60)}
          {shot.text.length > 60 ? "…" : ""}
        </h3>
        <button type="button" className="describer-remove" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="tl-editor-grid">
        <label className="tl-field">
          <span className="field-label">Footage</span>
          <select
            value={shot.sourceClipId}
            onChange={(e) => onEdit(shot.key, { sourceClipId: e.currentTarget.value })}
          >
            {clips
              .filter((c) => c.sourcePath)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id === shot.clipId ? "★ " : ""}
                  {c.fileName ?? c.id}
                </option>
              ))}
          </select>
          <span className="hint">
            {shot.swapped
              ? "Showing footage this line was not written for. The words and the recording are unchanged."
              : "The clip this line was written for."}
          </span>
        </label>

        <label className="tl-field">
          <span className="field-label">
            Start {maxTrim > 0 ? `· ${(shot.sourceInMs / 1000).toFixed(1)}s in` : ""}
          </span>
          <input
            type="range"
            min={0}
            max={maxTrim}
            step={100}
            value={Math.min(shot.sourceInMs, maxTrim)}
            disabled={maxTrim === 0}
            onChange={(e) => onEdit(shot.key, { sourceInMs: Number(e.currentTarget.value) })}
          />
          <span className="hint">
            {maxTrim === 0
              ? "This clip is only just long enough for its line; there is nothing to trim."
              : "Skip the start of the clip. The stop is decided by the narration."}
          </span>
        </label>

        <label className="tl-field">
          <span className="field-label">
            Dissolve into the next shot {shot.transitionMs > 0 ? `· ${shot.transitionMs}ms` : ""}
          </span>
          <input
            type="range"
            min={0}
            max={maxFade}
            step={50}
            value={Math.min(shot.transitionMs, maxFade)}
            disabled={!next || maxFade === 0}
            onChange={(e) => onEdit(shot.key, { transitionMs: Number(e.currentTarget.value) })}
          />
          <span className="hint">
            {!next
              ? "This is the last shot; there is nothing after it to dissolve into."
              : "Zero is a hard cut. A dissolve shortens the film by its own length."}
          </span>
        </label>

        {/* This shot's own sound. Per shot because "keep the sound" is
            rarely a decision about a film — it is a decision about the two
            clips with something worth hearing in them. */}
        <div className="tl-field">
          <span className="field-label">
            This clip's sound
            {shot.sound ? "" : " · following the track"}
          </span>
          <div className="voiced-controls">
            <button
              type="button"
              className={`style-chip small${shot.sound?.enabled === true ? " is-selected" : ""}`}
              onClick={() => onEdit(shot.key, { sound: { enabled: true, gain: shot.sound?.gain ?? undefined } })}
            >
              On
            </button>
            <button
              type="button"
              className={`style-chip small${shot.sound?.enabled === false ? " is-selected" : ""}`}
              onClick={() => onEdit(shot.key, { sound: { enabled: false } })}
            >
              Off
            </button>
            <button
              type="button"
              className={`style-chip small${shot.sound === null ? " is-selected" : ""}`}
              onClick={() => onEdit(shot.key, { sound: undefined })}
              title="Use whatever the Clip sound track is set to"
            >
              Follow track
            </button>
          </div>
          {shot.sound?.enabled && (
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((shot.sound.gain ?? trackGain) * 100)}
              aria-label="This clip's sound level"
              onChange={(e) =>
                onEdit(shot.key, {
                  sound: { enabled: true, gain: Number(e.currentTarget.value) / 100 },
                })
              }
            />
          )}
        </div>

        <div className="tl-field">
          <span className="field-label">In the film</span>
          <button
            type="button"
            className={shot.enabled ? "ghost-button" : "primary-button"}
            onClick={() => onEdit(shot.key, { enabled: !shot.enabled })}
          >
            {shot.enabled ? (
              <>
                <TrashIcon size={15} /> Drop this shot
              </>
            ) : (
              "Put it back"
            )}
          </button>
          <span className="hint">
            Dropping takes the line with it — the words, the recording and the
            caption. Nothing is deleted; it can come back.
          </span>
        </div>
      </div>
    </div>
  );
}

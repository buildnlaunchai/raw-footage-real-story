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
import { useRef, useState } from "react";
import {
  applyEdits,
  maxTransitionMs,
  maxTrimMs,
  moved,
  runtimeMs,
  withEdit,
  hasMusic,
  withOrder,
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
  children?: React.ReactNode;
}

/** Pixels per second at rest. The ruler scales; the tracks follow it. */
const BASE_PPS = 26;
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
  children,
}: Props) {
  const [zoom, setZoom] = useState(1);
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

      {drag && (
        <div className="tl-drag-note" role="status">
          Moving shot {live.findIndex((s) => s.key === drag.key) + 1} → position{" "}
          <strong>{destination(drag.key, drag.insertAt)}</strong>
        </div>
      )}

      <div className="tl-scroll">
        <div className="tl-inner" style={{ width }}>
          {/* ── ruler ───────────────────────────────────────────────────── */}
          <div className="tl-ruler" aria-hidden="true">
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
          <span className="hint">
            Drawn into the picture, in the language the script was written in. A .srt
            is saved beside the video either way.
          </span>
        </div>
      </div>

      {/* ── the selected shot ─────────────────────────────────────────── */}
      {current ? (
        <ShotEditor
          shot={current}
          shots={shots}
          clips={clips}
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
  onEdit,
  onClose,
}: {
  shot: Shot;
  shots: Shot[];
  clips: ProjectClip[];
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

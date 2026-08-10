/**
 * Stage 2 UI — pick a voice, synthesise the script, play back each line.
 *
 * Appears only once a script exists, so the page reads top to bottom as the
 * pipeline it is.
 */
import { useRef, useState } from "react";
import { VoicePicker } from "./VoicePicker";
import { audioUrl, type TtsProgress, type VoiceInfo, type VoicedLine } from "../lib/voiceover";
import type { Clip } from "../lib/types";

interface Props {
  clips: Clip[];
  voices: VoiceInfo[];
  voice: string;
  voiced: VoicedLine[] | null;
  busy: boolean;
  previewing: boolean;
  progress: TtsProgress | null;
  error: string | null;
  elapsedMs: number | null;
  onSelectVoice: (id: string) => void;
  onPreview: () => void;
  onGenerate: () => void;
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  return `${s.toFixed(1)}s`;
}

export function VoiceoverPanel({
  clips,
  voices,
  voice,
  voiced,
  busy,
  previewing,
  progress,
  error,
  elapsedMs,
  onSelectVoice,
  onPreview,
  onGenerate,
}: Props) {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const [playing, setPlaying] = useState<string | null>(null);

  /**
   * A line's identity. Play state was tracked by clip id, so when one clip
   * carried two moments, pressing play on either drove both rows.
   */
  const lineKey = (l: { clipId: string; segmentIndex?: number }) =>
    `${l.clipId}#${l.segmentIndex ?? 0}`;
  const audioRef = useRef<HTMLAudioElement | null>(null);

  function play(line: VoicedLine) {
    audioRef.current?.pause();
    const el = new Audio(audioUrl(line.audioPath));
    audioRef.current = el;
    setPlaying(lineKey(line));
    el.onended = () => setPlaying(null);
    el.onerror = () => setPlaying(null);
    void el.play();
  }

  function stop() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  }

  const totalMs = voiced?.reduce((sum, l) => sum + l.durationMs, 0) ?? 0;
  const allSkipped = [...new Set((voiced ?? []).flatMap((l) => l.skipped))];

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Voiceover</h2>
        <p className="hint">
          {voiced
            ? `${voiced.length} line${voiced.length === 1 ? "" : "s"} · ${formatDuration(totalMs)}${
                elapsedMs !== null ? ` · generated in ${(elapsedMs / 1000).toFixed(1)}s` : ""
              }`
            : "Spoken locally by Kokoro. Nothing is uploaded."}
        </p>
      </div>

      <VoicePicker
        voices={voices}
        selected={voice}
        disabled={busy}
        previewing={previewing}
        onSelect={onSelectVoice}
        onPreview={onPreview}
      />

      <div className="actions">
        <button
          type="button"
          className="primary-button"
          onClick={onGenerate}
          disabled={busy || voices.length === 0}
        >
          {busy ? "Generating…" : voiced ? "Regenerate voiceover" : "Generate voiceover"}
        </button>
        {busy && progress && (
          <span className="hint">
            {progress.done} of {progress.total}
          </span>
        )}
      </div>

      {busy && progress && (
        <div
          className="progress-track"
          role="progressbar"
          aria-valuenow={progress.done}
          aria-valuemin={0}
          aria-valuemax={progress.total}
        >
          <div
            className="progress-fill"
            style={{ width: `${(progress.done / progress.total) * 100}%` }}
          />
        </div>
      )}

      {error && (
        <div className="error" role="alert">
          <strong>Couldn’t generate the voiceover.</strong>
          <span>{error}</span>
        </div>
      )}

      {allSkipped.length > 0 && (
        <div className="warning" role="status">
          <strong>Some words couldn’t be pronounced</strong>
          <span>
            {allSkipped.join(", ")} — these were left out of the audio. Try rewording, or
            spell them phonetically in the clip description.
          </span>
        </div>
      )}

      {voiced && !busy && (
        <ol className="script-list voiced-list">
          {voiced.map((line, i) => (
            <li key={`${line.clipId}#${line.segmentIndex}`} className="script-row">
              <span className="clip-index" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="voiced-body">
                <p className="script-clip">{byId.get(line.clipId)?.description}</p>
                <p className="script-text">{line.text}</p>
                <div className="voiced-controls">
                  <button
                    type="button"
                    className="ghost-button small"
                    onClick={() => (playing === lineKey(line) ? stop() : play(line))}
                  >
                    {playing === lineKey(line) ? "■ Stop" : "▶ Play"}
                  </button>
                  <span className="hint">{formatDuration(line.durationMs)}</span>
                  {line.skipped.length > 0 && (
                    <span className="skip-chip" title={line.skipped.join(", ")}>
                      {line.skipped.length} skipped
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Stages C and D — the script, editable, and the words the voice couldn't say.
 *
 * A word that fails phonemisation is shown as a button rather than a warning.
 * Clicking it asks for a respelling in ordinary letters ("rake see vik"), which
 * goes through the same phonemiser as everything else — no IPA knowledge
 * required, which matters because the people hitting this are describing their
 * own holiday, not doing linguistics.
 *
 * Accepting a correction re-synthesises **only the affected line**. A twenty
 * line script is well over a minute of synthesis and the other nineteen lines
 * were already right.
 */
import { useEffect, useState } from "react";
import { audioUrl, type VoicedLine } from "../lib/voiceover";
import type { ProjectClip } from "../lib/project";
import { HOOK_MAX_WORDS, HOOK_MIN_WORDS, hookLengthOk, type ScriptLineDraft } from "../lib/scriptComposer";

interface Props {
  clips: ProjectClip[];
  title: string;
  lines: ScriptLineDraft[];
  words: number;
  wordTarget: number;
  voiced: VoicedLine[] | null;
  /** Keys whose recording no longer matches the words. */
  staleLines: Set<string>;
  /**
   * Lines saying more than their own clip can carry, by `clipId#segmentIndex`.
   *
   * Flagged rather than fixed. Generation shortens its own drafts silently;
   * a sentence somebody typed is theirs, so this offers the rewrite instead of
   * performing it.
   */
  overBudget: Map<string, { budget: number; used: number }>;
  shortening: string | null;
  onShorten: (index: number, budget: number) => void;
  pronunciations: Record<string, string>;
  /** Cloud providers have no lexicon, so nothing can be flagged. */
  showPronunciationFixes: boolean;
  busy: boolean;
  resynthesizing: string | null;
  /** The opening line, and everything about the state it is in. */
  intro: {
    enabled: boolean;
    hook: string | null;
    audio: VoicedLine | null;
    stale: boolean;
    busy: boolean;
    /** How many shots the montage would cut, once there is a recording. */
    shots: number;
    language: string;
    onEdit: (text: string) => void;
    onRegenerate: () => void;
    onRecord: () => void;
  };
  onEditLine: (index: number, text: string) => void;
  /** Record and play a single line, before the whole script is recorded. */
  onHearLine: (index: number) => void;
  onCorrectWord: (word: string, respelling: string) => void;
  children?: React.ReactNode;
}

function segmentText(clips: ProjectClip[], clipId: string, index: number): string {
  return clips.find((c) => c.id === clipId)?.segments[index]?.text ?? "";
}

export function ScriptPanel({
  clips,
  title,
  lines,
  words,
  wordTarget,
  voiced,
  staleLines,
  pronunciations,
  showPronunciationFixes,
  busy,
  resynthesizing,
  intro,
  overBudget,
  shortening,
  onShorten,
  onEditLine,
  onHearLine,
  onCorrectWord,
  children,
}: Props) {
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [respelling, setRespelling] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  /** The whole script as one readable column, rather than a stack of rows. */
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setRespelling(correcting ? (pronunciations[correcting.toLowerCase()] ?? "") : "");
  }, [correcting, pronunciations]);

  const byKey = new Map((voiced ?? []).map((v) => [`${v.clipId}#${v.segmentIndex}`, v]));
  const drift = wordTarget > 0 ? Math.round(((words - wordTarget) / wordTarget) * 100) : 0;

  function play(line: VoicedLine) {
    const el = new Audio(audioUrl(line.audioPath) + `?t=${Date.now()}`);
    setPlaying(`${line.clipId}#${line.segmentIndex}`);
    el.onended = () => setPlaying(null);
    el.onerror = () => setPlaying(null);
    void el.play();
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title || "Script"}</h2>
        <div className="actions">
          <button
            type="button"
            className="ghost-button small"
            onClick={() => setExpanded(true)}
          >
            Read the whole script
          </button>
        </div>
        <p className="hint">
          {lines.length} line{lines.length === 1 ? "" : "s"} · {words} words
          {wordTarget > 0 && (
            <>
              {" "}
              (target {wordTarget}
              {Math.abs(drift) >= 10 ? `, ${drift > 0 ? "+" : ""}${drift}%` : ""})
            </>
          )}
        </p>
      </div>

      {intro.enabled && <Opening intro={intro} busy={busy} />}

      <ol className="script-list">
        {lines.map((line, i) => {
          const key = `${line.clipId}#${line.segmentIndex}`;
          const audio = byKey.get(key);
          const isBusy = resynthesizing === key;
          const isStale = staleLines.has(key);
          const over = overBudget.get(key);
          return (
            <li key={key} className="script-row" data-stale={isStale || undefined}>
              <span className="clip-index" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="voiced-body">
                <p className="script-clip">
                  {segmentText(clips, line.clipId, line.segmentIndex)}
                </p>
                <label className="visually-hidden" htmlFor={`line-${i}`}>
                  Narration line {i + 1}
                </label>
                <textarea
                  id={`line-${i}`}
                  className="clip-input"
                  rows={2}
                  value={line.text}
                  disabled={busy}
                  onChange={(e) => onEditLine(i, e.currentTarget.value)}
                />

                {over && (
                  <div className="voiced-controls">
                    <span
                      className="skip-chip"
                      title={`This clip can carry about ${over.budget} words. Slowing stops at 2x, so the shot would be shown twice to cover the rest.`}
                    >
                      {over.used} words, clip fits {over.budget}
                    </span>
                    <button
                      type="button"
                      className="ghost-button small"
                      disabled={busy || shortening !== null}
                      onClick={() => onShorten(i, over.budget)}
                    >
                      {shortening === key ? "Shortening…" : "Shorten to fit"}
                    </button>
                  </div>
                )}

                {!audio && (
                  <div className="voiced-controls">
                    <button
                      type="button"
                      className="ghost-button small"
                      disabled={busy || isBusy || !line.text.trim()}
                      onClick={() => onHearLine(i)}
                    >
                      {isBusy ? "Recording…" : "▶ Hear this line"}
                    </button>
                    <span className="hint">records just this line</span>
                  </div>
                )}

                {audio && (
                  <div className="voiced-controls">
                    <button
                      type="button"
                      className="ghost-button small"
                      disabled={isBusy}
                      onClick={() => play(audio)}
                    >
                      {isBusy ? "Re-recording…" : playing === key ? "▶ Playing" : "▶ Play"}
                    </button>
                    {isStale && (
                      <span className="skip-chip" title="This line changed after it was recorded">
                        out of date
                      </span>
                    )}
                    <button
                      type="button"
                      className="ghost-button small"
                      disabled={busy || isBusy}
                      onClick={() => onHearLine(i)}
                      title="Record this line again with the current voice"
                    >
                      ↻ Re-record
                    </button>
                    <span className="hint">{(audio.durationMs / 1000).toFixed(1)}s</span>
                    {showPronunciationFixes &&
                      audio.skipped.map((w) => (
                      <button
                        key={w}
                        type="button"
                        className="skip-chip skip-chip-button"
                        title={`"${w}" couldn’t be pronounced — click to fix`}
                        onClick={() => setCorrecting(w)}
                      >
                        {w} ⚠
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {correcting && (
        <div className="warning correction" role="dialog" aria-label="Fix pronunciation">
          <strong>How should “{correcting}” sound?</strong>
          <span>
            Write it the way it’s said, using ordinary words or syllables — for
            example <em>rake see vik</em> for <em>Reykjavik</em>. Only the line
            containing it is re-recorded.
          </span>
          <form
            className="voice-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (respelling.trim()) {
                onCorrectWord(correcting, respelling.trim());
                setCorrecting(null);
              }
            }}
          >
            <input
              className="clip-input"
              value={respelling}
              autoFocus
              placeholder="rake see vik"
              onChange={(e) => setRespelling(e.currentTarget.value)}
            />
            <button type="submit" className="primary-button" disabled={!respelling.trim()}>
              Fix and re-record
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setCorrecting(null)}
            >
              Cancel
            </button>
          </form>
        </div>
      )}

      {!showPronunciationFixes && voiced && (
        <p className="placeholder-note">
          This voice does its own pronunciation. If a word sounds wrong, edit the
          line above and re-record just that line.
        </p>
      )}

      {showPronunciationFixes && Object.keys(pronunciations).length > 0 && (
        <p className="placeholder-note">
          Corrections in this video:{" "}
          {Object.entries(pronunciations)
            .map(([w, r]) => `${w} → ${r}`)
            .join(" · ")}
        </p>
      )}

      {children}
      {expanded && (
        <div
          className="describer"
          role="dialog"
          aria-label="The whole script"
          onClick={() => setExpanded(false)}
        >
          <div className="describer-panel" onClick={(e) => e.stopPropagation()}>
            <div className="describer-head">
              <div style={{ minWidth: 0 }}>
                <strong className="describer-name">{title || "Script"}</strong>
                <span className="hint">
                  {lines.length} line{lines.length === 1 ? "" : "s"} · {words} words
                </span>
              </div>
              <button
                type="button"
                className="lib-act"
                onClick={() => setExpanded(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="script-read">
              {/* Still one field per line: the lines are what the timeline
                  addresses, and editing the script as one blob would leave no
                  way to tell which clip a sentence belongs to. */}
              {lines.map((line, i) => (
                <div className="script-read-line" key={`${line.clipId}#${line.segmentIndex}`}>
                  <p className="script-read-source">
                    {String(i + 1).padStart(2, "0")} ·{" "}
                    {segmentText(clips, line.clipId, line.segmentIndex)}
                  </p>
                  <textarea
                    className="clip-input script-read-text"
                    rows={Math.max(2, Math.ceil(line.text.length / 60))}
                    value={line.text}
                    disabled={busy}
                    onChange={(e) => onEditLine(i, e.currentTarget.value)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The opening line.
 *
 * Above the numbered lines and outside the list, because it is not one of them:
 * it narrates no moment, it plays over a montage rather than a clip, and it is
 * counted against no word target. Showing it as line zero would say the
 * opposite of all three.
 */
function Opening({
  intro,
  busy,
}: {
  intro: Props["intro"];
  busy: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const text = intro.hook ?? "";
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lengthOk = !text.trim() || hookLengthOk(text, intro.language);

  function play() {
    if (!intro.audio) return;
    const el = new Audio(audioUrl(intro.audio.audioPath) + `?t=${Date.now()}`);
    setPlaying(true);
    el.onended = () => setPlaying(false);
    el.onerror = () => setPlaying(false);
    void el.play();
  }

  return (
    <div className="opening-block">
      <div className="opening-head">
        <strong>Opening line</strong>
        <span className="hint">
          {intro.audio
            ? `spoken over ${intro.shots} shot${intro.shots === 1 ? "" : "s"} before the film starts`
            : "spoken over a short montage before the film starts"}
        </span>
      </div>

      {intro.hook === null ? (
        <div className="voiced-controls">
          <p className="hint" style={{ margin: 0 }}>
            This video has no opening line yet.
          </p>
          <button
            type="button"
            className="ghost-button small"
            disabled={busy || intro.busy}
            onClick={intro.onRegenerate}
          >
            {intro.busy ? "Writing…" : "Write one"}
          </button>
        </div>
      ) : (
        <>
          <textarea
            className="clip-input"
            rows={2}
            value={text}
            disabled={busy || intro.busy}
            aria-label="Opening line"
            onChange={(e) => intro.onEdit(e.currentTarget.value)}
          />
          <div className="voiced-controls">
            <button
              type="button"
              className="ghost-button small"
              disabled={busy || intro.busy}
              onClick={intro.onRegenerate}
              title="Write a different opening line, leaving the script alone"
            >
              {intro.busy ? "Working…" : "↻ Rewrite"}
            </button>
            {intro.audio && !intro.stale && (
              <button
                type="button"
                className="ghost-button small"
                disabled={intro.busy}
                onClick={play}
              >
                {playing ? "▶ Playing" : "▶ Play"}
              </button>
            )}
            <button
              type="button"
              className="ghost-button small"
              disabled={busy || intro.busy || !text.trim()}
              onClick={intro.onRecord}
            >
              {intro.audio ? "↻ Re-record" : "▶ Hear it"}
            </button>
            {intro.audio && (
              <span className="hint">{(intro.audio.durationMs / 1000).toFixed(1)}s</span>
            )}
            {intro.stale && (
              <span className="skip-chip" title="The opening changed after it was recorded">
                out of date
              </span>
            )}
            {!lengthOk && (
              <span className="hint">
                {words} words — an opening reads best between {HOOK_MIN_WORDS} and{" "}
                {HOOK_MAX_WORDS}
              </span>
            )}
          </div>
          {!intro.audio && (
            <p className="hint" style={{ marginBottom: 0 }}>
              Recorded with the rest of the narration, or on its own from here.
              Without a recording there is no montage and the film starts on its
              first line.
            </p>
          )}
        </>
      )}
    </div>
  );
}

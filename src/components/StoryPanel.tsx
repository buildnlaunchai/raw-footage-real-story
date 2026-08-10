/**
 * Stage B — what could this footage become?
 *
 * The suggestions are derived only from what the clips say. Nothing about the
 * user is involved, so this is "here are the stories in your footage", not a
 * recommendation.
 */
import { useState } from "react";
import type { IdeaProgress, StoryIdea } from "../lib/storyIdeas";

interface Props {
  ideas: StoryIdea[] | null;
  busy: boolean;
  progress: IdeaProgress | null;
  error: string | null;
  describedClips: number;
  totalSegments: number;
  chosenTitle: string;
  wordCount: number;
  onSuggest: () => void;
  onChooseTitle: (title: string) => void;
  onWordCount: (n: number) => void;
  onContinue: () => void;
  continueLabel: string;
  continueBusy: boolean;
}

export function StoryPanel({
  ideas,
  busy,
  progress,
  error,
  describedClips,
  totalSegments,
  chosenTitle,
  wordCount,
  onSuggest,
  onChooseTitle,
  onWordCount,
  onContinue,
  continueLabel,
  continueBusy,
}: Props) {
  const [custom, setCustom] = useState("");

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Story</h2>
        <p className="hint">
          {describedClips} described clip{describedClips === 1 ? "" : "s"} · {totalSegments}{" "}
          segment{totalSegments === 1 ? "" : "s"}
        </p>
      </div>

      <div className="field-row">
        <label className="field-label" htmlFor="word-count">
          Script length
        </label>
        <div className="voice-row">
          <input
            id="word-count"
            className="clip-input word-input"
            type="number"
            min={20}
            max={2000}
            step={10}
            value={wordCount}
            onChange={(e) => onWordCount(Number(e.currentTarget.value) || 0)}
          />
          <span className="hint">
            words · roughly {Math.round((wordCount / 150) * 60)}s of narration
          </span>
        </div>
      </div>

      <div className="actions">
        <button
          type="button"
          className="ghost-button"
          onClick={onSuggest}
          disabled={busy || describedClips === 0}
        >
          {busy ? "Reading your footage…" : ideas ? "Suggest again" : "Suggest story ideas"}
        </button>
        {busy && progress && (
          <span className="hint">
            {progress.stage === "reading"
              ? `Reading ${progress.done} of ${progress.total}`
              : "Thinking of angles…"}
          </span>
        )}
        {describedClips === 0 && <span className="hint">Describe some clips first</span>}
      </div>

      {busy && progress?.stage === "reading" && progress.total > 0 && (
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
          <strong>Couldn’t suggest story ideas.</strong>
          <span>{error}</span>
        </div>
      )}

      {ideas && ideas.length > 0 && (
        <ul className="idea-list">
          {ideas.map((idea) => (
            <li key={idea.title}>
              <button
                type="button"
                className={`idea-item${chosenTitle === idea.title ? " is-selected" : ""}`}
                onClick={() => onChooseTitle(idea.title)}
              >
                <span className="idea-title">{idea.title}</span>
                <span className="hint">{idea.angle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="voice-row custom-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (custom.trim()) onChooseTitle(custom.trim());
        }}
      >
        <label className="visually-hidden" htmlFor="custom-title">
          Your own title
        </label>
        <input
          id="custom-title"
          className="clip-input"
          value={custom}
          placeholder="…or write your own title"
          onChange={(e) => setCustom(e.currentTarget.value)}
        />
        <button type="submit" className="ghost-button" disabled={!custom.trim()}>
          Use this
        </button>
      </form>

      {chosenTitle && (
        <div className="actions">
          <button
            type="button"
            className="primary-button"
            onClick={onContinue}
            disabled={continueBusy || wordCount < 20}
          >
            {continueBusy ? "Working…" : continueLabel}
          </button>
          <span className="hint">
            “{chosenTitle}” · ~{wordCount} words
          </span>
        </div>
      )}
    </section>
  );
}

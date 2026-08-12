/**
 * Stage B — what could this footage become?
 *
 * The suggestions are derived only from what the clips say. Nothing about the
 * user is involved, so this is "here are the stories in your footage", not a
 * recommendation.
 */
import { useState } from "react";
import type { IdeaProgress, StoryIdea } from "../lib/storyIdeas";
import { SCRIPT_STYLES, type ScriptStyle } from "../lib/scriptComposer";
import { LANGUAGES, languageFor } from "../lib/languages";
import { ScriptProviderSetup } from "./ScriptProviderSetup";
import type { QualityTier, ScriptProviderId } from "../lib/scriptProviders";

interface Props {
  ideas: StoryIdea[] | null;
  busy: boolean;
  progress: IdeaProgress | null;
  error: string | null;
  describedClips: number;
  totalSegments: number;
  chosenTitle: string;
  wordCount: number;
  /** What the chosen length does with the described footage. */
  coverage: { used: number; available: number; percent: number };
  /** A length that would use most of the library. */
  suggested: number;
  style: ScriptStyle;
  onStyle: (s: ScriptStyle) => void;
  language: string;
  onLanguage: (code: string) => void;
  scriptProvider: ScriptProviderId;
  onScriptProvider: (id: ScriptProviderId) => void;
  qualityTier: QualityTier;
  onQualityTier: (t: QualityTier) => void;
  usage: { inputTokens: number; outputTokens: number; calls: number } | null;
  critique: boolean;
  onCritique: (v: boolean) => void;
  onSuggest: () => void;
  onChooseTitle: (title: string) => void;
  onWordCount: (n: number) => void;
  onContinue: () => void;
  continueLabel: string;
  continueBusy: boolean;
  /** Failure from script generation, shown here rather than at the top of the
   *  page — an error rendered a screen away from its button reads as nothing
   *  having happened at all. */
  continueError: string | null;
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
  coverage,
  suggested,
  style,
  onStyle,
  language,
  onLanguage,
  scriptProvider,
  onScriptProvider,
  qualityTier,
  onQualityTier,
  usage,
  critique,
  onCritique,
  onSuggest,
  onChooseTitle,
  onWordCount,
  onContinue,
  continueLabel,
  continueBusy,
  continueError,
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

        {/* What this length does with the footage. The old default used six
            moments however large the library was, and nothing said so. */}
        <p className="coverage-line">
          <span className={coverage.percent >= 60 ? "is-good" : undefined}>
            {coverage.used} of {coverage.available} described moment
            {coverage.available === 1 ? "" : "s"}
          </span>{" "}
          <span className="hint">({coverage.percent}% of your footage)</span>
          {suggested !== wordCount && coverage.percent < 60 && (
            <button
              type="button"
              className="link-button"
              onClick={() => onWordCount(suggested)}
              title={`About ${Math.round((suggested / 150) * 60)}s of narration`}
            >
              use {suggested} words to cover most of it
            </button>
          )}
        </p>
      </div>

      <div className="field-row">
        <label className="field-label" htmlFor="script-language">
          Language
        </label>
        <div className="voice-row">
          <select
            id="script-language"
            className="select"
            value={language}
            onChange={(e) => onLanguage(e.currentTarget.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
                {l.nativeLabel !== l.label ? ` · ${l.nativeLabel}` : ""}
              </option>
            ))}
          </select>
          {!languageFor(language).localVoiceSupported && (
            <span className="hint">Needs a cloud voice</span>
          )}
        </div>
        {language !== "en" && scriptProvider === "local" && (
          <p className="placeholder-note">
            The local model writes {languageFor(language).label} poorly — tested
            on Bengali it invented names and used wrong vocabulary. OpenAI
            handled the same footage correctly; switch the script writer below.
          </p>
        )}
        {language !== "en" && scriptProvider === "openai" && !languageFor(language).documented && (
          <p className="placeholder-note">
            {languageFor(language).label} isn’t one of the languages this app
            has tested beyond Bengali. Read the draft before recording it.
          </p>
        )}
      </div>

      <div className="field-row">
        <span className="field-label">Tone</span>
        <div className="style-row">
          {SCRIPT_STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`style-chip${style === s.id ? " is-selected" : ""}`}
              onClick={() => onStyle(s.id)}
              title={s.hint}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <ScriptProviderSetup
        providerId={scriptProvider}
        onProvider={onScriptProvider}
        qualityTier={qualityTier}
        onQualityTier={onQualityTier}
        language={languageFor(language)}
        usage={usage}
      />

      <div className="field-row">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={critique}
            onChange={(e) => onCritique(e.currentTarget.checked)}
          />
          <span>
            Review and revise the draft
            <span className="hint"> · one extra pass, roughly 13s</span>
          </span>
        </label>
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
        <>
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

          {continueError && (
            <div className="error" role="alert">
              <strong>Couldn’t generate the script.</strong>
              <span>{continueError}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

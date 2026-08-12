/**
 * The instruction the script writer is given, in a box you can edit.
 *
 * Tuning how the model writes was a code change — the Bengali register work
 * was several paragraphs of prose living in a TypeScript file. That is the
 * wrong home for it: the person best placed to fix Bengali is whoever speaks
 * Bengali, not whoever can rebuild the app.
 */
import { useEffect, useState } from "react";
import { defaultWritingInstructions } from "../lib/scriptComposerCore";
import { getWritingInstructions, setWritingInstructions } from "../lib/scriptProviders";
import { HOOK_MAX_WORDS, HOOK_MIN_WORDS } from "../lib/scriptComposer";
import { languageFor, LANGUAGES } from "../lib/languages";

interface Props {
  /** The language whose built-in wording to show as the starting point. */
  language: string;
  /** Whether new scripts get an opening line and a montage under it. */
  introEnabled: boolean;
  onIntroEnabledChange: (enabled: boolean) => void;
}

export function SettingsPanel({ language, introEnabled, onIntroEnabledChange }: Props) {
  const [stored, setStored] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(language);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const builtIn = defaultWritingInstructions(languageFor(preview));

  useEffect(() => {
    void getWritingInstructions().then((v) => {
      setStored(v);
      setDraft(v ?? "");
      setLoading(false);
    });
  }, []);

  async function save() {
    const next = draft.trim() ? draft : null;
    await setWritingInstructions(next);
    setStored(next);
    setSaved(new Date().toLocaleTimeString());
  }

  async function reset() {
    await setWritingInstructions(null);
    setStored(null);
    setDraft("");
    setSaved(new Date().toLocaleTimeString());
  }

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>How the script is written</h2>
          <span className="hint">
            {loading ? "Loading…" : stored ? "Using your wording" : "Using the built-in wording"}
          </span>
        </div>

        <p className="hint" style={{ marginTop: 0 }}>
          This is the instruction sent to the model before it writes. Leave it
          empty to use the built-in wording, which adapts to the chosen
          language. Anything you put here is used instead, for every language —
          so if you write in more than one, say so in the text.
        </p>

        <label className="field-label" htmlFor="instructions">
          Your instruction
        </label>
        <textarea
          id="instructions"
          className="clip-input"
          rows={12}
          value={draft}
          placeholder="Empty — the built-in wording below is being used."
          onChange={(e) => setDraft(e.currentTarget.value)}
        />

        <div className="actions" style={{ marginTop: "0.9rem" }}>
          <button type="button" className="primary-button" onClick={save} disabled={loading}>
            Save
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setDraft(builtIn)}
            title="Copy the built-in wording into the box so you can edit it"
          >
            Start from the built-in wording
          </button>
          {stored && (
            <button type="button" className="ghost-button" onClick={reset}>
              Back to built-in
            </button>
          )}
          {saved && <span className="hint">Saved at {saved}</span>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>The opening</h2>
          <span className="hint">{introEnabled ? "On" : "Off"}</span>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          A film normally starts with one spoken line — {HOOK_MIN_WORDS} to{" "}
          {HOOK_MAX_WORDS} words — over a quick montage of shots, which then
          dissolves into the first narrated moment. The line is written after the
          script and counts towards no word target of its own, and the montage
          favours footage the story does not otherwise use.
        </p>
        <label className="voice-row" style={{ gap: "0.6rem" }}>
          <input
            type="checkbox"
            checked={introEnabled}
            onChange={(e) => onIntroEnabledChange(e.currentTarget.checked)}
          />
          <span>Give new videos an opening</span>
        </label>
        <p className="hint" style={{ marginBottom: 0 }}>
          Turning this off stops new scripts being given one, and leaves it out
          of anything you render from now on — including videos that already
          have an opening written. The line itself is kept, so turning this back
          on restores it.
        </p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>The built-in wording</h2>
          <label className="lib-tool">
            <span className="visually-hidden">Language</span>
            <select value={preview} onChange={(e) => setPreview(e.currentTarget.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          What would be sent for {languageFor(preview).label} if you leave the box
          empty. Shown in full rather than described, because a prompt you cannot
          read is one you cannot fix.
        </p>
        <pre className="instructions-preview">{builtIn}</pre>
      </div>
    </>
  );
}

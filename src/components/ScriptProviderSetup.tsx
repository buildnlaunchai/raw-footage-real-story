/**
 * Choosing who writes the script, and — for the paid option — proving the key
 * works before spending anything on it.
 */
import { useEffect, useState } from "react";
import {
  SCRIPT_PROVIDERS,
  testOpenAiKey,
  type QualityTier,
  type ScriptProviderId,
} from "../lib/scriptProviders";
import { clearApiKey, hasApiKey, setApiKey } from "../lib/ttsProviders";
import type { ScriptLanguage } from "../lib/languages";

interface Props {
  providerId: ScriptProviderId;
  onProvider: (id: ScriptProviderId) => void;
  qualityTier: QualityTier;
  onQualityTier: (t: QualityTier) => void;
  language: ScriptLanguage;
  usage: { inputTokens: number; outputTokens: number; calls: number } | null;
}

export function ScriptProviderSetup({
  providerId,
  onProvider,
  qualityTier,
  onQualityTier,
  language,
  usage,
}: Props) {
  const provider = SCRIPT_PROVIDERS[providerId];
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [testing, setTesting] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    if (!provider.capabilities.needsApiKey) {
      setKeyPresent(null);
      return;
    }
    void hasApiKey("openai").then(setKeyPresent);
  }, [provider]);

  async function onSaveKey() {
    setTesting(true);
    setKeyError(null);
    try {
      // Validated with a one-word call before storing, so a typo never becomes
      // a saved credential that fails mid-generation.
      await testOpenAiKey(keyInput.trim());
      await setApiKey(keyInput.trim(), "openai");
      setKeyPresent(true);
      setKeyInput("");
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="provider-picker">
      <span className="field-label">Script writer</span>
      <div className="style-row">
        {Object.values(SCRIPT_PROVIDERS).map((p) => (
          <button
            key={p.id}
            type="button"
            className={`style-chip${providerId === p.id ? " is-selected" : ""}`}
            onClick={() => onProvider(p.id)}
            title={p.blurb}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Only says what has actually been measured. The local model's Bengali
          was tested and failed; OpenAI's is not yet known, and claiming it is
          better before checking would be exactly the assumption this project
          keeps avoiding. */}
      {language.code !== "en" && provider.capabilities.nonEnglishQuality === "poor" && (
        <div className="warning" role="status">
          <strong>{language.label} quality is poor with the local model.</strong>
          <span>
            Tested on Bengali, it produced invented names and wrong vocabulary.
            Consider writing the script yourself and editing it below.
          </span>
        </div>
      )}

      {provider.capabilities.isCloud && (
        <div className="cloud-notice" role="status">
          <strong>This sends your clip descriptions to OpenAI.</strong>
          <span>
            Only text leaves this machine — your footage never does. You’re
            billed by OpenAI directly.
          </span>
        </div>
      )}

      {provider.capabilities.needsApiKey && keyPresent === false && (
        <div className="key-entry">
          <label className="field-label" htmlFor="openai-key">
            OpenAI API key
          </label>
          <div className="voice-row">
            <input
              id="openai-key"
              className="clip-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyInput}
              placeholder="sk-…"
              onChange={(e) => setKeyInput(e.currentTarget.value)}
            />
            <button
              type="button"
              className="primary-button"
              onClick={onSaveKey}
              disabled={testing || keyInput.trim().length === 0}
            >
              {testing ? "Checking…" : "Test and save"}
            </button>
          </div>
          <p className="placeholder-note">
            Stored in your system keychain, never in a project file or export.
          </p>
          {keyError && (
            <div className="error" role="alert">
              <strong>That key didn’t work.</strong>
              <span>{keyError}</span>
            </div>
          )}
        </div>
      )}

      {providerId === "openai" && keyPresent && (
        <>
          <div className="key-status">
            <span className="hint">Key saved in your keychain</span>
            <button
              type="button"
              className="ghost-button small"
              onClick={async () => {
                await clearApiKey("openai");
                setKeyPresent(false);
              }}
            >
              Remove key
            </button>
          </div>

          <span className="field-label">Model</span>
          <div className="style-row">
            {(["balanced", "best"] as QualityTier[]).map((t) => (
              <button
                key={t}
                type="button"
                className={`style-chip${qualityTier === t ? " is-selected" : ""}`}
                onClick={() => onQualityTier(t)}
                title={
                  t === "balanced"
                    ? "Good writing at a fraction of the cost"
                    : "The strongest model; several times the price per word"
                }
              >
                {t === "balanced" ? "Balanced" : "Best"}
              </button>
            ))}
          </div>

          <p className="placeholder-note">
            {usage ? (
              <>
                Last script used {usage.inputTokens.toLocaleString()} input and{" "}
                {usage.outputTokens.toLocaleString()} output tokens across{" "}
                {usage.calls} calls. Check current rates on OpenAI’s pricing
                page — they aren’t hardcoded here, so they can’t go stale.
              </>
            ) : (
              <>
                Billed per token by OpenAI. Exact counts are shown after each
                run; a normal API key can’t read account spend, so this app
                measures what it uses rather than guessing at cost.
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}

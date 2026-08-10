/**
 * Choosing where the voice comes from.
 *
 * The app's whole promise is that nothing leaves the machine, and selecting a
 * cloud provider makes that conditionally untrue. So the disclosure is
 * persistent rather than a one-time dialog, and it is specific: the script text
 * travels, the footage does not. "Cloud" on its own would imply the video is
 * being uploaded, which it never is.
 */
import { useEffect, useState } from "react";
import type { ScriptLanguage } from "../lib/languages";
import {
  characterCount,
  clearApiKey,
  fetchUsage,
  hasApiKey,
  PROVIDERS,
  setApiKey,
  testApiKey,
  type CloudUsage,
  type ProviderId,
  type VoiceOption,
} from "../lib/ttsProviders";

interface Props {
  providerId: ProviderId;
  onProvider: (id: ProviderId) => void;
  voices: VoiceOption[];
  voiceId: string;
  onVoice: (id: string) => void;
  voicesError: string | null;
  onReloadVoices: () => void;
  scriptLines: { text: string }[];
  language: ScriptLanguage;
  disabled: boolean;
  previewing: boolean;
  onPreview: () => void;
}

function resetLabel(unix: number | null): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  return ` · resets ${d.toLocaleDateString()}`;
}

export function ProviderPicker({
  providerId,
  onProvider,
  voices,
  voiceId,
  onVoice,
  voicesError,
  onReloadVoices,
  scriptLines,
  language,
  disabled,
  previewing,
  onPreview,
}: Props) {
  const provider = PROVIDERS[providerId];
  // A pasted id is simply one the listing does not contain.
  const listed = voices.some((v) => v.id === voiceId);
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [testing, setTesting] = useState(false);
  const [usage, setUsage] = useState<CloudUsage | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    if (!provider.capabilities.needsApiKey) {
      setKeyPresent(null);
      return;
    }
    void hasApiKey().then(setKeyPresent);
  }, [provider]);

  // Usage is refreshed whenever it might have changed, and its failure is
  // never fatal — not knowing the quota should not block generating.
  useEffect(() => {
    if (providerId !== "elevenlabs" || !keyPresent) return;
    void fetchUsage().then(setUsage).catch(() => setUsage(null));
  }, [providerId, keyPresent, scriptLines.length]);

  async function onSaveKey() {
    setTesting(true);
    setKeyError(null);
    try {
      // Validate before storing, so a typo never becomes a saved credential
      // that fails later with a confusing message.
      const u = await testApiKey(keyInput.trim());
      const stored = await setApiKey(keyInput.trim());
      // Confirm against the store rather than assuming the write took.
      const present = stored && (await hasApiKey());
      setKeyPresent(present);
      if (!present) {
        setKeyError(
          "The key couldn't be saved to your system keychain. Set ELEVENLABS_API_KEY instead.",
        );
        return;
      }
      setUsage(u);
      setKeyInput("");
      onReloadVoices();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  const chars = characterCount(scriptLines);
  const remaining = usage ? usage.characterLimit - usage.characterCount : null;

  return (
    <div className="provider-picker">
      <span className="field-label">Voice source</span>
      <div className="style-row">
        {Object.values(PROVIDERS).map((p) => {
          // A provider that cannot speak the script's language is offered but
          // plainly unavailable, rather than silently missing.
          const unsupported =
            p.capabilities.languages === "english-only" && !language.localVoiceSupported;
          return (
            <button
              key={p.id}
              type="button"
              className={`style-chip${providerId === p.id ? " is-selected" : ""}`}
              onClick={() => onProvider(p.id)}
              disabled={disabled || unsupported}
              title={
                unsupported
                  ? `Kokoro only supports English — switch to ElevenLabs for ${language.label} narration.`
                  : p.blurb
              }
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {!language.localVoiceSupported && (
        <p className="placeholder-note">
          Kokoro only supports English — {language.label} narration needs
          ElevenLabs (cloud).
        </p>
      )}

      {provider.capabilities.isCloud && (
        <div className="cloud-notice" role="status">
          <strong>This sends your script text to ElevenLabs.</strong>
          <span>
            Only the narration text leaves this machine — your footage never
            does. You’re billed by ElevenLabs directly.
          </span>
        </div>
      )}

      {provider.capabilities.needsApiKey && keyPresent === false && (
        <div className="key-entry">
          <label className="field-label" htmlFor="api-key">
            ElevenLabs API key
          </label>
          <div className="voice-row">
            <input
              id="api-key"
              className="clip-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyInput}
              placeholder="Paste your key"
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

      {provider.capabilities.needsApiKey && keyPresent && (
        <div className="key-status">
          <span className="hint">
            Key saved in your keychain
            {usage && (
              <>
                {" · "}
                {remaining?.toLocaleString()} of {usage.characterLimit.toLocaleString()}{" "}
                characters left ({usage.tier}){resetLabel(usage.resetsAtUnix)}
              </>
            )}
          </span>
          <button
            type="button"
            className="ghost-button small"
            onClick={async () => {
              await clearApiKey();
              setKeyPresent(false);
              setUsage(null);
            }}
          >
            Remove key
          </button>
        </div>
      )}

      {(providerId === "local" || keyPresent) && (
        <>
          <label className="field-label" htmlFor="voice-select">
            Voice
          </label>
          <div className="voice-row">
            {voices.length > 0 ? (
              <select
                id="voice-select"
                className="select"
                value={voiceId}
                disabled={disabled}
                onChange={(e) => onVoice(e.currentTarget.value)}
              >
                {voices.some((v) => v.recommended) && (
                  <optgroup label="Recommended for narration">
                    {voices
                      .filter((v) => v.recommended)
                      .map((v) => (
                        <option key={`rec-${v.id}`} value={v.id}>
                          {v.label} · {v.group}
                        </option>
                      ))}
                  </optgroup>
                )}
                {[...new Set(voices.map((v) => v.group))].map((group) => (
                  <optgroup key={group} label={group}>
                    {voices
                      .filter((v) => v.group === group)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              className="ghost-button"
              onClick={onPreview}
              disabled={disabled || previewing || !voiceId}
            >
              {previewing ? "Preview…" : "▶ Preview"}
            </button>
          </div>

          {provider.capabilities.acceptsManualVoiceId && (
            <>
              <label className="field-label" htmlFor="voice-manual">
                Or paste a voice ID
              </label>
              <input
                id="voice-manual"
                className="clip-input"
                value={listed ? "" : voiceId}
                placeholder={
                  voices.length > 0
                    ? "e.g. a cloned voice not in the list above"
                    : "Voice ID"
                }
                disabled={disabled}
                onChange={(e) => {
                  const next = e.currentTarget.value.trim();
                  // Clearing the field hands control back to the picker rather
                  // than leaving the project pointed at an empty voice.
                  onVoice(next || voices[0]?.id || "");
                }}
              />
              <p className="hint">
                {listed
                  ? "Using a voice from your account. Paste an ID to override it."
                  : `Using pasted ID ${voiceId || "—"}. Clear this to go back to the list.`}
              </p>
            </>
          )}

          {voicesError && (
            <div className="warning" role="status">
              <strong>Couldn’t load your voices.</strong>
              <span>
                {voicesError} You can still paste a voice ID above.{" "}
                <button type="button" className="link-button" onClick={onReloadVoices}>
                  Try again
                </button>
              </span>
            </div>
          )}

          {provider.capabilities.billing === "per-character" && scriptLines.length > 0 && (
            <p className="placeholder-note">
              This script is {chars.toLocaleString()} characters
              {remaining !== null && (
                <>
                  {" "}
                  · you have {remaining.toLocaleString()} left
                  {remaining < chars && " — not enough for this script"}
                </>
              )}
              .
            </p>
          )}
        </>
      )}
    </div>
  );
}

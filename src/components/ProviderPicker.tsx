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
  fetchUsage,
  PROVIDERS,
  type CloudUsage,
  type ProviderId,
  type VoiceOption,
} from "../lib/ttsProviders";
import {
  asAccountKeyError,
  openKeyManagement,
  statusFor,
  type ProviderStatus,
} from "../lib/accountKeys";

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
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [usage, setUsage] = useState<CloudUsage | null>(null);
  /**
   * Why the account could not be asked. Never why a key was refused — see the
   * same split in `ScriptProviderSetup`.
   */
  const [problem, setProblem] = useState<
    { message: string; consentUrl: string | null; actionLabel: string | null } | null
  >(null);

  async function refresh(force = false) {
    if (!provider.capabilities.needsApiKey) {
      setStatus(null);
      setProblem(null);
      return;
    }
    setChecking(true);
    try {
      const next = await statusFor("elevenlabs", force);
      setStatus(next);
      setProblem(null);
      // A key that has just appeared is a voice list worth loading.
      if (next?.linked) onReloadVoices();
    } catch (err) {
      const e = asAccountKeyError(err);
      setStatus(null);
      setProblem({ message: e.message, consentUrl: e.consentUrl, actionLabel: e.actionLabel });
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    // Re-asked when the chosen provider changes, and not on `refresh`'s
    // identity — it is redefined every render, so depending on it would ask the
    // platform once per render.
    void refresh();
  }, [provider]);

  const linked = status?.linked === true;

  // Usage is refreshed whenever it might have changed, and its failure is
  // never fatal — not knowing the quota should not block generating.
  useEffect(() => {
    if (providerId !== "elevenlabs" || !linked) return;
    void fetchUsage().then(setUsage).catch(() => setUsage(null));
  }, [providerId, linked, scriptLines.length]);

  const chars = characterCount(scriptLines);
  // Characters only. On credit the member's balance is in CREDITS, and
  // subtracting one unit from the other to compare against a script length is
  // how a UI ends up saying "not enough" to somebody with plenty.
  const remaining =
    usage?.kind === "provider" ? usage.characterLimit - usage.characterCount : null;
  const spendableCredits =
    usage?.kind === "credit" ? usage.balance - usage.held : null;

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

      {/* Could not ask. Not the same thing as having no key. */}
      {provider.capabilities.needsApiKey && problem && (
        <div className="warning" role="status">
          <strong>Couldn’t check your account.</strong>
          <span>{problem.message}</span>
          <div className="actions" style={{ marginTop: "0.6rem" }}>
            <button
              type="button"
              className="ghost-button small"
              onClick={() => void refresh(true)}
              disabled={checking}
            >
              {checking ? "Checking…" : "Try again"}
            </button>
            {/* Only ever the platform's own link, and only if it sent one. */}
            {problem.consentUrl && (
              <button
                type="button"
                className="ghost-button small"
                onClick={() => void openKeyManagement("elevenlabs", problem.consentUrl)}
              >
                {problem.actionLabel ?? "Open my dashboard"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Asked, and the answer was no. */}
      {provider.capabilities.needsApiKey && !problem && status && !linked && (
        <div className="key-entry">
          {/* The platform's own words for which of the three situations this
              is. Not written here, because "no key" and "not allowed yet" are
              different things and only the response knows which. */}
          <strong>{status.message}</strong>
          <p className="placeholder-note">
            Keys are managed on your BuildnLaunchAI account, not on this
            computer, so one key works everywhere you use the app and revoking
            it takes effect straight away.
          </p>
          <div className="actions">
            {status.linkUrl && (
              <button
                type="button"
                className="primary-button"
                onClick={() => void openKeyManagement("elevenlabs", status.linkUrl)}
              >
                {status.actionLabel ?? "Open my dashboard"}
              </button>
            )}
            <button
              type="button"
              className="ghost-button"
              onClick={() => void refresh(true)}
              disabled={checking}
            >
              {checking ? "Checking…" : "Re-check"}
            </button>
          </div>
        </div>
      )}

      {provider.capabilities.needsApiKey && linked && (
        <div className="key-status">
          <span className="hint">
            {status?.fromEnvironment
              ? "Using ELEVENLABS_API_KEY from this machine’s environment"
              : `Using the ElevenLabs key on your account${status?.hint ? ` (…${status.hint})` : ""}`}
            {usage?.kind === "provider" && (
              <>
                {" · "}
                {remaining?.toLocaleString()} of {usage.characterLimit.toLocaleString()}{" "}
                characters left ({usage.tier}){resetLabel(usage.resetsAtUnix)}
              </>
            )}
            {usage?.kind === "credit" && (
              <>
                {" · "}
                {spendableCredits?.toLocaleString()} credits left
              </>
            )}
          </span>
          {/* See the twin of this in `ScriptProviderSetup`: the platform's
              link, or no button at all. */}
          {status?.linkUrl && (
            <button
              type="button"
              className="ghost-button small"
              onClick={() => void openKeyManagement("elevenlabs", status.linkUrl)}
            >
              {status.actionLabel ?? "Manage key"}
            </button>
          )}
        </div>
      )}

      {(providerId === "local" || linked) && (
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
              {/* No "not enough" on credit: what a script costs in credits
                  depends on the model's rate, which this screen does not know.
                  Showing the balance is honest; guessing at it is not. */}
              {spendableCredits !== null && (
                <>
                  {" "}
                  · you have {spendableCredits.toLocaleString()} credits
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

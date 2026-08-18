/**
 * Choosing who writes the script, and saying plainly where the paid option's
 * key comes from.
 *
 * It comes from the account, and there is no second answer. This panel used to
 * carry a password field and a "test and save" button; both are gone, along
 * with the per-machine keychain entry behind them. What is left in the
 * unlinked case is one sentence and one button to the dashboard — because that
 * is genuinely all the app can offer, and a field that stored a key the account
 * did not know about was the thing making that untrue.
 */
import { useEffect, useState } from "react";
import {
  SCRIPT_PROVIDERS,
  type QualityTier,
  type ScriptProviderId,
} from "../lib/scriptProviders";
import {
  asAccountKeyError,
  openKeyManagement,
  statusFor,
  type ProviderStatus,
} from "../lib/accountKeys";
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
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [checking, setChecking] = useState(false);
  /**
   * Why the account could not be asked — never why a key was refused.
   *
   * Kept apart from `status` because "we could not reach your account" and
   * "your account has no key" want different words and different buttons, and
   * collapsing them tells an offline user to go and add a key they already
   * have.
   */
  const [problem, setProblem] = useState<{ message: string; manageUrl: string | null } | null>(null);

  async function refresh(force = false) {
    if (!provider.capabilities.needsApiKey) {
      setStatus(null);
      setProblem(null);
      return;
    }
    setChecking(true);
    try {
      setStatus(await statusFor("openai", force));
      setProblem(null);
    } catch (err) {
      const e = asAccountKeyError(err);
      setStatus(null);
      setProblem({ message: e.message, manageUrl: e.manageUrl });
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

      {/* Could not ask. Deliberately not the same screen as "no key". */}
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
            {problem.manageUrl && (
              <button
                type="button"
                className="ghost-button small"
                onClick={() => void openKeyManagement("openai", problem.manageUrl ?? undefined)}
              >
                Open my dashboard
              </button>
            )}
          </div>
        </div>
      )}

      {/* Asked, and the answer was no. One sentence, one destination. */}
      {provider.capabilities.needsApiKey && !problem && status && !linked && (
        <div className="key-entry">
          <strong>Your account has no OpenAI key available yet.</strong>
          <p className="placeholder-note">
            Keys are managed on your BuildnLaunchAI account, not on this
            computer, so one key works everywhere you use the app and revoking
            it takes effect straight away. Add or allow your OpenAI key on the
            dashboard, then re-check here.
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void openKeyManagement("openai", status.manageUrl)}
            >
              Manage my OpenAI key
            </button>
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

      {providerId === "openai" && linked && (
        <>
          <div className="key-status">
            <span className="hint">
              {status?.fromEnvironment
                ? "Using OPENAI_API_KEY from this machine’s environment"
                : `Using the OpenAI key on your account${status?.hint ? ` (…${status.hint})` : ""}`}
            </span>
            <button
              type="button"
              className="ghost-button small"
              onClick={() => void openKeyManagement("openai", status?.manageUrl)}
            >
              Manage
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

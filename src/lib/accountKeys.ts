/**
 * Where cloud provider keys come from, as the UI needs to know it.
 *
 * One source: the signed-in account. The app used to offer a second — paste a
 * key, keep it in this Mac's keychain — and that is gone. Two credentials for
 * one provider meant a key rotated on the dashboard stayed live locally until
 * somebody remembered to clear it, and neither side could show which of the two
 * was actually in use.
 *
 * So the screens here have exactly two states to render, and the second one has
 * exactly one thing to offer: a button to the page where the key is managed.
 * There is no field, because there is nothing this app can do with a key typed
 * into it.
 *
 * ## The link is the platform's, not ours
 *
 * In every state, not just the broken ones. A slot carries exactly one link —
 * somewhere to manage a key that works, somewhere to put right one that does
 * not — and Rust resolves the two into a single `linkUrl` before it gets here.
 * This file contains no dashboard address and composes none.
 *
 * It could not compose a correct one anyway: for a withheld key the
 * destination follows *why* it is withheld rather than which provider it is,
 * and `consent_required` lands on a page with no provider in its address at
 * all. A composed link would have looked right and opened a page that could not
 * grant the permission being asked for.
 */
import { invoke } from "@tauri-apps/api/core";
import { rememberMode, type KeyMode } from "./accountMode";
import { openUrl } from "@tauri-apps/plugin-opener";

export type ProviderSlug = "openai" | "elevenlabs";

// KeyMode and the remembered-mode helpers live in ./accountMode, which imports
// nothing from Tauri — so the test build can reach them without dragging a host
// bridge into a suite that is deliberately pure. Re-exported here because every
// screen already imports this module.
export type { KeyMode } from "./accountMode";
export {
  forgetMode,
  lastKnownMode,
  offlineModeNote,
  rememberMode,
} from "./accountMode";

/**
 * Why a provider is withheld, in the platform's own word.
 *
 * Three situations that are not interchangeable, and the app must not blur
 * them: `consentRequired` means the key exists and this app has not been
 * allowed to read it, so describing it as a missing key sends the person
 * looking for a problem they do not have.
 *
 * `undefined` where the platform said nothing, or said a word this build has
 * not been taught. That decides nothing — the message falls back to wording
 * true of all three, and the link beside it is still the platform's.
 */
export type WithheldReason = "consent_required" | "no_key" | "key_invalid";

/**
 * One provider's standing, as reported by Rust.
 *
 * Never carries the key. `hint` is four characters — enough to recognise which
 * key is in use, useless to anybody who reads it off a screen.
 */
export interface ProviderStatus {
  provider: ProviderSlug;
  /** How the provider is written in a sentence: "OpenAI", "ElevenLabs". */
  label: string;
  /** Is there a key this app can use right now? */
  linked: boolean;
  mode: KeyMode;
  hint: string | null;
  /**
   * Where the browser goes, exactly as the platform addressed it.
   *
   * Opened as-is: never joined to a base, never appended to, never composed.
   * Present in both states now — a working key carries somewhere to manage it,
   * a withheld one somewhere to fix it — so this is the single field every
   * button on every screen is built from.
   *
   * Absent only where there is genuinely nowhere to send anybody: a key coming
   * from an environment variable, which the account knows nothing about. The
   * rule for rendering is just: a button if there is a URL, no button if there
   * is not. Never a button pointing nowhere.
   */
  linkUrl?: string;
  reason?: WithheldReason;
  /** What to tell the person. Absent when the key works. */
  message?: string;
  /** What to put on the button that opens `linkUrl`. */
  actionLabel?: string;
  /** The key came from the environment — a CI and development arrangement. */
  fromEnvironment: boolean;
}

/**
 * A failure to find out, which is not the same as finding out there is no key.
 *
 * Being offline must never render as "you have not added a key": one is fixed
 * by waiting and the other by visiting a dashboard, and sending somebody to
 * re-add a key they already have is the wrong instruction delivered
 * confidently.
 */
export class AccountKeyError extends Error {
  code: string;
  consentUrl: string | null;
  actionLabel: string | null;

  constructor(
    code: string,
    message: string,
    consentUrl: string | null = null,
    actionLabel: string | null = null,
  ) {
    super(message);
    this.name = "AccountKeyError";
    this.code = code;
    this.consentUrl = consentUrl;
    this.actionLabel = actionLabel;
  }
}

export function asAccountKeyError(err: unknown): AccountKeyError {
  if (err instanceof AccountKeyError) return err;
  if (err instanceof Error) return new AccountKeyError("UNKNOWN", err.message);
  if (typeof err === "object" && err !== null && "code" in err) {
    const e = err as {
      code: string;
      message?: string;
      consentUrl?: string;
      actionLabel?: string;
    };
    return new AccountKeyError(
      e.code,
      e.message ?? e.code,
      e.consentUrl ?? null,
      e.actionLabel ?? null,
    );
  }
  return new AccountKeyError("UNKNOWN", String(err));
}

/**
 * What the account holds for both providers.
 *
 * `refresh` skips the session cache. Pass it when the user has just come back
 * from the dashboard — they are standing in front of the app expecting it to
 * have noticed.
 */
export async function providerKeyStatus(refresh = false): Promise<ProviderStatus[]> {
  try {
    const all = await invoke<ProviderStatus[]>("provider_key_status", { refresh });
    // Every successful answer refreshes the offline hint. See ./accountMode.
    rememberMode(all.map((s) => s.mode));
    return all;
  } catch (err) {
    throw asAccountKeyError(err);
  }
}



export async function statusFor(
  provider: ProviderSlug,
  refresh = false,
): Promise<ProviderStatus | null> {
  const all = await providerKeyStatus(refresh);
  return all.find((s) => s.provider === provider) ?? null;
}

/**
 * Open the page this provider's slot points at.
 *
 * Takes the URL it is given, or asks for the current one. There is no third
 * option and no address written down in this file: if neither produces a link,
 * this throws rather than opening something invented, because a button that
 * lands on the wrong page is worse than one that admits it cannot help — the
 * person follows it, finds nothing that fixes their problem, and has no reason
 * to think the app sent them somewhere wrong.
 */
export async function openKeyManagement(
  provider: ProviderSlug,
  url?: string | null,
): Promise<void> {
  const target = url ?? (await statusFor(provider))?.linkUrl ?? null;
  if (!target) {
    throw new AccountKeyError(
      "NO_LINK_URL",
      "Your account didn't say where to manage this key. Try again in a moment.",
    );
  }
  await openUrl(target);
}

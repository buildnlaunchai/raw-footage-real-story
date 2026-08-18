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
 */
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export type ProviderSlug = "openai" | "elevenlabs";

/** Whose key, and therefore who is billed. `platform` does not exist yet. */
export type KeyMode = "byok" | "platform";

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
   * Where the browser goes to put it right.
   *
   * The platform's own consent link when it sent one, and the dashboard
   * addressed to this provider otherwise. Always populated, so a button built
   * from it always has somewhere to go.
   */
  manageUrl: string;
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
  manageUrl: string | null;

  constructor(code: string, message: string, manageUrl: string | null = null) {
    super(message);
    this.name = "AccountKeyError";
    this.code = code;
    this.manageUrl = manageUrl;
  }
}

export function asAccountKeyError(err: unknown): AccountKeyError {
  if (err instanceof AccountKeyError) return err;
  if (err instanceof Error) return new AccountKeyError("UNKNOWN", err.message);
  if (typeof err === "object" && err !== null && "code" in err) {
    const e = err as { code: string; message?: string; manageUrl?: string };
    return new AccountKeyError(e.code, e.message ?? e.code, e.manageUrl ?? null);
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
    return await invoke<ProviderStatus[]>("provider_key_status", { refresh });
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
 * Where to send somebody for a provider, without asking the platform anything.
 *
 * For the screens that need a destination while offline or signed out — the
 * setup screen among them, which is reachable before any of this is known.
 */
export async function manageUrlFor(provider: ProviderSlug): Promise<string> {
  try {
    return await invoke<string>("provider_manage_url", { provider });
  } catch {
    // The command cannot really fail, and a button with no destination is the
    // one outcome worth writing a fallback for.
    return `https://buildnlaunchai.com/dashboard/keys?provider=${provider}`;
  }
}

/** Open the page where this provider's key is managed. */
export async function openKeyManagement(provider: ProviderSlug, url?: string): Promise<void> {
  await openUrl(url ?? (await manageUrlFor(provider)));
}

// The account's billing mode, and the one thing about it the app has to
// remember offline.
//
// Deliberately free of Tauri imports, so it can be reached from the test build
// — which is kept to pure modules on purpose. Everything here is a hint about
// what to SAY; nothing here decides what anyone is allowed to do.

/**
 * Whose key, and therefore who is billed.
 *
 * `credit` is the platform's word, not one invented here — the previous
 * spelling, `platform`, matched nothing the hub ever sent and made a credit
 * account unreadable. `unknown` is what a build sees when the hub adds a mode
 * it predates; it is a real state to render ("update the app"), not an error.
 */
export type KeyMode = "byok" | "credit" | "unknown";

// ─── Remembering the mode, for the one screen that has to work offline ───────
//
// THE PROBLEM THIS SOLVES. Credit mode puts the platform in the data path: we
// call the provider, on our key, and bill credit for it. That is fine until the
// laptop is on a plane. The app is built to keep working offline for a month —
// the licence is cached and signed, projects open, exports run — and none of
// that helps a credit member, because every generation needs a hub that is not
// there.
//
// Offline the app cannot ASK what mode the account is in: the answer comes from
// the platform. And the mode is not in the cached licence token either, because
// the platform does not sign it into the claims. So the last known answer is
// remembered here.
//
// IT IS A HINT AND IT DECIDES NOTHING. Nobody is allowed or refused anything on
// the strength of this value — it changes the SENTENCE the app shows when it
// already cannot reach the platform. Tampering with it buys an attacker a
// differently-worded error. That is why it can live in localStorage next to the
// sidebar state without any of the care the licence cache gets.

const LAST_MODE_KEY = "lastKnownKeyMode";

/**
 * Written on every successful status call, so it is never more than one online
 * moment out of date. Keyed by account: a shared machine must not tell the next
 * person about the last person's billing.
 */
export function rememberMode(modes: KeyMode[]): void {
  // Every slot carries the same top-level mode unless one overrides it; the
  // account's mode is what the first one says.
  const mode = modes[0];
  if (!mode) return;
  try {
    localStorage.setItem(LAST_MODE_KEY, mode);
  } catch {
    // Private mode, a locked-down profile, anything. A hint that cannot be
    // stored is a hint that is not available later, which the caller handles.
  }
}

/** What this account was last known to be on, or null if we have never seen. */
export function lastKnownMode(): KeyMode | null {
  try {
    const v = localStorage.getItem(LAST_MODE_KEY);
    return v === "byok" || v === "credit" || v === "unknown" ? v : null;
  } catch {
    return null;
  }
}

/** Called on sign-out. The next person is not the last person. */
export function forgetMode(): void {
  try {
    localStorage.removeItem(LAST_MODE_KEY);
  } catch {
    /* nothing to forget if it could not be stored in the first place */
  }
}

/**
 * The extra sentence to add when the platform cannot be reached.
 *
 * Null for a member on their own key: being offline is inconvenient for them
 * and not disqualifying, and the generic "could not reach your account" already
 * says enough. For a member on credits it is the whole story, and without it
 * they are left reading a network error and wondering whether their account has
 * broken.
 */
export function offlineModeNote(): string | null {
  return lastKnownMode() === "credit"
    ? "You're running on credits, which needs a connection to Build & Launch AI. "
      + "Reconnect and this will work again — nothing is wrong with your account."
    : null;
}

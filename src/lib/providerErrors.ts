/**
 * Turning a provider failure into something a person can read.
 *
 * Dependency-free so it can be tested outside the Tauri runtime — and because
 * the bug it exists to prevent is precisely the kind that hides until someone
 * exercises the unhappy path.
 */
/**
 * A failure from a script provider.
 *
 * Tauri rejects with the serialised Rust struct — a plain `{code, message}`
 * object, **not** an Error. Anything doing `err instanceof Error ? ... :
 * String(err)` therefore renders it as "[object Object]", which is how a
 * perfectly good "Add your OpenAI API key" message became invisible.
 */
export class ScriptProviderError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ScriptProviderError";
    this.code = code;
  }
}

const FRIENDLY: Record<string, string> = {
  // The key comes from the signed-in account, so none of these ask anybody to
  // find or paste one.
  //
  // `KEY_NOT_LINKED` is deliberately absent from this map. It arrives carrying
  // a message written against the platform's `reason` — "no key", "not allowed
  // yet" and "that key was rejected" are three different sentences — plus the
  // consent link the button is built from. A generic line here would override
  // all three with the vaguest of them, which is exactly how somebody whose key
  // only needs permission ends up being told they have no key.
  KEYS_SIGNED_OUT: "Sign in to use OpenAI — its key comes from your account.",
  KEYS_UNREACHABLE:
    "Couldn't reach your account to fetch the OpenAI key. Check your connection and try again.",
  KEYS_NOT_CONFIGURED: "This build has no account to fetch provider keys from.",
  KEYS_MALFORMED: "Your account returned something this app couldn't read.",
  MISSING_API_KEY:
    "Your account has no OpenAI key available yet. Open your dashboard to add one.",
  INVALID_API_KEY: "The OpenAI key on your account was rejected. Check it on your dashboard.",
  QUOTA_EXCEEDED:
    "The OpenAI credit balance on that key is exhausted. Add credit to continue.",
  SPEND_LIMIT: "You've hit a spend limit set on that OpenAI account.",
  RATE_LIMITED: "OpenAI is rate-limiting requests. Try again shortly.",
  MODEL_NOT_FOUND: "That model isn't available on that OpenAI account.",
  FORBIDDEN: "That OpenAI account doesn't have access to that model.",
  REFUSED: "The model declined to write this script.",
  SERVICE_ERROR: "OpenAI had a server error. Try again shortly.",
  NETWORK: "Couldn't reach OpenAI. Check your connection.",
  TIMEOUT: "OpenAI took too long to respond.",
  EMPTY_RESPONSE: "OpenAI returned no text for that request.",
  INVALID_REQUEST: "OpenAI rejected the request. This is a bug in the app, not your account.",
  OLLAMA_UNREACHABLE:
    "Can't reach Ollama. Start it with `brew services start ollama`, then try again.",
  MODEL_NOT_FOUND_LOCAL: "That local model isn't installed. Pull it with `ollama pull`.",
};

export function asScriptProviderError(err: unknown): ScriptProviderError {
  if (err instanceof ScriptProviderError) return err;
  if (err instanceof Error) return new ScriptProviderError("UNKNOWN", err.message);
  if (typeof err === "object" && err !== null && "code" in err) {
    const e = err as { code: string; message?: string };
    return new ScriptProviderError(e.code, FRIENDLY[e.code] ?? e.message ?? e.code);
  }
  return new ScriptProviderError("UNKNOWN", String(err));
}

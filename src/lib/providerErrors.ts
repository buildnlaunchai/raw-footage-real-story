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
  MISSING_API_KEY: "Add your OpenAI API key to use cloud script generation.",
  INVALID_API_KEY: "That API key was rejected. Check it in your OpenAI account.",
  QUOTA_EXCEEDED: "Your OpenAI credit balance is exhausted. Add credit to continue.",
  SPEND_LIMIT: "You've hit a spend limit set on your OpenAI account.",
  RATE_LIMITED: "OpenAI is rate-limiting requests. Try again shortly.",
  MODEL_NOT_FOUND: "That model isn't available on your OpenAI account.",
  FORBIDDEN: "Your OpenAI account doesn't have access to that model.",
  REFUSED: "The model declined to write this script.",
  SERVICE_ERROR: "OpenAI had a server error. Try again shortly.",
  NETWORK: "Couldn't reach OpenAI. Check your connection.",
  TIMEOUT: "OpenAI took too long to respond.",
  EMPTY_RESPONSE: "OpenAI returned no text for that request.",
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

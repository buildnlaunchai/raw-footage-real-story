/**
 * Pure parsing of a model completion into narration sentences.
 *
 * Deliberately dependency-free so it can be exercised outside the Tauri
 * runtime — the transport layer is what needs a webview, not this.
 */

/** Read `{ "sentences": [...] }`, tolerating anything that isn't that shape. */
export function parseJsonSentences(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { sentences?: unknown };
    if (!Array.isArray(parsed.sentences)) return [];
    return parsed.sentences.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

/** Pull `N. sentence` lines out of a plain-text completion. */
export function parseNumbered(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\d+[.)]\s*(.+?)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

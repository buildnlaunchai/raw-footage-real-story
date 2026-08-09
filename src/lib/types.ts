/**
 * A single piece of raw footage.
 *
 * `sourcePath` and `sourceDurationMs` are the only things assembly cares about.
 * Placeholder generation fills them today; real video upload will fill the
 * same two fields, so no assembly code changes when upload lands.
 */
export interface Clip {
  id: string;
  description: string;
  sourcePath?: string;
  sourceDurationMs?: number;
}

/** One narration sentence, bound to the clip it was written for. */
export interface ScriptLine {
  clipId: string;
  text: string;
}

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
  /** Display-only metadata from the import probe. */
  fileName?: string;
  thumbnailPath?: string;
  /** Set at import, never inferred from the filename. */
  isPlaceholder?: boolean;
  isHdr?: boolean;
  /** Whether the file carries a sound track of its own. */
  hasAudio?: boolean;
  warnings?: string[];
  /** Where in the clip a chosen segment starts. */
  sourceStartMs?: number;
}

/** One narration sentence, bound to the clip it was written for. */
export interface ScriptLine {
  clipId: string;
  /** Which described moment of that clip this line narrates. */
  segmentIndex?: number;
  text: string;
}

/** A single piece of raw footage. `file` lands here when upload is wired up. */
export interface Clip {
  id: string;
  description: string;
}

/** One narration sentence, bound to the clip it was written for. */
export interface ScriptLine {
  clipId: string;
  text: string;
}

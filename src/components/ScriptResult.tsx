/** Generated narration, each sentence shown against the clip it belongs to. */
import type { Clip, ScriptLine } from "../lib/types";

interface Props {
  clips: Clip[];
  script: ScriptLine[];
  model: string;
  elapsedMs: number | null;
}

export function ScriptResult({ clips, script, model, elapsedMs }: Props) {
  const byId = new Map(clips.map((c) => [c.id, c]));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Script</h2>
        <p className="hint">
          {model}
          {elapsedMs !== null && ` · ${(elapsedMs / 1000).toFixed(1)}s`}
        </p>
      </div>

      <ol className="script-list">
        {script.map((line, i) => (
          <li key={line.clipId} className="script-row">
            <span className="clip-index" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <div>
              <p className="script-clip">{byId.get(line.clipId)?.description}</p>
              <p className="script-text">{line.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

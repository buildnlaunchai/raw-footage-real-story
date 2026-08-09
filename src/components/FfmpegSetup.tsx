/**
 * Shown when ffmpeg can't be found. Blocks assembly only — script generation
 * and voiceover don't need ffmpeg and stay usable.
 */
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { setFfmpegPath, type FfmpegInfo } from "../lib/assembly";

const INSTALL_HINT: { label: string; command: string }[] = [
  { label: "macOS", command: "brew install ffmpeg" },
  { label: "Windows", command: "winget install ffmpeg" },
  { label: "Linux", command: "sudo apt install ffmpeg" },
];

interface Props {
  onFound: (info: FfmpegInfo) => void;
  onRecheck: () => Promise<void>;
}

export function FfmpegSetup({ onFound, onRecheck }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function locate() {
    setError(null);
    const picked = await open({
      title: "Select the ffmpeg binary",
      multiple: false,
      directory: false,
    });
    if (typeof picked !== "string") return;

    setBusy(true);
    try {
      onFound(await setFfmpegPath(picked));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function recheck() {
    setBusy(true);
    setError(null);
    try {
      await onRecheck();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Rough cut</h2>
        <p className="hint">Needs ffmpeg</p>
      </div>

      <div className="warning" role="status">
        <strong>ffmpeg isn’t available</strong>
        <span>
          Assembly uses ffmpeg to cut the clips together. Your script and
          voiceover are unaffected — install ffmpeg, then re-check.
        </span>
      </div>

      <dl className="install-list">
        {INSTALL_HINT.map((h) => (
          <div key={h.label} className="install-row">
            <dt>{h.label}</dt>
            <dd>
              <code>{h.command}</code>
            </dd>
          </div>
        ))}
      </dl>

      <div className="actions">
        <button type="button" className="primary-button" onClick={recheck} disabled={busy}>
          {busy ? "Checking…" : "Re-check"}
        </button>
        <button type="button" className="ghost-button" onClick={locate} disabled={busy}>
          Locate ffmpeg…
        </button>
      </div>

      {error && (
        <div className="error" role="alert">
          <strong>That didn’t work.</strong>
          <span>{error}</span>
        </div>
      )}

      <p className="placeholder-note">
        Already installed but not found? A packaged app doesn’t inherit your
        shell’s PATH, so pick the binary directly — or set <code>FFMPEG_PATH</code>.
      </p>
    </section>
  );
}

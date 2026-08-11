/**
 * ffmpeg setup and capability notices.
 *
 * Two distinct states, only one of which is blocking:
 *
 *  - **missing** — no usable ffmpeg. Assembly can't run, so this blocks stage 3.
 *    Script generation and voiceover are unaffected and stay usable.
 *  - **limited** — ffmpeg works but has no zscale, so HDR footage can't be
 *    colour-corrected. Assembly still runs, so this must NOT block; it explains
 *    the limitation up front instead of letting the user discover washed-out
 *    video after a long render and go hunting for a cause.
 */
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { setFfmpegPath, type FfmpegInfo } from "../lib/assembly";

const INSTALL_HINT: { label: string; command: string }[] = [
  // ffmpeg-full rather than ffmpeg: the plain formula is built without libzimg,
  // so it has no zscale and cannot tone-map HDR footage.
  { label: "macOS", command: "brew install ffmpeg-full" },
  // The package id is required. `winget install ffmpeg` matches several
  // packages and prompts for a disambiguation the user has no way to resolve.
  { label: "Windows", command: "winget install -e --id Gyan.FFmpeg" },
  { label: "Linux", command: "sudo apt install ffmpeg" },
];

interface Props {
  /** Null when nothing usable was found. */
  info: FfmpegInfo | null;
  /** Raises the urgency of the HDR notice when footage actually needs it. */
  hasHdrClips: boolean;
  onFound: (info: FfmpegInfo) => void;
  onRecheck: () => Promise<void>;
}

export function FfmpegSetup({ info, hasHdrClips, onFound, onRecheck }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const missing = info === null;
  const limited = info !== null && !info.caps.zscale;

  // Nothing to say when ffmpeg is present and fully capable.
  if (!missing && !limited) return null;

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
        <h2>{missing ? "Rough cut" : "HDR colour"}</h2>
        <p className="hint">{missing ? "Needs ffmpeg" : "Limited ffmpeg build"}</p>
      </div>

      {missing ? (
        <>
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
        </>
      ) : (
        <>
          <div className={hasHdrClips ? "error" : "warning"} role="status">
            <strong>
              {hasHdrClips
                ? "Your HDR clips will look washed out"
                : "This ffmpeg can’t colour-correct HDR footage"}
            </strong>
            <span>
              {hasHdrClips
                ? "Some of your clips are HDR, and this ffmpeg build has no zscale, so their colours can’t be corrected. Install a build that supports it, then point this app at it — the rough cut will otherwise come out pale and flat."
                : "This build has no zscale, so HDR clips (which is what phones record by default) can’t be tone-mapped. Everything else works normally."}
            </span>
          </div>

          <dl className="install-list">
            <div className="install-row">
              <dt>macOS</dt>
              <dd>
                <code>brew install ffmpeg-full</code>
              </dd>
            </div>
          </dl>

          <p className="placeholder-note">
            Homebrew’s standard <code>ffmpeg</code> doesn’t include zscale, and
            reinstalling it won’t add it. <code>ffmpeg-full</code> does, and
            installs alongside rather than replacing what you have — so after
            installing, use <strong>Locate ffmpeg…</strong> and pick{" "}
            <code>/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg</code>.
          </p>
        </>
      )}

      <div className="actions">
        <button type="button" className="primary-button" onClick={recheck} disabled={busy}>
          {busy ? "Checking…" : "Re-check"}
        </button>
        <button type="button" className="ghost-button" onClick={locate} disabled={busy}>
          Locate ffmpeg…
        </button>
        {info && <span className="hint">{info.version.replace(/^ffmpeg version /, "")}</span>}
      </div>

      {error && (
        <div className="error" role="alert">
          <strong>That didn’t work.</strong>
          <span>{error}</span>
        </div>
      )}

      {missing && (
        <p className="placeholder-note">
          Already installed but not found? A packaged app doesn’t inherit your
          shell’s PATH, so pick the binary directly — or set{" "}
          <code>FFMPEG_PATH</code>.
        </p>
      )}
    </section>
  );
}

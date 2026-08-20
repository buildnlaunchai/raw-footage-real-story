/**
 * What this machine can do, and how to fix what it cannot.
 *
 * Shown at launch when something is missing and reachable from the sidebar at
 * any time — dependencies break later too, and a first-launch-only wizard
 * cannot help with Ollama being closed on a Tuesday.
 *
 * Written for someone who has never opened a terminal. Every instruction is a
 * button first and a command second, and nothing is described as broken when
 * there is a way round it.
 */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  capabilities,
  installFor,
  ollamaReport,
  recommendedScriptRoute,
  usable,
  type Capability,
  type Probe,
  type Requirements,
} from "../lib/readiness";
import { asAccountKeyError, openKeyManagement } from "../lib/accountKeys";
import { CheckIcon, AlertIcon, RefreshIcon } from "./Icons";

interface Props {
  probe: Probe | null;
  requirements: Requirements;
  platform: "macos" | "windows" | "other";
  ollamaHost: string;
  checking: boolean;
  onRecheck: () => void;
  /** Take the user to where the cloud providers are set up. */
  onOpenProviders: () => void;
}

interface JobLine {
  job: string;
  line: string;
  fraction: number | null;
  done: boolean;
  ok: boolean | null;
}

export function ReadinessPanel({
  probe,
  requirements,
  platform,
  ollamaHost,
  checking,
  onRecheck,
  onOpenProviders,
}: Props) {
  const [running, setRunning] = useState<string | null>(null);
  const [log, setLog] = useState<JobLine[]>([]);
  const [fraction, setFraction] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /**
   * Why the key page could not be opened.
   *
   * It can genuinely fail now: the destination comes from the platform, and
   * this screen is reachable while signed out or offline, when there is nothing
   * to have asked. Saying so is the honest answer — the alternative was a
   * button built from an address the app made up, which opened cleanly and
   * landed somewhere that could not help.
   */
  const [keyLinkError, setKeyLinkError] = useState<string | null>(null);
  const logEnd = useRef<HTMLDivElement | null>(null);

  // A long install with no output looks hung, so the tail is always visible.
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [log]);

  /**
   * The re-check, reachable from the listener without being a dependency of it.
   *
   * `onRecheck` is a fresh closure on every render of the parent, so having the
   * subscription depend on it re-subscribed on every render — and `listen`
   * resolves asynchronously, so each of those left a window with no listener
   * attached. During a model pull that is every progress line, and the terminal
   * event arrives immediately after the last of them: squarely inside the
   * window it opened. The one event the screen actually needed was the one most
   * likely to be dropped.
   */
  const recheck = useRef(onRecheck);
  recheck.current = onRecheck;

  // Registered once, for the life of the panel.
  useEffect(() => {
    const un = listen<JobLine>("setup:progress", (e) => {
      setLog((l) => [...l.slice(-300), e.payload]);
      if (e.payload.fraction != null) setFraction(e.payload.fraction);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  async function openKeyPage() {
    setKeyLinkError(null);
    try {
      await openKeyManagement("openai");
    } catch (err) {
      setKeyLinkError(asAccountKeyError(err).message);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      /* a failed copy is not worth an error dialog; the text is on screen */
    }
  }

  /**
   * Run one long job and settle the screen from its own return.
   *
   * The progress event fills the log; it is deliberately *not* what decides the
   * job is over. An event can be missed, and a missed one used to leave the
   * button reading "Installing…" with a re-check that never ran — the state the
   * user could only escape by quitting the app. The awaited command cannot be
   * missed, so completion hangs off the promise and the event stream is left to
   * do the one thing it is good at.
   */
  async function run(job: string, work: () => Promise<unknown>) {
    setRunning(job);
    setLog([]);
    try {
      await work();
    } catch (err) {
      setLog((l) => [
        ...l,
        { job, line: String(err), fraction: null, done: true, ok: false },
      ]);
    } finally {
      setRunning(null);
      setFraction(null);
      // Whatever just ran was meant to change this machine. Ask it again
      // rather than making the user guess whether it worked — and ask after a
      // failure too, since a half-finished install still changed something.
      recheck.current();
    }
  }

  function runInstall(job: string, program: string, args: string[]) {
    void run(job, () => invoke("run_installer", { job, program, args }));
  }

  function pull(model: string) {
    void run(`pull:${model}`, () => invoke("ollama_pull", { host: ollamaHost, model }));
  }

  if (!probe) {
    return (
      <div className="panel">
        <p className="hint">Checking what this machine has…</p>
      </div>
    );
  }

  const caps = capabilities(probe, requirements);
  const ollama = ollamaReport(probe, requirements);
  const allWell = caps.every((c) => c.ready && !c.caveat);
  /**
   * Which route this screen is steering towards.
   *
   * Only ever `"local"` for a machine that already has the models, so on a
   * fresh install this is `"openai"` and everything below arranges itself
   * around that: one primary button, pointing at the key.
   */
  const route = recommendedScriptRoute(probe, requirements);

  /**
   * `emphasis` is the whole point of the parameter.
   *
   * There used to be one style here and it was primary, so a fresh machine
   * showed two primary buttons side by side — link a key, and install Ollama —
   * which is not a recommendation, it is a coin toss. ffmpeg keeps the emphasis
   * because it is genuinely required; the Ollama install gives it up whenever
   * the cloud route is the one being suggested.
   */
  function commandBlock(
    what: "ffmpeg" | "ollama",
    job: string,
    emphasis: "primary" | "secondary" = "primary",
  ) {
    const step = installFor(what, platform, probe!.installers);
    return (
      <div className="setup-cmd">
        <code>{step.command}</code>
        <div className="actions">
          {step.program && step.args && (
            <button
              type="button"
              className={`${emphasis === "primary" ? "primary-button" : "ghost-button"} small`}
              disabled={running !== null}
              onClick={() => runInstall(job, step.program!, step.args!)}
            >
              {running === job ? "Installing…" : "Install for me"}
            </button>
          )}
          <button
            type="button"
            className="ghost-button small"
            onClick={() => copy(step.command)}
          >
            {copied === step.command ? "Copied" : "Copy command"}
          </button>
        </div>
        {step.note && <p className="hint">{step.note}</p>}
      </div>
    );
  }

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>{allWell ? "Everything is ready" : "Setting up"}</h2>
          <button
            type="button"
            className="lib-tool"
            onClick={onRecheck}
            disabled={checking}
          >
            <span className={checking ? "is-spinning" : undefined} style={{ display: "flex" }}>
              <RefreshIcon size={15} />
            </span>
            {checking ? "Checking…" : "Re-check"}
          </button>
        </div>

        {!usable(caps) && (
          <p className="warning" style={{ marginTop: 0 }}>
            Until ffmpeg is installed, clips cannot be imported. Everything else
            here still works — you can add your keys and look around.
          </p>
        )}

        <ul className="ready-list">
          {caps.map((c) => (
            <CapabilityRow key={c.id} cap={c} />
          ))}
        </ul>
      </div>

      {/* ── ffmpeg ── */}
      {caps[0].ready === false && (
        <div className="panel">
          <div className="panel-head">
            <h2>Install ffmpeg</h2>
            <span className="hint">Required · about 100 MB</span>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            ffmpeg reads and writes video. It is what makes thumbnails when you
            import, and what assembles the finished cut. There is no cloud
            substitute for it in this app.
          </p>
          {commandBlock("ffmpeg", "ffmpeg", "primary")}
        </div>
      )}

      {/* ── script ── */}
      {caps[1].ready === false && (
        <div className="panel">
          <div className="panel-head">
            <h2>Choose how scripts get written</h2>
            <span className="hint">either one is enough</span>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            The first one needs no download and is where we would start you. The
            second is here for anyone who wants the app to work with no internet
            at all.
          </p>

          <div className="ready-choice">
            <div className="ready-option" data-recommended="true">
              <h3>
                Use your account&rsquo;s OpenAI key
                <span className="chip-tag">Recommended</span>
              </h3>
              <p>
                Nothing to install and nothing to download &mdash; you can write
                a script within a minute of signing in. A script costs a few
                cents, billed by OpenAI to your own account.
              </p>
              <p>
                The key lives on your BuildnLaunchAI account rather than being
                typed in here, so it works on every machine you sign in on.
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void openKeyPage()}
                >
                  Use my account&rsquo;s OpenAI key
                </button>
                <button type="button" className="ghost-button" onClick={onOpenProviders}>
                  Script settings
                </button>
              </div>
              {keyLinkError && (
                <p className="ready-caveat" role="alert">
                  {keyLinkError}
                </p>
              )}
            </div>

            <div className="ready-option">
              <h3>
                Run a model on this machine
                <span className="chip-tag is-muted">Optional</span>
              </h3>
              <p>
                Free, private, and works with no connection at all. The cost is
                the download: about 4.7&nbsp;GB before the first script and
                roughly 14&nbsp;GB for both models, and its writing outside
                English is measurably worse than OpenAI&rsquo;s.
              </p>
              {probe.ollamaModels === null
                ? commandBlock("ollama", "ollama", route === "local" ? "primary" : "secondary")
                : <p className="hint">Ollama is running. Pull a model below.</p>}
            </div>
          </div>
        </div>
      )}

      {/* ── models ── */}
      {probe.ollamaModels !== null && ollama.missing.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h2>Models</h2>
            <span className="hint">downloaded once, kept on this machine</span>
          </div>
          {/* A key already answers this row, so the download is a preference
              rather than a task. Saying so is the difference between a setup
              screen and a list of nags. */}
          {requirements.hasOpenAiKey && (
            <p className="hint" style={{ marginTop: 0 }}>
              Optional &mdash; the OpenAI key on your account already covers
              script writing. These are only worth downloading if you want the
              app to write scripts offline.
            </p>
          )}
          <ul className="ready-list">
            {ollama.present.map((m) => (
              <li key={m} className="ready-row">
                <span className="ready-dot" data-ok="true"><CheckIcon /></span>
                <div>
                  <strong>{m}</strong>
                  <p className="hint">Installed.</p>
                </div>
              </li>
            ))}
            {ollama.missing.map((m, i) => (
              <li key={m} className="ready-row">
                <span className="ready-dot" data-ok="false"><AlertIcon /></span>
                <div style={{ flex: 1 }}>
                  <strong>{m}</strong>
                  <p className="hint">
                    {i === 0 && ollama.present.length === 0
                      ? "Needed to write anything. About 4.7 GB."
                      : "Writes the final narration — the part people hear. About 9 GB, and optional: without it the smaller model does the writing."}
                  </p>
                </div>
                <button
                  type="button"
                  className="ghost-button small"
                  disabled={running !== null}
                  onClick={() => pull(m)}
                >
                  {running === `pull:${m}` ? "Downloading…" : "Download"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── output from whatever is running ── */}
      {(running || log.length > 0) && (
        <div className="panel">
          <div className="panel-head">
            <h2>{running ? "Working…" : "Finished"}</h2>
            {log.length > 0 && (
              <button
                type="button"
                className="ghost-button small"
                onClick={() => setLog([])}
              >
                Clear
              </button>
            )}
          </div>
          {fraction != null && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${fraction * 100}%` }} />
            </div>
          )}
          <pre className="setup-log">
            {log.map((l, i) => (
              <div key={i} data-bad={l.ok === false || undefined}>
                {l.line}
              </div>
            ))}
            <div ref={logEnd} />
          </pre>
        </div>
      )}
    </>
  );
}

function CapabilityRow({ cap }: { cap: Capability }) {
  const state = cap.ready ? (cap.caveat ? "warn" : "ok") : "bad";
  return (
    <li className="ready-row">
      <span className="ready-dot" data-ok={cap.ready} data-warn={Boolean(cap.caveat)}>
        {state === "ok" ? <CheckIcon /> : <AlertIcon />}
      </span>
      <div>
        <strong>{cap.label}</strong>
        <p className="hint">{cap.detail}</p>
        {cap.caveat && <p className="ready-caveat">{cap.caveat}</p>}
      </div>
    </li>
  );
}

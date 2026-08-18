/**
 * The screen in front of the app when somebody is not, or not yet, allowed in,
 * and the smaller pieces of the same subject that live *inside* it — the two
 * banners, and the way back out.
 *
 * Every state here is a dead end for the user unless it offers a way out, so
 * each one carries at least one action they can actually take. "Access denied"
 * with an OK button is the version of this that generates support mail.
 *
 * The decision itself lives in `lib/entitlement.ts` and is tested there; this
 * only renders it.
 */
import type { Gate } from "../lib/entitlement";

interface Props {
  gate: Gate;
  /** Opens the system browser and waits for the callback. */
  onSignIn: () => void;
  /** Abandon a sign-in that is in flight. */
  onCancel: () => void;
  /** Ask the platform again — after paying, or after finding a connection. */
  onRecheck: () => void;
  /** Forget this session and offer the sign-in screen again. */
  onSignOut: () => void;
  /** True between opening the browser and hearing back from it. */
  waiting: boolean;
  /** Whatever went wrong last, in the platform's own words. */
  error: string | null;
}

const ACCOUNT_URL = "https://buildnlaunchai.com/account";

export function LoginGate({
  gate,
  onSignIn,
  onCancel,
  onRecheck,
  onSignOut,
  waiting,
  error,
}: Props) {
  return (
    <div className="gate">
      <div className="gate-panel">
        <h1 className="gate-title">Raw Footage, Real Story</h1>
        {body()}
        {error && (
          <p className="gate-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );

  function body() {
    switch (gate.state) {
      // Restoring a saved session. Deliberately quiet — a decisive-looking
      // message here would flash "signed out" at somebody who is signed in.
      case "checking":
        return <p className="gate-lede">Checking your account…</p>;

      case "signed-out":
        return waiting ? waitingForBrowser() : signIn();

      // Signed in, and the platform says there is nothing to sign in to.
      // Named rather than anonymous, because the commonest cause is being
      // signed into the wrong account.
      case "no-licence":
        return (
          <>
            <p className="gate-lede">
              You're signed in as <strong>{gate.email}</strong>, but this account doesn't have an
              active subscription.
            </p>
            <div className="gate-actions">
              <a className="primary-button" href={ACCOUNT_URL} target="_blank" rel="noreferrer">
                Manage subscription
              </a>
              {/* The button somebody needs thirty seconds after paying. */}
              <button type="button" className="ghost-button" onClick={onRecheck}>
                Check again
              </button>
            </div>
            <button type="button" className="gate-quiet" onClick={onSignOut}>
              Sign in as someone else
            </button>
          </>
        );

      // The one place being offline genuinely blocks: nothing has ever been
      // confirmed for this account, so there is nothing to extend grace from.
      case "offline-first-run":
        return (
          <>
            <p className="gate-lede">
              Can't reach BuildnLaunchAI to check your subscription.
            </p>
            <p className="gate-note">
              You'll need to be online the first time you sign in. After that the app keeps working
              offline for {GRACE_TEXT}.
            </p>
            <div className="gate-actions">
              <button type="button" className="primary-button" onClick={onRecheck}>
                Try again
              </button>
            </div>
            <button type="button" className="gate-quiet" onClick={onSignOut}>
              Sign in as someone else
            </button>
          </>
        );

      // None of these three should ever reach this component: `letsAppRender`
      // is true for all of them, so the app renders and this does not.
      //
      // `read-only` used to be written out here in full, which was the bug —
      // a screen that could never appear, describing a restriction nothing
      // enforced. It is not a door, it is a banner over a working app, and it
      // now lives in `ReadOnlyBanner` below. Returning something honest still
      // beats rendering nothing if a caller gets the condition wrong.
      case "allowed":
      case "allowed-grace":
      case "read-only":
        return <p className="gate-lede">Signed in.</p>;
    }
  }

  function signIn() {
    return (
      <>
        <p className="gate-lede">
          Turn raw travel footage into a narrated rough cut, on your own machine.
        </p>
        <div className="gate-actions">
          <button type="button" className="primary-button" onClick={onSignIn}>
            Log in with BuildnLaunchAI
          </button>
        </div>
        <p className="gate-note">
          Your browser opens so you can sign in there. The app never sees your password.
        </p>
      </>
    );
  }

  function waitingForBrowser() {
    return (
      <>
        <p className="gate-lede">Waiting for your browser…</p>
        <p className="gate-note">
          Finish signing in on the page that opened, then come back here.
        </p>
        <div className="gate-actions">
          {/* Browser hand-offs fail quietly more often than you would think:
              the wrong default browser, a tab closed by accident, a page
              restored from sleep. Both ways out are needed. */}
          <button type="button" className="ghost-button" onClick={onSignIn}>
            Open the page again
          </button>
          <button type="button" className="ghost-button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </>
    );
  }
}

const GRACE_TEXT = "up to a month";

/**
 * The strip shown inside the app while running on an ageing cache.
 *
 * Deliberately not a dialog. Somebody mid-edit should be told, not
 * interrupted — and a modal here would land on the one user who is offline
 * precisely because they are somewhere they cannot fix it.
 */
export function GraceBanner({ daysLeft, onRecheck }: { daysLeft: number; onRecheck: () => void }) {
  return (
    <div className="gate-banner" role="status">
      <span>
        Connect to the internet within {daysLeft} {daysLeft === 1 ? "day" : "days"} to keep using
        the app.
      </span>
      <button type="button" className="ghost-button small" onClick={onRecheck}>
        Check now
      </button>
    </div>
  );
}

/**
 * The strip shown once the grace period has run out.
 *
 * Still a banner and still not a dialog, for a stronger version of the same
 * reason: this is the person who has been offline for a month, which makes
 * them the least able of anyone to act on a modal demanding they connect. The
 * app is behind it, their projects open, and their finished work exports — the
 * only thing withheld is starting something new, and the copy says so rather
 * than leaving them to discover it by clicking a button that does nothing.
 */
export function ReadOnlyBanner({
  daysOffline,
  onRecheck,
}: {
  daysOffline: number;
  onRecheck: () => void;
}) {
  return (
    <div className="gate-banner is-stale" role="status">
      <span>
        It's been {daysOffline} days since your subscription could be checked. Your projects still
        open and still export — connect to the internet to start new ones.
      </span>
      <button type="button" className="ghost-button small" onClick={onRecheck}>
        Check now
      </button>
    </div>
  );
}

/**
 * Signing out, from inside the app.
 *
 * Every gate screen offers a way to sign in as somebody else, because each of
 * them is a dead end and a dead end needs a door. Past the gate there was no
 * door at all: the session survives restarts by design, so the only way to
 * hand this app to a different account was to go and delete a keychain entry.
 *
 * It is in Settings rather than under the avatar in the rail. Signing out is
 * not a thing anybody should do by accident on the way to somewhere else.
 */
export function AccountPanel({
  email,
  onSignOut,
  busy,
}: {
  email: string | null;
  onSignOut: () => void;
  busy: boolean;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Your account</h2>
        <span className="hint">{email ?? "Not signed in"}</span>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        Signing out forgets this sign-in on this Mac and returns to the sign-in screen, where you
        can use a different account. Your collections, footage and rendered videos stay exactly
        where they are — they live on this machine and are not tied to an account.
      </p>
      <div className="actions" style={{ marginTop: "0.9rem" }}>
        <button type="button" className="ghost-button" onClick={onSignOut} disabled={busy}>
          Sign out
        </button>
      </div>
    </div>
  );
}

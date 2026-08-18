//! The last licence answer, kept somewhere it outlives the window.
//!
//! Without this the month-long grace in `entitlement.ts` cannot happen at all:
//! the gate's cache was React state, so quitting the app forgot every check
//! ever made, and the next offline launch had nothing to fall back to and
//! blocked. Everything below exists to make "the platform said yes on the
//! third" a thing this machine can still know on the twelfth, on a plane.
//!
//! ## Why a plain file, and not the keychain
//!
//! The session's refresh token is in the keychain because it is a *secret* —
//! anyone holding it can act as that person. A licence token is the opposite:
//! it is a signed public statement about an account, useless to anybody it is
//! not about, and its worth comes from being unforgeable rather than from
//! being unread. Confidentiality would buy nothing.
//!
//! It would cost something, though. A keychain item is bound to the code
//! signature of the app that made it, so a second item means a second
//! permission prompt after every rebuild, for a file whose entire contents the
//! platform would happily print on a web page.
//!
//! ## What is stored is the token, not the answer
//!
//! `{"active": true}` in a file is a suggestion — the person it gates can
//! open it in a text editor. So what is written down is the platform's signed
//! token, exactly as it arrived, and the *answer is recomputed from it* on
//! every launch by [`recall`]. Editing the file does not change what the app
//! believes; it only breaks the signature and throws the grace away.
//!
//! Even the date works this way. A grace period counted from a timestamp in
//! the file could be extended for ever by touching one field, so it is counted
//! from the token's signed `iat` — see [`crate::licence::Verified::issued_at`]
//! — and the file's own `checkedAt` is a fallback for a platform that does not
//! send one, plus something legible when somebody opens the file to see what
//! is in it.
//!
//! ## The cross-check, and what it is honestly worth
//!
//! [`recall`] refuses a token whose `sub` is not the account signed in on this
//! machine. That is what stops the obvious sharing move: a subscriber sends a
//! friend their cache file, the friend signs in as themselves, and the licence
//! in the file is visibly about somebody else.
//!
//! It is not a lock, and `entitlement.ts` is already clear about why nothing
//! here can be. Somebody willing to hand-write their own keychain entry can
//! put another person's user id next to a refresh token that is not theirs,
//! and offline nothing catches it — offline there is no access token to check
//! against, because getting one needs the network this whole path exists to do
//! without. The moment they have a connection the refresh is refused and the
//! session is cleared. Thirty days of inconvenient, detectable cheating is the
//! ceiling, and buying it down further would cost the people who paid.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Beside `settings.json` in the app's own data directory.
const FILE: &str = "licence.json";

/// What is written down after a check the signature was actually checked on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cached {
    /// The platform's signed token, byte for byte as it arrived. Re-verified
    /// on every read; never trusted for having been in a file this app wrote.
    pub licence_token: String,
    /// The platform's clock at the moment of that check, ISO-8601.
    ///
    /// A fallback and a courtesy, not evidence: used to date the cache only
    /// when the token carries no `iat`, and readable by anyone wondering what
    /// this file is.
    pub checked_at: String,
}

/// A stored answer that survived being checked.
#[derive(Debug, Clone, PartialEq)]
pub struct Recalled {
    pub active: bool,
    /// ISO-8601, from the token's signed `iat` where there is one.
    pub checked_at: String,
}

/// Decide what a stored answer is worth to the account signed in right now.
///
/// `None` covers every way a cache can be worthless — forged, edited, signed
/// by a key this build does not know, or about somebody else — because they
/// all lead to the same place: ask the platform again. The caller deletes the
/// file rather than carrying a cache that will fail identically next launch.
///
/// Split from the file handling so the rules can be argued with in tests
/// without a disk.
pub fn recall(stored: &Cached, user_id: &str, pem: &str) -> Option<Recalled> {
    let v = crate::licence::verify_cached_with(&stored.licence_token, pem).ok()?;
    // An empty `user_id` fails this, which is the intended answer: with
    // nobody established as signed in, there is nothing for the licence to be
    // *about*, and a cache that matches everyone is a cache that matches a
    // copied file.
    if !v.matches(user_id) {
        return None;
    }
    Some(Recalled {
        active: v.entitled(),
        checked_at: v
            .issued_at()
            .map(crate::platform::iso_from_epoch)
            .unwrap_or_else(|| stored.checked_at.clone()),
    })
}

/// Write the answer down. Errors are the caller's to decide about: failing to
/// cache is a worse offline experience later, never a failed check now.
pub fn store(dir: &Path, c: &Cached) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(c).map_err(std::io::Error::other)?;
    std::fs::write(dir.join(FILE), json)
}

/// Read whatever is there. A missing or unreadable file is "nothing cached",
/// which is a state the gate already knows how to be in.
pub fn load(dir: &Path) -> Option<Cached> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).ok()?).ok()
}

/// Throw it away. Signing out, and any cache that failed to recall.
pub fn forget(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(FILE));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same throwaway key the licence fixtures are signed with.
    const TEST_PUBLIC: &str = include_str!("../keys/testing-only.pub.pem");

    /// `sub: u-1`, `status: active`, `iat` 2026-01-01, expiring in 2100.
    const VALID: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiaXNzIjoiYnVpbGRubGF1bmNoYWkiLCJzdGF0dXMiOiJhY3RpdmUiLCJwbGFuIjoicHJvIn0.uNPihDjHOtLHnus2kAtWpQtxuiBYU3mP-2CSXV3TeMLfjlf8coudnHWFkOmK0a1f-EJL7eWldGCm7ZgJc-r9KkabKjJ7KsghkOCaae1ncI5SL2mQ-v4NePK-ziEgEvuofC04BzOn7ACZkycbx9vAoApwJ7tFyMa8tAa2e85DWEF_oPgxGhHw2toxDmQ_NlIjVbsLbSnMuG2jaUizQRrrjwEmFRHj5VGN8Rhe0gTaQN9Kpeg8I1xnbG_qe_R3BkvKTZrfcpxA3h1FvmGt1Hepq16qR3U3Vnlsh5YZySbSel1hr8gn2LHSgAkBHyfxZAteZwOlgLVmImvyE7vEYq9U2Q";
    /// Genuinely signed, `active: true`, and expired since 2020.
    const EXPIRED: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE1Nzc3NTA0MDAsImV4cCI6MTU3NzgzNjgwMCwiYWN0aXZlIjp0cnVlfQ.fDiNHnyR1GdmfKB1O4Hxnms-7SQqU9KwM2QVJDtQl8Wf8Hlr4VX9kbvwHDlx4DgrPmjQJpRWc_4eYeaw7WlnD29W0OfXymdGGi48GAU_z-8dYdNgzfTDU8LcaQyubXjDbwqKwWYxt9ElcF6wjqLH-N_aJPxSu1ATmGC5kfQLdtyF2zQqfiuV0MZpvNXb0WjzIKdQdXr2gG4rlBqwGERVPeXLSgnWxDooFRf6FsNUfGfZNPfqW_xGzeGYAGJb64KXtPnry8CbfqkTzdvG8Y9zzsTJMPNQzNshfWqLtZaHy81qpLUWA1e6ekHQY65CA9Y6hDk0Rhgo3kxX2FM2ExOpUg";
    /// A real licence, for `u-other`.
    const OTHER: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LW90aGVyIiwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjQxMDI0NDQ4MDAsImFjdGl2ZSI6dHJ1ZX0.hGI8K5NNHDAvDEoLtYZrviKK3tsDvMAyAmUKv7X5sWKPDkIBVQb2S_aNF7idh3Kh62bGxouEo2X4kSVIoGDOSSnEA9GtBkVXl4bU-QIMClnGhua7c39-Q3f4sHz4gi3v37cjYldId9i1HE4tqlfyOknPS-EQbWUXFrZj05rTaFVPDcaHb8fT-4Rk2QvFEFAVVviP4zPKB4Kv4NjAxPDAeHoznWg4hiLavBIHZJi5pIGWIUQ_npXgxvsMLUOwsjOMRZdTSbqNmcfsPWV6KFUb1VmuzPD8HQqa0On9HKLFGwFD00nqSHPIA1YzSwq5mGm4U28XGAODSRhVQgkIOOX__g";

    fn cached(token: &str) -> Cached {
        Cached { licence_token: token.into(), checked_at: "2026-08-18T09:00:00Z".into() }
    }

    /// A scratch directory of this test's own. No `tempfile` dependency for
    /// four tests, and named after the test so a leftover is traceable.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rfrs-licence-cache-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_cached_licence_comes_back_dated_by_its_signature_not_by_the_file() {
        // The file claims the check happened in 2099. The token says 2026,
        // and the token is the half nobody can edit.
        let mut c = cached(VALID);
        c.checked_at = "2099-01-01T00:00:00Z".into();
        let r = recall(&c, "u-1", TEST_PUBLIC).expect("recalls");
        assert!(r.active);
        assert_eq!(r.checked_at, "2026-01-01T00:00:00Z", "the file's date was believed over the signature's");
    }

    /// The grace period's whole point: an answer older than the token's own
    /// expiry is still the answer the platform gave.
    #[test]
    fn an_expired_token_still_dates_and_answers_a_cache() {
        let r = recall(&cached(EXPIRED), "u-1", TEST_PUBLIC).expect("recalls");
        assert!(r.active);
        assert_eq!(r.checked_at, "2019-12-31T00:00:00Z");
    }

    /// Every way a cache can be worth nothing arrives as the same answer,
    /// because there is only one thing to do about any of them.
    #[test]
    fn a_cache_that_is_not_this_accounts_is_worth_nothing() {
        // Somebody else's, which is the file-sharing case.
        assert_eq!(recall(&cached(OTHER), "u-1", TEST_PUBLIC), None);
        // Nobody signed in — a cache must not answer for an empty account.
        assert_eq!(recall(&cached(VALID), "", TEST_PUBLIC), None);
        // Edited on disk.
        let mut broken = cached(VALID);
        broken.licence_token = VALID.replace("dWIiOiJ1LTEi", "dWIiOiJ1LTIi");
        assert_eq!(recall(&broken, "u-1", TEST_PUBLIC), None);
        // Not a token at all.
        assert_eq!(recall(&cached("nonsense"), "u-1", TEST_PUBLIC), None);
        // A build with no key cannot read a cache, and says nothing rather
        // than guessing.
        assert_eq!(recall(&cached(VALID), "u-1", "not a pem"), None);
    }

    #[test]
    fn what_is_written_is_what_comes_back_and_forgetting_means_forgotten() {
        let dir = scratch("round-trip");
        assert_eq!(load(&dir), None, "an empty directory is not a cached licence");

        let c = cached(VALID);
        store(&dir, &c).expect("stores");
        assert_eq!(load(&dir).as_ref(), Some(&c));

        forget(&dir);
        assert_eq!(load(&dir), None, "signing out left the licence behind");
        // Forgetting what is already gone is not an error worth having.
        forget(&dir);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The file is written for a person to read, and holds nothing secret.
    #[test]
    fn the_file_holds_a_signed_statement_and_no_credential() {
        let dir = scratch("contents");
        store(&dir, &cached(VALID)).expect("stores");
        let raw = std::fs::read_to_string(dir.join(FILE)).expect("reads");

        assert!(raw.contains("licenceToken"), "the signed half is the point: {raw}");
        assert!(!raw.contains("refresh"), "a refresh token has no business here: {raw}");
        assert!(!raw.contains("access"), "an access token has no business here: {raw}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

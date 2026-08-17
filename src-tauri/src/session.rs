//! What is kept between launches once somebody has signed in.
//!
//! Only two things are worth keeping, and only one of them is sensitive: the
//! refresh token, which can be exchanged for a new access token, and enough
//! identity to say *who* is signed in on the login screen without a round trip.
//!
//! The access token is deliberately **not** here. It lives about an hour, it is
//! obtainable from the refresh token, and writing it down would put a second
//! credential at rest for no benefit.
//!
//! ## Rotation is the part that can strand somebody
//!
//! Refresh tokens rotate: spending one returns a new one and invalidates the
//! old. So there is a moment, between the server accepting the old token and
//! this process writing the new one, where a crash leaves the app holding a
//! token the server has already retired — and the user is signed out
//! permanently, with no error and nothing to retry.
//!
//! [`replace`] exists to make that window as small as it can be and to be loud
//! when it fails. A failed write is returned rather than logged, because
//! carrying on with a token that was never saved converts a recoverable
//! problem into that permanent one.

use serde::{Deserialize, Serialize};

/// The keychain account this is filed under, alongside the provider keys.
const ACCOUNT: &str = "buildnlaunchai-session";

/// A signed-in identity, as it survives a restart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    /// Exchangeable for an access token. The only secret here.
    pub refresh_token: String,
    pub user_id: String,
    /// Shown on the login screen — "signed in as …" — so somebody who has the
    /// wrong account can see that before they wonder why nothing works.
    pub email: String,
    /// When this was written, ISO-8601. Not used for expiry; used to explain
    /// staleness to a person.
    pub saved_at: String,
}

#[derive(Debug)]
pub enum SessionError {
    /// The keychain refused. On macOS this is usually the code-signature ACL
    /// rather than anything the user did — see the note in `save`.
    Store(String),
    /// Something was there but could not be read as a session. Treated as
    /// "signed out" rather than as an error to show, because the only useful
    /// response is to sign in again.
    Unreadable,
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "the sign-in could not be saved: {e}"),
            Self::Unreadable => write!(f, "the saved sign-in could not be read"),
        }
    }
}

/// Write the session to the OS keychain.
///
/// A note for whoever meets this next on macOS: a keychain item is trusted
/// against the *designated requirement* of the application that created it,
/// and for an ad-hoc signed build that requirement is the code hash of that
/// exact build — `cdhash H"bb29…"`. Every rebuild produces a different hash,
/// so an updated copy of this app is, to the keychain, a different program
/// asking for somebody else's secret. Expect a permission prompt after each
/// update until the app is signed with a stable Developer ID, whose
/// requirement is the team rather than the build.
pub fn save(s: &StoredSession) -> Result<(), SessionError> {
    let json = serde_json::to_string(s).map_err(|e| SessionError::Store(e.to_string()))?;
    crate::secrets::set(ACCOUNT, &json).map_err(|e| SessionError::Store(format!("{e:?}")))
}

/// Read the session, if there is one.
///
/// A missing or unreadable entry both mean the same thing to the caller —
/// nobody is signed in — so neither is an error worth surfacing.
pub fn load() -> Option<StoredSession> {
    let raw = crate::secrets::get(ACCOUNT)?;
    serde_json::from_str(&raw).ok()
}

/// Forget the session. Used by signing out, and by a refresh the server
/// rejects outright.
pub fn clear() -> Result<(), SessionError> {
    crate::secrets::clear(ACCOUNT).map_err(|e| SessionError::Store(format!("{e:?}")))
}

/// Swap in a rotated refresh token, keeping the identity that came with it.
///
/// Called the moment a refresh returns, before the new access token is used
/// for anything. If this fails the caller must stop and say so: continuing
/// would spend a token whose replacement was never written down, and the next
/// launch would find a session the server has already retired.
pub fn replace(previous: &StoredSession, refresh_token: &str, now: &str) -> Result<StoredSession, SessionError> {
    let next = StoredSession {
        refresh_token: refresh_token.to_string(),
        saved_at: now.to_string(),
        ..previous.clone()
    };
    save(&next)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> StoredSession {
        StoredSession {
            refresh_token: "r-one".into(),
            user_id: "u-123".into(),
            email: "someone@example.com".into(),
            saved_at: "2026-08-17T12:00:00Z".into(),
        }
    }

    /// The stored shape has to survive a round trip unchanged, because a
    /// session that parses into something *slightly* different is a session
    /// that silently signs people out.
    #[test]
    fn a_session_round_trips_through_its_stored_form() {
        let s = sample();
        let json = serde_json::to_string(&s).expect("serialises");
        assert_eq!(serde_json::from_str::<StoredSession>(&json).expect("parses"), s);
    }

    /// Nothing but the refresh token is secret, and the access token must not
    /// be in here at all — it is short-lived and derivable, so storing it
    /// would put a second credential at rest for nothing.
    #[test]
    fn the_access_token_is_not_among_the_things_kept() {
        let json = serde_json::to_string(&sample()).expect("serialises");
        assert!(!json.contains("accessToken"), "an access token is being persisted: {json}");
        assert!(json.contains("refreshToken"), "the refresh token is what makes this useful");
    }

    /// Rotation keeps the person and changes only the token.
    #[test]
    #[ignore = "writes to the real keychain"]
    fn rotating_keeps_the_identity_and_swaps_the_token() {
        let first = sample();
        save(&first).expect("save");
        let second = replace(&first, "r-two", "2026-08-17T13:00:00Z").expect("replace");

        assert_eq!(second.refresh_token, "r-two");
        assert_eq!(second.user_id, first.user_id, "rotation lost the identity");
        assert_eq!(second.email, first.email);
        assert_ne!(second.saved_at, first.saved_at, "rotation did not record when");

        assert_eq!(load().expect("still stored"), second, "the rotated token was not written");
        clear().expect("clear");
        assert!(load().is_none(), "signing out left the session behind");
    }
}

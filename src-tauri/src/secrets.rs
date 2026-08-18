//! Credential storage.
//!
//! What is kept here is the **session** — a refresh token, filed under
//! `buildnlaunchai-session` by [`crate::session`]. That is a credential, so it
//! goes in the OS keychain rather than beside the ffmpeg path in
//! `settings.json`: a file path is configuration, a token that gets somebody
//! into an account is not, and plaintext on disk is a weaker default than
//! every supported platform already offers for free.
//!
//! ## Provider keys are no longer among them
//!
//! OpenAI and ElevenLabs keys used to live here too, pasted into the app and
//! kept per machine. They come from the account now and only from the account
//! — fetched into memory for the session, never written down. See
//! [`crate::provider_keys`] for what that bought and what it cost.
//!
//! The read path (`get`, `set`, `clear`) stays general rather than being
//! narrowed to the session account: it is a keychain wrapper, and the
//! narrowing that matters — no commands the webview can call to write a
//! provider key — is done by not exposing any.
//!
//! **Nothing here reaches the webview.** There are no `#[tauri::command]`s in
//! this module by design. A secret the UI never holds cannot leak through
//! devtools, a crash report, or a logging line somebody adds later without
//! thinking about it.

use serde::Serialize;

const SERVICE: &str = "com.buildnlaunchai.raw-footage-real-story";

#[derive(Debug, Serialize)]
pub struct SecretError {
    pub code: String,
    pub message: String,
}

impl SecretError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

/// Read whatever is filed under an account name.
///
/// No environment override any more. It used to answer `OPENAI_API_KEY` and
/// `ELEVENLABS_API_KEY` from here, which was the right home while this module
/// owned provider keys and the wrong one afterwards — the session is the only
/// thing stored here now, and a session does not come from an environment
/// variable. Those two variables are still honoured, by the module that owns
/// them: see [`crate::provider_keys`].
pub fn get(account: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, account)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|v| !v.trim().is_empty())
}

/// Store a secret, and prove it actually stored.
///
/// The read-back is not paranoia. keyring's platform backends are opt-in
/// features; built without one it uses a mock store that returns `Ok` from a
/// write and then has nothing to give back. That produced a UI confidently
/// reporting "key saved" while generation failed with "no API key" — the two
/// halves of the app disagreeing because one of them trusted a write it never
/// verified.
///
/// Verifying here means a broken or unavailable backend surfaces as a failed
/// save, at the moment the user is looking at the entry field, rather than as a
/// contradiction later.
pub fn set(account: &str, secret: &str) -> Result<(), SecretError> {
    let entry = keyring::Entry::new(SERVICE, account)
        .map_err(|e| SecretError::new("KEYCHAIN_UNAVAILABLE", e.to_string()))?;
    entry
        .set_password(secret)
        .map_err(|e| SecretError::new("KEYCHAIN_WRITE_FAILED", e.to_string()))?;

    // Read straight back through the same path the rest of the app uses.
    match entry.get_password() {
        Ok(stored) if stored == secret => Ok(()),
        Ok(_) => Err(SecretError::new(
            "KEYCHAIN_VERIFY_FAILED",
            "The key was saved but read back as something else. Your keychain may be locked.",
        )),
        Err(e) => Err(SecretError::new(
            "KEYCHAIN_VERIFY_FAILED",
            // What fails to save here is the session, so there is no
            // environment variable to suggest as a way round it. The old text
            // named the two provider variables, which was advice for a feature
            // this module no longer has.
            format!("Your sign-in could not be saved to the system keychain ({e})."),
        )),
    }
}

pub fn clear(account: &str) -> Result<(), SecretError> {
    let entry = keyring::Entry::new(SERVICE, account)
        .map_err(|e| SecretError::new("KEYCHAIN_UNAVAILABLE", e.to_string()))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting something that was never stored is the desired end state.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(SecretError::new("KEYCHAIN_DELETE_FAILED", e.to_string())),
    }
}

// `secret_present`, `secret_set` and `secret_clear` were here, and were the
// webview's way of writing a provider key to this machine. They are gone with
// the feature: the account is the only source of a provider key now, so a
// command that stores one locally has nothing left to be used for, and leaving
// it registered would leave the removed path reachable from the console.

#[cfg(test)]
mod tests {
    use super::*;

    /// The account names this module knows about.
    ///
    /// Only one, and that is the assertion: provider keys used to be filed here
    /// under the providers' own names, and the guarantee that they are not any
    /// more is that the working part of this file never mentions them.
    ///
    /// Read out of the source rather than by calling `get`, because `get`
    /// reaches the real login keychain — which on macOS blocks on a permission
    /// prompt and turns a passing suite into a hang. The note on the OpenAI
    /// test in `openai.rs` learned that the expensive way; this does not repeat
    /// it.
    ///
    /// Only the part above `#[cfg(test)]` is scanned. The tests below it have
    /// to be able to name what they are checking for, and a test that fails on
    /// its own list of forbidden words is a test that can never pass.
    #[test]
    fn no_provider_account_is_named_in_the_working_code() {
        let source = include_str!("secrets.rs");
        let working = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        let code: String = working
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for banned in ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "openai", "elevenlabs"] {
            assert!(
                !code.contains(banned),
                "{banned} is back in the credential store; provider keys belong to the account",
            );
        }
    }
}

#[cfg(test)]
mod keychain_roundtrip {
    /// Does a write actually land, and can it be read back?
    ///
    /// `#[ignore]` because it touches the real login keychain and may prompt
    /// for permission on a desktop session.
    #[test]
    #[ignore = "writes to the real keychain"]
    fn set_then_get_then_clear() {
        let account = "rfrs-selftest";

        let write = super::set(account, "value-under-test");
        println!("\n  set   -> {:?}", write.as_ref().map(|_| "ok").map_err(|e| &e.code));
        assert!(write.is_ok(), "write failed: {:?}", write.err().map(|e| e.message));

        let read = super::get(account);
        println!("  get   -> {:?}", read.as_deref());
        assert_eq!(read.as_deref(), Some("value-under-test"), "written value did not read back");

        let cleared = super::clear(account);
        println!("  clear -> {:?}", cleared.as_ref().map(|_| "ok").map_err(|e| &e.code));
        assert!(cleared.is_ok());
        assert!(super::get(account).is_none(), "value survived deletion");
    }
}

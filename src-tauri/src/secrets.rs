//! Credential storage.
//!
//! The ElevenLabs key is a live billing credential, so it goes in the OS
//! keychain rather than beside the ffmpeg path in `settings.json`. A file path
//! is configuration; a key that spends someone's money is not, and plaintext on
//! disk is a weaker default than every supported platform already offers for
//! free.
//!
//! **The key never reaches the webview.** The frontend asks for synthesis by
//! name; this module reads the credential and the HTTP call happens in Rust. A
//! secret the UI never holds cannot leak through devtools, a crash report, or a
//! logging line somebody adds later without thinking about it.

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

/// Environment override, checked before the keychain.
///
/// Mirrors how `FFMPEG_PATH` works, and makes the whole cloud path testable in
/// CI without a keychain — which on a headless runner does not exist.
fn env_key(account: &str) -> Option<String> {
    let var = match account {
        "elevenlabs" => "ELEVENLABS_API_KEY",
        "openai" => "OPENAI_API_KEY",
        _ => return None,
    };
    std::env::var(var).ok().filter(|v| !v.trim().is_empty())
}

pub fn get(account: &str) -> Option<String> {
    if let Some(v) = env_key(account) {
        return Some(v);
    }
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
            format!(
                "The key could not be saved to your system keychain ({e}).                  Set OPENAI_API_KEY or ELEVENLABS_API_KEY in your environment instead."
            ),
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

/// Whether a key is present, without ever returning it.
///
/// The UI needs to know if it should show "connected" or an entry field, and
/// that question can be answered without the secret crossing the boundary.
#[tauri::command]
pub fn secret_present(account: String) -> bool {
    get(&account).is_some()
}

/// Stores the secret and returns whether it is now readable.
///
/// Returning the verified state rather than unit means the UI has no reason to
/// track a separate belief about whether a key exists.
#[tauri::command]
pub fn secret_set(account: String, secret: String) -> Result<bool, SecretError> {
    if secret.trim().is_empty() {
        return Err(SecretError::new("EMPTY_SECRET", "The key is empty."));
    }
    set(&account, secret.trim())?;
    Ok(get(&account).is_some())
}

#[tauri::command]
pub fn secret_clear(account: String) -> Result<(), SecretError> {
    clear(&account)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Environment variables are process-global, so these assertions live in
    /// one test rather than three. Split across parallel tests they raced each
    /// other and failed intermittently — which is a property of the test
    /// design, not of the code under test.
    #[test]
    fn env_overrides_take_precedence_and_are_per_account() {
        // Safety: this is the only test touching these variables, and each is
        // removed before the next assertion depends on its absence.
        unsafe { std::env::set_var("ELEVENLABS_API_KEY", "test-key-from-env") };
        assert_eq!(get("elevenlabs").as_deref(), Some("test-key-from-env"));

        // Whitespace is not a key.
        unsafe { std::env::set_var("ELEVENLABS_API_KEY", "   ") };
        assert!(env_key("elevenlabs").is_none());
        unsafe { std::env::remove_var("ELEVENLABS_API_KEY") };

        // OPENAI_API_KEY is a near-universal variable, so a key exported for
        // something else is picked up ahead of the keychain. That is the
        // documented precedence and is what makes CI work, but the mapping
        // should be deliberate rather than accidental.
        unsafe { std::env::set_var("OPENAI_API_KEY", "sk-test-openai") };
        assert_eq!(get("openai").as_deref(), Some("sk-test-openai"));
        // ...and it must not bleed into the other account. Asked through
        // `env_key` rather than `get`, because `get` falls through to the
        // keychain when the variable is absent, and on macOS that blocks on a
        // permission prompt the moment the test binary changes — which turned
        // a passing suite into a hang for reasons that had nothing to do with
        // the code under test.
        assert!(env_key("elevenlabs").is_none());
        unsafe { std::env::remove_var("OPENAI_API_KEY") };
    }

    #[test]
    fn unknown_accounts_have_no_env_override() {
        assert!(env_key("something-else").is_none());
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
        unsafe { std::env::remove_var("ELEVENLABS_API_KEY") };

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

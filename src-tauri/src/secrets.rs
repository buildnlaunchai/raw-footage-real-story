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

pub fn set(account: &str, secret: &str) -> Result<(), SecretError> {
    let entry = keyring::Entry::new(SERVICE, account)
        .map_err(|e| SecretError::new("KEYCHAIN_UNAVAILABLE", e.to_string()))?;
    entry
        .set_password(secret)
        .map_err(|e| SecretError::new("KEYCHAIN_WRITE_FAILED", e.to_string()))
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

#[tauri::command]
pub fn secret_set(account: String, secret: String) -> Result<(), SecretError> {
    if secret.trim().is_empty() {
        return Err(SecretError::new("EMPTY_SECRET", "The key is empty."));
    }
    set(&account, secret.trim())
}

#[tauri::command]
pub fn secret_clear(account: String) -> Result<(), SecretError> {
    clear(&account)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The environment override must win, so CI can exercise the cloud path
    /// without a keychain.
    #[test]
    fn env_override_is_used_when_set() {
        // Safety: single-threaded within this test, and the value is removed
        // before it can affect others.
        unsafe { std::env::set_var("ELEVENLABS_API_KEY", "test-key-from-env") };
        assert_eq!(get("elevenlabs").as_deref(), Some("test-key-from-env"));
        unsafe { std::env::remove_var("ELEVENLABS_API_KEY") };
    }

    #[test]
    fn blank_env_values_are_ignored() {
        unsafe { std::env::set_var("ELEVENLABS_API_KEY", "   ") };
        assert!(env_key("elevenlabs").is_none(), "whitespace is not a key");
        unsafe { std::env::remove_var("ELEVENLABS_API_KEY") };
    }

    #[test]
    fn unknown_accounts_have_no_env_override() {
        assert!(env_key("something-else").is_none());
    }
}

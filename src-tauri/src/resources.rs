//! Locating bundled resources (model, voices, lexicons).
//!
//! Tauri resolves resources differently in `tauri dev` than in a bundled app,
//! so the root is set once at startup from the AppHandle and falls back to the
//! crate directory. The fallback is what makes `cargo test` work without a
//! running app.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Called once during Tauri setup with the resolved resource directory.
pub fn init(path: PathBuf) {
    let _ = ROOT.set(path);
}

fn crate_fallback() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources")
}

/// Resource root. Prefers the app-provided path, but falls back to the crate
/// directory when that path doesn't actually contain the assets — which is the
/// case under `tauri dev`, where resources are not staged into the target dir.
pub fn root() -> PathBuf {
    match ROOT.get() {
        Some(p) if p.join("kokoro").is_dir() => p.clone(),
        _ => crate_fallback(),
    }
}

pub fn kokoro() -> PathBuf {
    root().join("kokoro")
}

pub fn lexicon() -> PathBuf {
    root().join("lexicon")
}

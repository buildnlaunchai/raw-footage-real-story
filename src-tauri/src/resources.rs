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

/// Resource root.
///
/// Prefers the app-provided path. When that path does not hold the assets the
/// behaviour deliberately differs by build:
///
/// - **debug/test** falls back to the crate directory, which is what makes
///   `tauri dev` and `cargo test` work without a staged bundle.
/// - **release** does not. The crate directory is a path from the machine this
///   was compiled on; on a user's disk it does not exist. Falling back to it
///   turns "the bundle is missing its resources" into "no such file at
///   /Users/somebody/…", which sends whoever is debugging it somewhere that was
///   never plausible. Returning the real resource dir keeps the error honest.
pub fn root() -> PathBuf {
    match ROOT.get() {
        Some(p) if p.join("kokoro").is_dir() => p.clone(),
        Some(p) if cfg!(not(debug_assertions)) => p.clone(),
        _ => crate_fallback(),
    }
}

/// What is wrong with the resources, if anything.
///
/// Checked once at startup so a mis-bundled build announces itself, rather than
/// looking fine until the first attempt to speak.
pub fn problem() -> Option<String> {
    let r = root();
    if !r.is_dir() {
        return Some(format!("resource directory does not exist: {}", r.display()));
    }
    for rel in ["kokoro/model_q8f16.onnx", "lexicon/us_gold.json"] {
        let p = r.join(rel);
        match std::fs::metadata(&p) {
            Ok(m) if m.len() > 1_000 => {}
            Ok(m) => {
                return Some(format!("{} is only {} bytes — a Git LFS pointer, not the file", p.display(), m.len()))
            }
            Err(e) => return Some(format!("{}: {e}", p.display())),
        }
    }
    None
}

pub fn kokoro() -> PathBuf {
    root().join("kokoro")
}

pub fn lexicon() -> PathBuf {
    root().join("lexicon")
}


/// Resolve the resource root from the executable's own location.
///
/// The self-test runs before Tauri's `setup`, so nothing has called `init` and
/// `root()` would fall back to the crate directory — which exists on every
/// build machine and on every CI runner. That made the self-test pass while
/// reading the repo instead of the bundle it was supposed to be checking: a
/// gate that cannot fail is not a gate.
///
/// Ordered bundle-first, so a real bundle is never mistaken for a dev tree.
/// Returns the layout it matched, so the log says which one was used rather
/// than leaving the reader to guess.
pub fn init_from_exe() -> Result<(PathBuf, &'static str), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("executable has no parent directory")?;

    let candidates: [(PathBuf, &'static str); 3] = [
        // macOS: Contents/MacOS/<bin> -> Contents/Resources/resources
        (dir.join("..").join("Resources").join("resources"), "macOS app bundle"),
        // Windows and Linux: resources sit beside the executable
        (dir.join("resources"), "beside the executable"),
        // cargo target/{debug,release}/<bin> -> src-tauri/resources
        (dir.join("..").join("..").join("resources"), "development tree"),
    ];

    for (path, what) in candidates {
        if path.join("kokoro").is_dir() {
            let resolved = strip_verbatim(path.canonicalize().unwrap_or(path));
            init(resolved.clone());
            return Ok((resolved, what));
        }
    }
    Err(format!(
        "no resource directory found near {}. Looked for a `kokoro` folder in \
         ../Resources/resources, ./resources and ../../resources.",
        dir.display()
    ))
}

/// Remove Windows' `\\?\` extended-length prefix.
///
/// `canonicalize` returns verbatim paths on Windows — `\\?\D:\a\...` — which are
/// valid for the Rust API and hostile to anything that parses a path itself.
/// ONNX Runtime takes the model path across an FFI boundary into C++, and the
/// Windows build segfaults while opening it; a verbatim prefix is the kind of
/// thing that does that.
///
/// Only the prefix is dropped, so the path still points at the same file. Done
/// by hand rather than by adding `dunce` for four lines.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\UNC\") {
        // \\?\UNC\server\share -> \\server\share
        Some(rest) => PathBuf::from(format!(r"\\{rest}")),
        None => match s.strip_prefix(r"\\?\") {
            Some(rest) => PathBuf::from(rest),
            None => p,
        },
    }
}
//! Does this build actually work?
//!
//! A packaging pipeline can produce a green build and a broken app. The
//! resources are 110MB of model, voices and lexicons that arrive through Git
//! LFS and a bundler glob, and every step between the repo and the user's disk
//! can drop them while every step still reports success. Inspecting the bundle
//! catches a wrong glob; only *using* the files catches an LFS pointer that was
//! never smudged, a model that downloaded truncated, or a resource root that
//! resolved somewhere plausible and empty.
//!
//! So this runs the real path — locate resources, load the ONNX session,
//! phonemise a sentence, synthesise it — and exits non-zero if any of it fails.
//! It is the gate that stands between "CI is green" and "it works when someone
//! downloads it".
//!
//! Invoked as `raw-footage-real-story --selftest`, before any window opens.

use std::path::Path;

/// Everything the app needs to have been bundled with it.
const REQUIRED: &[(&str, u64)] = &[
    // (path relative to the resource root, smallest believable size in bytes)
    //
    // The sizes are the point. An LFS pointer file is ~130 bytes and reads
    // perfectly well as a file, so "exists" is not evidence of anything; a
    // floor several orders of magnitude above a pointer is.
    ("kokoro/model_q8f16.onnx", 60_000_000),
    ("kokoro/tokenizer.json", 1_000),
    ("lexicon/us_gold.json", 100_000),
    ("lexicon/cmudict.dict", 1_000_000),
];

/// How many voice packs must be present. All of them; a partial set means the
/// glob matched something and stopped.
const VOICE_COUNT: usize = 55;

pub fn run() -> i32 {
    let mut failures: Vec<String> = Vec::new();

    // --- 1. are the files there, and are they real files? -------------------
    //
    // Resolved from the executable rather than through `root()`. Nothing has
    // called `resources::init` this early, so `root()` would fall back to the
    // crate directory — which exists on every CI runner, so the whole test
    // would pass while reading the repo instead of the bundle.
    let (root, layout) = match crate::resources::init_from_exe() {
        Ok(v) => v,
        Err(e) => {
            println!("FAIL  {e}");
            return 1;
        }
    };
    println!("resource root: {}", root.display());
    println!("layout:        {layout}");

    for (rel, min) in REQUIRED {
        let p = root.join(rel);
        match std::fs::metadata(&p) {
            Ok(m) if m.len() >= *min => {
                println!("  ok    {rel} ({} bytes)", m.len());
            }
            Ok(m) => {
                // The specific shape of an LFS failure, called out by name so
                // whoever reads the log knows which lever to pull.
                let hint = if m.len() < 500 && is_lfs_pointer(&p) {
                    " — this is a Git LFS pointer, not the file. `git lfs pull`."
                } else {
                    ""
                };
                failures.push(format!("{rel} is {} bytes, expected >= {min}{hint}", m.len()));
            }
            Err(e) => failures.push(format!("{rel} missing: {e}")),
        }
    }

    let voices = root.join("kokoro").join("voices");
    let found = std::fs::read_dir(&voices)
        .map(|d| d.filter_map(|e| e.ok()).filter(|e| e.path().extension().is_some_and(|x| x == "bin")).count())
        .unwrap_or(0);
    if found >= VOICE_COUNT {
        println!("  ok    {found} voice packs");
    } else {
        failures.push(format!("{found} voice packs, expected at least {VOICE_COUNT}"));
    }

    if !failures.is_empty() {
        println!("\nFAIL  bundled resources are not usable:");
        for f in &failures {
            println!("  - {f}");
        }
        return 1;
    }

    // --- 2. does the thing actually run? ------------------------------------
    //
    // Everything above could pass on a machine where the ONNX runtime is
    // missing or the wrong architecture — which on Windows is the open
    // question, since the macOS build links it statically and nobody has
    // checked whether that holds there.
    println!("\nsynthesising a line…");
    match crate::tts::synthesise_for_selftest("The harbour was still frozen.") {
        Ok(samples) => {
            let seconds = samples.len() as f64 / crate::tts::SAMPLE_RATE as f64;
            if samples.is_empty() || seconds < 0.3 {
                println!("FAIL  produced {seconds:.2}s of audio, which is not a spoken sentence");
                return 1;
            }
            let peak = samples.iter().fold(0f32, |a, s| a.max(s.abs()));
            if peak < 0.01 {
                println!("FAIL  produced {seconds:.2}s of silence (peak {peak:.4})");
                return 1;
            }
            println!("  ok    {seconds:.2}s of audio, peak {peak:.3}");
        }
        Err(e) => {
            println!("FAIL  synthesis failed: {e}");
            return 1;
        }
    }

    // --- 3. what did we find of the outside world? --------------------------
    //
    // Reported, never fatal. ffmpeg is not bundled and the app is built to work
    // without it — but on Windows nobody had checked whether discovery looks
    // where winget and scoop actually install, and a log line is how that stops
    // being a guess.
    println!("\nexternal tools:");
    match crate::ffmpeg::detect(&crate::ffmpeg::FfmpegSettings::default()) {
        Ok(info) => {
            println!("  ffmpeg   {}", info.ffmpeg);
            println!("  ffprobe  {}", info.ffprobe);
            println!("  zscale   {}", if info.caps.zscale { "yes" } else { "no — HDR cannot be tone-mapped" });
        }
        Err(e) => println!("  ffmpeg   not found ({}) — assembly will be unavailable", e.code),
    }

    println!("\nPASS  this build can find its resources and speak.");
    0
}

/// Git LFS pointers are a short text file with a known first line.
fn is_lfs_pointer(path: &Path) -> bool {
    std::fs::read(path)
        .map(|b| b.starts_with(b"version https://git-lfs"))
        .unwrap_or(false)
}

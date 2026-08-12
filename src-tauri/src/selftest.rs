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

/// Print and flush.
///
/// A segfault discards whatever is sitting in the stdout buffer, so an
/// un-flushed log of the step that crashed is exactly the log you do not get.
macro_rules! step {
    ($($arg:tt)*) => {{
        println!($($arg)*);
        let _ = std::io::Write::flush(&mut std::io::stdout());
    }};
}

/// Try to load one model and say whether it survived.
///
/// A separate process per model on purpose: the Windows failure is a segfault,
/// which takes the whole process down, so probing several in one run would only
/// ever report the first. The caller loops and each crash is contained.
///
/// Invoked as `--probe-model <path>`; exits 0 if the session builds.
pub fn probe_model(path: &str) -> i32 {
    use std::io::Write;
    let p = std::path::Path::new(path);
    let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    println!("probing {} ({:.1} MB)", p.display(), size as f64 / 1_048_576.0);
    let _ = std::io::stdout().flush();

    match crate::tts::stages::session_at(p) {
        Ok(mut session) => {
            println!("  session built");
            let _ = std::io::stdout().flush();
            // Loading is not speaking. A model that opens and then produces
            // nothing is the macOS failure in a different coat, so the probe
            // runs one inference too.
            match crate::tts::stages::infer(&mut session, "həlˈO.", "af_kore") {
                Ok(s) => {
                    let peak = s.iter().fold(0f32, |a, x| a.max(x.abs()));
                    println!("  OK  {} samples, peak {peak:.3}", s.len());
                    if peak < 0.01 { println!("  but silent"); return 1; }
                    0
                }
                Err(e) => {
                    println!("  FAIL inference: {e}");
                    1
                }
            }
        }
        Err(e) => {
            println!("  FAIL load: {e}");
            1
        }
    }
}

pub fn run() -> i32 {
    let mut failures: Vec<String> = Vec::new();

    // Reported first, and never fatal. It is the only external-tool answer we
    // get if something later takes the process down — which on Windows it does.
    step!("external tools:");
    match crate::ffmpeg::detect(&crate::ffmpeg::FfmpegSettings::default()) {
        Ok(info) => {
            step!("  ffmpeg   {}", info.ffmpeg);
            step!("  ffprobe  {}", info.ffprobe);
            step!("  zscale   {}", if info.caps.zscale { "yes" } else { "no" });
        }
        Err(e) => step!("  ffmpeg   not found ({}) — assembly unavailable", e.code),
    }
    step!("");

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
    // --- 3. does it actually run? -------------------------------------------
    //
    // Announced step by step and flushed, because the Windows failure is a
    // segfault: the process vanishes, and the last line printed is the only
    // evidence of how far it got.
    step!("synthesis, stage by stage:");

    step!("  1/5 phonemising…");
    let short = match crate::tts::stages::phonemise("Hello.") {
        Ok(p) => p,
        Err(e) => {
            step!("  FAIL  {e}");
            return 1;
        }
    };
    step!("      short phonemes: {short:?}");

    let long = match crate::tts::stages::phonemise("The harbour was still frozen.") {
        Ok(p) => p,
        Err(e) => {
            step!("  FAIL  {e}");
            return 1;
        }
    };
    step!("      long phonemes:  {long:?}");

    step!("  2/5 building the ONNX session (loads 82MB)…");
    let mut log = |m: &str| {
        println!("      · {m}");
        let _ = std::io::Write::flush(&mut std::io::stdout());
    };
    let mut session = match crate::tts::stages::session_verbose(&mut log) {
        Ok(s) => s,
        Err(e) => {
            step!("  FAIL  {e}");
            return 1;
        }
    };
    step!("      session built");

    // Shortest possible input first. If this survives and the longer one does
    // not, the fault is length- or shape-dependent rather than the runtime
    // being broken outright — a different problem with a different fix.
    step!("  3/5 inference on a two-word input…");
    let brief = match crate::tts::stages::infer(&mut session, &short, "af_kore") {
        Ok(s) => s,
        Err(e) => {
            step!("  FAIL  {e}");
            return 1;
        }
    };
    step!("      {} samples", brief.len());

    step!("  4/5 inference on a full sentence…");
    let samples = match crate::tts::stages::infer(&mut session, &long, "af_kore") {
        Ok(s) => s,
        Err(e) => {
            step!("  FAIL  {e}");
            return 1;
        }
    };

    step!("  5/5 checking the audio…");
    let seconds = samples.len() as f64 / crate::tts::SAMPLE_RATE as f64;
    let peak = samples.iter().fold(0f32, |a, s| a.max(s.abs()));
    step!("      {seconds:.2}s, peak {peak:.3}");
    if samples.is_empty() || seconds < 0.3 {
        step!("FAIL  {seconds:.2}s is not a spoken sentence");
        return 1;
    }
    if peak < 0.01 {
        step!("FAIL  {seconds:.2}s of silence (peak {peak:.4})");
        return 1;
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

//! Driving a local ffmpeg binary.
//!
//! ffmpeg is invoked as a separate process, never linked. That is a licensing
//! decision as much as a practical one: the common Homebrew build is
//! `--enable-gpl --enable-libx264`, so linking it would attach GPL obligations
//! to this whole bundle. Shelling out to a binary the user already has does not.
//!
//! This module knows about ffmpeg. It does not know about narration, and it
//! does not decide how long anything should be — that is [`crate::timeline`].

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::timeline::{Fit, TimelineItem};

#[derive(Debug, Serialize)]
pub struct FfmpegError {
    pub code: String,
    pub message: String,
}

impl FfmpegError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInfo {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegSettings {
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
}

/// Locations to check when the binary is not on `PATH`.
///
/// This list is load-bearing, not belt-and-braces: a macOS app bundle launched
/// from Finder inherits a minimal `PATH` that excludes Homebrew entirely. A
/// PATH-only lookup therefore works perfectly under `tauri dev` and fails for
/// every real user — which presents as "the app is broken", not "config missing".
#[cfg(target_os = "macos")]
const EXTRA_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin"];
#[cfg(target_os = "windows")]
const EXTRA_DIRS: &[&str] = &[
    r"C:\ffmpeg\bin",
    r"C:\Program Files\ffmpeg\bin",
    r"C:\ProgramData\chocolatey\bin",
];
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const EXTRA_DIRS: &[&str] = &["/usr/bin", "/usr/local/bin", "/snap/bin"];

fn exe_name(stem: &str) -> String {
    if cfg!(target_os = "windows") { format!("{stem}.exe") } else { stem.to_string() }
}

fn is_runnable(path: &Path) -> bool {
    path.is_file()
        && Command::new(path)
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
}

/// Resolution order: explicit env override, then a path the user chose in the
/// setup screen, then `PATH`, then well-known install locations.
fn resolve(stem: &str, env_key: &str, saved: Option<&String>) -> Option<PathBuf> {
    if let Ok(p) = std::env::var(env_key) {
        let p = PathBuf::from(p);
        if is_runnable(&p) {
            return Some(p);
        }
    }
    if let Some(p) = saved.map(PathBuf::from) {
        if is_runnable(&p) {
            return Some(p);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(exe_name(stem));
            if is_runnable(&candidate) {
                return Some(candidate);
            }
        }
    }
    for dir in EXTRA_DIRS {
        let candidate = Path::new(dir).join(exe_name(stem));
        if is_runnable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

pub fn detect(settings: &FfmpegSettings) -> Result<FfmpegInfo, FfmpegError> {
    let ffmpeg = resolve("ffmpeg", "FFMPEG_PATH", settings.ffmpeg_path.as_ref()).ok_or_else(
        || FfmpegError::new("FFMPEG_NOT_FOUND", "Could not find a working ffmpeg binary."),
    )?;
    // ffprobe usually sits beside ffmpeg; prefer that before searching again.
    let sibling = ffmpeg.parent().map(|d| d.join(exe_name("ffprobe")));
    let ffprobe = sibling
        .filter(|p| is_runnable(p))
        .or_else(|| resolve("ffprobe", "FFPROBE_PATH", settings.ffprobe_path.as_ref()))
        .ok_or_else(|| {
            FfmpegError::new(
                "FFPROBE_NOT_FOUND",
                "Found ffmpeg but not ffprobe. Both are required.",
            )
        })?;

    let out = Command::new(&ffmpeg)
        .arg("-version")
        .output()
        .map_err(|e| FfmpegError::new("FFMPEG_NOT_FOUND", e.to_string()))?;
    let version = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("unknown")
        .to_string();

    Ok(FfmpegInfo {
        ffmpeg: ffmpeg.to_string_lossy().into(),
        ffprobe: ffprobe.to_string_lossy().into(),
        version,
    })
}

fn run(cmd: &mut Command, what: &str) -> Result<String, FfmpegError> {
    let out = cmd
        .output()
        .map_err(|e| FfmpegError::new("SPAWN_FAILED", format!("{what}: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // ffmpeg's fatal reason is almost always the last non-empty line.
        let reason = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("unknown");
        return Err(FfmpegError::new("FFMPEG_FAILED", format!("{what}: {reason}")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub fn probe_duration_ms(ffprobe: &str, media: &Path) -> Result<u64, FfmpegError> {
    let stdout = run(
        Command::new(ffprobe).args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
        ]).arg(media),
        "probe duration",
    )?;
    let secs: f64 = stdout
        .trim()
        .parse()
        .map_err(|_| FfmpegError::new("PROBE_FAILED", format!("unreadable duration: {stdout:?}")))?;
    Ok((secs * 1000.0).round() as u64)
}

/// A flat colour card standing in for real footage.
///
/// Colours rather than captions because `drawtext` needs libfreetype, which
/// many ffmpeg builds omit — including the Homebrew one here. Distinct colours
/// turn out to be strictly better for testing anyway: a frame's colour can be
/// asserted numerically, whereas a text label could only be eyeballed.
pub fn make_placeholder(
    ffmpeg: &str,
    out: &Path,
    color: &str,
    duration_ms: u64,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<(), FfmpegError> {
    let secs = duration_ms as f64 / 1000.0;
    run(
        Command::new(ffmpeg).args([
            "-y", "-v", "error",
            "-f", "lavfi",
            "-i", &format!("color=c={color}:s={width}x{height}:r={fps}:d={secs}"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", &secs.to_string(),
        ]).arg(out),
        "generate placeholder",
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct RenderItem {
    pub video: PathBuf,
    pub audio: PathBuf,
    pub item: TimelineItem,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSettings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl Default for RenderSettings {
    fn default() -> Self {
        Self { width: 1920, height: 1080, fps: 30 }
    }
}

/// Assemble the rough cut in a single pass.
///
/// Each input is normalised inline — scaled and letterboxed rather than
/// cropped, because silently discarding footage is worse than black bars —
/// then everything is concatenated. Video and audio are concatenated together
/// by the same `concat` filter, which keeps them locked in step.
pub fn render_rough_cut(
    ffmpeg: &str,
    items: &[RenderItem],
    settings: &RenderSettings,
    out: &Path,
) -> Result<(), FfmpegError> {
    if items.is_empty() {
        return Err(FfmpegError::new("NOTHING_TO_RENDER", "There are no lines to assemble."));
    }

    let RenderSettings { width, height, fps } = *settings;
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-y", "-v", "error"]);

    for it in items {
        cmd.arg("-i").arg(&it.video);
        cmd.arg("-i").arg(&it.audio);
    }

    let mut filter = String::new();
    for (i, it) in items.iter().enumerate() {
        let v = i * 2;
        let a = v + 1;
        let use_ms = it.item.source_out_ms.saturating_sub(it.item.source_in_ms);
        let total_s = it.item.timeline_duration_ms as f64 / 1000.0;

        // trim -> normalise geometry -> lock timebase/rate -> hold last frame.
        // Order matters: tpad must come last or it pads the pre-scaled stream.
        filter.push_str(&format!(
            "[{v}:v]trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS,\
             scale={width}:{height}:force_original_aspect_ratio=decrease,\
             pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}",
            it.item.source_in_ms as f64 / 1000.0,
            use_ms as f64 / 1000.0,
        ));
        if it.item.fit == Fit::Held && it.item.hold_ms > 0 {
            filter.push_str(&format!(
                ",tpad=stop_mode=clone:stop_duration={:.3}",
                it.item.hold_ms as f64 / 1000.0
            ));
        }
        // Guarantee the exact slot length regardless of rounding in the filters.
        filter.push_str(&format!(",trim=duration={total_s:.3},setpts=PTS-STARTPTS[v{i}];"));

        // Narration, resampled and padded with silence to fill the same slot.
        filter.push_str(&format!(
            "[{a}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
             apad,atrim=duration={total_s:.3},asetpts=PTS-STARTPTS[a{i}];"
        ));
    }

    for i in 0..items.len() {
        filter.push_str(&format!("[v{i}][a{i}]"));
    }
    filter.push_str(&format!("concat=n={}:v=1:a=1[outv][outa]", items.len()));

    cmd.args(["-filter_complex", &filter]);
    cmd.args([
        "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        // yuv420p is not optional: without it QuickTime and browsers refuse
        // otherwise-valid H.264 files.
        "-pix_fmt", "yuv420p",
        "-r", &fps.to_string(),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart",
    ]);
    cmd.arg(out);

    run(&mut cmd, "render rough cut")?;
    Ok(())
}

/// Average RGB of a single frame, used by tests to assert which clip is on
/// screen at a given moment.
pub fn frame_rgb(ffmpeg: &str, media: &Path, at_ms: u64) -> Result<(u8, u8, u8), FfmpegError> {
    let out = Command::new(ffmpeg)
        .args(["-v", "error", "-ss", &format!("{:.3}", at_ms as f64 / 1000.0)])
        .arg("-i")
        .arg(media)
        .args([
            "-frames:v", "1",
            "-vf", "scale=8:8",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ])
        .output()
        .map_err(|e| FfmpegError::new("SPAWN_FAILED", e.to_string()))?;

    if !out.status.success() || out.stdout.len() < 3 {
        return Err(FfmpegError::new(
            "FRAME_READ_FAILED",
            format!("no frame at {at_ms}ms: {}", String::from_utf8_lossy(&out.stderr)),
        ));
    }

    let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
    for px in out.stdout.chunks_exact(3) {
        r += px[0] as u64;
        g += px[1] as u64;
        b += px[2] as u64;
        n += 1;
    }
    Ok(((r / n) as u8, (g / n) as u8, (b / n) as u8))
}

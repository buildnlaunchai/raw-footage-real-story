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
    /// What this particular build can do. Capabilities vary widely between
    /// Homebrew, winget and distro packages, and the gaps are user-visible.
    pub caps: FfmpegCaps,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegCaps {
    /// libzimg. Without it, HDR footage cannot be tone-mapped properly and
    /// comes out washed out and grey — silently, which is the worst kind.
    pub zscale: bool,
    pub tonemap: bool,
}

fn probe_caps(ffmpeg: &Path) -> FfmpegCaps {
    let filters = Command::new(ffmpeg)
        .arg("-filters")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let has = |name: &str| {
        filters
            .lines()
            .any(|l| l.split_whitespace().nth(1).is_some_and(|f| f == name))
    };
    FfmpegCaps { zscale: has("zscale"), tonemap: has("tonemap") }
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

    let caps = probe_caps(&ffmpeg);

    Ok(FfmpegInfo {
        ffmpeg: ffmpeg.to_string_lossy().into(),
        ffprobe: ffprobe.to_string_lossy().into(),
        version,
        caps,
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

// ---------------------------------------------------------------------------
// Inspecting real footage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub codec: String,
    pub fps: f64,
    pub has_audio: bool,
    /// Degrees from the display matrix. Phone footage relies on this; ignoring
    /// it renders portrait video sideways.
    pub rotation: i32,
    pub color_transfer: String,
    pub is_hdr: bool,
}

impl MediaInfo {
    /// Dimensions as a viewer sees them, after rotation is applied.
    pub fn display_size(&self) -> (u32, u32) {
        if self.rotation.abs() % 180 == 90 {
            (self.height, self.width)
        } else {
            (self.width, self.height)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaVerdict {
    Accepted,
    Warning,
    Rejected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCheck {
    pub verdict: MediaVerdict,
    /// Always populated for warnings and rejections. Nothing is ever dropped
    /// without the user being told exactly why.
    pub reasons: Vec<String>,
    pub info: Option<MediaInfo>,
}

fn frame_rate(spec: &str) -> f64 {
    match spec.split_once('/') {
        Some((n, d)) => {
            let (n, d) = (n.parse::<f64>().unwrap_or(0.0), d.parse::<f64>().unwrap_or(1.0));
            if d == 0.0 { 0.0 } else { n / d }
        }
        None => spec.parse().unwrap_or(0.0),
    }
}

/// Inspect a file with ffprobe.
///
/// Validation is by probe, never by extension: an extension is a claim, the
/// probe is the fact.
pub fn probe_media(ffprobe: &str, media: &Path) -> Result<MediaInfo, FfmpegError> {
    let stdout = run(
        Command::new(ffprobe).args([
            "-v", "error",
            "-show_streams", "-show_format",
            "-of", "json",
        ]).arg(media),
        "probe media",
    )?;

    let json: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| FfmpegError::new("PROBE_FAILED", e.to_string()))?;
    let empty = vec![];
    let streams = json["streams"].as_array().unwrap_or(&empty);

    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or_else(|| FfmpegError::new("NO_VIDEO_STREAM", "This file has no video track."))?;

    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");

    // Rotation lives in side data on modern files; older ones use a tag.
    let rotation = video["side_data_list"]
        .as_array()
        .and_then(|list| list.iter().find_map(|d| d["rotation"].as_i64()))
        .or_else(|| video["tags"]["rotate"].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0) as i32;

    let color_transfer = video["color_transfer"].as_str().unwrap_or("").to_string();
    // PQ and HLG are the two HDR transfer functions in practice.
    let is_hdr = matches!(color_transfer.as_str(), "smpte2084" | "arib-std-b67");

    let duration_ms = json["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .map(|s| (s * 1000.0).round() as u64)
        .unwrap_or(0);

    Ok(MediaInfo {
        duration_ms,
        width: video["width"].as_u64().unwrap_or(0) as u32,
        height: video["height"].as_u64().unwrap_or(0) as u32,
        codec: video["codec_name"].as_str().unwrap_or("unknown").to_string(),
        fps: frame_rate(video["r_frame_rate"].as_str().unwrap_or("0/1")),
        has_audio,
        rotation,
        color_transfer,
        is_hdr,
    })
}

/// Decide whether a file is usable, and say plainly what is wrong if not.
pub fn check_media(ffprobe: &str, media: &Path, caps: &FfmpegCaps) -> MediaCheck {
    let info = match probe_media(ffprobe, media) {
        Ok(i) => i,
        Err(e) => {
            let reason = match e.code.as_str() {
                "NO_VIDEO_STREAM" => "No video track — this looks like an audio file or an image.",
                _ => "Couldn't read this file. It may be corrupt or in an unsupported format.",
            };
            return MediaCheck {
                verdict: MediaVerdict::Rejected,
                reasons: vec![reason.to_string()],
                info: None,
            };
        }
    };

    if info.duration_ms == 0 || info.width == 0 || info.height == 0 {
        return MediaCheck {
            verdict: MediaVerdict::Rejected,
            reasons: vec!["This file has no usable video (zero duration or size).".into()],
            info: Some(info),
        };
    }

    let mut reasons = Vec::new();
    let (dw, dh) = info.display_size();

    if info.is_hdr {
        if caps.zscale && caps.tonemap {
            reasons.push("HDR footage will be tone-mapped to SDR.".into());
        } else {
            // Note the specific formula: Homebrew's plain `ffmpeg` does not
            // depend on libzimg, so reinstalling it never adds zscale.
            // `ffmpeg-full` does, and is keg-only so it will not shadow an
            // existing install — point the app at it via "Locate ffmpeg…".
            reasons.push(
                "HDR footage, but this ffmpeg has no zscale (libzimg), so it cannot be tone-mapped \
                 and will look washed out. Install a build that has it — on macOS, \
                 `brew install ffmpeg-full` — then point this app at it."
                    .into(),
            );
        }
    }
    if info.codec == "hevc" {
        reasons.push("HEVC/H.265 decodes fine but encodes more slowly.".into());
    }
    if dw > 2560 || dh > 2560 {
        reasons.push(format!("{dw}×{dh} is large; assembly will take longer."));
    }
    if info.fps > 60.0 {
        reasons.push(format!("{:.0}fps will be resampled to the project frame rate.", info.fps));
    }
    if !info.has_audio {
        reasons.push("No audio track — only the narration will be heard.".into());
    }

    MediaCheck {
        verdict: if reasons.is_empty() { MediaVerdict::Accepted } else { MediaVerdict::Warning },
        reasons,
        info: Some(info),
    }
}

/// Still frame for the clip list.
///
/// Seeks 10% in rather than to frame zero: most footage opens on a black or
/// motion-blurred frame, which makes for a useless thumbnail.
pub fn make_thumbnail(
    ffmpeg: &str,
    media: &Path,
    out: &Path,
    duration_ms: u64,
    width: u32,
) -> Result<(), FfmpegError> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| FfmpegError::new("MKDIR_FAILED", e.to_string()))?;
    }
    let at = (duration_ms as f64 / 1000.0) * 0.10;
    run(
        Command::new(ffmpeg)
            .args(["-y", "-v", "error", "-ss", &format!("{at:.3}")])
            .arg("-i")
            .arg(media)
            .args([
                "-frames:v", "1",
                "-vf", &format!("scale={width}:-2"),
                "-q:v", "3",
            ])
            .arg(out),
        "generate thumbnail",
    )?;
    Ok(())
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
    /// Set from the probe at import. HDR sources need tone mapping or they
    /// come out grey and desaturated.
    pub is_hdr: bool,
}

/// Filter fragment converting HDR to SDR, or empty when it cannot be done well.
///
/// `tonemap` requires **linear light**. `zscale=t=linear` is what provides it,
/// so without libzimg there is no correct way to feed the filter. Running it on
/// non-linear HLG data anyway was measured against real iPhone HDR footage and
/// produced a dark, murky frame — worse than leaving the footage alone, which
/// at least stays bright and recognisable.
///
/// So when zscale is absent we deliberately do nothing and rely on the import
/// warning. A wrong correction that looks deliberate is harder for a user to
/// diagnose than no correction at all.
fn tonemap_chain(caps: &FfmpegCaps) -> &'static str {
    if caps.zscale && caps.tonemap {
        ",zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
    } else {
        ""
    }
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
    caps: &FfmpegCaps,
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

        // trim -> tone map -> normalise geometry -> lock timebase/rate -> hold.
        // Order matters twice over: tone mapping must precede the scale so it
        // works on the original colour data, and tpad must come last or it pads
        // the pre-scaled stream.
        //
        // Rotation needs no filter here: ffmpeg's autorotation applies the
        // display matrix on decode, and that survives filter_complex — verified
        // by `rotation_survives_filter_complex` in the tests.
        filter.push_str(&format!(
            "[{v}:v]trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS{}\
             ,scale={width}:{height}:force_original_aspect_ratio=decrease,\
             pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}",
            it.item.source_in_ms as f64 / 1000.0,
            use_ms as f64 / 1000.0,
            if it.is_hdr { tonemap_chain(caps) } else { "" },
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
    frame_rgb_filter(ffmpeg, media, at_ms, "scale=8:8")
}

/// Average RGB of a rectangular region — used to tell picture from letterbox.
pub fn frame_rgb_region(
    ffmpeg: &str,
    media: &Path,
    at_ms: u64,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<(u8, u8, u8), FfmpegError> {
    frame_rgb_filter(ffmpeg, media, at_ms, &format!("crop={w}:{h}:{x}:{y},scale=1:1"))
}

fn frame_rgb_filter(
    ffmpeg: &str,
    media: &Path,
    at_ms: u64,
    vf: &str,
) -> Result<(u8, u8, u8), FfmpegError> {
    let out = Command::new(ffmpeg)
        .args(["-v", "error", "-ss", &format!("{:.3}", at_ms as f64 / 1000.0)])
        .arg("-i")
        .arg(media)
        .args([
            "-frames:v", "1",
            "-vf", vf,
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

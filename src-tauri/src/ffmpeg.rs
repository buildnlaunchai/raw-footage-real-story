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
    /// libass. Without it nothing can draw text into the picture, so subtitles
    /// can only be written as a file alongside the video.
    ///
    /// Not an incidental gap: Homebrew's plain `ffmpeg` formula is built
    /// without it, so the most ordinary install on macOS cannot burn a single
    /// character. Bengali, Arabic and Thai make it load-bearing rather than a
    /// nicety — they need the shaping and bidi that libass brings with
    /// harfbuzz and fribidi, which no hand-rolled overlay would get right.
    pub subtitles: bool,
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
    FfmpegCaps {
        zscale: has("zscale"),
        tonemap: has("tonemap"),
        subtitles: has("subtitles"),
    }
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
/// ffmpeg-full is keg-only, so Homebrew never links it into `bin` and it can
/// never appear on `PATH`. Without its `opt` path listed here a user could
/// install it on our own advice, hit Re-check, and see nothing change.
#[cfg(target_os = "macos")]
const EXTRA_DIRS: &[&str] = &[
    "/opt/homebrew/opt/ffmpeg-full/bin",
    "/usr/local/opt/ffmpeg-full/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/opt/local/bin",
];
#[cfg(target_os = "windows")]
const EXTRA_DIRS: &[&str] = &[
    r"C:\ffmpeg\bin",
    r"C:\Program Files\ffmpeg\bin",
    r"C:\ProgramData\chocolatey\bin",
];

/// Where Windows package managers actually put ffmpeg.
///
/// The static list above covers a manual unzip and Chocolatey. It misses both
/// of the tools people are most likely to use, which mattered because the setup
/// screen told them to run winget and then could not find what winget installed:
///
/// - **winget** shims into `%LOCALAPPDATA%\Microsoft\WinGet\Links`, and puts
///   the real binary under `…\WinGet\Packages\<id>\ffmpeg-<version>\bin` —
///   a path with a version in it, so it has to be searched rather than named.
/// - **scoop** shims into `%USERPROFILE%\scoop\shims`.
///
/// Home-relative and version-dependent, so this cannot be a list of constants.
#[cfg(target_os = "windows")]
fn user_install_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let winget = PathBuf::from(&local).join("Microsoft").join("WinGet");
        out.push(winget.join("Links"));

        // Packages/<publisher.package>/<ffmpeg-N.N-full_build>/bin — two levels
        // of directory whose names carry a version, so walk rather than guess.
        if let Ok(pkgs) = std::fs::read_dir(winget.join("Packages")) {
            for pkg in pkgs.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()) {
                if let Ok(inner) = std::fs::read_dir(pkg.path()) {
                    for d in inner.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()) {
                        out.push(d.path().join("bin"));
                        out.push(d.path());
                    }
                }
            }
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        out.push(PathBuf::from(&home).join("scoop").join("shims"));
    }
    out
}

#[cfg(not(target_os = "windows"))]
fn user_install_dirs() -> Vec<PathBuf> {
    Vec::new()
}
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

/// A path the user named: `FFMPEG_PATH`, or the binary chosen in the setup
/// screen. Deliberately separate from automatic discovery, because an explicit
/// choice is never second-guessed.
fn resolve_explicit(env_key: &str, saved: Option<&String>) -> Option<PathBuf> {
    if let Ok(p) = std::env::var(env_key) {
        let p = PathBuf::from(p);
        if is_runnable(&p) {
            return Some(p);
        }
    }
    let p = PathBuf::from(saved?);
    is_runnable(&p).then_some(p)
}

/// Every place we look, in order, de-duplicated.
fn candidates(stem: &str) -> Vec<PathBuf> {
    let exe = exe_name(stem);
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            push(dir.join(&exe));
        }
    }
    for dir in user_install_dirs() {
        push(dir.join(&exe));
    }
    for dir in EXTRA_DIRS {
        push(Path::new(dir).join(&exe));
    }
    out
}

fn resolve_auto(stem: &str) -> Option<PathBuf> {
    candidates(stem).into_iter().find(|c| is_runnable(c))
}

/// Find ffmpeg, preferring a build that can actually tone-map HDR.
///
/// An explicit choice always wins outright — silently substituting a different
/// binary than the one a user named would be worse than the problem it solves.
/// A limited explicit choice is reported through [`FfmpegCaps`] instead.
///
/// For automatic discovery only, the most capable build wins. On macOS the
/// common case is Homebrew's `ffmpeg` on PATH — no zscale, no libass —
/// alongside keg-only `ffmpeg-full`, which has both. Picking the former means
/// every HDR clip silently loses its colour and no subtitle can be drawn.
fn resolve_ffmpeg(saved: Option<&String>) -> Option<PathBuf> {
    if let Some(explicit) = resolve_explicit("FFMPEG_PATH", saved) {
        return Some(explicit);
    }

    let mut best: Option<(u8, PathBuf)> = None;
    for candidate in candidates("ffmpeg") {
        if !is_runnable(&candidate) {
            continue;
        }
        let caps = probe_caps(&candidate);
        let score = u8::from(caps.zscale) + u8::from(caps.subtitles);
        // Nothing scores higher, so stop paying for probes.
        if score == 2 {
            return Some(candidate);
        }
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, candidate));
        }
    }
    best.map(|(_, p)| p)
}

pub fn detect(settings: &FfmpegSettings) -> Result<FfmpegInfo, FfmpegError> {
    let ffmpeg = resolve_ffmpeg(settings.ffmpeg_path.as_ref()).ok_or_else(|| {
        FfmpegError::new("FFMPEG_NOT_FOUND", "Could not find a working ffmpeg binary.")
    })?;
    // ffprobe must come from the same install as the chosen ffmpeg, so the
    // sibling is tried first — a mismatched pair can disagree about what a file
    // even contains.
    let sibling = ffmpeg.parent().map(|d| d.join(exe_name("ffprobe")));
    let ffprobe = sibling
        .filter(|p| is_runnable(p))
        .or_else(|| resolve_explicit("FFPROBE_PATH", settings.ffprobe_path.as_ref()))
        .or_else(|| resolve_auto("ffprobe"))
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
    // A tenth in: far enough past a fade-up or a black first frame to show
    // something, early enough to still be the shot the clip is about.
    grab_frame(ffmpeg, media, out, duration_ms / 10, width)
}

/// One frame at a chosen moment, written as an image.
///
/// Separate from `make_thumbnail` because a poster is chosen by a person
/// scrubbing to a frame they like, not by a rule of thumb.
pub fn grab_frame(
    ffmpeg: &str,
    media: &Path,
    out: &Path,
    at_ms: u64,
    width: u32,
) -> Result<(), FfmpegError> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| FfmpegError::new("MKDIR_FAILED", e.to_string()))?;
    }
    let at = at_ms as f64 / 1000.0;
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
        "grab frame",
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
    /// Crossfade between clips, in milliseconds. Zero means hard cuts, which
    /// stays the default: the original scope called for cuts only, and a
    /// dissolve is a stylistic choice rather than an improvement.
    #[serde(default)]
    pub crossfade_ms: u32,
    /// Crossfade from the opening montage into the first narrated line.
    ///
    /// Separate from `crossfade_ms` because the montage is cut hard inside
    /// itself whatever the rest of the film does; this is the one dissolve that
    /// is part of the opening rather than a style choice.
    ///
    /// Non-zero only when item zero really is an intro. Setting it otherwise
    /// dissolves the first two clips of an ordinary cut.
    #[serde(default)]
    pub intro_fade_ms: u32,
    /// Optional music bed mixed under the narration.
    #[serde(default)]
    pub music_path: Option<String>,
    /// Music level relative to full scale. Low by default: a bed that competes
    /// with the voice defeats the point of the voice.
    #[serde(default = "default_music_gain")]
    pub music_gain: f32,
    /// A subtitle file to burn into the picture.
    ///
    /// The file is written whatever this is set to — it is useful on its own,
    /// and every site accepts one as an upload. This is only about drawing the
    /// words into the frames, which needs a build with libass.
    #[serde(default)]
    pub subtitle_path: Option<String>,
}

fn default_music_gain() -> f32 {
    0.10
}

impl Default for RenderSettings {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30,
            crossfade_ms: 0,
            // Zero by default, and set only when an intro has actually been
            // prepended. Defaulting it to a real duration made every hard-cut
            // render take the intro path and swallow half a second at the first
            // boundary — "there is an intro" and "fade at boundary zero" have
            // to be the same fact, or they drift apart.
            intro_fade_ms: 0,
            music_path: None,
            music_gain: default_music_gain(),
            subtitle_path: None,
        }
    }
}

/// Longest crossfade that still leaves a slot with picture of its own.
///
/// A dissolve consumes time from both neighbours, so on a short slot two
/// overlapping fades can leave no un-faded frames at all — the shot never
/// resolves. Capping at a third of the shortest slot keeps every clip visible
/// as itself.
pub fn clamp_crossfade(requested_ms: u32, items: &[RenderItem]) -> u32 {
    if requested_ms == 0 || items.len() < 2 {
        return 0;
    }
    let shortest = items
        .iter()
        .map(|i| i.item.timeline_duration_ms)
        .min()
        .unwrap_or(0);
    requested_ms.min((shortest / 3) as u32).min(1_500)
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

    let RenderSettings { width, height, fps, .. } = *settings;
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

        // trim -> tone map -> stretch -> normalise geometry -> lock rate.
        // Order matters twice over: tone mapping must precede the scale so it
        // works on the original colour data, and the stretch must precede `fps`
        // so the frame rate filter fills in the intermediate frames rather than
        // stretching a stream that has already been locked.
        //
        // Rotation needs no filter here: ffmpeg's autorotation applies the
        // display matrix on decode, and that survives filter_complex — verified
        // by `rotation_survives_filter_complex` in the tests.
        filter.push_str(&format!(
            "[{v}:v]trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS{}{}\
             ,scale={width}:{height}:force_original_aspect_ratio=decrease,\
             pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}",
            it.item.source_in_ms as f64 / 1000.0,
            use_ms as f64 / 1000.0,
            if it.is_hdr { tonemap_chain(caps) } else { "" },
            // Slowed rather than frozen when the line outruns the footage.
            // `setpts` multiplies each timestamp, so a stretch of 1.4 makes the
            // clip take 1.4x as long; `fps` afterwards interpolates the gaps so
            // the result is smooth rather than a slideshow.
            // Any fit that carries a stretch, not just `Slowed`: a shot that
            // hit the cap is slowed *and* replayed, and testing for one fit by
            // name meant a capped shot was replayed at full speed and came out
            // short of its own narration.
            if it.item.stretch > 1.0 {
                format!(",setpts={:.4}*PTS", it.item.stretch)
            } else {
                String::new()
            },
        ));

        // `settb` below matters even when nothing fades: the intro path joins a
        // concat output (microsecond timebase) to a raw stream at an xfade, and
        // ffmpeg refuses unless both agree —
        //   "First input link main timebase (1/30) do not match the
        //    corresponding second input link xfade timebase (1/1000000)"
        filter.push_str(&format!("[seg{i}];"));

        // A shot the cap would not let cover its line is shown again rather
        // than crawling or freezing. `split` then `concat` repeats the trimmed
        // segment itself — looping the *input* would replay the whole file,
        // which for a moment taken from the middle of a long clip is different
        // footage, not the same shot again.
        let plays = it.item.fit.plays(
            it.item.timeline_duration_ms,
            use_ms,
            it.item.stretch,
        );
        if plays > 1 {
            filter.push_str(&format!("[seg{i}]split={plays}"));
            for r in 0..plays {
                filter.push_str(&format!("[rep{i}_{r}]"));
            }
            filter.push(';');
            for r in 0..plays {
                filter.push_str(&format!("[rep{i}_{r}]"));
            }
            filter.push_str(&format!("concat=n={plays}:v=1:a=0[shot{i}];"));
        } else {
            filter.push_str(&format!("[seg{i}]null[shot{i}];"));
        }

        // Guarantee the exact slot length regardless of rounding in the
        // filters, and hand on a timebase the intro's xfade can join.
        filter.push_str(&format!(
            "[shot{i}]trim=duration={total_s:.3},setpts=PTS-STARTPTS,settb=1/{fps}[v{i}];"
        ));

        // Narration, resampled and padded with silence to fill the same slot.
        filter.push_str(&format!(
            "[{a}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
             apad,atrim=duration={total_s:.3},asetpts=PTS-STARTPTS[a{i}];"
        ));
    }

    let fade_ms = clamp_crossfade(settings.crossfade_ms, items);

    // Three shapes, not two. The third exists because the opening montage wants
    // hard cuts everywhere except the one boundary where it dissolves into the
    // first narrated line.
    let intro_fade_ms = clamp_crossfade(settings.intro_fade_ms, items);
    let intro_only_fade = fade_ms == 0 && intro_fade_ms > 0 && items.len() > 1;

    let (vout, aout) = if intro_only_fade {
        // Body concatenated as one stream, then crossfaded with the intro.
        // Verified against real ffmpeg before it was written: duration exact,
        // and sampled pixels mid-transition are a genuine blend rather than a
        // cut.
        let d = intro_fade_ms as f64 / 1000.0;
        for i in 1..items.len() {
            filter.push_str(&format!("[v{i}][a{i}]"));
        }
        filter.push_str(&format!("concat=n={}:v=1:a=1[bodyv][bodya];", items.len() - 1));
        filter.push_str(&format!("[bodyv]settb=1/{fps}[bodyv2];"));
        let offset = items[0].item.timeline_duration_ms as f64 / 1000.0 - d;
        filter.push_str(&format!(
            "[v0][bodyv2]xfade=transition=fade:duration={d:.3}:offset={offset:.3}[outv];"
        ));
        filter.push_str(&format!("[a0][bodya]acrossfade=d={d:.3}[outa];"));
        ("[outv]".to_string(), "[outa]".to_string())
    } else if fade_ms == 0 {
        // Hard cuts: one concat handles both streams and keeps them locked.
        for i in 0..items.len() {
            filter.push_str(&format!("[v{i}][a{i}]"));
        }
        filter.push_str(&format!("concat=n={}:v=1:a=1[outv][outa];", items.len()));
        ("[outv]".to_string(), "[outa]".to_string())
    } else {
        // Crossfade: chain xfade/acrossfade pairwise. Both streams get the same
        // fade so audio and video stay locked; the overlap lands in the tail
        // after the last word, which is why the tail exists.
        let mut offset = 0f64;
        let mut vprev = "v0".to_string();
        let mut aprev = "a0".to_string();
        for i in 1..items.len() {
            // The first boundary is the intro's own dissolve when there is an
            // intro. Without this it would silently take the body's crossfade
            // setting, which makes the opening a style choice — and the whole
            // reason `intro_fade_ms` is a separate field is that it is not.
            let d = if i == 1 && intro_fade_ms > 0 { intro_fade_ms } else { fade_ms } as f64
                / 1000.0;
            // Each fade overlaps the streams, so every subsequent offset is
            // reduced by all the overlap consumed so far.
            offset += items[i - 1].item.timeline_duration_ms as f64 / 1000.0 - d;
            let (vn, an) = (format!("xv{i}"), format!("xa{i}"));
            filter.push_str(&format!(
                "[{vprev}][v{i}]xfade=transition=fade:duration={d:.3}:offset={offset:.3}[{vn}];"
            ));
            filter.push_str(&format!("[{aprev}][a{i}]acrossfade=d={d:.3}[{an}];"));
            vprev = vn;
            aprev = an;
        }
        (format!("[{vprev}]"), format!("[{aprev}]"))
    };

    // Subtitles last, so they are drawn over the finished picture rather than
    // into a shot that a later dissolve then fades out from under them.
    //
    // The file is named without a path and ffmpeg is run from the directory it
    // sits in. The filter parses its own argument, so a Windows drive letter or
    // any of the punctuation macOS allows in a folder name would otherwise have
    // to be escaped twice over — and getting that wrong fails at render time,
    // on someone else's machine, with a parse error about a colon.
    let vout = match settings.subtitle_path.as_deref().filter(|p| Path::new(p).is_file()) {
        None => vout,
        Some(subs) => {
            let path = Path::new(subs);
            if let Some(dir) = path.parent() {
                cmd.current_dir(dir);
            }
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            // Sized from the frame rather than fixed: 24pt is unreadable on a
            // phone-shot 1080-wide portrait clip and enormous on a 4K one.
            let font = (height as f64 / 22.0).round().max(16.0) as u32;
            filter.push_str(&format!(
                "{vout}subtitles=filename={name}:force_style='FontSize={font},\
                 PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,\
                 Outline=2,Shadow=1,MarginV={}'[subv];",
                (height as f64 / 18.0).round().max(12.0) as u32,
            ));
            "[subv]".to_string()
        }
    };

    // Optional music bed under the narration.
    let aout = match settings.music_path.as_deref().filter(|p| Path::new(p).is_file()) {
        None => aout,
        Some(music) => {
            cmd.arg("-stream_loop").arg("-1").arg("-i").arg(music);
            let music_idx = items.len() * 2;
            let gain = settings.music_gain.clamp(0.0, 1.0);
            filter.push_str(&format!(
                "[{music_idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
                 volume={gain:.3},afade=t=in:d=1.5[mus];"
            ));
            // duration=first keeps the mix as long as the narration; the looped
            // music is trimmed to it rather than extending the film.
            filter.push_str(&format!("{aout}[mus]amix=inputs=2:duration=first:dropout_transition=0[mixa];"));
            "[mixa]".to_string()
        }
    };

    let filter = filter.trim_end_matches(';').to_string();
    cmd.args(["-filter_complex", &filter]);
    cmd.args([
        "-map", &vout, "-map", &aout,
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

/// One shot of the opening montage.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntroShot {
    pub source_path: String,
    pub source_in_ms: u64,
    pub duration_ms: u64,
    #[serde(default)]
    pub is_hdr: bool,
}

/// Render the opening montage to its own file.
///
/// Its own pass on purpose. The montage wants hard cuts between shots — that is
/// what makes it a montage — but the main graph applies one crossfade setting to
/// every boundary, and `acrossfade` across a cut inside a spoken line would
/// dissolve the middle of a word. Rendering it separately makes the montage
/// immune to that setting, and it enters the main timeline as one ordinary item
/// with one video and one audio track, exactly like a placeholder does.
///
/// The hook narration plays over the whole thing, so the audio here is the hook
/// file trimmed to the montage's length rather than anything per-shot.
pub fn render_intro(
    ffmpeg: &str,
    shots: &[IntroShot],
    hook_audio: &Path,
    settings: &RenderSettings,
    caps: &FfmpegCaps,
    out: &Path,
) -> Result<u64, FfmpegError> {
    if shots.is_empty() {
        return Err(FfmpegError::new("NO_SHOTS", "The intro has no shots to show."));
    }
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| FfmpegError::new("MKDIR_FAILED", e.to_string()))?;
    }

    let RenderSettings { width, height, fps, .. } = *settings;
    let total_ms: u64 = shots.iter().map(|s| s.duration_ms).sum();
    let total_s = total_ms as f64 / 1000.0;

    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-y", "-v", "error"]);
    for s in shots {
        cmd.arg("-i").arg(&s.source_path);
    }
    cmd.arg("-i").arg(hook_audio);

    let mut filter = String::new();
    for (i, s) in shots.iter().enumerate() {
        filter.push_str(&format!(
            "[{i}:v]trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS{}\
             ,scale={width}:{height}:force_original_aspect_ratio=decrease,\
             pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},settb=1/{fps}[v{i}];",
            s.source_in_ms as f64 / 1000.0,
            s.duration_ms as f64 / 1000.0,
            if s.is_hdr { tonemap_chain(caps) } else { "" },
        ));
    }
    for i in 0..shots.len() {
        filter.push_str(&format!("[v{i}]"));
    }
    filter.push_str(&format!("concat=n={}:v=1:a=0[mv];", shots.len()));
    // A shot shorter than its slot (a clip that ends early) would leave the
    // montage short, so the whole thing is trimmed to the length the hook needs.
    filter.push_str(&format!("[mv]trim=duration={total_s:.3},setpts=PTS-STARTPTS[outv];"));

    let hook_idx = shots.len();
    filter.push_str(&format!(
        "[{hook_idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
         apad,atrim=duration={total_s:.3},asetpts=PTS-STARTPTS[outa]"
    ));

    cmd.args(["-filter_complex", &filter]);
    cmd.args(["-map", "[outv]", "-map", "[outa]"]);
    cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]);
    cmd.args(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]);
    cmd.arg(out);

    run(&mut cmd, "render intro")?;
    Ok(total_ms)
}

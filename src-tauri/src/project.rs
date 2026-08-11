//! The project file — a clip library plus the videos cut from it.
//!
//! Also the contract with the v2 web timeline editor, so it is versioned and
//! documented in `docs/project-file.md`.
//!
//! Two principles govern the shape:
//!
//! 1. **The timeline is stored explicitly, never derived.** If the editor
//!    recomputed our reconciliation, any later change to those rules would
//!    silently move every project already exported.
//! 2. **A project is a library, not a video.** Footage is imported once and
//!    described once; any number of videos can then be cut from it. Each video
//!    owns its own selection, script, audio and render.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::ffmpeg::RenderSettings;
use crate::timeline::TimelineItem;

/// v2 introduced timestamped segments and multiple videos per project.
///
/// This is a deliberate breaking change from v1, which had one flat
/// description per clip and one video per project. v1 had no users, and
/// carrying a compatibility shim for a format nobody had written would have
/// cost more than it saved. v1 files are migrated on load rather than rejected,
/// so anything produced during development still opens.
pub const SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub slug: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    /// Cover image for the gallery, inside the project folder.
    ///
    /// Optional and defaulted, so projects written before posters existed load
    /// unchanged and gain one the first time anybody sets it.
    #[serde(default)]
    pub poster_path: Option<String>,
}

/// A described moment inside a clip.
///
/// Segments are what later stages actually reason over: a story can pull the
/// eight seconds of a plane landing without dragging in the ninety seconds of
/// taxiing that follow it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
}

impl Segment {
    pub fn duration_ms(&self) -> u64 {
        (((self.end_sec - self.start_sec).max(0.0)) * 1000.0).round() as u64
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectClip {
    pub id: String,
    /// Relative to the project file when inside it, absolute when referenced.
    pub source_path: Option<String>,
    pub sha256: Option<String>,
    pub source_duration_ms: Option<u64>,
    pub is_placeholder: bool,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub thumbnail_path: Option<String>,
    #[serde(default)]
    pub is_hdr: bool,
    /// Ordered by `start_sec`. Empty until the clip has been described.
    #[serde(default)]
    pub segments: Vec<Segment>,
}

impl ProjectClip {
    /// Everything said about this clip, for prompts that want one blob.
    pub fn combined_text(&self) -> String {
        self.segments
            .iter()
            .map(|s| s.text.trim())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join(". ")
    }

    pub fn is_described(&self) -> bool {
        self.segments.iter().any(|s| !s.text.trim().is_empty())
    }
}

/// One segment chosen for one video, in story order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedSegment {
    pub clip_id: String,
    /// Index into that clip's `segments`.
    pub segment_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptLineRecord {
    pub clip_id: String,
    #[serde(default)]
    pub segment_index: usize,
    pub text: String,
    /// True once the user has edited this line by hand, so regeneration can
    /// warn before overwriting deliberate work.
    #[serde(default)]
    pub edited: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSection {
    pub model: String,
    pub generated_at: String,
    pub lines: Vec<ScriptLineRecord>,
    #[serde(default)]
    pub word_count_target: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLineRecord {
    pub clip_id: String,
    #[serde(default)]
    pub segment_index: usize,
    pub path: String,
    pub duration_ms: u64,
    pub skipped_words: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSection {
    pub voice: String,
    pub sample_rate: u32,
    pub lines: Vec<AudioLineRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSection {
    #[serde(flatten)]
    pub settings: RenderSettings,
    pub vcodec: String,
    pub acodec: String,
    pub output_path: Option<String>,
}

/// One video cut from the library.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProject {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    /// The chosen segments, in the order the story wants them.
    #[serde(default)]
    pub selection: Vec<SelectedSegment>,
    pub script: Option<ScriptSection>,
    pub audio: Option<AudioSection>,
    #[serde(default)]
    pub timeline: Vec<TimelineItem>,
    pub render: Option<RenderSection>,
    /// Word -> phoneme or replacement text, for words the phonemiser cannot
    /// pronounce. Lives per video because a correction is a creative choice
    /// about this narration, not a fact about the footage.
    #[serde(default)]
    pub pronunciations: BTreeMap<String, String>,
}

impl VideoProject {
    pub fn new(id: String, title: String, now: String) -> Self {
        Self {
            id,
            title,
            created_at: now.clone(),
            updated_at: now,
            selection: Vec::new(),
            script: None,
            audio: None,
            timeline: Vec::new(),
            render: None,
            pronunciations: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub schema_version: u32,
    pub app: AppInfo,
    pub project: ProjectMeta,
    /// The clip library. Described once, reused by every video.
    pub clips: Vec<ProjectClip>,
    #[serde(default)]
    pub videos: Vec<VideoProject>,
}

impl ProjectFile {
    pub fn new(id: String, name: String, now: String) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            app: AppInfo {
                slug: "raw-footage-real-story".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            project: ProjectMeta {
                id,
                name,
                created_at: now.clone(),
                updated_at: now,
                poster_path: None,
            },
            clips: Vec::new(),
            videos: Vec::new(),
        }
    }

    pub fn segment_count(&self) -> usize {
        self.clips.iter().map(|c| c.segments.len()).sum()
    }

    pub fn video(&self, id: &str) -> Option<&VideoProject> {
        self.videos.iter().find(|v| v.id == id)
    }

    pub fn video_mut(&mut self, id: &str) -> Option<&mut VideoProject> {
        self.videos.iter_mut().find(|v| v.id == id)
    }
}

// ---------------------------------------------------------------------------
// Loading, with migration from v1
// ---------------------------------------------------------------------------

/// Read a project, upgrading a v1 file in memory if needed.
///
/// v1 stored one flat `description` per clip and a single script/audio/timeline
/// at project level. Both map cleanly onto v2: the description becomes a single
/// segment spanning the whole clip, and the video becomes the project's first
/// and only `VideoProject`.
pub fn load(path: &Path) -> Result<ProjectFile, String> {
    let raw = std::fs::read(path).map_err(|e| format!("read project: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|e| format!("parse project: {e}"))?;

    let version = value["schemaVersion"].as_u64().unwrap_or(0) as u32;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "This project was written by a newer version of the app (schema v{version}); \
             this build understands up to v{SCHEMA_VERSION}."
        ));
    }
    if version == SCHEMA_VERSION {
        return serde_json::from_value(value).map_err(|e| format!("parse project: {e}"));
    }
    migrate_v1(value)
}

fn migrate_v1(value: serde_json::Value) -> Result<ProjectFile, String> {
    let meta: ProjectMeta = serde_json::from_value(value["project"].clone())
        .map_err(|e| format!("v1 project meta: {e}"))?;

    let empty = vec![];
    let clips = value["clips"].as_array().unwrap_or(&empty);
    let mut out_clips = Vec::with_capacity(clips.len());

    for c in clips {
        let duration = c["sourceDurationMs"].as_u64();
        let description = c["description"].as_str().unwrap_or("").trim().to_string();
        // One segment spanning the whole clip preserves the v1 meaning exactly.
        let segments = if description.is_empty() {
            Vec::new()
        } else {
            vec![Segment {
                start_sec: 0.0,
                end_sec: duration.unwrap_or(0) as f64 / 1000.0,
                text: description,
            }]
        };
        out_clips.push(ProjectClip {
            id: c["id"].as_str().unwrap_or_default().to_string(),
            source_path: c["sourcePath"].as_str().map(str::to_string),
            sha256: c["sha256"].as_str().map(str::to_string),
            source_duration_ms: duration,
            is_placeholder: c["isPlaceholder"].as_bool().unwrap_or(false),
            file_name: None,
            thumbnail_path: None,
            is_hdr: false,
            segments,
        });
    }

    // The single v1 video, if it got as far as having a script.
    let mut videos = Vec::new();
    if value["script"].is_object() {
        let mut video = VideoProject::new(
            format!("{}-v1", meta.id),
            "Untitled video".into(),
            meta.created_at.clone(),
        );
        video.script = serde_json::from_value(value["script"].clone()).ok();
        video.audio = serde_json::from_value(value["audio"].clone()).ok();
        video.timeline = serde_json::from_value(value["timeline"].clone()).unwrap_or_default();
        video.render = serde_json::from_value(value["render"].clone()).ok();
        video.selection = video
            .timeline
            .iter()
            .map(|t| SelectedSegment { clip_id: t.clip_id.clone(), segment_index: 0 })
            .collect();
        videos.push(video);
    }

    Ok(ProjectFile {
        schema_version: SCHEMA_VERSION,
        app: AppInfo {
            slug: "raw-footage-real-story".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
        project: meta,
        clips: out_clips,
        videos,
    })
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn write_json(project: &ProjectFile, path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(project)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // Write-then-rename so an interrupted save cannot leave a truncated project
    // behind — losing a described 300-clip library to a crash would be brutal.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}

fn add_dir_to_zip<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    dir: &Path,
    prefix: &str,
    opts: zip::write::SimpleFileOptions,
) -> std::io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            add_dir_to_zip(zip, &path, &format!("{prefix}{name}/"), opts)?;
        } else {
            zip.start_file(format!("{prefix}{name}"), opts)?;
            let mut f = std::fs::File::open(&path)?;
            std::io::copy(&mut f, zip)?;
        }
    }
    Ok(())
}

/// Self-contained `.zip` of the project: media, audio, render and manifest.
///
/// Media is *referenced* while editing, not copied, so a working project.json
/// can hold absolute paths to files anywhere on disk. Those files are copied in
/// here and the manifest rewritten as it goes, so the bundle always satisfies
/// the "every path is relative" invariant the format promises.
pub fn write_bundle(project_dir: &Path, out_zip: &Path) -> std::io::Result<()> {
    if let Some(parent) = out_zip.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = std::fs::File::create(out_zip)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let manifest_path = project_dir.join("project.json");
    let mut external: Vec<(String, PathBuf)> = Vec::new();

    let manifest_json = if manifest_path.is_file() {
        let raw = std::fs::read(&manifest_path)?;
        match serde_json::from_slice::<ProjectFile>(&raw) {
            Ok(mut manifest) => {
                for (i, clip) in manifest.clips.iter_mut().enumerate() {
                    let Some(src) = clip.source_path.clone() else { continue };
                    let p = Path::new(&src);
                    if !p.is_absolute() {
                        continue;
                    }
                    let name = p
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| format!("clip-{i:03}"));
                    let entry = format!("clips/{i:03}-{name}");
                    if p.is_file() {
                        external.push((entry.clone(), p.to_path_buf()));
                        clip.source_path = Some(entry);
                    } else {
                        clip.source_path = None;
                    }
                }
                serde_json::to_vec_pretty(&manifest).unwrap_or(raw)
            }
            Err(_) => raw,
        }
    } else {
        Vec::new()
    };

    if !manifest_json.is_empty() {
        zip.start_file("project.json", opts)?;
        zip.write_all(&manifest_json)?;
    }

    for sub in ["clips", "audio", "render", "thumbs"] {
        add_dir_to_zip(&mut zip, &project_dir.join(sub), &format!("{sub}/"), opts)?;
    }

    for (entry, src) in external {
        zip.start_file(&entry, opts)?;
        let mut f = std::fs::File::open(&src)?;
        std::io::copy(&mut f, &mut zip)?;
    }

    zip.finish()?;
    Ok(())
}

/// Path relative to the project directory, using forward slashes so a bundle
/// written on Windows still resolves in a browser.
pub fn relative_to(base: &Path, path: &Path) -> String {
    let rel: PathBuf = path.strip_prefix(base).unwrap_or(path).to_path_buf();
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

//! Project persistence: create, save, open, and the recent-projects list.
//!
//! A project is a directory under app data, holding the manifest plus the
//! generated media that belongs to it:
//!
//! ```text
//! projects/<id>/
//!   project.json     the library and its videos
//!   clips/           placeholder or consolidated media
//!   thumbs/          clip thumbnails
//!   audio/           narration WAVs, one per line per video
//!   render/          rendered rough cuts
//! ```
//!
//! The manifest is written whole on every save. That is a deliberate choice
//! rather than an oversight: at the scale this app targets (~300 clips with
//! segment descriptions) the file is small enough that a single read or write
//! is imperceptible, and a single JSON document is far easier to reason about,
//! diff and hand to the v2 editor than a sharded store. See
//! `store_tests::measures_manifest_size_at_scale` for the numbers this claim
//! rests on.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::project::{self, ProjectFile};

#[derive(Debug, Serialize)]
pub struct StoreError {
    pub code: String,
    pub message: String,
}

impl StoreError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

/// One row in the "recent projects" list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    /// Cover image, if one was set.
    pub poster_path: Option<String>,
    /// Clip stills, for a gallery card with no poster.
    pub thumbnails: Vec<String>,
    /// Clip media, in order, so the gallery can play a project as a reel.
    pub preview_paths: Vec<String>,
    pub updated_at: String,
    pub clip_count: usize,
    pub segment_count: usize,
    pub video_count: usize,
    pub described_clip_count: usize,
}

pub fn projects_root(app: &AppHandle) -> Result<PathBuf, StoreError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| StoreError::new("NO_APP_DIR", e.to_string()))?;
    let dir = base.join("projects");
    std::fs::create_dir_all(&dir)
        .map_err(|e| StoreError::new("MKDIR_FAILED", format!("{}: {e}", dir.display())))?;
    Ok(dir)
}

/// Project ids come from the frontend, so keep them to a charset that cannot
/// escape the projects directory.
pub fn safe_id(id: &str) -> Result<String, StoreError> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err(StoreError::new("BAD_PROJECT_ID", "project id has no usable characters"));
    }
    Ok(safe)
}

pub fn project_dir(app: &AppHandle, id: &str) -> Result<PathBuf, StoreError> {
    Ok(projects_root(app)?.join(safe_id(id)?))
}

pub fn manifest_path(app: &AppHandle, id: &str) -> Result<PathBuf, StoreError> {
    Ok(project_dir(app, id)?.join("project.json"))
}

pub fn summarise(p: &ProjectFile) -> ProjectSummary {
    ProjectSummary {
        id: p.project.id.clone(),
        name: p.project.name.clone(),
        poster_path: p.project.poster_path.clone(),
        thumbnails: p
            .clips
            .iter()
            .filter_map(|c| c.thumbnail_path.clone())
            .take(6)
            .collect(),
        preview_paths: p
            .clips
            .iter()
            .filter_map(|c| c.source_path.clone())
            .collect(),
        updated_at: p.project.updated_at.clone(),
        clip_count: p.clips.len(),
        segment_count: p.segment_count(),
        video_count: p.videos.len(),
        described_clip_count: p.clips.iter().filter(|c| c.is_described()).count(),
    }
}

pub fn save_to(path: &Path, manifest: &ProjectFile) -> Result<(), StoreError> {
    project::write_json(manifest, path)
        .map_err(|e| StoreError::new("SAVE_FAILED", format!("{}: {e}", path.display())))
}

pub fn load_from(path: &Path) -> Result<ProjectFile, StoreError> {
    project::load(path).map_err(|e| StoreError::new("LOAD_FAILED", e))
}

/// Scan the projects directory. The list is rebuilt from the manifests rather
/// than kept in a side index, so it can never disagree with what is on disk —
/// a stale index pointing at a deleted project is a worse failure than a
/// directory scan that takes a few milliseconds.
pub fn list_projects(app: &AppHandle) -> Result<Vec<ProjectSummary>, StoreError> {
    let root = projects_root(app)?;
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let manifest = entry.path().join("project.json");
        if !manifest.is_file() {
            continue;
        }
        if let Ok(p) = project::load(&manifest) {
            out.push(summarise(&p));
        }
    }
    // Most recently touched first.
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn project_create(
    app: AppHandle,
    id: String,
    name: String,
    now: String,
) -> Result<ProjectFile, StoreError> {
    let dir = project_dir(&app, &id)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| StoreError::new("MKDIR_FAILED", format!("{}: {e}", dir.display())))?;
    let manifest = ProjectFile::new(safe_id(&id)?, name, now);
    save_to(&dir.join("project.json"), &manifest)?;
    Ok(manifest)
}

#[tauri::command]
pub fn project_save(
    app: AppHandle,
    manifest: ProjectFile,
    now: String,
) -> Result<ProjectSummary, StoreError> {
    let mut manifest = manifest;
    manifest.project.updated_at = now;
    manifest.schema_version = project::SCHEMA_VERSION;
    let path = manifest_path(&app, &manifest.project.id)?;
    save_to(&path, &manifest)?;
    Ok(summarise(&manifest))
}

#[tauri::command]
pub fn project_open(app: AppHandle, id: String) -> Result<ProjectFile, StoreError> {
    let path = manifest_path(&app, &id)?;
    if !path.is_file() {
        return Err(StoreError::new("NOT_FOUND", format!("no project at {}", path.display())));
    }
    load_from(&path)
}

#[tauri::command]
pub fn project_list(app: AppHandle) -> Result<Vec<ProjectSummary>, StoreError> {
    list_projects(&app)
}

#[tauri::command]
pub fn project_delete(app: AppHandle, id: String) -> Result<(), StoreError> {
    let dir = project_dir(&app, &id)?;
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| StoreError::new("DELETE_FAILED", format!("{}: {e}", dir.display())))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Posters
// ---------------------------------------------------------------------------

/// Where a project's cover image lives.
fn poster_dest(app: &AppHandle, id: &str, ext: &str) -> Result<PathBuf, StoreError> {
    Ok(project_dir(app, id)?.join(format!("poster.{ext}")))
}

/// Rewrite just the poster on an already-saved project.
///
/// Loads and saves rather than taking the manifest from the frontend: the
/// gallery has a summary, not a whole project, and sending one back to be
/// written would let a stale copy overwrite newer work.
fn set_poster(app: &AppHandle, id: &str, poster: Option<String>) -> Result<(), StoreError> {
    let manifest_path = project_dir(app, id)?.join("project.json");
    let mut manifest = load_from(&manifest_path)?;
    manifest.project.poster_path = poster;
    save_to(&manifest_path, &manifest)
}

/// Use a frame of a clip as the project's cover.
#[tauri::command]
pub fn project_poster_from_frame(
    app: AppHandle,
    id: String,
    source_path: String,
    at_ms: u64,
) -> Result<String, StoreError> {
    let info = crate::ffmpeg::detect(&crate::ffmpeg::FfmpegSettings::default())
        .map_err(|e| StoreError::new("NO_FFMPEG", e.message))?;
    let dest = poster_dest(&app, &id, "jpg")?;
    crate::ffmpeg::grab_frame(&info.ffmpeg, Path::new(&source_path), &dest, at_ms, 1280)
        .map_err(|e| StoreError::new("FRAME_FAILED", e.message))?;
    let path = dest.to_string_lossy().to_string();
    set_poster(&app, &id, Some(path.clone()))?;
    Ok(path)
}

/// Use an image the user picked as the project's cover.
#[tauri::command]
pub fn project_poster_from_image(
    app: AppHandle,
    id: String,
    source_path: String,
) -> Result<String, StoreError> {
    let src = Path::new(&source_path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| matches!(e.as_str(), "jpg" | "jpeg" | "png" | "webp"))
        .ok_or_else(|| {
            StoreError::new("BAD_IMAGE", "Choose a JPEG, PNG or WebP image.")
        })?;
    let dest = poster_dest(&app, &id, &ext)?;
    // Copied into the project rather than referenced: a cover that vanishes
    // when the user tidies their Downloads folder is worse than none.
    std::fs::copy(src, &dest)
        .map_err(|e| StoreError::new("COPY_FAILED", format!("{}: {e}", src.display())))?;
    let path = dest.to_string_lossy().to_string();
    set_poster(&app, &id, Some(path.clone()))?;
    Ok(path)
}

#[tauri::command]
pub fn project_clear_poster(app: AppHandle, id: String) -> Result<(), StoreError> {
    set_poster(&app, &id, None)
}

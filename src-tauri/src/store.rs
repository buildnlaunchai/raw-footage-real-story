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
    let mut file = load_from(&path)?;
    absolutise(&mut file, &project_dir(&app, &id)?);
    Ok(file)
}

/// Turn the manifest's stored paths into ones the app can open directly.
///
/// Media that lives inside the project is written down relative to it, so a
/// project folder can be moved without every path in it going stale. Media
/// that lives elsewhere — the user's own footage — is stored absolute, because
/// there is nothing to be relative to. The reader should not have to know
/// which is which, and until now it did: narration recordings came back as
/// `audio/line-01.wav`, which is not something a webview can load, so playing
/// a line worked right after recording it and silently did nothing once the
/// project had been closed and reopened.
#[cfg(test)]
pub fn absolutise_for_test(file: &mut ProjectFile, dir: &Path) {
    absolutise(file, dir);
}

fn absolutise(file: &mut ProjectFile, dir: &Path) {
    let fix = |p: &mut String| {
        if !p.is_empty() && Path::new(&*p).is_relative() {
            *p = dir.join(&*p).to_string_lossy().into_owned();
        }
    };
    for video in &mut file.videos {
        if let Some(audio) = video.audio.as_mut() {
            for line in &mut audio.lines {
                fix(&mut line.path);
            }
        }
        if let Some(render) = video.render.as_mut() {
            if let Some(out) = render.output_path.as_mut() {
                fix(out);
            }
        }
    }
    for take in &mut file.takes {
        for line in &mut take.audio {
            fix(&mut line.path);
        }
    }
    for clip in &mut file.clips {
        if let Some(src) = clip.source_path.as_mut() {
            fix(src);
        }
        if let Some(thumb) = clip.thumbnail_path.as_mut() {
            fix(thumb);
        }
    }
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

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    /// Everything the app itself wrote: manifests, thumbnails, narration, cuts.
    pub app_bytes: u64,
    /// Source footage the library points at. Not the app's to delete.
    pub footage_bytes: u64,
    /// Volume capacity, when it could be read. `None` on platforms where this
    /// is not implemented, so the UI can show sizes without inventing a total.
    pub disk_total_bytes: Option<u64>,
    pub disk_free_bytes: Option<u64>,
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(|e| e.ok())
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// Volume capacity and free space.
///
/// Shelling out to `df` rather than taking a dependency for two numbers. It is
/// absent on Windows, and the return type says so rather than guessing — an
/// invented capacity would make the bar a decoration that looks like a fact.
#[cfg(unix)]
fn disk_stats(path: &Path) -> (Option<u64>, Option<u64>) {
    let Ok(out) = std::process::Command::new("df").arg("-k").arg(path).output() else {
        return (None, None);
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let Some(line) = text.lines().nth(1) else {
        return (None, None);
    };
    let cols: Vec<&str> = line.split_whitespace().collect();
    // Filesystem, 1K-blocks, Used, Available, ...
    let total = cols.get(1).and_then(|v| v.parse::<u64>().ok()).map(|k| k * 1024);
    let free = cols.get(3).and_then(|v| v.parse::<u64>().ok()).map(|k| k * 1024);
    (total, free)
}

#[cfg(not(unix))]
fn disk_stats(_path: &Path) -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[tauri::command]
pub fn storage_usage(app: AppHandle) -> Result<StorageUsage, StoreError> {
    let root = projects_root(&app)?;
    let app_bytes = dir_size(&root);

    // Footage is counted once per path: the same file referenced by two
    // projects occupies one place on disk, and counting it twice would tell
    // the user they are using space they are not.
    let mut seen = std::collections::HashSet::new();
    let mut footage_bytes = 0u64;
    for summary_path in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        let manifest = summary_path.path().join("project.json");
        if let Ok(p) = project::load(&manifest) {
            for clip in &p.clips {
                if let Some(src) = clip.source_path.as_deref() {
                    if seen.insert(src.to_string()) {
                        footage_bytes += std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
                    }
                }
            }
        }
    }

    let (disk_total_bytes, disk_free_bytes) = disk_stats(&root);
    Ok(StorageUsage { app_bytes, footage_bytes, disk_total_bytes, disk_free_bytes })
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
//
// The library view spans every project, so it cannot be served from whichever
// one happens to be open. These read and write clips by (project, clip) pair.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryClip {
    pub project_id: String,
    pub project_name: String,
    pub clip_id: String,
    pub file_name: String,
    pub source_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub duration_ms: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub codec: Option<String>,
    pub is_placeholder: bool,
    pub is_hdr: bool,
    pub favorite: bool,
    pub deleted_at: Option<String>,
    /// Everything described about the clip, joined — what the table shows.
    pub description: String,
    pub segment_count: usize,
    /// The described moments themselves.
    ///
    /// Carried rather than left to be rebuilt from `description`: a clip split
    /// into two moments cannot be recovered from the sentence they join into,
    /// and a view that tried collapsed real segments back into one.
    pub segments: Vec<project::Segment>,
    /// When the clip entered the library. Falls back to the project's own time
    /// for clips imported before this was tracked.
    pub added_at: String,
    /// When the camera recorded it, where the file says. Unix milliseconds.
    pub captured_at_ms: Option<i64>,
    /// Where this clip sits in its project's running order, from zero.
    ///
    /// The order *is* the position in `project.json`'s `clips` array — there is
    /// no separate field to drift out of step with it. It is carried on the row
    /// because the library view merges several projects and re-sorts them,
    /// which is exactly where array position gets lost.
    pub sequence: usize,
}

/// Flatten one clip into a library row.
///
/// Separated from `library_list` so the mapping can be tested: the row used to
/// carry only the joined description, and a view that needed real segments
/// rebuilt a single one from that sentence — which quietly destroyed splits.
pub fn to_library_clip(p: &ProjectFile, c: &project::ProjectClip, sequence: usize) -> LibraryClip {
    LibraryClip {
        project_id: p.project.id.clone(),
        project_name: p.project.name.clone(),
        clip_id: c.id.clone(),
        file_name: c
            .file_name
            .clone()
            .or_else(|| {
                c.source_path
                    .as_deref()
                    .and_then(|s| Path::new(s).file_name().map(|n| n.to_string_lossy().to_string()))
            })
            .unwrap_or_else(|| "Untitled clip".into()),
        source_path: c.source_path.clone(),
        thumbnail_path: c.thumbnail_path.clone(),
        duration_ms: c.source_duration_ms,
        width: c.width,
        height: c.height,
        codec: c.codec.clone(),
        is_placeholder: c.is_placeholder,
        is_hdr: c.is_hdr,
        favorite: c.favorite,
        deleted_at: c.deleted_at.clone(),
        description: c.combined_text(),
        segment_count: c.segments.len(),
        captured_at_ms: c.captured_at_ms,
        sequence,
        segments: c.segments.clone(),
        added_at: p.project.created_at.clone(),
    }
}

#[tauri::command]
pub fn library_list(app: AppHandle) -> Result<Vec<LibraryClip>, StoreError> {
    let root = projects_root(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        let manifest = entry.path().join("project.json");
        let Ok(p) = project::load(&manifest) else { continue };
        for (i, c) in p.clips.iter().enumerate() {
            out.push(to_library_clip(&p, c, i));
        }
    }
    Ok(out)
}

/// Read the recording time out of every clip that has not got one stored.
///
/// Footage imported before this was recorded carries nothing, and the whole
/// library is that footage. Probing is a few milliseconds per file, so it runs
/// once, in the background, and writes what it finds back — the alternative is
/// a date column that stays empty for everything anybody already owns.
///
/// Returns how many clips gained a time.
#[tauri::command]
pub fn clip_backfill_capture(app: AppHandle, project_id: String) -> Result<usize, StoreError> {
    let info = crate::ffmpeg::detect(&crate::assembly::settings_for(&app))
        .map_err(|e| StoreError::new("NO_FFMPEG", e.message))?;
    let path = project_dir(&app, &project_id)?.join("project.json");
    let mut manifest = load_from(&path)?;

    let mut filled = 0usize;
    for clip in manifest.clips.iter_mut() {
        if clip.captured_at_ms.is_some() && clip.has_audio.is_some() {
            continue;
        }
        let Some(src) = clip.source_path.clone() else { continue };
        // Relative paths are stored relative to the project folder.
        let full = if Path::new(&src).is_absolute() {
            PathBuf::from(&src)
        } else {
            project_dir(&app, &project_id)?.join(&src)
        };
        if !full.is_file() {
            continue;
        }
        if let Ok(media) = crate::ffmpeg::probe_media(&info.ffprobe, &full) {
            if clip.captured_at_ms.is_none() && media.created_at_ms.is_some() {
                clip.captured_at_ms = media.created_at_ms;
                filled += 1;
            }
            if clip.has_audio.is_none() {
                clip.has_audio = Some(media.has_audio);
            }
        }
    }

    if filled > 0 || manifest.clips.iter().any(|c| c.has_audio.is_some()) {
        save_to(&path, &manifest)?;
    }
    Ok(filled)
}

/// Put a project's clips into the given order.
///
/// The running order of the footage *is* the order of the `clips` array — the
/// script is written to follow it and the cut is assembled in it — so
/// reordering is a rewrite of that array rather than a field set on each clip.
/// One source of truth, and no way for a stored index to disagree with the
/// position it claims to describe.
///
/// Ids the caller does not mention keep their relative order and follow the
/// ones it does. That matters because the table can be filtered or paged: a
/// drag on the visible twenty must not silently discard the other two hundred
/// and eighty.
#[tauri::command]
pub fn clip_reorder(
    app: AppHandle,
    project_id: String,
    clip_ids: Vec<String>,
) -> Result<(), StoreError> {
    let path = project_dir(&app, &project_id)?.join("project.json");
    let mut manifest = load_from(&path)?;
    manifest.clips = reordered(std::mem::take(&mut manifest.clips), &clip_ids);
    save_to(&path, &manifest)
}

/// The named clips first, in the order named; everything else after, in the
/// order it already had.
pub fn reordered(
    clips: Vec<project::ProjectClip>,
    order: &[String],
) -> Vec<project::ProjectClip> {
    let rank: std::collections::HashMap<&str, usize> =
        order.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    let mut named: Vec<project::ProjectClip> = Vec::new();
    let mut rest: Vec<project::ProjectClip> = Vec::new();
    for c in clips {
        if rank.contains_key(c.id.as_str()) {
            named.push(c);
        } else {
            rest.push(c);
        }
    }
    named.sort_by_key(|c| rank[c.id.as_str()]);
    named.extend(rest);
    named
}

/// Apply one change to one clip, in place.
fn edit_clip<F>(app: &AppHandle, project_id: &str, clip_id: &str, f: F) -> Result<(), StoreError>
where
    F: FnOnce(&mut project::ProjectClip),
{
    let path = project_dir(app, project_id)?.join("project.json");
    let mut manifest = load_from(&path)?;
    let clip = manifest
        .clips
        .iter_mut()
        .find(|c| c.id == clip_id)
        .ok_or_else(|| StoreError::new("NO_CLIP", "That clip is no longer in the project."))?;
    f(clip);
    save_to(&path, &manifest)
}

#[tauri::command]
pub fn clip_set_favorite(
    app: AppHandle,
    project_id: String,
    clip_id: String,
    favorite: bool,
) -> Result<(), StoreError> {
    edit_clip(&app, &project_id, &clip_id, |c| c.favorite = favorite)
}

/// Move a clip to the trash, or bring it back.
///
/// The description is kept either way. Footage is referenced rather than copied,
/// so what a delete actually destroys is the writing somebody did about it.
#[tauri::command]
pub fn clip_set_deleted(
    app: AppHandle,
    project_id: String,
    clip_id: String,
    deleted_at: Option<String>,
) -> Result<(), StoreError> {
    edit_clip(&app, &project_id, &clip_id, |c| c.deleted_at = deleted_at)
}

/// Drop a clip for good.
#[tauri::command]
pub fn clip_purge(app: AppHandle, project_id: String, clip_id: String) -> Result<(), StoreError> {
    let path = project_dir(&app, &project_id)?.join("project.json");
    let mut manifest = load_from(&path)?;
    manifest.clips.retain(|c| c.id != clip_id);
    save_to(&path, &manifest)
}

/// Replace what a clip says.
///
/// A clip described as one span keeps being one span. A clip cut into several
/// is left alone, because collapsing it here would silently throw away timings
/// somebody set deliberately in the segment editor.
#[tauri::command]
pub fn clip_set_description(
    app: AppHandle,
    project_id: String,
    clip_id: String,
    text: String,
) -> Result<bool, StoreError> {
    let mut applied = false;
    edit_clip(&app, &project_id, &clip_id, |c| {
        if c.segments.len() > 1 {
            return;
        }
        applied = true;
        let end = c.source_duration_ms.unwrap_or(0) as f64 / 1000.0;
        match c.segments.first_mut() {
            Some(s) => s.text = text.clone(),
            None => c.segments.push(project::Segment { start_sec: 0.0, end_sec: end, text }),
        }
        c.segments.retain(|s| !s.text.trim().is_empty());
    })?;
    Ok(applied)
}

/// Whose machine this is.
///
/// The app has no accounts, so the sidebar shows the OS user rather than
/// inventing a profile and a role to go with it.
#[tauri::command]
pub fn machine_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "This machine".into())
}

/// Replace a clip's described moments wholesale.
///
/// Unlike `clip_set_description` this carries timings, so it is what the
/// describe-one-by-one view writes: splitting a clip is the whole point of
/// that screen, and a single text field cannot express where the boundaries
/// fall. Empty trailing text is kept — a moment marked but not yet described
/// is a real state, and dropping it would undo the split.
#[tauri::command]
pub fn clip_set_segments(
    app: AppHandle,
    project_id: String,
    clip_id: String,
    segments: Vec<project::Segment>,
) -> Result<(), StoreError> {
    edit_clip(&app, &project_id, &clip_id, |c| c.segments = segments)
}

/// Let the webview read specific media files.
///
/// Footage is referenced where the user keeps it, not copied into the project,
/// so it sits outside the `$APPDATA/**` the asset protocol allows by default —
/// which is why thumbnails (written into the project folder) appeared while the
/// clips themselves would not play.
///
/// Granted file by file rather than by widening the static scope to the home
/// directory: the app should be able to read the footage somebody imported, not
/// everything they own. The scope is in-memory, so this is called again on every
/// launch as the library is read.
#[tauri::command]
pub fn allow_media(app: AppHandle, paths: Vec<String>) -> Result<usize, StoreError> {
    let scope = app.asset_protocol_scope();
    let mut granted = 0;
    for p in paths {
        let path = Path::new(&p);
        // A path that has gone away is not an error here: the library still
        // lists it, and the UI reports the missing file where it is used.
        if path.is_file() && scope.allow_file(path).is_ok() {
            granted += 1;
        }
    }
    Ok(granted)
}


#[cfg(test)]
mod library_rows {
    use super::*;
    use crate::project::{ProjectClip, Segment};

    fn clip_with(segments: Vec<Segment>) -> ProjectClip {
        ProjectClip {
            id: "c1".into(),
            source_path: Some("/tmp/IMG_6016.mov".into()),
            sha256: None,
            source_duration_ms: Some(85_055),
            is_placeholder: false,
            file_name: Some("IMG_6016.mov".into()),
            thumbnail_path: None,
            is_hdr: true,
            width: Some(1920),
            height: Some(1080),
            codec: Some("hevc".into()),
            has_audio: Some(true),
            captured_at_ms: None,
            imported_at: None,
            favorite: false,
            deleted_at: None,
            segments,
        }
    }

    /// A split clip must survive the trip to the library and back.
    ///
    /// The describe view reads its moments from the row. When the row carried
    /// only `description`, two moments came back as one covering the whole clip
    /// — and were then written over the real ones. Joined text cannot be
    /// unjoined, so the segments have to travel.
    #[test]
    fn a_row_carries_every_moment_not_just_their_joined_text() {
        let mut p = ProjectFile::new("p1".into(), "Mecca".into(), "2026-08-12T00:00:00Z".into());
        p.clips.push(clip_with(vec![
            Segment { start_sec: 0.0, end_sec: 12.0, text: "kobutor".into() },
            Segment { start_sec: 12.0, end_sec: 85.055, text: "mosque".into() },
        ]));

        let row = to_library_clip(&p, &p.clips[0], 0);

        assert_eq!(row.segments.len(), 2, "both moments must reach the row");
        assert_eq!(row.segments[0].text, "kobutor");
        assert_eq!(row.segments[1].text, "mosque");
        assert_eq!(row.segments[1].start_sec, 12.0, "the boundary must survive");

        // The joined form is still there for the table, and is exactly the
        // thing that cannot be turned back into two moments.
        assert_eq!(row.description, "kobutor. mosque");
        assert_eq!(row.segment_count, 2);
    }

    #[test]
    fn an_undescribed_clip_has_no_moments_rather_than_an_empty_one() {
        let mut p = ProjectFile::new("p1".into(), "Mecca".into(), "2026-08-12T00:00:00Z".into());
        p.clips.push(clip_with(Vec::new()));
        let row = to_library_clip(&p, &p.clips[0], 0);
        assert!(row.segments.is_empty());
        assert_eq!(row.description, "");
    }
}

// ---------------------------------------------------------------------------
// Takes
// ---------------------------------------------------------------------------

/// Record a generation, so regenerating no longer destroys the last attempt.
#[tauri::command]
pub fn take_add(
    app: AppHandle,
    project_id: String,
    take: project::Take,
) -> Result<Vec<project::Take>, StoreError> {
    let path = project_dir(&app, &project_id)?.join("project.json");
    let mut manifest = load_from(&path)?;
    manifest.takes.push(take);
    save_to(&path, &manifest)?;
    Ok(manifest.takes)
}

/// Forget a take, and the file it owns.
///
/// Only render takes own a file. Script and voice takes point at audio the
/// current recording may still be using, so deleting one must not touch disk —
/// that would silence a project to tidy up its history.
#[tauri::command]
pub fn take_delete(
    app: AppHandle,
    project_id: String,
    take_id: String,
) -> Result<Vec<project::Take>, StoreError> {
    let path = project_dir(&app, &project_id)?.join("project.json");
    let mut manifest = load_from(&path)?;

    if let Some(t) = manifest.takes.iter().find(|t| t.id == take_id) {
        if t.kind == "render" {
            if let Some(v) = t.video_path.as_deref() {
                remove_render_files(std::path::Path::new(v));
            }
        }
    }
    manifest.takes.retain(|t| t.id != take_id);
    save_to(&path, &manifest)?;
    Ok(manifest.takes)
}

/// Delete a rendered cut and anything rendered only for it.
///
/// The take's opening montage sits beside it under the same take id —
/// `cut-<id>.mp4` and `intro-<id>.mp4`. Nothing else ever references the
/// montage, so removing only the cut leaves an orphan behind on every render
/// the user throws away.
pub fn remove_render_files(cut: &std::path::Path) {
    let _ = std::fs::remove_file(cut);
    if let (Some(dir), Some(name)) = (cut.parent(), cut.file_name()) {
        if let Some(rest) = name.to_string_lossy().strip_prefix("cut-") {
            let _ = std::fs::remove_file(dir.join(format!("intro-{rest}")));
        }
    }
}

#[tauri::command]
pub fn take_list(app: AppHandle, project_id: String) -> Result<Vec<project::Take>, StoreError> {
    let path = project_dir(&app, &project_id)?.join("project.json");
    Ok(load_from(&path)?.takes)
}

// ---------------------------------------------------------------------------
// Writing instructions
// ---------------------------------------------------------------------------

/// The instruction the script writer is given, editable without a rebuild.
///
/// The register work on Bengali was a code change for what is really a piece of
/// writing. Keeping it in the source means every adjustment needs a developer,
/// which is the wrong shape for the part of the app most likely to need
/// tuning by whoever speaks the language.
#[tauri::command]
pub fn writing_instructions_get(app: AppHandle) -> Option<String> {
    settings_file(&app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["scriptInstructions"].as_str().map(str::to_string))
        .filter(|s| !s.trim().is_empty())
}

/// Store, or clear with `None` to go back to the built-in wording.
#[tauri::command]
pub fn writing_instructions_set(
    app: AppHandle,
    instructions: Option<String>,
) -> Result<(), StoreError> {
    write_setting(
        &app,
        "scriptInstructions",
        instructions
            .filter(|s| !s.trim().is_empty())
            .map(|v| serde_json::json!(v)),
    )
}

/// Whether new scripts get an opening line and a montage to run it over.
///
/// App-level rather than per project, and on unless turned off: an opening is
/// what the feature is for, and someone who does not want one wants that
/// decision to hold for everything they make, not to be re-made per video.
#[tauri::command]
pub fn intro_enabled_get(app: AppHandle) -> bool {
    read_setting(&app, "introEnabled").and_then(|v| v.as_bool()).unwrap_or(true)
}

#[tauri::command]
pub fn intro_enabled_set(app: AppHandle, enabled: bool) -> Result<(), StoreError> {
    write_setting(&app, "introEnabled", Some(serde_json::json!(enabled)))
}

fn read_setting(app: &AppHandle, key: &str) -> Option<serde_json::Value> {
    settings_file(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get(key).cloned())
}

/// Read-modify-write the whole file: the ffmpeg paths live here too, and
/// replacing it wholesale would forget them.
fn write_setting(
    app: &AppHandle,
    key: &str,
    value: Option<serde_json::Value>,
) -> Result<(), StoreError> {
    let path = settings_file(app)
        .ok_or_else(|| StoreError::new("NO_APP_DIR", "No settings location."))?;
    let mut doc: serde_json::Value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    match value {
        Some(v) => doc[key] = v,
        None => {
            if let Some(o) = doc.as_object_mut() {
                o.remove(key);
            }
        }
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&doc).unwrap_or_default())
        .map_err(|e| StoreError::new("SAVE_FAILED", e.to_string()))
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("settings.json"))
}

#[cfg(test)]
mod take_payloads {
    use super::*;

    /// The take payloads the frontend sends must deserialize.
    ///
    /// These are copied from `src/lib/takes.ts`. The field names are Rust's —
    /// `path`, not `audioPath`; `skippedWords`, which has no default — and
    /// guessing them meant serde rejected the whole payload at the moment a
    /// recording finished, so the recording appeared to fail. A command called
    /// across a language boundary has a contract, and this is where it is
    /// checked rather than in a manual run.
    #[test]
    fn a_voice_take_from_the_frontend_deserializes() {
        let json = serde_json::json!({
            "id": "3f1c",
            "kind": "voice",
            "createdAt": "2026-08-12T00:00:00Z",
            "label": "11 lines · 61.4s",
            "detail": "ElevenLabs (cloud) · CwhR · Bengali",
            "lines": [
                { "clipId": "c1", "segmentIndex": 0, "text": "eta holo amader hotel", "edited": false }
            ],
            "audio": [
                {
                    "clipId": "c1",
                    "segmentIndex": 0,
                    "path": "/tmp/line-01.wav",
                    "durationMs": 4200,
                    "skippedWords": []
                }
            ],
            "videoPath": serde_json::Value::Null,
            "durationMs": serde_json::Value::Null
        });
        let take: project::Take = serde_json::from_value(json).expect("voice take");
        assert_eq!(take.audio.len(), 1);
        assert_eq!(take.audio[0].path, "/tmp/line-01.wav");
        assert_eq!(take.lines[0].text, "eta holo amader hotel");
    }

    #[test]
    fn script_and_render_takes_deserialize() {
        let script = serde_json::json!({
            "id": "a", "kind": "script", "createdAt": "2026-08-12T00:00:00Z",
            "label": "11 lines · 151 words", "detail": "Bengali · emotional",
            "lines": [{ "clipId": "c1", "segmentIndex": 0, "text": "hi", "edited": false }],
            "audio": [], "videoPath": serde_json::Value::Null,
            "durationMs": serde_json::Value::Null
        });
        let t: project::Take = serde_json::from_value(script).expect("script take");
        assert_eq!(t.kind, "script");
        assert!(t.audio.is_empty());

        let render = serde_json::json!({
            "id": "b", "kind": "render", "createdAt": "2026-08-12T00:00:00Z",
            "label": "117.7s cut", "detail": "hard cuts · no music",
            "lines": [], "audio": [],
            "videoPath": "/tmp/cut-b.mp4", "durationMs": 117_700
        });
        let t: project::Take = serde_json::from_value(render).expect("render take");
        assert_eq!(t.video_path.as_deref(), Some("/tmp/cut-b.mp4"));
        assert_eq!(t.duration_ms, Some(117_700));
    }
}

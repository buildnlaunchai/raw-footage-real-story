//! Stage 3 commands: detect ffmpeg, make placeholder clips, assemble, export.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::ffmpeg::{self, FfmpegError, FfmpegInfo, FfmpegSettings, RenderItem, RenderSettings};
use crate::project::{self, *};
use crate::timeline::{self, ClipInput, LineInput};

/// Distinct, widely separated colours so placeholder clips are told apart at a
/// glance — and, in tests, numerically.
const PLACEHOLDER_COLORS: &[&str] = &[
    "0xE4572E", "0x17BEBB", "0xFFC914", "0x2E282A", "0x76B041", "0x8332AC", "0x0B6E4F", "0xD7263D",
];

fn settings_path(app: &AppHandle) -> Result<PathBuf, FfmpegError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| FfmpegError { code: "NO_APP_DIR".into(), message: e.to_string() })?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| FfmpegError { code: "MKDIR_FAILED".into(), message: e.to_string() })?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> FfmpegSettings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn project_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, FfmpegError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| FfmpegError { code: "NO_APP_DIR".into(), message: e.to_string() })?;
    let safe: String = project_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err(FfmpegError {
            code: "BAD_PROJECT_ID".into(),
            message: "project id has no usable characters".into(),
        });
    }
    Ok(base.join("projects").join(safe))
}

#[tauri::command]
pub fn ffmpeg_detect(app: AppHandle) -> Result<FfmpegInfo, FfmpegError> {
    ffmpeg::detect(&load_settings(&app))
}

/// Records a path the user picked in the setup screen, then re-detects so the
/// UI immediately learns whether the choice actually works.
#[tauri::command]
pub fn ffmpeg_set_path(app: AppHandle, ffmpeg_path: String) -> Result<FfmpegInfo, FfmpegError> {
    let settings = FfmpegSettings { ffmpeg_path: Some(ffmpeg_path), ffprobe_path: None };
    let info = ffmpeg::detect(&settings)?;
    if let Ok(path) = settings_path(&app) {
        let persisted = FfmpegSettings {
            ffmpeg_path: Some(info.ffmpeg.clone()),
            ffprobe_path: Some(info.ffprobe.clone()),
        };
        if let Ok(json) = serde_json::to_string_pretty(&persisted) {
            let _ = std::fs::write(path, json);
        }
    }
    Ok(info)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSpec {
    pub id: String,
    pub description: String,
    pub source_path: Option<String>,
    pub source_duration_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicedSpec {
    pub clip_id: String,
    pub text: String,
    pub audio_path: String,
    pub duration_ms: u64,
    pub skipped: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedClip {
    pub clip_id: String,
    pub source_path: String,
    pub source_duration_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RenderProgress {
    stage: String,
    done: usize,
    total: usize,
}

/// Dev-only affordance: stand-in footage so the assembly pipeline can be run
/// and watched before real video upload exists. Each clip is generated at its
/// narration length, so nothing needs trimming or holding.
#[tauri::command]
pub fn assembly_make_placeholders(
    app: AppHandle,
    clips: Vec<ClipSpec>,
    voiced: Vec<VoicedSpec>,
    project_id: String,
) -> Result<Vec<GeneratedClip>, FfmpegError> {
    let info = ffmpeg::detect(&load_settings(&app))?;
    let dir = project_dir(&app, &project_id)?.join("clips");
    std::fs::create_dir_all(&dir)
        .map_err(|e| FfmpegError { code: "MKDIR_FAILED".into(), message: e.to_string() })?;

    let settings = RenderSettings::default();
    let mut out = Vec::new();

    for (i, clip) in clips.iter().enumerate() {
        let Some(line) = voiced.iter().find(|v| v.clip_id == clip.id) else {
            continue; // nothing said over it, so it never reaches the timeline
        };
        let duration = timeline::on_screen_ms(line.duration_ms);
        let path = dir.join(format!("placeholder-{i:02}.mp4"));
        ffmpeg::make_placeholder(
            &info.ffmpeg,
            &path,
            PLACEHOLDER_COLORS[i % PLACEHOLDER_COLORS.len()],
            duration,
            settings.width,
            settings.height,
            settings.fps,
        )?;
        let _ = app.emit(
            "render:progress",
            RenderProgress { stage: "placeholders".into(), done: i + 1, total: clips.len() },
        );
        out.push(GeneratedClip {
            clip_id: clip.id.clone(),
            source_path: path.to_string_lossy().into(),
            source_duration_ms: duration,
        });
    }

    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembleResult {
    pub video_path: String,
    pub project_path: String,
    pub duration_ms: u64,
    pub timeline: Vec<crate::timeline::TimelineItem>,
}

#[tauri::command]
pub async fn assembly_render(
    app: AppHandle,
    clips: Vec<ClipSpec>,
    voiced: Vec<VoicedSpec>,
    project_id: String,
    project_name: String,
    model: String,
    voice: String,
    created_at: String,
    updated_at: String,
) -> Result<AssembleResult, FfmpegError> {
    let info = ffmpeg::detect(&load_settings(&app))?;
    let dir = project_dir(&app, &project_id)?;
    std::fs::create_dir_all(dir.join("render"))
        .map_err(|e| FfmpegError { code: "MKDIR_FAILED".into(), message: e.to_string() })?;

    let clip_inputs: Vec<ClipInput> = clips
        .iter()
        .map(|c| ClipInput {
            clip_id: c.id.clone(),
            source_duration_ms: c.source_duration_ms,
        })
        .collect();
    let line_inputs: Vec<LineInput> = voiced
        .iter()
        .map(|v| LineInput { clip_id: v.clip_id.clone(), duration_ms: v.duration_ms })
        .collect();
    let items = timeline::plan(&clip_inputs, &line_inputs);

    if items.is_empty() {
        return Err(FfmpegError {
            code: "NOTHING_TO_RENDER".into(),
            message: "Generate a voiceover before assembling.".into(),
        });
    }

    // Every timeline item needs media. Anything still missing gets generated at
    // exactly the length the planner assumed for it.
    let clips_dir = dir.join("clips");
    std::fs::create_dir_all(&clips_dir)
        .map_err(|e| FfmpegError { code: "MKDIR_FAILED".into(), message: e.to_string() })?;

    let mut render_items = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let spec = clips.iter().find(|c| c.id == item.clip_id);
        let video = match spec.and_then(|c| c.source_path.clone()) {
            Some(p) if Path::new(&p).is_file() => PathBuf::from(p),
            _ => {
                let path = clips_dir.join(format!("auto-{i:02}.mp4"));
                ffmpeg::make_placeholder(
                    &info.ffmpeg,
                    &path,
                    PLACEHOLDER_COLORS[i % PLACEHOLDER_COLORS.len()],
                    item.timeline_duration_ms,
                    RenderSettings::default().width,
                    RenderSettings::default().height,
                    RenderSettings::default().fps,
                )?;
                path
            }
        };
        let audio = voiced
            .iter()
            .find(|v| v.clip_id == item.clip_id)
            .map(|v| PathBuf::from(&v.audio_path))
            .ok_or_else(|| FfmpegError {
                code: "MISSING_AUDIO".into(),
                message: format!("no narration audio for clip {}", item.clip_id),
            })?;

        render_items.push(RenderItem { video, audio, item: item.clone() });
    }

    let _ = app.emit(
        "render:progress",
        RenderProgress { stage: "encoding".into(), done: 0, total: items.len() },
    );

    let settings = RenderSettings::default();
    let out = dir.join("render").join("rough-cut.mp4");
    ffmpeg::render_rough_cut(&info.ffmpeg, &render_items, &settings, &out)?;

    // --- manifest -----------------------------------------------------------
    let project_clips: Vec<ProjectClip> = clips
        .iter()
        .map(|c| {
            let path = c.source_path.as_ref().map(PathBuf::from);
            let is_placeholder = path
                .as_ref()
                .map(|p| p.to_string_lossy().contains("placeholder-") || p.to_string_lossy().contains("auto-"))
                .unwrap_or(true);
            ProjectClip {
                id: c.id.clone(),
                source_path: path.as_ref().map(|p| project::relative_to(&dir, p)),
                sha256: path.as_ref().filter(|p| p.is_file()).and_then(|p| project::sha256_file(p).ok()),
                source_duration_ms: c.source_duration_ms,
                description: c.description.clone(),
                is_placeholder,
            }
        })
        .collect();

    let manifest = ProjectFile {
        schema_version: SCHEMA_VERSION,
        app: AppInfo {
            slug: "raw-footage-real-story".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
        project: ProjectMeta {
            id: project_id.clone(),
            name: project_name,
            created_at,
            updated_at,
        },
        clips: project_clips,
        script: ScriptSection {
            model,
            generated_at: chrono_stub(),
            lines: voiced
                .iter()
                .map(|v| ScriptLineRecord { clip_id: v.clip_id.clone(), text: v.text.clone() })
                .collect(),
        },
        audio: AudioSection {
            voice,
            sample_rate: crate::tts::SAMPLE_RATE,
            lines: voiced
                .iter()
                .map(|v| AudioLineRecord {
                    clip_id: v.clip_id.clone(),
                    path: project::relative_to(&dir, Path::new(&v.audio_path)),
                    duration_ms: v.duration_ms,
                    skipped_words: v.skipped.clone(),
                })
                .collect(),
        },
        timeline: items.clone(),
        render: RenderSection {
            settings,
            vcodec: "h264".into(),
            acodec: "aac".into(),
            output_path: Some(project::relative_to(&dir, &out)),
        },
    };

    let manifest_path = dir.join("project.json");
    project::write_json(&manifest, &manifest_path)
        .map_err(|e| FfmpegError { code: "MANIFEST_WRITE_FAILED".into(), message: e.to_string() })?;

    Ok(AssembleResult {
        video_path: out.to_string_lossy().into(),
        project_path: manifest_path.to_string_lossy().into(),
        duration_ms: timeline::total_duration_ms(&items),
        timeline: items,
    })
}

/// Timestamps come from the frontend where possible; this is only the fallback
/// for the one field generated during render.
fn chrono_stub() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{}", d.as_millis()))
        .unwrap_or_default()
}

#[tauri::command]
pub fn assembly_export_bundle(
    app: AppHandle,
    project_id: String,
    destination: String,
) -> Result<String, FfmpegError> {
    let dir = project_dir(&app, &project_id)?;
    let out = PathBuf::from(&destination);
    project::write_bundle(&dir, &out)
        .map_err(|e| FfmpegError { code: "BUNDLE_FAILED".into(), message: e.to_string() })?;
    Ok(out.to_string_lossy().into())
}

#[tauri::command]
pub fn assembly_export_project_only(
    app: AppHandle,
    project_id: String,
    destination: String,
) -> Result<String, FfmpegError> {
    let src = project_dir(&app, &project_id)?.join("project.json");
    let out = PathBuf::from(&destination);
    std::fs::copy(&src, &out)
        .map_err(|e| FfmpegError { code: "EXPORT_FAILED".into(), message: e.to_string() })?;
    Ok(out.to_string_lossy().into())
}

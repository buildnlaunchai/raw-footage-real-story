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

/// The saved ffmpeg settings, for callers outside this module.
pub fn settings_for(app: &AppHandle) -> FfmpegSettings {
    load_settings(app)
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
    /// Set explicitly at import rather than guessed from the filename. Sniffing
    /// the path for "placeholder-" mislabels a user's own `placeholder-beach.mp4`,
    /// and the manifest is a contract — it should not contain inferences.
    #[serde(default)]
    pub is_placeholder: bool,
    /// From the import probe; drives tone mapping at render time.
    #[serde(default)]
    pub is_hdr: Option<bool>,
    /// Where in the clip this item starts, when a story uses one described
    /// segment rather than the whole clip.
    #[serde(default)]
    pub source_start_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicedSpec {
    pub clip_id: String,
    #[serde(default)]
    pub segment_index: usize,
    pub text: String,
    pub audio_path: String,
    pub duration_ms: u64,
    pub skipped: Vec<String>,
    #[serde(default)]
    pub speech_end_ms: Option<u64>,
    #[serde(default)]
    pub edited: bool,
    /// Where in the clip this line's segment begins.
    #[serde(default)]
    pub source_start_ms: Option<u64>,
}

/// The opening montage, as the frontend asks for it.
///
/// The shots are chosen in TypeScript (`lib/intro.ts`) and the hook is spoken
/// through the ordinary voice pipeline, so by the time it arrives here there is
/// nothing left to decide — only a montage to render and a dissolve to place.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntroSpec {
    pub shots: Vec<crate::ffmpeg::IntroShot>,
    /// The spoken hook. Its length is the montage's length.
    pub audio_path: String,
    /// Dissolve from the montage into the first narrated line.
    #[serde(default = "default_intro_fade")]
    pub fade_ms: u32,
    /// The words spoken over the montage, so they can be captioned too.
    #[serde(default)]
    pub text: Option<String>,
}

fn default_intro_fade() -> u32 {
    600
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
            // Placeholders are per clip, so the first line for it is enough.
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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMedia {
    pub source_path: String,
    pub file_name: String,
    pub thumbnail_path: Option<String>,
    pub verdict: ffmpeg::MediaVerdict,
    pub reasons: Vec<String>,
    pub info: Option<ffmpeg::MediaInfo>,
}

/// Inspect files the user picked, without copying them.
///
/// Media is referenced in place: importing 40GB of 4K footage should be
/// instant, and the renderer reads originals perfectly well. Copies are made
/// only at export, when the user has actually asked for something portable.
/// Only the thumbnail lands in the project folder.
#[tauri::command]
pub fn assembly_import_media(
    app: AppHandle,
    paths: Vec<String>,
    project_id: String,
) -> Result<Vec<ImportedMedia>, FfmpegError> {
    let info = ffmpeg::detect(&load_settings(&app))?;
    let thumbs = project_dir(&app, &project_id)?.join("thumbs");
    std::fs::create_dir_all(&thumbs)
        .map_err(|e| FfmpegError { code: "MKDIR_FAILED".into(), message: e.to_string() })?;

    let total = paths.len();
    let mut out = Vec::with_capacity(total);

    for (i, raw) in paths.iter().enumerate() {
        let path = PathBuf::from(raw);
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| raw.clone());

        let check = ffmpeg::check_media(&info.ffprobe, &path, &info.caps);

        // Only worth a thumbnail if the file is actually usable.
        let thumbnail_path = match (&check.verdict, &check.info) {
            (ffmpeg::MediaVerdict::Rejected, _) | (_, None) => None,
            (_, Some(media)) => {
                let dest = thumbs.join(format!("{i:03}-{}.jpg", sanitise(&file_name)));
                match ffmpeg::make_thumbnail(&info.ffmpeg, &path, &dest, media.duration_ms, 480) {
                    Ok(()) => Some(dest.to_string_lossy().to_string()),
                    // A missing thumbnail is cosmetic; it must not fail the import.
                    Err(_) => None,
                }
            }
        };

        let _ = app.emit(
            "import:progress",
            RenderProgress { stage: "import".into(), done: i + 1, total },
        );

        out.push(ImportedMedia {
            source_path: path.to_string_lossy().to_string(),
            file_name,
            thumbnail_path,
            verdict: check.verdict,
            reasons: check.reasons,
            info: check.info,
        });
    }

    Ok(out)
}

fn sanitise(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidatedClip {
    pub clip_id: String,
    pub source_path: String,
}

/// Power-user action: copy referenced media into the project folder so it
/// survives the originals being moved or deleted.
#[tauri::command]
pub fn assembly_consolidate_media(
    app: AppHandle,
    clips: Vec<ClipSpec>,
    project_id: String,
) -> Result<Vec<ConsolidatedClip>, FfmpegError> {
    let dir = project_dir(&app, &project_id)?.join("clips");
    std::fs::create_dir_all(&dir)
        .map_err(|e| FfmpegError { code: "MKDIR_FAILED".into(), message: e.to_string() })?;

    let total = clips.len();
    let mut out = Vec::new();

    for (i, clip) in clips.iter().enumerate() {
        let Some(src) = clip.source_path.as_ref().map(PathBuf::from) else { continue };
        if !src.is_file() {
            continue;
        }
        // Already inside the project? Nothing to do.
        if src.starts_with(&dir) {
            out.push(ConsolidatedClip {
                clip_id: clip.id.clone(),
                source_path: src.to_string_lossy().into(),
            });
            continue;
        }
        let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let dest = dir.join(format!("{i:03}-{}", sanitise(&name)));
        std::fs::copy(&src, &dest).map_err(|e| FfmpegError {
            code: "COPY_FAILED".into(),
            message: format!("{}: {e}", src.display()),
        })?;
        let _ = app.emit(
            "import:progress",
            RenderProgress { stage: "consolidate".into(), done: i + 1, total },
        );
        out.push(ConsolidatedClip {
            clip_id: clip.id.clone(),
            source_path: dest.to_string_lossy().into(),
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
    /// Where the subtitle file was written. Always, whether or not it is burned
    /// in — it costs nothing to make and every site takes one as an upload.
    pub subtitle_path: Option<String>,
    /// Why the words are not drawn into the picture, when that was asked for.
    pub subtitle_error: Option<String>,
    /// Why the opening is missing, when one was asked for and could not be made.
    ///
    /// Present rather than thrown: the cut itself rendered, and a silent
    /// omission would leave the user staring at a film that starts where they
    /// did not expect it to with nothing to explain why.
    pub intro_error: Option<String>,
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
    video_id: Option<String>,
    // Names the output file, so each render is its own take rather than
    // overwriting the last one.
    take_id: Option<String>,
    video_title: Option<String>,
    crossfade_ms: Option<u32>,
    music_id: Option<String>,
    intro: Option<IntroSpec>,
    subtitles: Option<bool>,
) -> Result<AssembleResult, FfmpegError> {
    let info = ffmpeg::detect(&load_settings(&app))?;
    let dir = project_dir(&app, &project_id)?;
    std::fs::create_dir_all(dir.join("render"))
        .map_err(|e| FfmpegError { code: "MKDIR_FAILED".into(), message: e.to_string() })?;

    // One entry per narrated line, not per clip: a story may return to the same
    // clip for a different moment, and each needs its own source offset.
    let clip_inputs: Vec<ClipInput> = voiced
        .iter()
        .map(|v| ClipInput {
            clip_id: v.clip_id.clone(),
            segment_index: v.segment_index,
            source_duration_ms: clips
                .iter()
                .find(|c| c.id == v.clip_id)
                .and_then(|c| c.source_duration_ms),
            source_start_ms: v.source_start_ms.unwrap_or(0),
        })
        .collect();
    let line_inputs: Vec<LineInput> = voiced
        .iter()
        .map(|v| LineInput {
            clip_id: v.clip_id.clone(),
            segment_index: v.segment_index,
            duration_ms: v.duration_ms,
            speech_end_ms: v.speech_end_ms,
            text: Some(v.text.clone()),
        })
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
        // Audio is per line, so match the pair; the media file is per clip.
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
            .find(|v| v.clip_id == item.clip_id && v.segment_index == item.segment_index)
            .map(|v| PathBuf::from(&v.audio_path))
            .ok_or_else(|| FfmpegError {
                code: "MISSING_AUDIO".into(),
                message: format!(
                    "no narration audio for clip {} segment {}",
                    item.clip_id, item.segment_index
                ),
            })?;

        render_items.push(RenderItem {
            video,
            audio,
            item: item.clone(),
            is_hdr: spec.and_then(|c| c.is_hdr).unwrap_or(false),
        });
    }

    let _ = app.emit(
        "render:progress",
        RenderProgress { stage: "encoding".into(), done: 0, total: items.len() },
    );

    // Music ids map to bundled files; an unknown id is silence rather than an
    // error, since a missing bed should not fail a render.
    let music_path = music_id.as_deref().and_then(|id| {
        let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        let p = crate::resources::root().join("music").join(format!("{safe}.m4a"));
        p.is_file().then(|| p.to_string_lossy().to_string())
    });
    let mut settings = RenderSettings {
        crossfade_ms: crossfade_ms.unwrap_or(0),
        music_path,
        ..RenderSettings::default()
    };
    // One file per render. A fixed name meant every render destroyed the
    // previous one, which is the thing takes exist to stop.
    let stem: String = take_id
        .as_deref()
        .unwrap_or("rough-cut")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();

    // --- opening montage ------------------------------------------------------
    //
    // Rendered first, to its own file, then prepended as an ordinary item. A
    // montage that fails to render loses the opening and nothing else: the cut
    // is the work, the opening is an addition to it, and swapping that around
    // would mean a bad first frame costs somebody their whole film.
    let mut items = items;
    let mut intro_error: Option<String> = None;
    if let Some(spec) = intro.as_ref().filter(|i| !i.shots.is_empty()) {
        let intro_path = dir.join("render").join(format!("intro-{stem}.mp4"));
        match ffmpeg::render_intro(
            &info.ffmpeg,
            &spec.shots,
            Path::new(&spec.audio_path),
            &settings,
            &info.caps,
            &intro_path,
        ) {
            Ok(intro_ms) => {
                // Placed with a fade of zero first, only so the clamp can see
                // the montage's own length alongside every other slot.
                let placed = timeline::with_intro(&items, intro_ms, 0);
                render_items.insert(
                    0,
                    RenderItem {
                        video: intro_path,
                        audio: PathBuf::from(&spec.audio_path),
                        item: placed[0].clone(),
                        // Already tone-mapped by `render_intro` if it needed to be.
                        is_hdr: false,
                    },
                );
                // Clamped against the assembled list, so a one-second first line
                // cannot be swallowed whole by the dissolve into it.
                settings.intro_fade_ms = ffmpeg::clamp_crossfade(spec.fade_ms, &render_items);
                items = timeline::with_intro(&items, intro_ms, settings.intro_fade_ms);
            }
            Err(e) => intro_error = Some(e.message.clone()),
        }
    }

    // --- subtitles ------------------------------------------------------------
    //
    // Built from the timeline that is about to be rendered, so the timings are
    // the cut's own rather than an estimate of it, and written whatever the
    // toggle says. Burning them in is the part that needs libass.
    let subs_path = dir.join("render").join(format!("cut-{stem}.srt"));
    let cues = crate::subtitles::cues(&items, |it| {
        if it.clip_id == timeline::INTRO_CLIP_ID {
            intro.as_ref().and_then(|i| i.text.clone())
        } else {
            voiced
                .iter()
                .find(|v| v.clip_id == it.clip_id && v.segment_index == it.segment_index)
                .map(|v| v.text.clone())
        }
    });
    let mut subtitle_path = None;
    let mut subtitle_error = None;
    if !cues.is_empty() {
        let doc = crate::subtitles::to_srt(&cues, Some(crate::subtitles::WRAP_CHARS));
        match std::fs::write(&subs_path, doc) {
            Ok(()) => subtitle_path = Some(subs_path.to_string_lossy().to_string()),
            Err(e) => subtitle_error = Some(format!("Could not write the subtitle file: {e}")),
        }
    }

    if subtitles.unwrap_or(false) {
        if !info.caps.subtitles {
            subtitle_error = Some(
                "This copy of ffmpeg was built without libass, so it cannot draw text into \
                 the picture. The subtitle file was still saved next to the video."
                    .into(),
            );
        } else if let Some(p) = subtitle_path.clone() {
            settings.subtitle_path = Some(p);
        }
    }

    let out = dir.join("render").join(format!("cut-{stem}.mp4"));
    ffmpeg::render_rough_cut(&info.ffmpeg, &render_items, &settings, &info.caps, &out)?;

    // --- manifest -----------------------------------------------------------
    // The project manifest is the source of truth for the clip library, so this
    // merges into it rather than overwriting: segment descriptions and other
    // videos must survive a render.
    let manifest_path = dir.join("project.json");
    let mut manifest = project::load(&manifest_path)
        .unwrap_or_else(|_| ProjectFile::new(project_id.clone(), project_name.clone(), created_at.clone()));
    manifest.project.name = project_name;
    manifest.project.updated_at = updated_at;

    for c in &clips {
        let path = c.source_path.as_ref().map(PathBuf::from);
        // No media at all is still a placeholder slot; otherwise trust the
        // flag the importer set.
        let is_placeholder = path.is_none() || c.is_placeholder;
        let source_path = path.as_ref().map(|p| project::relative_to(&dir, p));
        let sha256 = path
            .as_ref()
            .filter(|p| p.is_file())
            .and_then(|p| project::sha256_file(p).ok());

        match manifest.clips.iter_mut().find(|existing| existing.id == c.id) {
            Some(existing) => {
                // Never clobber segment descriptions the user has entered.
                existing.source_path = source_path;
                existing.sha256 = sha256;
                existing.source_duration_ms = c.source_duration_ms;
                existing.is_placeholder = is_placeholder;
                existing.is_hdr = c.is_hdr.unwrap_or(existing.is_hdr);
            }
            None => manifest.clips.push(ProjectClip {
                id: c.id.clone(),
                source_path,
                sha256,
                source_duration_ms: c.source_duration_ms,
                is_placeholder,
                file_name: None,
                thumbnail_path: None,
                is_hdr: c.is_hdr.unwrap_or(false),
                width: None,
                height: None,
                codec: None,
                has_audio: None,
                captured_at_ms: None,
                favorite: false,
                deleted_at: None,
                segments: if c.description.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![project::Segment {
                        start_sec: 0.0,
                        end_sec: c.source_duration_ms.unwrap_or(0) as f64 / 1000.0,
                        text: c.description.clone(),
                    }]
                },
            }),
        }
    }

    let video_id = video_id.unwrap_or_else(|| "default".into());
    let now = chrono_stub();
    if manifest.video(&video_id).is_none() {
        manifest.videos.push(VideoProject::new(
            video_id.clone(),
            video_title.clone().unwrap_or_else(|| "Untitled video".into()),
            now.clone(),
        ));
    }
    let existing_target = manifest
        .video(&video_id)
        .and_then(|v| v.script.as_ref())
        .and_then(|s| s.word_count_target);
    // The render knows the montage but not the words spoken over it, so the
    // hook is carried through rather than rewritten from nothing.
    let existing_hook = manifest
        .video(&video_id)
        .and_then(|v| v.script.as_ref())
        .and_then(|s| s.hook.clone());
    let video = manifest.video_mut(&video_id).expect("just inserted");
    if let Some(t) = video_title {
        video.title = t;
    }
    video.updated_at = now.clone();
    video.selection = voiced
        .iter()
        .map(|v| SelectedSegment { clip_id: v.clip_id.clone(), segment_index: v.segment_index })
        .collect();
    video.script = Some(ScriptSection {
        model,
        generated_at: now,
        lines: voiced
            .iter()
            .map(|v| ScriptLineRecord {
                clip_id: v.clip_id.clone(),
                segment_index: v.segment_index,
                text: v.text.clone(),
                edited: v.edited,
            })
            .collect(),
        word_count_target: existing_target,
        hook: existing_hook,
    });
    video.audio = Some(AudioSection {
        voice,
        sample_rate: crate::tts::SAMPLE_RATE,
        lines: voiced
            .iter()
            .map(|v| AudioLineRecord {
                clip_id: v.clip_id.clone(),
                segment_index: v.segment_index,
                path: project::relative_to(&dir, Path::new(&v.audio_path)),
                duration_ms: v.duration_ms,
                skipped_words: v.skipped.clone(),
            })
            .collect(),
    });
    video.timeline = items.clone();
    video.render = Some(RenderSection {
        settings,
        vcodec: "h264".into(),
        acodec: "aac".into(),
        output_path: Some(project::relative_to(&dir, &out)),
    });

    project::write_json(&manifest, &manifest_path)
        .map_err(|e| FfmpegError { code: "MANIFEST_WRITE_FAILED".into(), message: e.to_string() })?;

    Ok(AssembleResult {
        video_path: out.to_string_lossy().into(),
        project_path: manifest_path.to_string_lossy().into(),
        duration_ms: timeline::total_duration_ms(&items),
        timeline: items,
        subtitle_path,
        subtitle_error,
        intro_error,
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

/// Copy the finished cut wherever the user wants it.
///
/// The rendered file is already an mp4 in the project folder; this is a copy to
/// a chosen destination and nothing more. Bundles and project files are a
/// different job — this one is "give me the video".
#[tauri::command]
pub fn save_video_as(from: String, to: String) -> Result<String, FfmpegError> {
    let src = std::path::Path::new(&from);
    if !src.is_file() {
        return Err(FfmpegError {
            code: "NO_VIDEO".into(),
            message: "That render is no longer on disk. Render again.".into(),
        });
    }
    std::fs::copy(src, &to).map_err(|e| FfmpegError {
        code: "COPY_FAILED".into(),
        message: format!("{to}: {e}"),
    })?;
    Ok(to)
}

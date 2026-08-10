//! The project file — the contract with the v2 web timeline editor.
//!
//! This is an interface between two codebases, so it is versioned from the
//! start and documented in `docs/project-file.md`.
//!
//! The governing principle: **the timeline is stored explicitly, never
//! derived**. If the editor had to re-run our reconciliation to know where
//! things sit, any later change to that algorithm would silently move every
//! previously exported project. Absolute computed timings make old projects
//! immutable and correct forever.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::ffmpeg::RenderSettings;
use crate::timeline::TimelineItem;

/// Bump only for breaking changes. The editor refuses versions it predates.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub slug: String,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectClip {
    pub id: String,
    /// Relative to the project file, so a bundle relocates cleanly.
    pub source_path: Option<String>,
    /// Lets the editor detect media that moved or changed underneath it.
    pub sha256: Option<String>,
    pub source_duration_ms: Option<u64>,
    pub description: String,
    pub is_placeholder: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptLineRecord {
    pub clip_id: String,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSection {
    pub model: String,
    pub generated_at: String,
    pub lines: Vec<ScriptLineRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLineRecord {
    pub clip_id: String,
    pub path: String,
    pub duration_ms: u64,
    /// G2P misses carried through from stage 2, so the editor can flag lines
    /// worth re-recording instead of rediscovering the problem.
    pub skipped_words: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSection {
    pub voice: String,
    pub sample_rate: u32,
    pub lines: Vec<AudioLineRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSection {
    #[serde(flatten)]
    pub settings: RenderSettings,
    pub vcodec: String,
    pub acodec: String,
    pub output_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub schema_version: u32,
    pub app: AppInfo,
    pub project: ProjectMeta,
    pub clips: Vec<ProjectClip>,
    pub script: ScriptSection,
    pub audio: AudioSection,
    pub timeline: Vec<TimelineItem>,
    pub render: RenderSection,
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
    std::fs::write(path, json)
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
/// This is the default export because it is the only form that round-trips —
/// a manifest referencing media on the author's disk is useless to the editor.
///
/// Media is *referenced* while editing, not copied, so a working project.json
/// can legitimately hold absolute paths to files anywhere on disk. Those files
/// are copied in here and the manifest is rewritten as it goes, so the bundle
/// always satisfies the "every path is relative" invariant the format promises,
/// whatever state the working directory was in.
pub fn write_bundle(project_dir: &Path, out_zip: &Path) -> std::io::Result<()> {
    if let Some(parent) = out_zip.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = std::fs::File::create(out_zip)?;
    let mut zip = zip::ZipWriter::new(file);
    // Media is already compressed; storing avoids a pointless second pass.
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
                        continue; // already inside the project
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
                        // Media went missing; say so in the manifest rather than
                        // shipping a path that resolves to nothing.
                        clip.source_path = None;
                    }
                }
                serde_json::to_vec_pretty(&manifest).unwrap_or(raw)
            }
            // Unparseable manifest still gets bundled verbatim rather than lost.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::{ClipInput, LineInput};

    fn sample_project() -> ProjectFile {
        let clips = [ClipInput { clip_id: "c0".into(), source_duration_ms: Some(9_000) }];
        let lines = [LineInput { clip_id: "c0".into(), duration_ms: 2_000 }];
        ProjectFile {
            schema_version: SCHEMA_VERSION,
            app: AppInfo { slug: "raw-footage-real-story".into(), version: "0.1.0".into() },
            project: ProjectMeta {
                id: "p1".into(),
                name: "Test".into(),
                created_at: "2026-08-10T00:00:00Z".into(),
                updated_at: "2026-08-10T00:00:00Z".into(),
            },
            clips: vec![ProjectClip {
                id: "c0".into(),
                source_path: Some("clips/c0.mp4".into()),
                sha256: None,
                source_duration_ms: Some(9_000),
                description: "harbour".into(),
                is_placeholder: true,
            }],
            script: ScriptSection {
                model: "qwen2.5:7b".into(),
                generated_at: "2026-08-10T00:00:00Z".into(),
                lines: vec![ScriptLineRecord { clip_id: "c0".into(), text: "The harbour.".into() }],
            },
            audio: AudioSection {
                voice: "af_heart".into(),
                sample_rate: 24_000,
                lines: vec![AudioLineRecord {
                    clip_id: "c0".into(),
                    path: "audio/line-01.wav".into(),
                    duration_ms: 2_000,
                    skipped_words: vec!["Aqsa".into()],
                }],
            },
            timeline: crate::timeline::plan(&clips, &lines),
            render: RenderSection {
                settings: RenderSettings::default(),
                vcodec: "h264".into(),
                acodec: "aac".into(),
                output_path: Some("render/rough-cut.mp4".into()),
            },
        }
    }

    #[test]
    fn round_trips_through_json() {
        let original = sample_project();
        let json = serde_json::to_string_pretty(&original).expect("serialize");
        let back: ProjectFile = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(back.schema_version, SCHEMA_VERSION);
        assert_eq!(back.timeline, original.timeline, "timeline must survive verbatim");
        assert_eq!(back.audio.lines[0].skipped_words, vec!["Aqsa".to_string()]);
        assert_eq!(back.render.settings.width, 1920);
    }

    #[test]
    fn json_uses_camel_case_for_the_web_editor() {
        let json = serde_json::to_string(&sample_project()).expect("serialize");
        for key in [
            "schemaVersion", "sourceDurationMs", "isPlaceholder", "skippedWords",
            "timelineStartMs", "timelineDurationMs", "sourceInMs", "sourceOutMs", "holdMs",
        ] {
            assert!(json.contains(&format!("\"{key}\"")), "missing key {key} in {json}");
        }
        assert!(!json.contains("schema_version"), "snake_case leaked into the manifest");
    }

    #[test]
    fn timeline_is_absolute_not_derived() {
        // The editor must be able to place every item without recomputing.
        let p = sample_project();
        let item = &p.timeline[0];
        assert_eq!(item.timeline_start_ms, 0);
        assert_eq!(item.timeline_duration_ms, 2_300);
        assert_eq!(item.source_out_ms, 2_300);
        assert_eq!(format!("{:?}", item.fit), "Trimmed");
    }

    #[test]
    fn relative_paths_use_forward_slashes() {
        let base = Path::new("/tmp/proj");
        let p = base.join("audio").join("line-01.wav");
        assert_eq!(relative_to(base, &p), "audio/line-01.wav");
    }

    #[test]
    fn bundle_contains_manifest_and_media() {
        let dir = std::env::temp_dir().join("rfrs-bundle-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("audio")).unwrap();
        std::fs::create_dir_all(dir.join("render")).unwrap();
        write_json(&sample_project(), &dir.join("project.json")).unwrap();
        std::fs::write(dir.join("audio/line-01.wav"), b"fake").unwrap();
        std::fs::write(dir.join("render/rough-cut.mp4"), b"fake").unwrap();

        let zip_path = dir.join("bundle.zip");
        write_bundle(&dir, &zip_path).unwrap();

        let f = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        println!("\n  bundle contains: {names:?}");
        for expected in ["project.json", "audio/line-01.wav", "render/rough-cut.mp4"] {
            assert!(names.contains(&expected.to_string()), "bundle missing {expected}");
        }
    }

    /// Media is referenced while editing, so a working manifest holds absolute
    /// paths. A bundle must not: it has to be openable on another machine.
    #[test]
    fn bundle_pulls_in_externally_referenced_media_and_rewrites_paths() {
        let root = std::env::temp_dir().join("rfrs-external-test");
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("project");
        let elsewhere = root.join("Movies");
        std::fs::create_dir_all(dir.join("audio")).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();

        // A real clip living outside the project, as a referenced import would.
        let external = elsewhere.join("holiday.mp4");
        std::fs::write(&external, b"pretend this is video").unwrap();

        let mut p = sample_project();
        p.clips[0].source_path = Some(external.to_string_lossy().to_string());
        p.clips[0].is_placeholder = false;
        write_json(&p, &dir.join("project.json")).unwrap();
        std::fs::write(dir.join("audio/line-01.wav"), b"fake").unwrap();

        let zip_path = root.join("bundle.zip");
        write_bundle(&dir, &zip_path).unwrap();

        let f = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        println!("\n  bundle: {names:?}");

        let copied = names.iter().find(|n| n.ends_with("holiday.mp4")).cloned();
        assert!(copied.is_some(), "external media should be copied in: {names:?}");

        let mut manifest_raw = String::new();
        {
            use std::io::Read;
            archive.by_name("project.json").unwrap().read_to_string(&mut manifest_raw).unwrap();
        }
        let bundled: ProjectFile = serde_json::from_str(&manifest_raw).unwrap();
        let path = bundled.clips[0].source_path.as_ref().expect("path present");
        println!("  rewritten sourcePath: {path}");

        assert!(!Path::new(path).is_absolute(), "bundle path must be relative, got {path}");
        assert_eq!(Some(path.clone()), copied, "manifest must point at the copied entry");
        // The timeline must survive the rewrite untouched.
        assert_eq!(bundled.timeline, p.timeline);
    }

    /// Media that vanished before export should be reported as absent, not
    /// shipped as a path that resolves to nothing.
    #[test]
    fn bundle_drops_paths_whose_media_is_missing() {
        let dir = std::env::temp_dir().join("rfrs-missing-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mut p = sample_project();
        p.clips[0].source_path = Some("/nowhere/gone.mp4".into());
        write_json(&p, &dir.join("project.json")).unwrap();

        let zip_path = dir.join("bundle.zip");
        write_bundle(&dir, &zip_path).unwrap();

        let f = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        let mut raw = String::new();
        {
            use std::io::Read;
            archive.by_name("project.json").unwrap().read_to_string(&mut raw).unwrap();
        }
        let bundled: ProjectFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(bundled.clips[0].source_path, None, "dangling path should be cleared");
    }

    #[test]
    fn hashes_are_stable_and_content_dependent() {
        let dir = std::env::temp_dir().join("rfrs-hash-test");
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        std::fs::write(&a, b"hello").unwrap();
        let h1 = sha256_file(&a).unwrap();
        let h2 = sha256_file(&a).unwrap();
        assert_eq!(h1, h2, "same content must hash the same");
        std::fs::write(&a, b"hello!").unwrap();
        assert_ne!(h1, sha256_file(&a).unwrap(), "changed content must hash differently");
    }
}
